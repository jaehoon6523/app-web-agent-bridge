import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { DashboardController } from "../src/orchestration/dashboard-controller.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";
import { CodeChangeStore } from "../src/persistence/code-change-store.js";
import { loadConfig } from "../src/config.js";
import { observeChildClose, waitChildClose } from "../src/runtime/child-close.js";
import { runDiagnosticServer } from "../scripts/diagnose-server.mjs";

function codeRuntime(calls, fail = null) {
  const runs = ["private-first-run", "private-second-run"].map((runId, index) => ({
    runId, objective:"private-objective", targetRoot:"private-workspace-path",
    stage:"CREATED", createdAt:`2026-10-04T10:00:0${index}Z`, events:[],
  }));
  return {
    store:{listRuns:() => { calls.push("discussion-list"); return []; }},
    codeChanges:{
      list:() => { calls.push("code-list"); return runs; },
      snapshot:(id, preflight) => {
        calls.push(id);
        if (fail) throw fail;
        return {run:runs.find(run => run.runId === id), preflight, commandCapabilities:[]};
      },
    },
  };
}

async function project(onDiagnostic, fail = null) {
  const calls = [], live = codeRuntime(calls, fail);
  const controller = new DashboardController({
    getRuntime:() => { calls.push("runtime"); return Promise.resolve(live); },
    preflight:() => { calls.push("preflight"); return {readyForProvisioning:false}; },
    webSession:null, transport:null, onDiagnostic,
  });
  return {controller, calls, state:await controller.snapshot()};
}

test("snapshot diagnostics preserve read order, duplicate selected projection and output even when the sink throws", async () => {
  const reference = await project(undefined), events = [];
  const observed = await project(event => { events.push(event); throw new Error("sink failure"); });
  assert.deepEqual(observed.calls, reference.calls);
  assert.deepEqual(observed.state, reference.state);
  assert.equal(observed.calls.filter(call => call === "private-second-run").length, 2);
  const projections = events.filter(event => event.type === "state.snapshot.code-run.started");
  assert.deepEqual(projections.map(({scope, index, count}) => ({scope, index, count})), [
    {scope:"list", index:0, count:2}, {scope:"list", index:1, count:2},
    {scope:"selected", index:undefined, count:undefined},
  ]);
  for (const start of events.filter(event => event.type.endsWith(".started"))) {
    const done = events.find(event => event.stepId === start.stepId && event.type.endsWith(".completed"));
    assert.ok(done); assert.equal(done.snapshotId, start.snapshotId); assert.ok(done.elapsedMs >= 0);
  }
  assert.doesNotMatch(JSON.stringify(events), /private-first-run|private-second-run|private-objective|private-workspace-path/u);
  await observed.controller.snapshot();
  assert.deepEqual([...new Set(events.map(event => event.snapshotId))], [1, 2]);
});

test("snapshot diagnostics retain the original synchronous failure and do not invent completed stages or later reads", async () => {
  const events = [], cause = Object.assign(new Error("private-error-message"), {code:"CONTROLLED_READ_FAILURE"});
  await assert.rejects(project(event => { events.push(event); throw new Error("sink failure"); }, cause), error => error === cause);
  const start = events.find(event => event.type === "state.snapshot.code-run.started");
  const failed = events.find(event => event.type === "state.snapshot.code-run.failed");
  assert.ok(start); assert.ok(failed); assert.equal(failed.stepId, start.stepId);
  assert.equal(failed.errorCode, "CONTROLLED_READ_FAILURE");
  assert.equal(events.some(event => event.type === "state.snapshot.code-run.completed"), false);
  assert.equal(events.some(event => event.type === "state.snapshot.sort.started"), false);
  assert.doesNotMatch(JSON.stringify(events), /private-error-message/u);
});

test("snapshot runtime rejection remains a degraded result while diagnostics record the failed acquisition", async () => {
  const events = [], controller = new DashboardController({
    getRuntime:async () => { throw Object.assign(new Error("runtime unavailable"), {code:"RUNTIME_UNAVAILABLE"}); },
    preflight:() => ({readyForProvisioning:false}), webSession:null, transport:null,
    onDiagnostic:event => events.push(event),
  });
  const state = await controller.snapshot();
  assert.equal(state.runtimeAvailability.ready, false);
  assert.equal(state.runtimeAvailability.code, "RUNTIME_UNAVAILABLE");
  assert.ok(events.some(event => event.type === "state.snapshot.runtime.failed" && event.errorCode === "RUNTIME_UNAVAILABLE"));
  assert.equal(events.some(event => event.type === "state.snapshot.runtime.completed"), false);
  assert.equal(events.some(event => event.type === "state.snapshot.code-runs.started"), false);
});

test("real controller SQLite contention preserves independent HTTP responses and recovers the same snapshot contract", {timeout:20000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-snapshot-diagnostic-"));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const token = "snapshot-diagnostic-token-0123456789abcdef";
  const runtimeConfig = loadConfig({cwd:root, env:{WORKSPACE:root,CONTROLLER_DATA_DIR:root,PORT:String(port),DASHBOARD_TOKEN:token,
    WEB_EXTENSION_SHARED_SECRET:"snapshot-extension-secret-0123456789abcdef",WEB_EXTENSION_EXPECTED_IDENTITY:"snapshot-extension"}});
  new SqliteStore(runtimeConfig.persistence.databasePath).close();
  new CodeChangeStore(runtimeConfig.persistence.databasePath).close();
  const events = [], changed = new EventEmitter();
  const child = runDiagnosticServer({runtimeConfig, outputFile:path.join(root, "events.jsonl"),
    onEvent:event => { events.push(event); changed.emit("event", event); }});
  const observation = observeChildClose(child);
  let locker, locked = false;
  t.after(async () => {
    if (locked) locker.exec("ROLLBACK");
    locker?.close();
    const result = await waitChildClose(child, observation, {timeoutMs:8000, request:() => {
      if (child.connected) child.send({type:"bridge.shutdown"});
    }});
    assert.deepEqual(result, {code:0,signal:null});
    fs.rmSync(root, {recursive:true,force:true});
  });
  async function until(predicate) {
    const found = events.find(predicate);
    if (found) return found;
    let listener, timer;
    try {
      return await new Promise((resolve, reject) => {
        listener = event => { if (predicate(event)) resolve(event); };
        changed.on("event", listener);
        timer = setTimeout(() => reject(new Error("Missing snapshot diagnostic checkpoint: "+JSON.stringify(
          events.filter(event => event.type.startsWith("state.snapshot.") || event.type.startsWith("watchdog.")).slice(-20)))), 6000);
      });
    } finally { changed.off("event", listener); clearTimeout(timer); }
  }
  await until(event => event.type === "server.listening");
  const read = () => fetch(runtimeConfig.baseUrl+"/api/state?private="+token, {
    headers:{authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(7000),
  });
  locker = new DatabaseSync(runtimeConfig.persistence.databasePath);
  locker.exec("BEGIN IMMEDIATE"); locked = true;
  // WAL permits readers during a write lock. First runtime acquisition really
  // requests a writer transaction; observe that existing wait, without changing
  // journal mode, server deadlines or persistence implementation.
  const pending = read(); pending.catch(() => {});
  const start = await until(event => event.type === "state.snapshot.runtime.started");
  const probes = await Promise.all(["/api/preflight", "/api/health"].map(async route => {
    const response = await fetch(runtimeConfig.baseUrl+route, {signal:AbortSignal.timeout(1000)});
    await response.arrayBuffer();
    return response.status;
  }));
  assert.deepEqual(probes, [200, 200]);
  assert.equal(events.some(event => event.snapshotId === start.snapshotId && event.stepId === start.stepId
    && event.type === "state.snapshot.runtime.completed"), false);
  const response = await pending; assert.equal(response.status, 200);
  const unavailable = await response.json();
  assert.equal(unavailable.runtimeAvailability.ready, false);
  assert.equal(unavailable.dataKnowledge.runs.status, "UNAVAILABLE");
  assert.equal(events.some(event => event.type === "watchdog.unresponsive" && event.requestId === start.requestId), false);
  locker.exec("COMMIT"); locked = false;
  const recovered = await read(); assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).runtimeAvailability.ready, true);
  const completed = await until(event => event.type === "state.snapshot.runtime.completed" && event.snapshotId > start.snapshotId);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "events.jsonl"), "utf8"), new RegExp(token));
  t.diagnostic(JSON.stringify({snapshot:start, independentHttp:probes, unavailable:unavailable.runtimeAvailability, completed}));
});
