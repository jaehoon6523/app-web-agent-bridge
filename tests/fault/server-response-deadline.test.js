import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const serverUrl = new URL("../../src/server.js", import.meta.url).href;
const token = "response-deadline-dashboard-token-0123456789";
const responseDeadlineMs = 5000;

async function startServer(t, stalledRuntime = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-response-deadline-"));
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const config = {
    host:"127.0.0.1", port, baseUrl:`http://127.0.0.1:${port}`,
    workspace:root, logDir:root, demoMode:false, auditProjectFile:null,
    dashboard:{ token }, codex:{ executablePath:process.execPath },
    persistence:{ databasePath:path.join(root, "bridge.sqlite"), artifactDirectory:path.join(root, "artifacts") },
    webExtension:{ enabled:true, sharedSecret:"response-deadline-extension-secret-0123456789", expectedExtensionIdentity:"deadline-extension" },
    relay:{ webResponseTimeoutMs:500 },
  };
  // A subprocess keeps the test deadline enforceable even if the server blocks its event loop.
  const script = `
    import { main, createBridgeServer } from ${JSON.stringify(serverUrl)};
    const config = ${JSON.stringify(config)};
    if (${stalledRuntime}) {
      const bridge = createBridgeServer({ runtimeConfig:config, createLiveRuntime:() => new Promise(() => {}) });
      await bridge.listen();
      console.log('DEADLINE_SERVER_LISTENING');
    } else {
      await main(config);
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd:root, env:{ PATH:process.env.PATH, SystemRoot:process.env.SystemRoot }, stdio:["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    fs.rmSync(root, { recursive:true, force:true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not announce listening: ${output}`)), 5000);
    const onData = chunk => {
      output += chunk;
      if (output.includes(stalledRuntime ? "DEADLINE_SERVER_LISTENING" : "Extension integration: configured")) {
        clearTimeout(timer); resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`Server exited before readiness: ${output}`)); });
  });
  return config.baseUrl;
}

async function readResponse(baseUrl, route, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, { headers, signal:AbortSignal.timeout(responseDeadlineMs) });
  // Receiving headers alone is insufficient: the response body must finish too.
  return { status:response.status, body:await response.json() };
}

test("startup: LIVE configured announcement is followed by preflight 200 and unauthenticated state 401 within five seconds", { timeout:15000 }, async t => {
  const baseUrl = await startServer(t);
  const [preflight, state] = await Promise.all([
    readResponse(baseUrl, "/api/preflight"),
    readResponse(baseUrl, "/api/state"),
  ]);
  assert.equal(preflight.status, 200);
  assert.equal(preflight.body.checks.extensionConfigured, true);
  assert.equal(state.status, 401);
});

test("fault: pending runtime initialization must not leave authenticated state unanswered or block concurrent preflight", { timeout:15000 }, async t => {
  const baseUrl = await startServer(t, true);
  const results = await Promise.allSettled([
    readResponse(baseUrl, "/api/state", { authorization:`Bearer ${token}` }),
    readResponse(baseUrl, "/api/preflight"),
  ]);
  assert.equal(results[1].status, "fulfilled", "preflight must respond while runtime initialization remains pending");
  assert.equal(results[1].value.status, 200);
  assert.equal(results[0].status, "fulfilled", "authenticated /api/state must finish within five seconds despite pending runtime initialization");
  const state = results[0].value;
  assert.ok([200, 503].includes(state.status), "bounded degraded response must be HTTP 200 or 503");
  if (state.status === 200) {
    assert.equal(state.body.runtimeAvailability.ready, false);
    assert.equal(state.body.dataKnowledge.runs.status, "UNAVAILABLE");
    assert.equal(state.body.commandCapabilities.includes("preparation.start"), false);
  } else {
    assert.equal(typeof state.body.error, "string");
    assert.ok(state.body.error.length > 0);
  }
});
