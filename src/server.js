import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { createDiscussionRunPolicy } from "./domain/run-policy.js";
import {
  ChatGptWebSessionAdapter,
  WebExtensionTransport,
} from "./runtime/web/index.js";
import { createLiveDiscussionRuntime } from "./runtime/live-discussion-runtime.js";
import { LocalAuthError, LocalSessionAuthenticator } from "./security/local-auth.js";
import { nowIso } from "./utils.js";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const publicDir = path.resolve(dirname, "../public");
const MAX_LOCAL_MESSAGE_BYTES = 1024 * 1024;
const LIVE_ORCHESTRATION_UNAVAILABLE =
  "Live run commands are unavailable until the authenticated start/recovery API is enabled.";

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
  let liveRuntime = null;
  let liveRuntimePromise = null;

  async function getLiveRuntime() {
    if (runtimeConfig.demoMode) {
      throw new Error("Demo mode cannot create a live discussion runtime.");
    }
    if (liveRuntime !== null) return liveRuntime;
    if (liveRuntimePromise === null) {
      liveRuntimePromise = createLiveRuntime({ runtimeConfig, webSession })
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
    const checks = {
      demoModeDisabled: runtimeConfig.demoMode === false,
      codexExecutableConfigured: runtimeConfig.codex?.executablePath != null,
      extensionAuthenticated: Boolean(extensionTransport?.authenticated),
      webAdapterAvailable: webSession !== null,
      commandAuthenticationConfigured: dashboardAuth !== null,
    };
    const missing = Object.entries(checks)
      .filter(([, ready]) => !ready)
      .map(([name]) => name);
    return Object.freeze({ checks, missing, readyForProvisioning: missing.length === 0 });
  }

  function requireDashboardMutation(req, res, next) {
    if (dashboardAuth === null) {
      res.status(503).json({ error: "DASHBOARD_TOKEN must be configured before live run commands." });
      return;
    }
    try {
      dashboardAuth.verifyMutation({
        authorization: req.get("authorization"),
        origin: req.get("origin"),
      });
      next();
    } catch (error) {
      const status = error instanceof LocalAuthError ? error.statusCode : 401;
      res.status(status).json({ error: error.message });
    }
  }

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

  app.get("/api/health", (_req, res) => {
    const preflight = livePreflight();
    res.json({
      ok: true,
      at: nowIso(),
      demoMode: runtimeConfig.demoMode,
      coreOrchestrationReady: true,
      fakeVerticalSliceVerified: true,
      codexRuntimeReady: false,
      webRuntimeReady: false,
      liveSessionBindingReady: false,
      liveOrchestrationReady: false,
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
      const live = await getLiveRuntime();
      const provisioned = await live.composition.provisionRun({
        objective: request.objective,
        policy: createDiscussionRunPolicy(),
        webConversationUrl: request.conversationUrl,
      });
      const result = await provisioned.dispatcher.runUntilSettled({
        runId: provisioned.run.runId,
        maxDispatches: provisioned.run.maxTurns,
      });
      res.status(200).json({
        runId: provisioned.run.runId,
        status: result.status,
        outcome: result.outcome,
      });
    } catch (error) {
      res.status(502).json({
        error: "Live run did not complete.",
        code: error?.code || "LIVE_RUN_FAILED",
      });
    }
  });
  app.get("/api/state", (_req, res) => {
    res.status(503).json({ error: LIVE_ORCHESTRATION_UNAVAILABLE });
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
      for (const ws of extensionWss.clients) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1001, "Server shutting down");
        }
      }
      await webSession?.close();
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
