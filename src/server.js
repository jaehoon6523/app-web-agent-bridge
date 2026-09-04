import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import {
  ChatGptWebSessionAdapter,
  WebExtensionTransport,
} from "./runtime/web/index.js";
import { createLiveDiscussionRuntime } from "./runtime/live-discussion-runtime.js";
import { nowIso } from "./utils.js";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const publicDir = path.resolve(dirname, "../public");
const MAX_LOCAL_MESSAGE_BYTES = 1024 * 1024;
const LIVE_ORCHESTRATION_UNAVAILABLE =
  "Live Controller orchestration is unavailable until Codex and ChatGPT Web runtimes are composed.";

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

/** @param {{runtimeConfig?: RuntimeConfig}} [options] */
export function createBridgeServer({ runtimeConfig } = {}) {
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
  let liveRuntime = null;
  let liveRuntimePromise = null;

  async function getLiveRuntime() {
    if (runtimeConfig.demoMode) {
      throw new Error("Demo mode cannot create a live discussion runtime.");
    }
    if (liveRuntime !== null) return liveRuntime;
    if (liveRuntimePromise === null) {
      liveRuntimePromise = createLiveDiscussionRuntime({ runtimeConfig, webSession })
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
  app.get("/api/health", (_req, res) => {
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
      liveCompositionConfigured: runtimeConfig.codex?.executablePath != null,
      webConnected: Boolean(extensionTransport?.authenticated),
    });
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
