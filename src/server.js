import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { readAuditProject } from "./orchestration/audit-project.js";
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
  const auditSettings = readAuditProject(runtimeConfig.auditProjectFile);

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
    const checks = {
      demoModeDisabled: runtimeConfig.demoMode === false,
      codexExecutableConfigured: runtimeConfig.codex?.executablePath != null,
      extensionAuthenticated: Boolean(extensionTransport?.authenticated),
      webAdapterAvailable: webSession !== null,
      commandAuthenticationConfigured: dashboardAuth !== null,
      auditProjectConfigured: audit.project !== null,
    };
    const missing = Object.entries(checks)
      .filter(([, ready]) => !ready)
      .map(([name]) => name);
    return Object.freeze({ checks, missing, readyForProvisioning: missing.length === 0,
      readyForDiscussion: missing.filter((key) => key !== "auditProjectConfigured").length === 0,
      project: audit.project ? { projectId: audit.project.projectId, targetRoot: audit.project.targetRoot,
        requirementsId: audit.project.requirements.requirementsId, revision: audit.project.requirements.revision,
        requirements: audit.project.requirements, policy: audit.project.policy,
        verifications: audit.project.verifications.map(({ verificationId, purpose }) => ({ verificationId, purpose })) } : null,
      projectError: audit.error });
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

  app.post("/api/commands", requireDashboardMutation, async (req, res) => {
    try {
      if (!req.body || typeof req.body.type !== "string" || typeof req.body.requestId !== "string") {
        res.status(400).json({ error: "Command type and requestId are required." });
        return;
      }
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
    res.json({
      ok: true,
      at: nowIso(),
      demoMode: runtimeConfig.demoMode,
      coreOrchestrationReady: liveRuntime !== null,
      fakeVerticalSliceVerified: null,
      codexRuntimeReady: codexReady,
      webRuntimeReady: webReady,
      liveSessionBindingReady: Boolean(bound),
      liveOrchestrationReady: Boolean(codexReady && bound),
      webConnected: preflight.checks.extensionAuthenticated,
      liveCompositionConfigured: preflight.checks.codexExecutableConfigured,
    });
  });
  app.get("/api/preflight", (_req, res) => {
    res.json(livePreflight());
  });
  app.post("/api/runs/start", requireDashboardMutation, async (req, res) => {
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
