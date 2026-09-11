import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.js";
import { computeWebChallengeHmac } from "../src/runtime/web/auth.js";
import { createBridgeServer } from "../src/server.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodeChangeStore } from "../src/persistence/code-change-store.js";
import { project } from "./helpers/audit-fixtures.js";

const SHARED_SECRET = "integration-shared-secret-0123456789abcdef";
const EXTENSION_IDENTITY = "extension-integration";
const DASHBOARD_TOKEN = "dashboard-token-0123456789abcdef-dashboard-token";

function runtimeConfig({
  demoMode = false,
  dashboardToken = null,
  codexExecutablePath = null,
  auditProjectFile = null,
  extensionEnabled = !demoMode,
} = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    baseUrl: "http://127.0.0.1:0",
    workspace: process.cwd(),
    logDir: process.cwd(),
    demoMode,
    auditProjectFile,
    dashboard: { token: dashboardToken },
    codex: { executablePath: codexExecutablePath },
    webExtension: {
      enabled: extensionEnabled,
      sharedSecret: extensionEnabled ? SHARED_SECRET : null,
      expectedExtensionIdentity: extensionEnabled ? EXTENSION_IDENTITY : null,
    },
    relay: { webResponseTimeoutMs: 500 },
  };
}

async function rejectedStatus(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error(`Expected ${url} to reject the WebSocket upgrade.`));
    });
    socket.once("error", reject);
  });
}

async function requestLocalBrowserSession(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/api/dashboard/session",
      method: "POST",
      headers: {
        host: "127.0.0.1:0",
        origin: "http://127.0.0.1:0",
        "sec-fetch-site": "same-origin",
        "content-length": "0",
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        resolve({ status: response.statusCode, body: JSON.parse(body) });
      });
    });
    request.once("error", reject);
    request.end();
  });
}

test("optional integration configuration is feature-gated and EXTENSION_TOKEN is not a fallback", () => {
  assert.throws(
    () => loadConfig({ env: { HOST: "0.0.0.0", DEMO_MODE: "true" } }),
    /loopback address/u,
  );

  const minimal = loadConfig({ env: { EXTENSION_TOKEN: "legacy-token" } });
  assert.deepEqual(minimal.webExtension, {
    enabled: false,
    sharedSecret: null,
    expectedExtensionIdentity: null,
  });
  assert.equal(minimal.dashboard.token, null);
  assert.equal(minimal.codex.executablePath, null);
  assert.equal(Object.hasOwn(minimal, "extensionToken"), false);

  assert.throws(
    () => loadConfig({ env: { WEB_EXTENSION_SHARED_SECRET: SHARED_SECRET } }),
    /must be configured together/u,
  );
  assert.throws(
    () => loadConfig({ env: { WEB_EXTENSION_EXPECTED_IDENTITY: EXTENSION_IDENTITY } }),
    /must be configured together/u,
  );
  assert.throws(
    () => loadConfig({
      env: {
        WEB_EXTENSION_SHARED_SECRET: "too-short",
        WEB_EXTENSION_EXPECTED_IDENTITY: EXTENSION_IDENTITY,
      },
    }),
    /at least 32 UTF-8 bytes/u,
  );

  const loaded = loadConfig({
    env: {
      EXTENSION_TOKEN: "must-be-ignored",
      WEB_EXTENSION_SHARED_SECRET: ` ${SHARED_SECRET} `,
      WEB_EXTENSION_EXPECTED_IDENTITY: ` ${EXTENSION_IDENTITY} `,
    },
    cwd: process.cwd(),
  });
  assert.deepEqual(loaded.webExtension, {
    enabled: true,
    sharedSecret: SHARED_SECRET,
    expectedExtensionIdentity: EXTENSION_IDENTITY,
  });

  const demo = loadConfig({ env: { DEMO_MODE: "true", EXTENSION_TOKEN: "ignored" } });
  assert.deepEqual(demo.webExtension, {
    enabled: false,
    sharedSecret: null,
    expectedExtensionIdentity: null,
  });
});

test("server rejects token URLs and authenticates the exact extension identity by HMAC", async (t) => {
  const bridge = createBridgeServer({ runtimeConfig: runtimeConfig() });
  assert.equal(bridge.extensionWss.options.maxPayload, 1024 * 1024);
  await bridge.listen();
  t.after(async () => {
    for (const client of bridge.extensionWss.clients) client.terminate();
    await bridge.close();
  });

  const { port } = bridge.server.address();
  const baseHttp = `http://127.0.0.1:${port}`;
  const baseWs = `ws://127.0.0.1:${port}`;

  assert.equal(await rejectedStatus(`${baseWs}/ws/extension?token=legacy`), 400);
  assert.equal(await rejectedStatus(`${baseWs}/ws/dashboard`), 503);
  assert.equal((await fetch(`${baseHttp}/api/state`)).status, 401);
  assert.equal((await fetch(`${baseHttp}/api/nope`)).status, 404);
  assert.equal((await fetch(`${baseHttp}/runs`, { method: "POST" })).status, 503);
  assert.equal((await fetch(`${baseHttp}/approvals/pending`, { method: "POST" })).status, 503);
  assert.equal((await fetch(`${baseHttp}/not-a-command`, { method: "POST" })).status, 404);

  const socket = new WebSocket(`${baseWs}/ws/extension`);
  const challengeMessage = once(socket, "message");
  await once(socket, "open");
  const [challengeRaw] = await challengeMessage;
  const challenge = JSON.parse(String(challengeRaw));
  assert.equal(challenge.type, "controller.auth.challenge");
  assert.equal(new URL(socket.url).search, "");

  const acceptedMessage = once(socket, "message");
  socket.send(JSON.stringify({
    type: "extension.auth.response",
    protocolVersion: challenge.protocolVersion,
    challengeId: challenge.challengeId,
    extensionIdentity: EXTENSION_IDENTITY,
    hmacSha256: computeWebChallengeHmac(challenge.nonce, SHARED_SECRET),
  }));
  const [acceptedRaw] = await acceptedMessage;
  assert.equal(JSON.parse(String(acceptedRaw)).type, "controller.auth.accepted");
  assert.equal(bridge.extensionTransport.authenticated, true);
  const healthResponse = await fetch(`${baseHttp}/api/health`);
  assert.match(healthResponse.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
  const health = await healthResponse.json();
  assert.equal(health.webConnected, true);
  assert.deepEqual({
    coreOrchestrationReady: health.coreOrchestrationReady,
    fakeVerticalSliceVerified: health.fakeVerticalSliceVerified,
    codexRuntimeReady: health.codexRuntimeReady,
    webRuntimeReady: health.webRuntimeReady,
    liveSessionBindingReady: health.liveSessionBindingReady,
    liveOrchestrationReady: health.liveOrchestrationReady,
  }, {
    coreOrchestrationReady: false,
    fakeVerticalSliceVerified: null,
    codexRuntimeReady: false,
    webRuntimeReady: false,
    liveSessionBindingReady: false,
    liveOrchestrationReady: false,
  });
  assert.equal(Object.hasOwn(health, "orchestrationReady"), false);

  const closed = once(socket, "close");
  socket.close();
  await closed;
});

test("demo mode is transport-free and does not accept extension or dashboard upgrades", async (t) => {
  const bridge = createBridgeServer({ runtimeConfig: runtimeConfig({ demoMode: true }) });
  await bridge.listen();
  t.after(async () => {
    await bridge.close();
  });

  assert.equal(bridge.extensionTransport, null);
  assert.equal(bridge.webSession, null);
  const { port } = bridge.server.address();
  assert.equal(await rejectedStatus(`ws://127.0.0.1:${port}/ws/extension`), 409);
  assert.equal(await rejectedStatus(`ws://127.0.0.1:${port}/ws/dashboard`), 503);
});

test("server boots without optional live credentials and local browser session remains usable", async (t) => {
  const bridge = createBridgeServer({
    runtimeConfig: runtimeConfig({
      dashboardToken: null,
      extensionEnabled: false,
      codexExecutablePath: null,
    }),
  });
  await bridge.listen();
  t.after(async () => {
    await bridge.close();
  });

  assert.equal(bridge.extensionTransport, null);
  assert.equal(bridge.webSession, null);

  const { port } = bridge.server.address();
  const baseHttp = `http://127.0.0.1:${port}`;

  const preflight = await (await fetch(`${baseHttp}/api/preflight`)).json();
  assert.equal(preflight.checks.commandAuthenticationConfigured, true);
  assert.equal(preflight.checks.staticDashboardTokenConfigured, false);
  assert.equal(preflight.checks.extensionConfigured, false);
  assert.equal(preflight.readyForProvisioning, false);

  assert.equal(await rejectedStatus(`ws://127.0.0.1:${port}/ws/extension`), 503);

  const session = await requestLocalBrowserSession(port);
  assert.equal(session.status, 200);
  assert.equal(typeof session.body.token, "string");
  assert.ok(session.body.token.length >= 32);
  assert.equal(session.body.staticTokenConfigured, false);

  const projectResponse = await fetch(`${baseHttp}/api/project`, {
    headers: { authorization: `Bearer ${session.body.token}` },
  });
  assert.equal(projectResponse.status, 200);

  const legacyStart = await fetch(`${baseHttp}/api/runs/start`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.body.token}`,
      origin: "http://127.0.0.1:0",
    },
  });
  assert.equal(legacyStart.status, 410);
});

test("legacy authenticated start cannot bypass preparation approval", async (t) => {
  const calls = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-server-audit-"));
  const auditProjectFile = path.join(directory, "project.json");
  fs.writeFileSync(auditProjectFile, JSON.stringify(project(directory)));
  const receipts = new CodeChangeStore(path.join(directory, "receipts.sqlite"));
  const bridge = createBridgeServer({
    runtimeConfig: runtimeConfig({
      dashboardToken: DASHBOARD_TOKEN,
      codexExecutablePath: "C:\\safe\\codex.exe",
      auditProjectFile,
    }),
    createLiveRuntime: async () => ({
      codeChanges: { store: receipts, get: () => null, busy: () => false,
        async start(input) { calls.push({ type: "code.start", input }); return { runId: "run_live_test", status: "ACCEPTED" }; } },
      store: {
        listRuns: () => [],
        getRun: () => ({ phase: "COMPLETE" }),
        getRunOutcome: () => ({ type: "CONSENSUS" }),
      },
      composition: {
        getRuntimeSessions: () => ({}),
        async dispatchUntilSettled(input) {
          calls.push({ type: "dispatch", input });
        },
        async provisionRun(input) {
          calls.push({ type: "provision", input });
          return {
            run: { runId: "run_live_test", maxTurns: 5 },
            dispatcher: {
              async runUntilSettled(input) {
                calls.push({ type: "dispatch", input });
                return { status: "COMPLETE", outcome: { type: "CONSENSUS" } };
              },
            },
          };
        },
      },
      async close() {},
    }),
  });
  await bridge.listen();
  t.after(async () => {
    for (const client of bridge.extensionWss.clients) client.terminate();
    await bridge.close();
    receipts.close(); fs.rmSync(directory, { recursive: true, force: true });
  });
  const { port } = bridge.server.address();
  const baseHttp = `http://127.0.0.1:${port}`;
  const baseWs = `ws://127.0.0.1:${port}`;

  assert.equal(
    (await fetch(`${baseHttp}/api/runs/start`, { method: "POST" })).status,
    403,
  );

  const socket = new WebSocket(`${baseWs}/ws/extension`);
  const [challengeRaw] = await once(socket, "message");
  const challenge = JSON.parse(String(challengeRaw));
  socket.send(JSON.stringify({
    type: "extension.auth.response",
    protocolVersion: challenge.protocolVersion,
    challengeId: challenge.challengeId,
    extensionIdentity: EXTENSION_IDENTITY,
    hmacSha256: computeWebChallengeHmac(challenge.nonce, SHARED_SECRET),
  }));
  await once(socket, "message");

  const response = await fetch(`${baseHttp}/api/runs/start`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${DASHBOARD_TOKEN}`,
      origin: "http://127.0.0.1:0",
      "content-type": "application/json",
      "x-request-id": "test-start-once",
    },
    body: JSON.stringify({
      objective: "서로에게 짧게 인사해.",
      conversationUrl: "https://chatgpt.com/c/6a9b4c95-f564-83e8-8e92-ab11d6ef2f60",
    }),
  });
  assert.equal(response.status, 410);
  assert.equal((await response.json()).code, "PREPARATION_API_REQUIRED");
  assert.equal(calls.length, 0);
  socket.close();
});
