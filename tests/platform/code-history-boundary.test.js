import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CodeChangeStore } from "../../src/persistence/code-change-store.js";
import { seedHistory } from "../helpers/code-history-fixture.js";
import { resources } from "../../scripts/e2e/helpers/resources.mjs";
import { loadConfig } from "../../src/config.js";
import { createLiveDiscussionRuntime } from "../../src/runtime/live-discussion-runtime.js";

function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-history-boundary-"));
  const owner = resources(t);
  owner.add("workspace", () => fs.rmSync(root, {recursive:true, force:true}), 30);
  const filename = path.join(root, "state.sqlite");
  const seeded = seedHistory(filename, options);
  const open = (options = {}) => {
    const store = new CodeChangeStore(filename, options);
    owner.add("store", () => store.close(), 20);
    return store;
  };
  return {root, filename, open, ...seeded};
}

test("TEMP history cannot replace the history validated on the worker's main connection", async t => {
  const {open, record} = fixture(t);
  const store = open({verification:"background"});
  store.database.exec("CREATE TEMP TABLE code_change_history AS SELECT * FROM main.code_change_history");
  const forged = {...record, objective:"never verified"};
  store.database.prepare("UPDATE temp.code_change_history SET record_json=? WHERE version=?").run(JSON.stringify(forged), record.version);
  await store.prepareForRead();
  assert.deepEqual(store.history(record.runId).at(-1), record);
  const saved = store.save({...record, objective:"real append"}, record.version);
  const durable = new DatabaseSync(store.filename);
  try {
    assert.equal(durable.prepare("SELECT count(*) AS n FROM main.code_change_history").get().n, saved.version);
    assert.deepEqual(JSON.parse(durable.prepare("SELECT record_json FROM main.code_change_runs").get().record_json), saved);
  } finally { durable.close(); }
});

test("a relative database filename remains bound to its opened file after cwd changes", async t => {
  const {root, filename, record} = fixture(t);
  const other = path.join(root, "other"); fs.mkdirSync(other);
  seedHistory(path.join(other, "state.sqlite"));
  const db = new DatabaseSync(path.join(other, "state.sqlite"));
  try { db.exec("UPDATE code_change_history SET entry_hash='corrupt' WHERE version=1"); }
  finally { db.close(); }
  const moduleUrl = new URL("../../src/persistence/code-change-store.js", import.meta.url).href;
  const source = `import assert from 'node:assert/strict'; import {CodeChangeStore} from ${JSON.stringify(moduleUrl)};
    process.chdir(${JSON.stringify(root)}); const store = new CodeChangeStore('state.sqlite',{verification:'background'});
    try { process.chdir(${JSON.stringify(other)}); await store.prepareForRead(); assert.equal(store.get(${JSON.stringify(record.runId)}).version,${record.version}); }
    finally { await store.close(); }`;
  const script = path.join(root, "cwd.mjs"); fs.writeFileSync(script, source);
  await promisify(execFile)(process.execPath, [script], {timeout:10000});
  assert.ok(fs.existsSync(filename));
});

for (const verification of ["synchronous", "background"]) {
  test(`${verification}: migration UPDATE trigger corruption rolls back every migrated row`, async t => {
    const {filename, record} = fixture(t, {legacy:true});
    const db = new DatabaseSync(filename);
    try { db.exec("CREATE TRIGGER damage_migration AFTER UPDATE OF entry_hash ON code_change_history BEGIN UPDATE code_change_history SET record_hash='corrupt' WHERE version=1; END"); }
    finally { db.close(); }
    if (verification === "synchronous") assert.throws(() => new CodeChangeStore(filename), /integrity/);
    else {
      const store = new CodeChangeStore(filename, {verification});
      try { await assert.rejects(store.prepareForRead(), /integrity/); }
      finally { await store.close(); }
    }
    const reopened = new DatabaseSync(filename);
    try {
      assert.equal(reopened.prepare("SELECT count(*) AS n FROM code_change_history WHERE entry_hash IS NOT NULL OR previous_hash IS NOT NULL").get().n, 0);
      assert.equal(reopened.prepare("SELECT count(*) AS n FROM code_change_history WHERE record_hash='corrupt'").get().n, 0);
      assert.equal(reopened.prepare("SELECT version FROM code_change_runs").get().version, record.version);
    } finally { reopened.close(); }
  });
}

test("a rejected append cannot supply the version or previous hash of the next successful append", async t => {
  const {open, record, headHash} = fixture(t);
  const store = open({verification:"background"});
  store.database.exec("CREATE TRIGGER reject_append BEFORE INSERT ON code_change_history BEGIN SELECT RAISE(ABORT,'rejected append'); END");
  await store.prepareForRead();
  assert.throws(() => store.save(record, record.version), /rejected append/);
  store.database.exec("DROP TRIGGER reject_append");
  await store.prepareForRead();
  const saved = store.save({...record, objective:"after rejection"}, record.version);
  assert.equal(saved.version, record.version+1);
  assert.equal(store.historyProof(record.runId).entries.at(-1).previousHash, headHash);
  const reopened = new CodeChangeStore(store.filename);
  try { assert.deepEqual(reopened.history(record.runId).at(-1), saved); }
  finally { reopened.close(); }
});

test("a middle deletion failure rolls back current, history and both receipt formats before retry", async t => {
  const {open, record} = fixture(t);
  const store = open({verification:"background"});
  await store.prepareForRead();
  store.beginCommand("new", "hash", record.runId); store.finishCommand("new", {payload:{runId:record.runId}});
  store.beginCommand("legacy", "hash"); store.finishCommand("legacy", {payload:{runId:record.runId}});
  store.database.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON code_change_runs BEGIN SELECT RAISE(ABORT,'rejected delete'); END");
  await store.prepareForRead();
  assert.throws(() => store.deleteFinished(record.runId, record.version), /rejected delete/);
  const durable = new DatabaseSync(store.filename);
  try {
    assert.equal(durable.prepare("SELECT count(*) AS n FROM code_change_history").get().n, record.version);
    assert.equal(durable.prepare("SELECT count(*) AS n FROM code_change_runs").get().n, 1);
    assert.equal(durable.prepare("SELECT count(*) AS n FROM audit_command_receipts WHERE status='COMPLETED'").get().n, 2);
  } finally { durable.close(); }
  store.database.exec("DROP TRIGGER reject_delete");
  await store.prepareForRead();
  assert.equal(store.deleteFinished(record.runId, record.version), true);
  assert.deepEqual(store.list(), []);
  assert.equal(store.receipt("new"), undefined); assert.equal(store.receipt("legacy"), undefined);
});

test("primary append failure survives a cleanup exception and cleanup still rolls back the real DB", async t => {
  const {open, record} = fixture(t);
  const store = open({verification:"background"});
  store.database.exec("CREATE TRIGGER reject_append BEFORE INSERT ON code_change_history BEGIN SELECT RAISE(ABORT,'primary append failure'); END");
  await store.prepareForRead();
  const original = store.database.exec.bind(store.database);
  const cleanup = new Error("controlled rollback boundary failure");
  store.database.exec = sql => { const result = original(sql); if (sql === "ROLLBACK") throw cleanup; return result; };
  let failure;
  try { store.save(record, record.version); } catch (error) { failure = error; }
  finally { store.database.exec = original; }
  assert.ok(failure instanceof AggregateError);
  assert.match(failure.errors[0].message, /primary append failure/);
  assert.equal(failure.errors[1], cleanup);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM code_change_history").get().n, record.version);
  store.database.exec("DROP TRIGGER reject_append");
  await store.prepareForRead();
  assert.equal(store.save(record, record.version).version, record.version+1);
});

test("whole chain agrees with literal canonical bytes and independently calculated SHA-256", async t => {
  const {open, record} = fixture(t, {versions:1});
  const store = open();
  const vectors = [
    '{"events":[{"detail":"한글","items":[3,1,2]}],"objective":"첫째","runId":"golden","stage":"CANCELLED","version":1}',
    '{"events":[{"detail":"한글","items":[3,1,2]}],"objective":"둘째","runId":"golden","stage":"CANCELLED","version":2}',
  ];
  const sha = bytes => "sha256:"+createHash("sha256").update(bytes, "utf8").digest("hex");
  let previous = null;
  store.database.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < vectors.length; i++) {
    const version=i+1, hash=sha(vectors[i]);
    const literal=`{"kind":"CODE_CHANGE_HISTORY","previousHash":${JSON.stringify(previous)},"recordHash":"${hash}","runId":"golden","version":${version}}`;
    const head=sha(literal);
    store.database.prepare("INSERT INTO code_change_history VALUES (?,?,?,?,?,?)").run("golden",version,vectors[i],hash,previous,head);
    previous=head;
  }
  store.database.prepare("INSERT INTO code_change_runs VALUES (?,?,?,?)").run("golden",2,vectors[1],sha(vectors[1]));
  store.database.exec("COMMIT");
  await store.prepareForRead();
  const proof=store.historyProof("golden");
  assert.equal(proof.entries.at(-1).entryHash, previous);
  assert.deepEqual(store.history("golden"), vectors.map(bytes=>JSON.parse(bytes)));
  assert.equal(store.historyProof(record.runId).version, 1);
  const rows=store.database.prepare("SELECT record_json,record_hash FROM code_change_history WHERE run_id='golden' ORDER BY version").all();
  assert.deepEqual(rows.map(row=>row.record_json),vectors);
  assert.deepEqual(rows.map(row=>row.record_hash),vectors.map(sha));
});

test("close during migration writer contention waits for pending prepare and never starts another job", {timeout:10000}, async t => {
  const {filename, open} = fixture(t, {legacy:true});
  const writer = new DatabaseSync(filename);
  resources(t).add("migration writer",()=>writer.close(),20);
  let reached, close;
  const retry = new Promise(resolve=>{reached=resolve;});
  const store = open({verification:"background",onDiagnostic:event=>{
    if(event.type==='persistence.code-store.history-background.busy-retry' && !close) {
      close=Promise.resolve(store.close()); reached();
    }
  }});
  writer.exec("BEGIN IMMEDIATE");
  let settled=false;
  const pending=store.prepareForRead();
  pending.finally(()=>{settled=true;}).catch(()=>{});
  await Promise.race([retry,pending.then(()=>{throw new Error('prepare completed without writer contention');})]);
  await close;
  assert.equal(settled,true,'closure must include the prepare retry waiter, not just an already-exited Job');
  await assert.rejects(pending,{code:'CODE_CHANGE_STORE_CLOSED'});
  assert.throws(()=>store.prepareForRead(),{code:'CODE_CHANGE_STORE_CLOSED'});
  await store.close();
  writer.exec("ROLLBACK");
});

test("migration SQLITE_BUSY retries after the writer releases and adopts only the final read proof", {timeout:10000}, async t => {
  const {filename, open, record, headHash} = fixture(t, {legacy:true});
  const writer = new DatabaseSync(filename);
  resources(t).add("migration writer",()=>writer.close(),20);
  let released=false;
  const store=open({verification:"background",onDiagnostic:event=>{
    if(event.type==='persistence.code-store.history-background.busy-retry' && !released) {
      writer.exec("ROLLBACK"); released=true;
    }
  }});
  writer.exec("BEGIN IMMEDIATE");
  await store.prepareForRead();
  assert.equal(released,true,'the lock must cause a real SQLITE_BUSY before release');
  assert.deepEqual(store.get(record.runId),record);
  assert.equal(store.historyProof(record.runId).entries.at(-1).entryHash,headHash);
});

test("external corruption at the production list read boundary cannot return a previously verified record", async t => {
  const {filename, open} = fixture(t);
  let armed=false, changed=false;
  const store=open({verification:"background",onDiagnostic:event=>{
    if(armed && event.type==='persistence.code-store.list-read.started') {
      const writer=new DatabaseSync(filename);
      try {writer.exec("UPDATE code_change_history SET entry_hash='corrupt' WHERE version=1");changed=true;}
      finally {writer.close();}
    }
  }});
  await store.prepareForRead(); armed=true;
  assert.throws(()=>store.list(),{code:'CODE_CHANGE_HISTORY_UNVERIFIED'});
  assert.equal(changed,true);
  await assert.rejects(store.prepareForRead(),/integrity/);
});

test("live initialization preserves integrity failure and both real handle close failures", async t => {
  const {root,filename}=fixture(t);
  const writer=new DatabaseSync(filename);
  try {writer.exec("UPDATE code_change_history SET entry_hash='corrupt' WHERE version=1");}
  finally {writer.close();}
  const base=loadConfig({cwd:root,env:{CONTROLLER_DATA_DIR:root}});
  const config={...base,persistence:{...base.persistence,databasePath:filename}};
  const nativeClose=DatabaseSync.prototype.close;
  const cleanup=[new Error('controlled code-store close boundary'),new Error('controlled controller-store close boundary')];
  let closed=0,failure;
  // Actual handles are closed first. Inject reporting failures at their real
  // owner boundary; this is not a claim that the OS produced native close errors.
  DatabaseSync.prototype.close=function(){nativeClose.call(this);const error=cleanup[closed++];if(error)throw error;};
  try {await createLiveDiscussionRuntime({runtimeConfig:config,webSession:{start:async()=>{}}});}
  catch(error){failure=error;}
  finally {DatabaseSync.prototype.close=nativeClose;}
  assert.equal(closed,2);
  assert.ok(failure instanceof AggregateError);
  assert.match(failure.errors[0].message,/integrity/);
  assert.equal(failure.errors[1],cleanup[0]);
  assert.equal(failure.errors[2],cleanup[1]);
  fs.unlinkSync(filename);
});

async function controlledJob(t, source) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"bridge-history-job-"));
  resources(t).add("job workspace",()=>fs.rmSync(root,{recursive:true,force:true}),30);
  // Copy the unchanged production Job bytes; only its actual Worker dependency
  // is a controlled process. This proves the Job boundary, not a live verifier.
  fs.copyFileSync(new URL("../../src/persistence/code-change-history-job.js",import.meta.url),path.join(root,"job.mjs"));
  fs.writeFileSync(path.join(root,"package.json"),'{"type":"module"}');
  fs.writeFileSync(path.join(root,"code-change-history-worker.js"),source);
  const {CodeChangeHistoryJob}=await import(pathToFileURL(path.join(root,"job.mjs")));
  const job=new CodeChangeHistoryJob("controlled.sqlite");
  resources(t).add("real worker",async()=>{job.cancel();try{await job.closed;}catch{ /* Expected fault is asserted by the test. */ }},20);
  return job;
}

for (const [label,source] of [
  ["nonzero exit", "process.exitCode=7"],
  ["worker error", "throw new Error('controlled worker failure')"],
  ["resultless normal exit", "process.exitCode=0"],
]) {
  test(`Job rejects ${label} without adopting a proof`, {timeout:10000}, async t=>{
    const job=await controlledJob(t,source);
    await assert.rejects(job.result,{code:"CODE_CHANGE_HISTORY_WORKER_EXIT"});
    if(label==='resultless normal exit')await job.closed;
    else await assert.rejects(job.closed,{code:"CODE_CHANGE_HISTORY_WORKER_EXIT"});
    assert.equal(job.exited,true);
  });
}

test("forced worker cleanup preserves the cancellation cause and never reports normal close", {timeout:10000},async t=>{
  const job=await controlledJob(t,"import {parentPort} from 'node:worker_threads'; parentPort.postMessage({progress:1}); setInterval(()=>{},1000)");
  const cause=Object.assign(new Error("primary cancellation"),{code:"CONTROLLED_CANCEL"});
  job.cancel(cause);
  await assert.rejects(job.result,error=>error.code==='CODE_CHANGE_HISTORY_FORCED_CLEANUP' && error.cause===cause);
  await assert.rejects(job.closed,{code:"CODE_CHANGE_HISTORY_FORCED_CLEANUP"});
  assert.equal(job.exited,true); assert.equal(job.forced,true);
});
