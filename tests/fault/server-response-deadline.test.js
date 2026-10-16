import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {evidenceTestFile,evidenceFetch} from "../helpers/failure-evidence.mjs";
const test = evidenceTestFile(import.meta.url);
import { DashboardController } from "../../src/orchestration/dashboard-controller.js";

const serverUrl = new URL("../../src/server.js", import.meta.url).href;
const token = "response-deadline-dashboard-token-0123456789";
const responseDeadlineMs = 5000;

async function startServer(t, stalledRuntime = false, readTimeoutEnv = null, events = []) {
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
    import {performance} from 'node:perf_hooks';
    let previous=performance.now();setInterval(()=>{const now=performance.now();if(process.connected)process.send({type:'heartbeat',at:new Date().toISOString(),monotonicMs:performance.timeOrigin+now,loopDelayMs:Math.max(0,now-previous-100)},()=>{});previous=now},100).unref();
    const config = ${JSON.stringify(config)};
    const readTimeoutEnv = ${JSON.stringify(readTimeoutEnv)};
    if (readTimeoutEnv !== null) {
      const { loadConfig } = await import(${JSON.stringify(new URL("../../src/config.js", import.meta.url).href)});
      config.dashboard.runtimeReadTimeoutMs = loadConfig({ env:{ DASHBOARD_RUNTIME_READ_TIMEOUT_MS:readTimeoutEnv } }).dashboard.runtimeReadTimeoutMs;
    }
    if (${stalledRuntime}) {
      const bridge = createBridgeServer({ runtimeConfig:config, createLiveRuntime:() => new Promise(() => {}),
        onDiagnostic:event=>{if(process.connected)process.send(event);if(/^(?:preparation|runtime)\\.initialization\\.|^state\\.|^request\\./u.test(event.type))
          console.error('FAULT_STAGE '+JSON.stringify({type:event.type,at:event.at,route:event.route,elapsedMs:event.elapsedMs,code:event.code}));} });
      await bridge.listen();
      console.log('DEADLINE_SERVER_LISTENING');
    } else {
      await main(config,{onDiagnostic:event=>{if(process.connected)process.send(event,()=>{});}});
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd:root, env:{ PATH:process.env.PATH, SystemRoot:process.env.SystemRoot }, stdio:["ignore", "pipe", "pipe", "ipc"],
  });
  child.on('message', event => {events.push(event);t.evidence.event(event);});
  let output = "";
  const exited = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => {
    t.diagnostic(JSON.stringify({stalledRuntime,readTimeoutEnv,
      stages:output.split(/\r?\n/u).filter(line=>line.startsWith("FAULT_STAGE ")).slice(-25)}));
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    t.evidence.preserve(root);
    fs.writeFileSync(path.join(t.evidence.directory,"server-output.log"),output);
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
  return {baseUrl:config.baseUrl,evidence:t.evidence};
}

async function readResponse(server, route, headers = {}) {
  const {baseUrl,evidence} = server;
  const response = await evidenceFetch.bind(null,evidence)(`${baseUrl}${route}`, { headers, signal:AbortSignal.timeout(responseDeadlineMs) });
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
    assert.equal(state.body.runtimeAvailability.code, "LIVE_RUNTIME_READ_TIMEOUT");
    assert.equal(state.body.dataKnowledge.runs.status, "UNAVAILABLE");
    assert.equal(state.body.commandCapabilities.includes("preparation.start"), false);
  } else {
    assert.equal(typeof state.body.error, "string");
    assert.ok(state.body.error.length > 0);
  }
});


test("runtime read deadline preserves initialization and a later snapshot observes its completion", { timeout:10000 }, async () => {
  let finishInitialization;
  const pending = new Promise(resolve => { finishInitialization = resolve; });
  const controller = new DashboardController({ getRuntime:() => pending, preflight:() => ({}), runtimeReadTimeoutMs:25 });
  const degraded = await controller.snapshot();
  assert.equal(degraded.runtimeAvailability.code, "LIVE_RUNTIME_READ_TIMEOUT");
  assert.equal(degraded.dataKnowledge.runs.status, "UNAVAILABLE");
  finishInitialization({ store:{ listRuns:() => [] }, composition:{} });
  const recovered = await controller.snapshot();
  assert.equal(recovered.runtimeAvailability.ready, true);
  assert.equal(recovered.dataKnowledge.runs.status, "AVAILABLE_EMPTY");
});


for (const readBudgetMs of [100, 700]) test(`configuration: parsed ${readBudgetMs}ms read budget reaches the HTTP snapshot`, { timeout:10000 }, async t => {
  const events = [];
  const baseUrl = await startServer(t, true, String(readBudgetMs), events);
  const started = performance.now();
  let response;
  try { response = await evidenceFetch(baseUrl.evidence,`${baseUrl.baseUrl}/api/state`, {
    headers:{authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(responseDeadlineMs),
  }); }
  finally { t.diagnostic(JSON.stringify({stateFetchElapsedMs:performance.now()-started,deadlineMs:responseDeadlineMs})); }
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.runtimeAvailability.code, "LIVE_RUNTIME_READ_TIMEOUT");
  assert.equal(body.dataKnowledge.runs.status, "UNAVAILABLE");
  assert.equal(body.commandCapabilities.includes("preparation.start"), false);
  const observationDeadline = performance.now() + 1000;
  while (!events.some(event => event.type === 'state.snapshot.runtime.failed') && performance.now() < observationDeadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  const timedRead = events.find(event => event.type === 'state.snapshot.runtime.failed');
  assert.equal(timedRead?.errorCode, 'LIVE_RUNTIME_READ_TIMEOUT');
  // Measure only the runtime read, excluding server startup and projection.
  assert.ok(timedRead.elapsedMs >= readBudgetMs - 25, 'the configured read must not expire early');
  assert.ok(timedRead.elapsedMs < readBudgetMs + 500, 'ignoring the configured read budget must fail');
});

test("configuration: maximum allowed read budget still returns degraded state inside the five-second HTTP deadline", { timeout:15000 }, async t => {
  const baseUrl = await startServer(t, true, "4000");
  const response = await readResponse(baseUrl, "/api/state", {authorization:`Bearer ${token}`});
  assert.equal(response.status,200);
  assert.equal(response.body.runtimeAvailability.code,"LIVE_RUNTIME_READ_TIMEOUT");
  assert.equal(response.body.dataKnowledge.runs.status,"UNAVAILABLE");
});
