import { RequirementsPlanner } from "./orchestration/requirements-planner.js";
import { GitChangeWorkspace } from "./repository/git-change-workspace.js";
import { chooseProjectFolder } from "./repository/folder-picker.js";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { AuditProjectSettings } from "./orchestration/audit-project-settings.js";
import { isTerminalRunPhase } from "./domain/run-state-machine.js";
import {
  ChatGptWebSessionAdapter,
  WebExtensionTransport,
} from "./runtime/web/index.js";
import { createLiveDiscussionRuntime } from "./runtime/live-discussion-runtime.js";
import { LocalAuthError, LocalSessionAuthenticator } from "./security/local-auth.js";
import { nowIso } from "./utils.js";
import { DashboardController } from "./orchestration/dashboard-controller.js";
import { redactForEvidence } from "./security/redaction.js";
import { canonicalJson } from "./domain/canonical-json.js";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const publicDir = path.resolve(dirname, "../public");
const MAX_LOCAL_MESSAGE_BYTES = 1024 * 1024;
const LIVE_ORCHESTRATION_UNAVAILABLE =
  "Configure DASHBOARD_TOKEN and connect the browser extension to start a live run.";

/** @typedef {ReturnType<typeof loadConfig>} RuntimeConfig */

function writeUpgradeRejection(socket, statusLine, message = "") {
  const body = message ? `${message}\n` : "";
  socket.write([
    `HTTP/1.1 ${statusLine}`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n"));
  socket.destroy();
}

/** @param {{runtimeConfig?: RuntimeConfig, createLiveRuntime?: typeof createLiveDiscussionRuntime}} [options] */
export function createBridgeServer({
  runtimeConfig,
  createLiveRuntime = createLiveDiscussionRuntime,
} = {}) {
  if (!runtimeConfig || typeof runtimeConfig !== "object") {
    throw new TypeError("createBridgeServer requires runtimeConfig.");
  }
  const projectSettings = new AuditProjectSettings({
    filename: path.join(runtimeConfig.persistence?.databasePath
      ? path.dirname(runtimeConfig.persistence.databasePath) : path.join(runtimeConfig.workspace || process.cwd(), ".agent-controller"), "audit-project.json"),
    fallbackFile: runtimeConfig.auditProjectFile,
  });
  let auditSettings = projectSettings.snapshot();

  const extensionTransport = runtimeConfig.demoMode
    ? null
    : new WebExtensionTransport(runtimeConfig.webExtension);
  const webSession = runtimeConfig.demoMode
    ? null
    : new ChatGptWebSessionAdapter({
        transport: extensionTransport,
        responseTimeoutMs: runtimeConfig.relay.webResponseTimeoutMs,
      });
  const dashboardAuth = runtimeConfig.dashboard?.token
    ? new LocalSessionAuthenticator({
        token: runtimeConfig.dashboard.token,
        allowedOrigins: [runtimeConfig.baseUrl],
      })
    : null;
  // Browser sessions use a separate, process-lifetime token, never the .env secret.
  const browserSession = LocalSessionAuthenticator.issue({ allowedOrigins: [runtimeConfig.baseUrl] });
  function verifyDashboardAuthorization(authorization) {
    try {
      dashboardAuth.verifyAuthorizationHeader(authorization);
    } catch (error) {
      if (!(error instanceof LocalAuthError)) throw error;
      browserSession.authenticator.verifyAuthorizationHeader(authorization);
    }
  }

  function verifyLocalBrowser(req) {
    const peer = req.socket.remoteAddress;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)
        || req.get("host") !== new URL(runtimeConfig.baseUrl).host
        || req.get("sec-fetch-site") !== "same-origin") {
      throw new LocalAuthError("Open the dashboard at the configured local server address.", "LOCAL_BROWSER_REQUIRED", 403);
    }
    browserSession.authenticator.verifyOrigin(req.get("origin"));
  }
  let liveRuntime = null;
  let liveRuntimePromise = null;
  let closing = false;

  async function getLiveRuntime() {
    if (closing) throw new Error("Server is shutting down.");
    if (runtimeConfig.demoMode) {
      throw new Error("Demo mode cannot create a live discussion runtime.");
    }
    if (liveRuntime !== null) return liveRuntime;
    if (liveRuntimePromise === null) {
      liveRuntimePromise = createLiveRuntime({ runtimeConfig: { ...runtimeConfig, auditProject: auditSettings.project }, webSession })
        .then((runtime) => {
          liveRuntime = runtime;
          return runtime;
        })
        .finally(() => {
          liveRuntimePromise = null;
        });
    }
    return liveRuntimePromise;
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; form-action 'none'",
    );
    next();
  });
  function livePreflight() {
    const audit = auditSettings;
    const provider = runtimeConfig.codeWorker?.provider ?? "codex";
    const codeWorkerExecutableConfigured = provider === "codex"
      ? runtimeConfig.codex?.executablePath != null
      : runtimeConfig.codeWorker?.executablePath != null;
    const checks = {
      demoModeDisabled: runtimeConfig.demoMode === false,
      codeWorkerExecutableConfigured,
      discussionCodexExecutableConfigured: runtimeConfig.codex?.executablePath != null,
      extensionAuthenticated: Boolean(extensionTransport?.authenticated),
      webAdapterAvailable: webSession !== null,
      commandAuthenticationConfigured: dashboardAuth !== null,
      auditProjectConfigured: audit.project !== null,
    };
    const commonKeys = ["demoModeDisabled", "extensionAuthenticated", "webAdapterAvailable", "commandAuthenticationConfigured"];
    const codeChangeKeys = [...commonKeys, "codeWorkerExecutableConfigured", "auditProjectConfigured"];
    const discussionKeys = [...commonKeys, "discussionCodexExecutableConfigured"];
    const missingFor = (keys) => keys.filter((key) => !checks[key]);
    const missing = missingFor(codeChangeKeys);
    const discussionMissing = missingFor(discussionKeys);
    return Object.freeze({
      checks,
      missing,
      discussionMissing,
      readyForProvisioning: missing.length === 0,
      readyForDiscussion: discussionMissing.length === 0,
      workerProvider: provider,
      project: audit.project ? {
        projectId: audit.project.projectId,
        targetRoot: audit.project.targetRoot,
        requirementsId: audit.project.requirements.requirementsId,
        revision: audit.project.requirements.revision,
        requirements: audit.project.requirements,
        policy: audit.project.policy,
        verifications: audit.project.verifications.map(({ verificationId, purpose }) => ({ verificationId, purpose })),
      } : null,
      projectError: audit.error,
    });
  }

  function requireDashboardMutation(req, res, next) {
    if (dashboardAuth === null) {
      res.status(503).json({ error: "DASHBOARD_TOKEN must be configured before live run commands." });
      return;
    }
    try {
      dashboardAuth.verifyOrigin(req.get("origin"));
      verifyDashboardAuthorization(req.get("authorization"));
      next();
    } catch (error) {
      const status = error instanceof LocalAuthError ? error.statusCode : 401;
      res.status(status).json({ error: error.message });
    }
  }

  const dashboard = new DashboardController({
    getRuntime: getLiveRuntime,
    preflight: livePreflight,
    webSession,
    transport: extensionTransport,
  });
  const commandReceipts = new Map();
  const planner = new RequirementsPlanner(webSession, { canRecoverRun: (runId) => {
    const run = liveRuntime?.store.listRuns().find((item) => item.runId === runId);
    return Boolean(run && isTerminalRunPhase(run.phase));
  } });

  function requireDashboardRead(req, res, next) {
    if (dashboardAuth === null) {
      res.status(503).json({ error: "DASHBOARD_TOKEN must be configured." });
      return;
    }
    try {
      verifyDashboardAuthorization(req.get("authorization"));
      next();
    } catch (error) {
      res.status(error.statusCode || 401).json({ error: error.message });
    }
  }

  app.post("/api/dashboard/session", (req, res) => {
    try {
      verifyLocalBrowser(req);
      if (!dashboardAuth) {
        res.status(503).json({ error: ".env에 DASHBOARD_TOKEN을 설정하고 서버를 다시 시작하세요." });
        return;
      }
      res.json({ token: browserSession.token });
    } catch (error) {
      res.status(error.statusCode || 403).json({ error: error.message });
    }
  });

  app.post("/api/project/folder", requireDashboardMutation, async (_req, res) => {
    try { res.json(await chooseProjectFolder()); }
    catch (error) { res.status(400).json({ error: redactForEvidence(error.message) }); }
  });
  app.post("/api/project/prepare", requireDashboardMutation, async (req, res) => {
    try {
      const live = await getLiveRuntime();
      if (planner.busy || dashboard.isDispatching() || live.codeChanges?.busy() || live.store.listRuns().some((r) => !isTerminalRunPhase(r.phase))) throw new Error("진행 중인 작업을 종료한 뒤 준비하세요.");
      res.json(GitChangeWorkspace.prepareTarget(req.body?.targetRoot));
    } catch (error) { res.status(400).json({ error: redactForEvidence(error.message) }); }
  });
  function proposalSnapshot() {
    const draft = structuredClone(planner.current);
    if (draft?.errorDetails) {
      const run = liveRuntime?.store.listRuns().find((item) => item.runId === draft.errorDetails.runId);
      draft.errorDetails.runObjective = run?.objective ?? null;
      draft.errorDetails.runPhase = run?.phase ?? null;
    }
    return draft;
  }
  app.get("/api/project/proposal", requireDashboardRead, (_req, res) => res.json(proposalSnapshot()));
  app.post("/api/project/proposal/session", requireDashboardMutation, async (req, res) => {
    try {
      const { draftId, action } = req.body || {};
      if (!planner.current || draftId !== planner.current.draftId || planner.busy) throw new Error("준비 요청이 변경됐거나 진행 중입니다. 상태를 다시 확인하세요.");
      if (!["inspect", "focus", "stop", "recover"].includes(action)) throw new Error("지원하지 않는 세션 작업입니다.");
      const live = await getLiveRuntime();
      if (dashboard.isDispatching() || live.codeChanges?.busy() || live.store.listRuns().some((r) => !isTerminalRunPhase(r.phase))) throw new Error("진행 중인 실행을 먼저 중단하세요.");
      if (action === "inspect") planner.current.errorDetails = await webSession.inspectDelivery();
      else {
        const expected = planner.current.errorDetails;
        if (!expected?.sessionId || (action !== "focus" && !expected.currentDeliveryId)) throw new Error("이전 전송 상태를 먼저 확인하세요.");
        if (action === "focus") await webSession.focusDelivery(expected);
        else if (action === "stop") planner.current.errorDetails = await webSession.stopDelivery(expected);
        else {
          planner.current.recoveredDelivery = await webSession.recoverDelivery(expected);
          planner.current.errorDetails = { ...expected, currentDeliveryId: null };
        }
      }
      res.json(proposalSnapshot());
    } catch (error) {
      res.status(409).json({ error: redactForEvidence(error.message), code: error.code ?? null, details: error.details ?? null });
    }
  });
  app.post("/api/project/proposal", requireDashboardMutation, async (req, res) => {
    try {
      const live = await getLiveRuntime();
      if (planner.busy || dashboard.isDispatching() || live.codeChanges?.busy() || live.store.listRuns().some((r) => !isTerminalRunPhase(r.phase))) throw new Error("진행 중인 작업을 종료한 뒤 제안을 요청하세요.");
      if (!extensionTransport?.authenticated) throw new Error("브라우저 확장을 연결하고 ChatGPT 대화 탭을 열어 주세요.");
      res.json(planner.start(req.body));
    } catch (error) { res.status(400).json({ error: redactForEvidence(error.message) }); }
  });

  app.get("/api/project", requireDashboardRead, (_req, res) => {
    res.json({ ...projectSettings.snapshot(), defaults: { targetRoot: runtimeConfig.workspace || process.cwd(), executable: process.execPath } });
  });
  app.put("/api/project", requireDashboardMutation, async (req, res) => {
    try {
      const live = await getLiveRuntime();
      if (planner.busy || dashboard.isDispatching() || live.codeChanges?.busy()
        || live.store.listRuns().some((run) => !isTerminalRunPhase(run.phase))) {
        res.status(409).json({ error: "미종료 작업을 중단한 뒤 프로젝트 설정을 저장하세요." });
        return;
      }
      if (req.body?.draftId && (planner.current?.draftId !== req.body.draftId
        || planner.current.status !== "READY" || planner.current.proposal.questions.length)) {
        throw new Error("최신 웹 제안을 확인하고 남은 질문에 답한 뒤 승인하세요.");
      }
      const saved = projectSettings.save(req.body?.project, req.body?.expectedVersion);
      auditSettings = saved;
      if (live.codeChanges) live.codeChanges.project = structuredClone(saved.project);
      res.json(saved);
    } catch (error) {
      res.status(error.code === "PROJECT_VERSION_CONFLICT" ? 409 : 400)
        .json({ error: redactForEvidence(error.message) });
    }
  });

  app.post("/api/commands", requireDashboardMutation, async (req, res) => {
    try {
      if (!req.body || typeof req.body.type !== "string" || typeof req.body.requestId !== "string") {
        res.status(400).json({ error: "Command type and requestId are required." });
        return;
      }
      if (planner.busy && req.body.type === "run.start") throw new Error("웹 제안이 완료된 뒤 시작하세요.");
      const requestHash = canonicalJson(req.body);
      let receipt = commandReceipts.get(req.body.requestId);
      if (receipt && receipt.requestHash !== requestHash) {
        res.status(409).json({ error: "requestId was already used for a different command." });
        return;
      }
      if (!receipt) {
        if (commandReceipts.size >= 256) {
          const completed = [...commandReceipts.entries()].find(([, item]) => item.completed);
          if (!completed) {
            res.status(429).json({ error: "Too many commands in progress." });
            return;
          }
          commandReceipts.delete(completed[0]);
        }
        receipt = { requestHash, completed: false, result: null };
        receipt.result = dashboard.executeDurable(req.body).finally(() => { receipt.completed = true; });
        commandReceipts.set(req.body.requestId, receipt);
      }
      const payload = await receipt.result;
      res.json({ type: "command.result", requestId: req.body.requestId, payload });
    } catch (error) {
      res.status(error.code === "RUN_VERSION_CONFLICT" || error.code === "RUN_BUSY" ? 409 : 400)
        .json({ type: "command.error", requestId: req.body?.requestId,
          payload: { message: redactForEvidence(error.message), code: error.code || "COMMAND_FAILED" } });
    }
  });

  function startRequest(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new TypeError("Start request must be an object.");
    }
    const allowed = new Set(["objective", "conversationUrl"]);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) throw new TypeError(`Unsupported start field ${JSON.stringify(key)}.`);
    }
    if (typeof body.objective !== "string" || body.objective.trim() === "") {
      throw new TypeError("objective must be a non-empty string.");
    }
    if (typeof body.conversationUrl !== "string" || body.conversationUrl.trim() === "") {
      throw new TypeError("conversationUrl must be a non-empty string.");
    }
    return Object.freeze({
      objective: body.objective.trim(),
      conversationUrl: body.conversationUrl.trim(),
    });
  }

  app.get("/api/health", async (_req, res) => {
    const preflight = livePreflight();
    const web = await webSession?.inspect();
    const codexReady = liveRuntime?.manager?.status === "READY";
    const webReady = preflight.checks.extensionAuthenticated && web?.sessionReady === true;
    const bound = webReady && web?.binding?.bindingStatus === "BOUND";
    const discussionRuntimeReady = Boolean(codexReady && bound);
    res.json({
      ok: true,
      at: nowIso(),
      demoMode: runtimeConfig.demoMode,
      coreOrchestrationReady: liveRuntime !== null,
      fakeVerticalSliceVerified: null,
      codexRuntimeReady: codexReady,
      codeWorkerProvider: preflight.workerProvider,
      codeWorkerConfigured: preflight.checks.codeWorkerExecutableConfigured,
      codeChangeProvisioningReady: preflight.readyForProvisioning,
      webRuntimeReady: webReady,
      liveSessionBindingReady: Boolean(bound),
      discussionRuntimeReady,
      liveOrchestrationReady: discussionRuntimeReady,
      webConnected: preflight.checks.extensionAuthenticated,
      liveCompositionConfigured: preflight.checks.discussionCodexExecutableConfigured,
    });
  });
  app.get("/api/preflight", (_req, res) => {
    res.json(livePreflight());
  });
  app.post("/api/runs/start", requireDashboardMutation, async (req, res) => {
    if (planner.busy) { res.status(409).json({ error: "웹 제안이 완료된 뒤 시작하세요." }); return; }
    const preflight = livePreflight();
    if (!preflight.readyForProvisioning) {
      res.status(409).json({ error: "Live run preflight is incomplete.", preflight });
      return;
    }
    let request;
    try {
      request = startRequest(req.body);
    } catch (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    try {
      const started = await dashboard.executeDurable({ type: "run.start", requestId: req.get("x-request-id"), payload: {
        ...request, expectedVersion: 0, mode: "CODE_CHANGE",
      } });
      res.status(202).json(started);
    } catch (error) {
      res.status(502).json({
        error: redactForEvidence(error?.message || "Live run did not complete."),
        code: error?.code || "LIVE_RUN_FAILED",
        details: null,
      });
    }
  });
  app.get("/api/state", requireDashboardRead, async (req, res) => {
    try {
      if (req.query.runId !== undefined && typeof req.query.runId !== "string") {
        res.status(400).json({ error: "runId must be a string." });
        return;
      }
      res.json(await dashboard.snapshot(req.query.runId || null));
    } catch (error) {
      res.status(503).json({ error: redactForEvidence(error.message) });
    }
  });
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Unknown API route." });
  });
  app.use(["/runs", "/approvals"], (_req, res) => {
    res.status(503).json({ error: LIVE_ORCHESTRATION_UNAVAILABLE });
  });
  app.use(express.static(publicDir));
  app.use((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(404).json({ error: "Unknown route." });
      return;
    }
    res.sendFile(path.join(publicDir, "index.html"));
  });

  const server = http.createServer(app);
  const extensionWss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    maxPayload: MAX_LOCAL_MESSAGE_BYTES,
  });

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    } catch {
      writeUpgradeRejection(socket, "400 Bad Request");
      return;
    }

    if (url.pathname === "/ws/dashboard") {
      writeUpgradeRejection(socket, "503 Service Unavailable", LIVE_ORCHESTRATION_UNAVAILABLE);
      return;
    }

    if (url.pathname === "/ws/extension") {
      if (url.search !== "") {
        writeUpgradeRejection(
          socket,
          "400 Bad Request",
          "The extension WebSocket URL must not contain a query string.",
        );
        return;
      }
      if (runtimeConfig.demoMode) {
        writeUpgradeRejection(
          socket,
          "409 Conflict",
          "Demo mode does not accept extension connections.",
        );
        return;
      }
      extensionWss.handleUpgrade(req, socket, head, (ws) => {
        extensionWss.emit("connection", ws, req);
      });
      return;
    }

    writeUpgradeRejection(socket, "404 Not Found");
  });

  extensionWss.on("connection", (ws) => {
    extensionTransport.attach(ws);
  });

  let closePromise = null;
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      dashboard.close();
      for (const ws of extensionWss.clients) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
      }
      await webSession?.close();
      if (liveRuntimePromise) await liveRuntimePromise.catch(() => {});
      await liveRuntime?.close();
      /** @type {Promise<void>} */
      const websocketClose = new Promise((resolve, reject) => {
        extensionWss.close(() => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => (error ? reject(error) : resolve()));
        });
      });
      await websocketClose;
    })();
    return closePromise;
  }

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(server.address());
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(runtimeConfig.port, runtimeConfig.host);
    });
  }

  return Object.freeze({
    app,
    close,
    extensionTransport,
    extensionWss,
    listen,
    getLiveRuntime,
    server,
    webSession,
  });
}

export async function main(runtimeConfig = loadConfig()) {
  const bridge = createBridgeServer({ runtimeConfig });
  await bridge.listen();

  console.log(`\nApp/Web Agent Bridge running at ${runtimeConfig.baseUrl}`);
  console.log(`Mode: ${runtimeConfig.demoMode ? "DEMO (transport disabled)" : "LIVE"}`);
  console.warn(LIVE_ORCHESTRATION_UNAVAILABLE);
  console.log("");

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}; shutting down.`);
    const failsafe = setTimeout(() => process.exit(1), 5000);
    failsafe.unref();
    try {
      await bridge.close();
      clearTimeout(failsafe);
      process.exit(0);
    } catch (error) {
      console.error("Shutdown error:", error);
      process.exit(1);
    }
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  return bridge;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === filename;
if (isMain) {
  void main().catch((error) => {
    console.error("Bridge startup failed:", error.message);
    process.exitCode = 1;
  });
}
