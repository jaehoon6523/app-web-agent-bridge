import assert from "node:assert/strict";
import test from "node:test";
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
import { seedHistory } from "../helpers/code-history-fixture.js";
import { canonicalJson, sha256CanonicalJson } from "../../src/domain/canonical-json.js";

async function serverFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-history-http-"));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const token = "history-contract-token-0123456789abcdef";
  const config = loadConfig({cwd:root, env:{WORKSPACE:root,CONTROLLER_DATA_DIR:root,PORT:String(port),DASHBOARD_TOKEN:token,
    WEB_EXTENSION_SHARED_SECRET:"history-extension-secret-0123456789abcdef", WEB_EXTENSION_EXPECTED_IDENTITY:"history-extension"}});
  new SqliteStore(config.persistence.databasePath).close();
  const {record} = seedHistory(config.persistence.databasePath, {versions:1000, eventBytes:1024});
  const events = [], changed = new EventEmitter();
  const child = runDiagnosticServer({runtimeConfig:config, outputFile:path.join(root, "events.jsonl"),
    onEvent:event => { events.push(event); changed.emit("event", event); }});
  const observation = observeChildClose(child);
  let stopped;
  const stop = () => stopped ??= waitChildClose(child, observation, {timeoutMs:8000, request:() => {
    if (child.connected) child.send({type:"bridge.shutdown"});
  }});
  t.after(async () => {
    try { assert.deepEqual(await stop(), {code:0,signal:null}); }
    finally { fs.rmSync(root, {recursive:true,force:true}); }
  });
  async function until(predicate, after = 0) {
    const found = events.slice(after).find(predicate);
    if (found) return found;
    let listener, timer;
    try {
      return await new Promise((resolve, reject) => {
        listener = event => { if (predicate(event)) resolve(event); };
        changed.on("event", listener);
        timer = setTimeout(() => reject(new Error("Missing history checkpoint "+predicate.toString()+": "+JSON.stringify(
          events.slice(after).filter(event => /history|runtime|snapshot/u.test(event.type)).slice(-20)))), 12000);
      });
    } finally { changed.off("event", listener); clearTimeout(timer); }
  }
  await until(event => event.type === "server.listening");
  const read = () => fetch(config.baseUrl+"/api/state", {headers:{authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(5000)});
  return {config, record, events, until, read, stop};
}

test("cold and invalidated real history verification keep independent HTTP responsive and preserve the durable projection", {timeout:45000}, async t => {
  const server = await serverFixture(t), phases = [];
  let expected = server.record;
  for (const phase of ["cold", "external append"]) {
    const checkpoint = server.events.length;
    if (phase === "external append") {
      const writer = new DatabaseSync(server.config.persistence.databasePath);
      try {
        expected = {...expected, version:expected.version+1};
        const json = canonicalJson(expected), hash = sha256CanonicalJson(expected);
        const previousHash = writer.prepare("SELECT entry_hash FROM code_change_history ORDER BY version DESC LIMIT 1").get().entry_hash;
        const headHash = sha256CanonicalJson({kind:"CODE_CHANGE_HISTORY",runId:expected.runId,version:expected.version,recordHash:hash,previousHash});
        writer.exec("BEGIN IMMEDIATE");
        writer.prepare("UPDATE code_change_runs SET version=?,record_json=?,record_hash=? WHERE run_id=?").run(expected.version,json,hash,expected.runId);
        writer.prepare("INSERT INTO code_change_history VALUES (?,?,?,?,?,?)").run(expected.runId,expected.version,json,hash,previousHash,headHash);
        writer.exec("COMMIT");
      }
      finally { writer.close(); }
    }
    const pending = server.read(); pending.catch(() => {});
    await server.until(event => event.type === "persistence.code-store.history-background.progress", checkpoint);
    const probes = await Promise.all(["/api/health", "/api/preflight"].map(async route => {
      const started = performance.now();
      const response = await fetch(server.config.baseUrl+route, {signal:AbortSignal.timeout(1000)});
      await response.arrayBuffer();
      assert.equal(response.status, 200);
      return {route,status:response.status,elapsedMs:performance.now()-started};
    }));
    assert.equal(server.events.slice(checkpoint).some(event => event.type === "persistence.code-store.history-background.completed"), false,
      "Probes must actually overlap history verification.");
    const response = await pending; assert.equal(response.status, 200);
    const first = await response.json();
    if (!first.runtimeAvailability.ready) {
      assert.equal(first.dataKnowledge.runs.status, "UNAVAILABLE");
      assert.equal(first.runtimeAvailability.code, "LIVE_RUNTIME_READ_TIMEOUT");
    }
    const completed = await server.until(event => event.type === "persistence.code-store.history-background.completed", checkpoint);
    const ready = await server.read(); assert.equal(ready.status, 200);
    const state = await ready.json();
    assert.equal(state.runtimeAvailability.ready, true);
    assert.equal(state.runs[0].runId, server.record.runId);
    assert.equal(state.run.version, expected.version);
    assert.equal(state.run.stage, expected.stage);
    assert.equal(server.events.slice(checkpoint).some(event => event.type === "watchdog.unresponsive"), false);
    phases.push({phase,probes,verificationMs:completed.elapsedMs,firstAvailability:first.runtimeAvailability});
  }
  assert.equal(server.events.filter(event => event.type === "persistence.code-store.history-background.completed").length, 2,
    "Recovery and subsequent snapshots must reuse the verified generation.");
  t.diagnostic(JSON.stringify({node:process.version,platform:process.platform,phases}));
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
