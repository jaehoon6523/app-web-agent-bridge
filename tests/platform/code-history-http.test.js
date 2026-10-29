import assert from "node:assert/strict";
import {evidenceTestFile,evidenceFetch} from "../helpers/failure-evidence.mjs";
const test = evidenceTestFile(import.meta.url);
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../../src/config.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { observeChildClose, waitChildClose } from "../../src/runtime/child-close.js";
import { runDiagnosticServer } from "../../scripts/diagnose-server.mjs";
import { seedHistory, appendHistory } from "../helpers/code-history-fixture.js";
import { removeOwnedFixture } from "../../scripts/e2e/helpers/owned-fixture.mjs";

async function serverFixture(t, {corrupt = false} = {}) {
  const fixtureStarted=performance.now(), timing={phases:[]};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-history-http-"));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const token = "history-contract-token-0123456789abcdef";
  const config = loadConfig({cwd:root, env:{WORKSPACE:root,CONTROLLER_DATA_DIR:root,PORT:String(port),DASHBOARD_TOKEN:token,
    WEB_EXTENSION_SHARED_SECRET:"history-extension-secret-0123456789abcdef", WEB_EXTENSION_EXPECTED_IDENTITY:"history-extension"}});
  new SqliteStore(config.persistence.databasePath).close();
  const seedStarted=performance.now();
  const {record} = seedHistory(config.persistence.databasePath, corrupt ? {versions:8} : {versions:1000, eventBytes:1024});
  timing.seedMs=performance.now()-seedStarted;
  if (corrupt) {
    const writer = new DatabaseSync(config.persistence.databasePath);
    try { writer.exec("UPDATE code_change_history SET record_json='{broken' WHERE version=1"); }
    finally { writer.close(); }
  }
  const events = [], changed = new EventEmitter();
  const child = runDiagnosticServer({runtimeConfig:config, outputFile:path.join(root, "events.jsonl"),recordHeartbeats:true,
    onEvent:event => { events.push(event);t.evidence.event(event);changed.emit("event", event); }});
  const observation = observeChildClose(child);
  let stopped, pendingAppend;
  const stop = () => stopped ??= waitChildClose(child, observation, {timeoutMs:8000, request:() => {
    if (child.connected) child.send({type:"bridge.shutdown"});
  }}).then(async closure => { await child.diagnosticsClosed; return closure; });
  t.after(async () => {
    const closeStarted=performance.now();
    const errors=[];
    let resourcesClosed=false;
    try {
      // Abort cancels fixture work too. Observe its worker exit before removing
      // the database, including when node:test has already ended the test body.
      await pendingAppend?.catch(() => {});
      const closure=await stop();resourcesClosed=true;
      assert.deepEqual(closure, {code:0,signal:null});
    } catch(error) {errors.push(error);}
    try {
      timing.closeMs=performance.now()-closeStarted;
      timing.totalMs=performance.now()-fixtureStarted;
      t.diagnostic(JSON.stringify({node:process.version,platform:process.platform,timing,
        watchdog:events.filter(event=>/^(?:watchdog\.|event-loop\.delay)/u.test(event.type))
          .map(({type,at,silenceMs,loopDelayMs,lastStage,route})=>({type,at,silenceMs,loopDelayMs,lastStage,route})),
        lastCheckpoints:events.filter(event=>/history|runtime.initialization/u.test(event.type)).slice(-12)
          .map(({type,elapsedMs,errorCode})=>({type,elapsedMs,errorCode}))}));
      t.evidence.preserve(root);t.evidence.copy(path.join(root,"events.jsonl"),"server-events.jsonl");
    } catch(error) {errors.push(error);}
    if(resourcesClosed)try {await removeOwnedFixture(root);} catch(error) {errors.push(error);}
    if(errors.length===1)throw errors[0];
    if(errors.length)throw new AggregateError(errors,errors.map(error=>`${error.code??error.name}: ${error.message}`).join('\n'),{cause:errors[0]});
  });
  async function until(predicate, after = 0, timeoutMs = 12000) {
    const found = events.slice(after).find(predicate);
    if (found) return found;
    let listener, timer;
    try {
      return await new Promise((resolve, reject) => {
        listener = event => { if (predicate(event)) resolve(event); };
        changed.on("event", listener);
        timer = setTimeout(() => reject(new Error("Missing history checkpoint "+predicate.toString()+": "+JSON.stringify(
          events.slice(after).filter(event => /history|runtime|snapshot/u.test(event.type)).slice(-20)))), timeoutMs);
      });
    } finally { changed.off("event", listener); clearTimeout(timer); }
  }
  await until(event => event.type === "server.listening");
  timing.fixtureMs=performance.now()-fixtureStarted;
  const read = () => evidenceFetch(t.evidence,config.baseUrl+"/api/state", {headers:{authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(5000)});
  const append = record => pendingAppend = appendHistory(config.persistence.databasePath,record,{signal:t.signal});
  return {config, record, events, until, read, stop, timing, append};
}

// Windows took 43.23s including the real cumulative-history fixture under a 45s
// harness cap. Allow fixture cost without relaxing HTTP/checkpoint/product deadlines.
test("cold and invalidated real history verification keep independent HTTP responsive and preserve the durable projection", {timeout:90000}, async t => {
  const server = await serverFixture(t), phases = [];
  let expected = server.record;
  for (const phase of ["cold", "external append"]) {
    const phaseStarted=performance.now();
    const phaseTiming={phase,stage:'starting'}; server.timing.phases.push(phaseTiming);
    const checkpoint = server.events.length;
    if (phase === "external append") {
      expected = {...expected, version:expected.version+1};
      await server.append(expected);
    }
    const pending = server.read(); pending.catch(() => {});
    phaseTiming.stage='waiting for progress';
    await server.until(event => event.type === "persistence.code-store.history-background.progress", checkpoint);
    phaseTiming.progressMs=performance.now()-phaseStarted;
    phaseTiming.stage='independent HTTP probes';
    const probes = await Promise.all(["/api/health", "/api/preflight"].map(async route => {
      const started = performance.now();
      const response = await evidenceFetch(t.evidence,server.config.baseUrl+route, {signal:AbortSignal.timeout(1000)});
      await response.arrayBuffer();
      assert.equal(response.status, 200);
      return {route,status:response.status,elapsedMs:performance.now()-started};
    }));
    assert.equal(server.events.slice(checkpoint).some(event => event.type === "persistence.code-store.history-background.completed"), false,
      "Probes must actually overlap history verification.");
    phaseTiming.stage='state response';
    const response = await pending; assert.equal(response.status, 200);
    const first = await response.json();
    if (!first.runtimeAvailability.ready) {
      assert.equal(first.dataKnowledge.runs.status, "UNAVAILABLE");
      assert.equal(first.runtimeAvailability.code, "LIVE_RUNTIME_READ_TIMEOUT");
    }
    phaseTiming.stage='waiting for verification completion';
    // History verification has a 60s production budget; keep short waits for other checkpoints.
    const completed = await server.until(event => event.type === "persistence.code-store.history-background.completed", checkpoint, 60000);
    const ready = await server.read(); assert.equal(ready.status, 200);
    const state = await ready.json();
    assert.equal(state.runtimeAvailability.ready, true);
    assert.equal(state.runs[0].runId, server.record.runId);
    assert.equal(state.run.version, expected.version);
    assert.equal(state.run.stage, expected.stage);
    assert.equal(server.events.slice(checkpoint).some(event => event.type === "watchdog.unresponsive"
      && event.lastStage !== "process.starting"), false,
    "History verification must not stall the server after startup.");
    Object.assign(phaseTiming,{stage:'completed',elapsedMs:performance.now()-phaseStarted,verificationMs:completed.elapsedMs});
    phases.push({phase,probes,verificationMs:completed.elapsedMs,firstAvailability:first.runtimeAvailability});
  }
  assert.equal(server.events.filter(event => event.type === "persistence.code-store.history-background.completed").length, 2,
    "Recovery and subsequent snapshots must reuse the verified generation.");
  t.diagnostic(JSON.stringify({node:process.version,platform:process.platform,phases}));
});

test("first-row corruption before progress produces unavailable knowledge while health and natural shutdown remain available", {timeout:15000}, async t => {
  const server = await serverFixture(t, {corrupt:true});
  const response = await server.read();
  assert.equal(response.status,200);
  const state=await response.json();
  assert.equal(state.runtimeAvailability.ready,false);
  assert.equal(state.dataKnowledge.runs.status,"UNAVAILABLE");
  assert.equal(server.events.some(event=>event.type==='persistence.code-store.history-background.progress'),false);
  assert.equal(server.events.some(event=>event.type==='persistence.code-store.history-background.completed'),false);
  for(const route of ['/api/health','/api/preflight']) {
    const probe=await evidenceFetch(t.evidence,server.config.baseUrl+route,{signal:AbortSignal.timeout(1000)});
    assert.equal(probe.status,200); await probe.arrayBuffer();
  }
  assert.deepEqual(await server.stop(),{code:0,signal:null});
  assert.equal(server.events.some(event=>event.type==='shutdown.stage.error' || event.type==='shutdown.deadline'),false);
});

test("production shutdown during real history verification cancels the worker and closes every database handle", {timeout:30000}, async t => {
  const server = await serverFixture(t);
  const pending = server.read(); pending.catch(() => {});
  await server.until(event => event.type === "persistence.code-store.history-background.progress");
  const started = performance.now();
  assert.deepEqual(await server.stop(), {code:0,signal:null});
  assert.ok(server.events.some(event => event.type === "persistence.code-store.history-background.failed" && event.errorCode === "SERVER_CLOSING"));
  assert.equal(server.events.some(event => event.type === "shutdown.stage.error" || event.type === "shutdown.deadline"), false);
  fs.unlinkSync(server.config.persistence.databasePath);
  t.diagnostic(JSON.stringify({shutdownMs:performance.now()-started,naturalExit:true,deletedImmediately:true}));
});
