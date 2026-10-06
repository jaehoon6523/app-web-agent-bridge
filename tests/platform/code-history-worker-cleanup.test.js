import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedHistory } from "../helpers/code-history-fixture.js";
import { resources } from "../../scripts/e2e/helpers/resources.mjs";

async function workerFixture(t, {cleanup = false, checkpoint = null, cancelReason} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-worker-cleanup-"));
  const owner = resources(t);
  owner.add("workspace", () => fs.rmSync(root, {recursive:true, force:true}), 30);
  fs.mkdirSync(path.join(root, "domain"));
  fs.mkdirSync(path.join(root, "persistence"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  for (const file of ["code-change-history-job.js", "code-change-history-worker.js", "code-change-history.js"]) {
    fs.copyFileSync(new URL(`../../src/persistence/${file}`, import.meta.url), path.join(root, "persistence", file));
  }
  fs.copyFileSync(new URL("../../src/domain/canonical-json.js", import.meta.url), path.join(root, "domain", "canonical-json.js"));
  const filename = path.join(root, "state.sqlite");
  seedHistory(filename, {legacy:true});
  if (cleanup) {
    // Real SQLite migration raises at a real trigger. Inject reporting failures
    // only after the real rollback and native close have both completed.
    fs.writeFileSync(path.join(root, "persistence", "sqlite-database.js"), `
      import {DatabaseSync as Native} from 'node:sqlite';
      export class DatabaseSync extends Native {
        constructor(...args) { super(...args); this.exec("CREATE TRIGGER reject_migration BEFORE UPDATE ON code_change_history BEGIN SELECT RAISE(ABORT,'sensitive primary payload'); END"); }
        exec(sql) { const result=super.exec(sql); if(sql==='ROLLBACK') throw Object.assign(new Error('sensitive rollback payload'),{code:'ROLLBACK_REPORT_FAILED'}); return result; }
        close() { super.close(); throw Object.assign(new Error('sensitive close payload'),{code:'CLOSE_REPORT_FAILED'}); }
      }`);
  } else if (checkpoint) {
    fs.writeFileSync(path.join(root, "persistence", "sqlite-database.js"), `
      import {DatabaseSync as Native} from 'node:sqlite';
      import {workerData} from 'node:worker_threads';
      export class DatabaseSync extends Native {
        prepare(sql) {
          const statement=super.prepare(sql);
          if(sql.startsWith('UPDATE main.code_change_history SET previous_hash=')) {
            const run=statement.run.bind(statement); let updates=0;
            statement.run=(...args)=> { const result=run(...args); if(++updates===4) {
              ${checkpoint === "crash" ? "process.exit(7);" : "Atomics.store(new Int32Array(workerData.cancellation),0,1);"}
            } return result; };
          }
          return statement;
        }
      }`);
  } else {
    fs.writeFileSync(path.join(root, "persistence", "code-change-history-worker.js"), `
      import {parentPort,workerData} from 'node:worker_threads';
      const cancellation=new Int32Array(workerData.cancellation);
      Atomics.wait(cancellation,0,0,1000);
      parentPort.postMessage({ok:true,verified:[]}); parentPort.close();`);
  }
  const {CodeChangeHistoryJob} = await import(pathToFileURL(path.join(root, "persistence", "code-change-history-job.js")));
  const job = new CodeChangeHistoryJob(filename, {migrate:cleanup || Boolean(checkpoint)});
  owner.add("worker", async () => {job.cancel(); await job.closed.catch(() => {});}, 20);
  if (!cleanup && !checkpoint) job.cancel(cancelReason);
  return {job, filename};
}

test("Worker keeps primary migration and both cleanup failures without exporting sensitive text", async t => {
  const {job, filename} = await workerFixture(t, {cleanup:true});
  let error;
  try {await job.result;} catch (failure) {error=failure;}
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors.length, 3);
  assert.equal(error.errors[0].code, "ERR_SQLITE_ERROR");
  assert.equal(error.errors[1].code, "ROLLBACK_REPORT_FAILED");
  assert.equal(error.errors[2].code, "CLOSE_REPORT_FAILED");
  assert.equal(error.cause, error.errors[0]);
  for (const failure of [error, ...error.errors]) assert.ok(!failure.message.includes("sensitive"));
  await assert.rejects(job.closed, {code:"CODE_CHANGE_HISTORY_CLEANUP_FAILED"});
  assert.equal(job.exited, true);
  const {DatabaseSync} = await import("node:sqlite");
  const durable = new DatabaseSync(filename);
  try {assert.equal(durable.prepare("SELECT count(*) AS n FROM code_change_history WHERE entry_hash IS NOT NULL").get().n, 0);}
  finally {durable.close();}
});

for (const reason of [null, false, 0, ""]) {
  test(`Job never adopts a result after cancellation with reason ${JSON.stringify(reason)}`, async t => {
    const {job} = await workerFixture(t, {cancelReason:reason});
    const outcome = await job.result.then(() => ({resolved:true}), error => ({resolved:false, error}));
    assert.equal(outcome.resolved, false);
    assert.equal(outcome.error, reason);
    await job.closed;
    assert.equal(job.forced, undefined);
  });
}

for (const checkpoint of ["cancel", "crash"]) {
  test(`real migration ${checkpoint} after four writes leaves no partial chain on reopen`, async t => {
    const {job, filename} = await workerFixture(t, {checkpoint});
    await assert.rejects(job.result, {code:checkpoint === "crash" ? "CODE_CHANGE_HISTORY_WORKER_EXIT" : "CODE_CHANGE_HISTORY_CANCELLED"});
    if (checkpoint === "crash") await assert.rejects(job.closed, {code:"CODE_CHANGE_HISTORY_WORKER_EXIT"});
    else await job.closed;
    const {DatabaseSync} = await import("node:sqlite");
    const durable = new DatabaseSync(filename);
    try {
      assert.equal(durable.prepare("SELECT count(*) AS n FROM code_change_history WHERE entry_hash IS NOT NULL OR previous_hash IS NOT NULL").get().n, 0);
      assert.equal(durable.prepare("SELECT count(*) AS n FROM code_change_history").get().n, 8);
    } finally {durable.close();}
    const {CodeChangeStore} = await import("../../src/persistence/code-change-store.js");
    const reopened = new CodeChangeStore(filename, {verification:"background"});
    try {
      await reopened.prepareForRead();
      assert.equal(reopened.historyProof("accumulated-history").version, 8);
      assert.equal(reopened.history("accumulated-history").length, 8);
    } finally {await reopened.close();}
  });
}

test("production Store cancellation preserves a null AbortSignal reason and closes normally", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-store-null-abort-"));
  const owner = resources(t);
  owner.add("workspace", () => fs.rmSync(root, {recursive:true, force:true}), 30);
  const filename = path.join(root, "state.sqlite");
  seedHistory(filename);
  const {CodeChangeStore} = await import("../../src/persistence/code-change-store.js");
  const controller = new AbortController();
  const store = new CodeChangeStore(filename, {verification:"background",onDiagnostic:event => {
    if (event.type === "persistence.code-store.history-background.started") controller.abort(null);
  }});
  owner.add("store", () => store.close(), 20);
  const outcome = await store.prepareForRead({signal:controller.signal})
    .then(() => ({resolved:true}), error => ({resolved:false,error}));
  assert.equal(outcome.resolved, false);
  assert.equal(outcome.error, null);
  await store.close();
});
