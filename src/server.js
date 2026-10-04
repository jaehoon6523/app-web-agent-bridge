import { PreparationService } from "./orchestration/preparation-service.js";
import { GitChangeWorkspace } from "./repository/git-change-workspace.js";
import { chooseProjectFolder } from "./repository/folder-picker.js";
import http from "node:http";
import { createServerObserver, diagnosticErrorCode } from "./diagnostics/server-observer.js";
import { closeSteps } from "./diagnostics/shutdown.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { AuditProjectSettings } from "./orchestration/audit-project-settings.js";
import { defaultReviewerConfiguration } from "./orchestration/reviewer-settings.js";
import { isTerminalRunPhase } from "./domain/run-state-machine.js";
import {
  ChatGptWebSessionAdapter,
  createReviewerWebProviderSessions,
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
  "Connect the browser extension and configure the required providers to start a live run.";

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

/** @param {{runtimeConfig?: RuntimeConfig, createLiveRuntime?: typeof createLiveDiscussionRuntime, onDiagnostic?: (event:any) => void}} [options] */
export function createBridgeServer({
  runtimeConfig,
  createLiveRuntime = createLiveDiscussionRuntime,
  onDiagnostic,
} = {}) {
  if (!runtimeConfig || typeof runtimeConfig !== "object") {
    throw new TypeError("createBridgeServer requires runtimeConfig.");
  }
  const diagnostics = createServerObserver(onDiagnostic);
  const projectSettings = new AuditProjectSettings({
    filename: path.join(runtimeConfig.persistence?.databasePath
      ? path.dirname(runtimeConfig.persistence.databasePath) : path.join(runtimeConfig.workspace || process.cwd(), ".agent-controller"), "audit-project.json"),
    fallbackFile: runtimeConfig.auditProjectFile,
  });
  let auditSettings = projectSettings.snapshot();

  const extensionConfigured = runtimeConfig.demoMode === false
    && runtimeConfig.webExtension?.enabled === true;
  const extensionTransport = extensionConfigured
    ? new WebExtensionTransport(runtimeConfig.webExtension)
    : null;
  const webSession = extensionTransport
    ? new ChatGptWebSessionAdapter({
        transport: extensionTransport,
        responseTimeoutMs: runtimeConfig.relay.webResponseTimeoutMs,
      })
    : null;
  const reviewerWebProviders = extensionTransport && webSession
    ? createReviewerWebProviderSessions({
        transport:extensionTransport,
        chatGptSession:webSession,
        responseTimeoutMs:runtimeConfig.relay.webResponseTimeoutMs,
      })
    : null;
  const dashboardAuth = runtimeConfig.dashboard?.token
    ? new LocalSessionAuthenticator({
        token: runtimeConfig.dashboard.token,
        allowedOrigins: [runtimeConfig.baseUrl],
      })
    : null;
  // Browser sessions use a separate, process-lifetime token, never the .env secret.
  // DASHBOARD_TOKEN is optional and only adds a stable credential for explicit
  // local API/automation clients.
  const browserSession = LocalSessionAuthenticator.issue({ allowedOrigins: [runtimeConfig.baseUrl] });
  function verifyDashboardAuthorization(authorization) {
    if (dashboardAuth !== null) {
      try {
        dashboardAuth.verifyAuthorizationHeader(authorization);
        return;
      } catch (error) {
        if (!(error instanceof LocalAuthError)) throw error;
      }
    }
    browserSession.authenticator.verifyAuthorizationHeader(authorization);
  }

  function verifyDashboardOrigin(origin) {
    browserSession.authenticator.verifyOrigin(origin);
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
  function sendDashboardAuthFailure(res, error, fallbackStatus) {
    const localAuthError = error instanceof LocalAuthError;
    res.status(localAuthError ? error.statusCode : fallbackStatus).json({
      code:localAuthError ? error.code : "DASHBOARD_AUTH_FAILED",
      error:error.message,
    });
  }
  let liveRuntime = null;
  let liveRuntimePromise = null;
  let closing = false;
  const runtimeInitialization = new AbortController();

  async function getLiveRuntime() {
    if (closing) throw new Error("Server is shutting down.");
    if (runtimeConfig.demoMode) {
      throw new Error("Demo mode cannot create a live discussion runtime.");
    }
    if (!webSession) {
      throw new Error("Web extension integration is not configured.");
    }
    if (liveRuntime !== null) return liveRuntime;
    if (liveRuntimePromise === null) {
      diagnostics.emit("runtime.initialization.started");
      let initialization;
      try {
        initialization = createLiveRuntime({
          runtimeConfig:{ ...runtimeConfig, auditProject:auditSettings.project },
          webSession,
          reviewerWebProviders,
          initializationSignal:runtimeInitialization.signal,
          onDiagnostic:event => diagnostics.emit(event.type, event),
        });
      } catch (error) {
        diagnostics.emit("runtime.initialization.failed");
        throw error;
      }
      liveRuntimePromise = initialization
        .then((runtime) => {
          liveRuntime = runtime;
          diagnostics.emit("runtime.initialization.completed");
          return runtime;
        })
        .catch((error) => {
          diagnostics.emit("runtime.initialization.failed");
          throw error;
        })
        .finally(() => {
          liveRuntimePromise = null;
        });
    }
    return liveRuntimePromise;
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(diagnostics.middleware);
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
      extensionConfigured,
      extensionAuthenticated: Boolean(extensionTransport?.responsive),
      webAdapterAvailable: webSession !== null,
      commandAuthenticationConfigured: true,
      staticDashboardTokenConfigured: dashboardAuth !== null,
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
      lastWebBinding: extensionTransport?.responsive && extensionTransport.snapshot.binding
        ? { bindingStatus:extensionTransport.snapshot.binding.bindingStatus,
            conversationUrl:extensionTransport.snapshot.binding.conversationUrl,
            sessionId:extensionTransport.snapshot.binding.sessionId }
        : null,
      workerProvider: provider,
      project: audit.project ? {
        projectId: audit.project.projectId,
        targetRoot: audit.project.targetRoot,
        requirementsId: audit.project.requirements.requirementsId,
        revision: audit.project.requirements.revision,
        requirements: audit.project.requirements,
        policy: audit.project.policy,
        reviewers: audit.project.reviewers,
        verifications: audit.project.verifications.map(({ verificationId, purpose }) => ({ verificationId, purpose })),
      } : null,
      projectError: audit.error,
    });
  }

  function requireDashboardMutation(req, res, next) {
    try {
      verifyDashboardOrigin(req.get("origin"));
      verifyDashboardAuthorization(req.get("authorization"));
      next();
    } catch (error) {
      sendDashboardAuthFailure(res, error, 401);
    }
  }

  const dashboard = new DashboardController({
    getRuntime: getLiveRuntime,
    runtimeReadTimeoutMs: runtimeConfig.dashboard?.runtimeReadTimeoutMs,
    preflight: livePreflight,
    webSession,
    transport: extensionTransport,
  });
  const commandReceipts = new Map();
  let preparationService = null;
  function preparations() {
    if (closing) throw Object.assign(new Error("Server is shutting down."), {code:"SERVER_CLOSING"});
    if (preparationService) return preparationService;
    diagnostics.emit("preparation.initialization.started");
    try {
      preparationService = new PreparationService({
        filename: path.join(path.dirname(projectSettings.filename), "preparations.sqlite"),
        web: webSession,
        available: () => Boolean(extensionTransport?.authenticated),
        assertStart: async () => {
          const live = await getLiveRuntime();
          if (dashboard.isDispatching() || live.codeChanges?.busy() || live.store.listRuns().some((r) => !isTerminalRunPhase(r.phase))) {
            throw Object.assign(new Error("진행 중인 작업을 먼저 종료하세요."), { code: "RUN_BUSY" });
          }
        },
        findRun: async (id) => (await getLiveRuntime()).codeChanges?.get(id) ?? null,
        approve: async (context) => {
          const live = await getLiveRuntime();
          if (!live.codeChanges || !livePreflight().readyForDiscussion) throw new Error("CLI와 웹 연결 상태를 확인하세요.");
          const repository = GitChangeWorkspace.prepareTarget(context.targetRoot);
          const projectId = context.preparationId;
          const project = {
            projectId, targetRoot: context.targetRoot,
            requirements: { requirementsId: projectId + "-requirements", revision: String(context.version),
              authority: "REQUIREMENTS_JSON", sourceRoles: [], unresolvedQuestions: [],
              items: context.agreement.requirements.map((item, index) => ({
                requirementId: "R" + (index + 1), statement: item.statement, acceptanceCriteria: item.acceptanceCriteria,
                required: true, sourceRefs: [],
                verificationMethod: { kinds: ["CODE_SNAPSHOT"], description: "코드 스냅샷 검토 (실행 검증 없음)" },
              })) },
            policy: { maxIterations: 3, maxEvidenceRounds: 3, maxFormatRepairs: 2, totalTimeoutMs: 1800000, turnTimeoutMs: 600000 },
            reviewers: structuredClone(context.reviewers ?? auditSettings.project?.reviewers ?? defaultReviewerConfiguration()),
            verifications: [],
          };
          auditSettings = projectSettings.save(project, projectSettings.snapshot().version);
          live.codeChanges.project = structuredClone(auditSettings.project);
          const result = await live.codeChanges.startPrepared({ objective: context.objective, conversationUrl: context.conversationUrl }, context);
          return { ...result, repository };
        },
      });
      diagnostics.emit("preparation.initialization.completed");
    } catch (error) {
      diagnostics.emit("preparation.initialization.failed");
      throw error;
    }
    return preparationService;
  }


  function requireDashboardRead(req, res, next) {
    try {
      verifyDashboardAuthorization(req.get("authorization"));
      next();
    } catch (error) {
      sendDashboardAuthFailure(res, error, 401);
    }
  }

  app.post("/api/dashboard/session", (req, res) => {
    try {
      verifyLocalBrowser(req);
      res.json({
        token: browserSession.token,
        staticTokenConfigured: dashboardAuth !== null,
      });
    } catch (error) {
      sendDashboardAuthFailure(res, error, 403);
    }
  });

  app.post("/api/project/folder", requireDashboardMutation, async (_req, res) => {
    try { res.json(await chooseProjectFolder()); }
    catch (error) { res.status(400).json({ error: redactForEvidence(error.message) }); }
  });
  for (const legacy of ["/api/project/prepare", "/api/project/proposal", "/api/project/proposal/session"]) {
    app.all(legacy, requireDashboardMutation, (_req, res) => res.status(410).json({
      code: "PREPARATION_API_REQUIRED", message: "Use the canonical preparation API.",
    }));
  }
  const preparationRoute = (type) => async (req, res) => {
    try {
      const input = { ...req.body, ...(req.params.id ? { preparationId: req.params.id } : {}) };
      const command = type === "web" ? input.command : type;
      if (typeof command !== "string" || (type === "web" && !["web.inspect", "web.focus", "web.stop", "web.reconcile", "web.rebind"].includes(command))) {
        throw Object.assign(new Error("Invalid Web command."), { code: "INVALID_COMMAND" });
      }
      diagnostics.stage(req, "preparation.mutation.started");
      const result = await preparations().execute(command, input);
      diagnostics.stage(req, "preparation.mutation.completed");
      res.status(type === "preparation.start" || type === "preparation.reply" ? 202 : 200).json(result);
    } catch (error) {
      diagnostics.stage(req, "preparation.mutation.failed");
      res.status(error.code === "INVALID_INPUT" || error.code === "INVALID_COMMAND" ? 400 : 409).json({
        code: error.code ?? "PREPARATION_FAILED", message: redactForEvidence(error.message),
        retryable: false, workflowStage: preparationService?.current?.stage ?? "START",
        preparationId: preparationService?.current?.preparationId ?? null,
        runId: preparationService?.current?.resultingRunId ?? null, details: error.details ?? null,
      });
    }
  };
  app.post("/api/preparations", requireDashboardMutation, preparationRoute("preparation.start"));
  app.post("/api/preparations/web", requireDashboardMutation, preparationRoute("web"));
  for (const action of ["reply", "approve", "cancel", "discard"]) {
    app.post("/api/preparations/:id/" + action, requireDashboardMutation, preparationRoute("preparation." + action));
  }

  app.get("/api/project", requireDashboardRead, (_req, res) => {
    res.json({ ...projectSettings.snapshot(), defaults: { targetRoot: runtimeConfig.workspace || process.cwd(), executable: process.execPath } });
  });
  app.put("/api/project", requireDashboardMutation, (_req, res) => res.status(410).json({
    code: "PREPARATION_API_REQUIRED", message: "Project settings are saved by preparation approval.",
  }));

  app.post("/api/commands", requireDashboardMutation, async (req, res) => {
    try {
      if (!req.body || typeof req.body.type !== "string" || typeof req.body.requestId !== "string") {
        res.status(400).json({ error: "Command type and requestId are required." });
        return;
      }
      if (req.body.type === "run.start") throw new Error("작업 시작은 준비 합의 승인으로만 가능합니다.");
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
  app.post("/api/runs/start", requireDashboardMutation, (_req, res) => res.status(410).json({
    code: "PREPARATION_API_REQUIRED", message: "Start a run by approving a preparation.",
  }));
  app.get("/api/state", requireDashboardRead, async (req, res) => {
    try {
      if (req.query.runId !== undefined && typeof req.query.runId !== "string") {
        res.status(400).json({ error: "runId must be a string." });
        return;
      }
      const service = preparations();
      diagnostics.emit("state.snapshot.started");
      const baseSnapshot = await dashboard.snapshot(req.query.runId || null,
        event => diagnostics.stage(req, event.type, event));
      diagnostics.emit("state.snapshot.completed");
      diagnostics.emit("state.projection.started");
      const snapshot = await service.project(baseSnapshot,
        { runId: req.query.runId || null, start: req.query.view === "start" });
      diagnostics.emit("state.projection.completed");
      if (typeof req.query.requestId === "string") {
        snapshot.requestResult = service.receipt(req.query.requestId);
        if (snapshot.requestResult.status === "NOT_FOUND") {
          if (baseSnapshot.runtimeAvailability?.ready === false) {
            snapshot.requestResult = { requestId:req.query.requestId, status:"UNAVAILABLE" };
          } else {
            const live = await getLiveRuntime();
            const receipt = live.codeChanges?.store?.receipt(req.query.requestId);
            if (receipt) {
              snapshot.requestResult = {
                requestId:req.query.requestId,
                status:receipt.status === "COMPLETED" ? "COMPLETED" : "PROCESSING",
              };
            }
          }
        }
      }
      res.json(snapshot);
    } catch (error) {
      diagnostics.emit("state.read.failed");
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
  server.prependListener("request", diagnostics.received);
  server.on("connection", diagnostics.connected);
  // Own accepted TCP connections that have not reached an HTTP request or
  // upgrade. Node's HTTP idle-connection close does not reap every such peer.
  // This ownership is independent of diagnostic instrumentation.
  const unrequestedSockets = new Set();
  let httpClosing = false;
  server.on("connection", socket => {
    unrequestedSockets.add(socket);
    socket.once("close", () => unrequestedSockets.delete(socket));
    if (httpClosing && socket.bytesRead === 0) socket.destroy();
  });
  server.prependListener("request", req => unrequestedSockets.delete(req.socket));
  server.prependListener("upgrade", req => unrequestedSockets.delete(req.socket));
  const extensionWss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    maxPayload: MAX_LOCAL_MESSAGE_BYTES,
  });

  server.on("upgrade", (req, socket, head) => {
    diagnostics.upgrade(req);
    const rejectUpgrade = (statusLine, message = "") => {
      diagnostics.upgrade(req, "REJECTED", Number(statusLine.slice(0, 3)));
      writeUpgradeRejection(socket, statusLine, message);
    };
    if (closing) {
      rejectUpgrade("503 Service Unavailable", "Server is shutting down.");
      return;
    }
    let url;
    try {
      url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    } catch {
      rejectUpgrade("400 Bad Request");
      return;
    }

    if (url.pathname === "/ws/dashboard") {
      rejectUpgrade("503 Service Unavailable", LIVE_ORCHESTRATION_UNAVAILABLE);
      return;
    }

    if (url.pathname === "/ws/extension") {
      if (url.search !== "") {
        rejectUpgrade(
          "400 Bad Request",
          "The extension WebSocket URL must not contain a query string.",
        );
        return;
      }
      if (runtimeConfig.demoMode) {
        rejectUpgrade(
          "409 Conflict",
          "Demo mode does not accept extension connections.",
        );
        return;
      }
      if (!extensionTransport) {
        rejectUpgrade(
          "503 Service Unavailable",
          "Web extension integration is not configured.",
        );
        return;
      }
      extensionWss.handleUpgrade(req, socket, head, (ws) => {
        diagnostics.upgrade(req, "ACCEPTED", 101, ws);
        extensionWss.emit("connection", ws, req);
      });
      return;
    }

    rejectUpgrade("404 Not Found");
  });

  extensionWss.on("connection", (ws) => {
    extensionTransport?.attach(ws);
  });

  let closePromise = null;
  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    runtimeInitialization.abort(Object.assign(new Error("Server is shutting down."), {code:"SERVER_CLOSING"}));
    diagnostics.beginShutdown();
    closePromise = closeSteps([
      ["dashboard.close", () => dashboard.close()],
      ["preparationService.close", () => preparationService?.close()],
      ["extension websocket terminate", () => { for (const ws of extensionWss.clients) {
        // CLOSING peers may never finish their TCP half-close. Shutdown owns
        // these upgraded sockets too; do not wait for the peer close timeout.
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
        }
      } }],
      ["webSession.close", () => webSession?.close()],
      ["runtime initialization", async () => { if (liveRuntimePromise) await liveRuntimePromise.catch(() => {}); }],
      ["runtime.close", () => liveRuntime?.close()],
      ["extension websocket close", () => new Promise(resolve => extensionWss.close(error => {
        diagnostics.emit("shutdown.websocket.close.callback", {errorCode:diagnosticErrorCode(error)});
        // Preserve the existing close policy; expose callback errors as evidence.
        resolve(undefined);
      }))],
      ["HTTP server close", () => {
        diagnostics.emit("shutdown.http.inventory", diagnostics.socketInventory("http-close-start"));
        if (!server.listening) return;
        httpClosing = true;
        const closed = new Promise((resolve, reject) => server.close(error => {
          diagnostics.emit("shutdown.http.close.callback", {errorCode:diagnosticErrorCode(error)});
          diagnostics.emit("shutdown.http.inventory", diagnostics.socketInventory("http-close-callback"));
          if (error) reject(error);
          else resolve(undefined);
        }));
        // Stop accepting before reclaiming silent connections. A partial HTTP
        // header has bytesRead > 0 and must retain the existing drain policy;
        // parsed requests and upgraded sockets already have their own owner.
        for (const socket of unrequestedSockets) {
          if (socket.bytesRead === 0) socket.destroy();
        }
        return closed;
      }],
    ], diagnostics.emit);
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
        diagnostics.emit("server.listening");
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
    socketInventory:diagnostics.socketInventory,
  });
}

/** @param {RuntimeConfig} [runtimeConfig] @param {{onDiagnostic?: (event:any) => void}} [options] */
export async function main(runtimeConfig = loadConfig(), { onDiagnostic } = {}) {
  const pendingStages = new Set(), failedStages = new Set();
  const report = event => {
    if (event.type.startsWith("shutdown.")) {
      if (event.type === "shutdown.stage.start") pendingStages.add(event.stage);
      if (event.type === "shutdown.stage.done" || event.type === "shutdown.stage.error") pendingStages.delete(event.stage);
      if (event.type === "shutdown.stage.error") failedStages.add(event.stage);
      console.error(`[bridge.shutdown] ${JSON.stringify(event)}`);
    }
    try { onDiagnostic?.(event); } catch { /* Diagnostics are observational. */ }
  };
  const bridge = createBridgeServer({ runtimeConfig, onDiagnostic:report });
  await bridge.listen();

  console.log(`\nHTTP server listening at ${runtimeConfig.baseUrl}`);
  console.log("Dashboard API responsiveness: not yet verified");
  console.log("Runtime initialization: not started (lazy)");
  console.log(`Mode: ${runtimeConfig.demoMode ? "DEMO (transport disabled)" : "LIVE"}`);
  console.log(`Extension connection: ${bridge.extensionTransport?.authenticated ? "connected" : "disconnected"}`);
  console.log("Reviewer readiness: not yet verified");
  console.log(`Extension integration: ${bridge.extensionTransport ? "configured" : "not configured"}`);
  console.log("");

  let shutdownPromise;
  function gracefulShutdown(reason) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      console.log(`\nReceived ${reason}; shutting down.`);
      // Preserve bounded production shutdown; only the failure path forces exit.
      const failsafe = setTimeout(() => {
        console.error("Graceful shutdown deadline exceeded.");
        report({type:"shutdown.http.inventory", ...bridge.socketInventory("deadline")});
        report({type:"shutdown.deadline", pendingStages:[...pendingStages], failedStages:[...failedStages],
          activeResources:process.getActiveResourcesInfo().reduce((counts, type) => {
            counts[type] = (counts[type] ?? 0) + 1; return counts;
          }, {})});
        process.exit(1);
      }, 5000);
      failsafe.unref();
      try {
        await bridge.close();
        report({type:"shutdown.bridge.done"});
        process.exitCode = 0;
      } catch (error) {
        console.error("Shutdown error:", error);
        process.exitCode = 1;
      } finally {
        // Keep the unrefed deadline armed through rejection or leaked handles.
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
        process.off("message", onProcessMessage);
        // Release the IPC channel after resources close; let Node drain naturally.
        report({type:"shutdown.ipc.start", connected:process.connected ?? false});
        if (process.connected) process.disconnect();
        report({type:"shutdown.ipc.done"});
      }
    })();
    return shutdownPromise;
  }
  const onSigint = () => void gracefulShutdown("SIGINT");
  const onSigterm = () => void gracefulShutdown("SIGTERM");
  const onProcessMessage = message => {
    if (message && typeof message === "object" && "type" in message && message.type === "bridge.shutdown") void gracefulShutdown("IPC");
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  if (process.connected) process.on("message", onProcessMessage);
  return bridge;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === filename;
if (isMain) {
  void main().catch((error) => {
    console.error("Bridge startup failed:", error.message);
    process.exitCode = 1;
  });
}
