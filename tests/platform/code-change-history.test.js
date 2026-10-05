import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodeChangeStore } from "../../src/persistence/code-change-store.js";
import { CodeChangeHistoryJob } from "../../src/persistence/code-change-history-job.js";
import { canonicalJson, sha256CanonicalJson } from "../../src/domain/canonical-json.js";
import { seedHistory } from "../helpers/code-history-fixture.js";

function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-history-contract-"));
  const filename = path.join(root, "state.sqlite");
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return {filename, ...seedHistory(filename, options)};
}

test("verified history is reused through reads, own appends and receipts without changing durable proof", async t => {
  const {filename, record, headHash} = fixture(t), events = [];
  const store = new CodeChangeStore(filename, {verification:"background", onDiagnostic:event => events.push(event)});
  t.after(() => store.close());
  assert.throws(() => store.list(), {code:"CODE_CHANGE_HISTORY_UNVERIFIED"});
  await Promise.all([store.prepareForRead(), store.prepareForRead()]);
  const first = store.get(record.runId); first.events[0].detail = "caller mutation";
  assert.deepEqual(store.list(), [record]);
  store.beginCommand("request", "request-hash", record.runId);
  const saved = store.save({...record, objective:"appended"}, record.version);
  store.finishCommand("request", {payload:{runId:record.runId}});
  assert.deepEqual(store.get(record.runId), saved);
  assert.deepEqual(store.history(record.runId).at(-1), saved);
  const proof = store.historyProof(record.runId);
  assert.equal(proof.entries.at(-1).previousHash, headHash);
  assert.equal(proof.entries.at(-1).entryHash, sha256CanonicalJson({kind:"CODE_CHANGE_HISTORY",runId:record.runId,
    version:saved.version,recordHash:sha256CanonicalJson(saved),previousHash:headHash}));
  await store.prepareForRead();
  assert.equal(events.filter(event => event.type === "persistence.code-store.history-background.started").length, 1);
  assert.equal(store.deleteFinished(record.runId, saved.version), true);
  assert.deepEqual(store.list(), []);
  assert.equal(store.receipt("request"), undefined);
  assert.doesNotMatch(JSON.stringify(events), /accumulated-history|history contract|caller mutation|state.sqlite/u);
});

for (const connection of ["external", "same"]) {
  test(`${connection} connection changing only old history invalidates reads and writes; corruption remains rejected`, async t => {
    const {filename, record} = fixture(t);
    const store = new CodeChangeStore(filename, {verification:"background"});
    t.after(() => store.close());
    await store.prepareForRead();
    const db = connection === "same" ? store.database : new DatabaseSync(filename);
    try { db.exec("UPDATE code_change_history SET entry_hash='corrupt' WHERE version=1"); }
    finally { if (connection === "external") db.close(); }
    assert.throws(() => store.get(record.runId), {code:"CODE_CHANGE_HISTORY_UNVERIFIED"});
    assert.throws(() => store.save({...record, objective:"must not persist"}, record.version), {code:"CODE_CHANGE_HISTORY_UNVERIFIED"});
    await assert.rejects(store.prepareForRead(), /integrity/u);
    assert.equal(store.database.prepare("SELECT version FROM code_change_runs").get().version, record.version);
    assert.throws(() => store.list(), {code:"CODE_CHANGE_HISTORY_UNVERIFIED"});
  });
}

test("an external valid append is reverified and becomes the same current durable record", async t => {
  const {filename, record} = fixture(t);
  const store = new CodeChangeStore(filename, {verification:"background"}); t.after(() => store.close());
  await store.prepareForRead();
  const writer = new CodeChangeStore(filename);
  let appended;
  try { appended = writer.save({...record, objective:"external append"}, record.version); }
  finally { writer.close(); }
  assert.throws(() => store.list(), {code:"CODE_CHANGE_HISTORY_UNVERIFIED"});
  await store.prepareForRead();
  assert.deepEqual(store.get(record.runId), appended);
});

for (const verification of ["synchronous", "background"]) {
  test(`${verification}: caller-owned provisional history cannot acquire or reuse a committed proof`, async t => {
    const {filename, record, headHash} = fixture(t);
    const store = new CodeChangeStore(filename, {verification}); t.after(() => store.close());
    await store.prepareForRead();
    store.database.exec("BEGIN; UPDATE code_change_history SET entry_hash='uncommitted-corrupt' WHERE version=1");
    try {
      assert.throws(() => store.prepareForRead(), {code:"CODE_CHANGE_TRANSACTION_ACTIVE"});
      for (const read of [() => store.list(), () => store.get(record.runId), () => store.history(record.runId), () => store.historyProof(record.runId)]) {
        assert.throws(read, {code:"CODE_CHANGE_TRANSACTION_ACTIVE"});
      }
      // Rejection must preserve the caller's transaction and provisional write.
      assert.equal(store.database.prepare("SELECT entry_hash FROM code_change_history WHERE version=1").get().entry_hash, "uncommitted-corrupt");
    } finally { store.database.exec("ROLLBACK"); }
    await store.prepareForRead();
    assert.deepEqual(store.get(record.runId), record);
    assert.equal(store.historyProof(record.runId).entries.at(-1).entryHash, headHash);
    store.database.exec("SAVEPOINT caller_owned; UPDATE code_change_history SET entry_hash='committed-corrupt' WHERE version=1");
    assert.throws(() => store.historyProof(record.runId), {code:"CODE_CHANGE_TRANSACTION_ACTIVE"});
    store.database.exec("RELEASE caller_owned");
    await assert.rejects(store.prepareForRead(), /integrity/u);
  });
}

test("a transaction opened during worker verification prevents publishing its committed proof", async t => {
  const {filename, record} = fixture(t, {versions:300, eventBytes:32});
  let opened = false;
  const store = new CodeChangeStore(filename, {verification:"background", onDiagnostic:event => {
    if (!opened && event.type === "persistence.code-store.history-background.progress") {
      opened = true;
      store.database.exec("BEGIN; UPDATE code_change_history SET entry_hash='uncommitted-corrupt' WHERE version=1");
    }
  }});
  t.after(() => store.close());
  try {
    await assert.rejects(store.prepareForRead(), {code:"CODE_CHANGE_TRANSACTION_ACTIVE"});
    assert.equal(opened, true);
    assert.throws(() => store.get(record.runId), {code:"CODE_CHANGE_TRANSACTION_ACTIVE"});
  } finally { if (opened) store.database.exec("ROLLBACK"); }
  await store.prepareForRead();
  assert.deepEqual(store.get(record.runId), record);
});

test("a commit during a real verification discards the snapshot proof before publishing it", async t => {
  const {filename} = fixture(t, {versions:300, eventBytes:32});
  let changed = false; const events = [];
  const store = new CodeChangeStore(filename, {verification:"background", onDiagnostic:event => {
    events.push(event);
    if (!changed && event.type === "persistence.code-store.history-background.progress") {
      changed = true;
      const writer = new DatabaseSync(filename);
      try { writer.exec("UPDATE code_change_history SET record_hash='corrupt' WHERE version=1"); }
      finally { writer.close(); }
    }
  }});
  t.after(() => store.close());
  await assert.rejects(store.prepareForRead(), /integrity/u);
  assert.equal(changed, true);
  assert.ok(events.some(event => event.type === "persistence.code-store.history-background.invalidated"));
  assert.equal(events.some(event => event.type === "persistence.code-store.history-background.completed"), false);
  assert.throws(() => store.list(), {code:"CODE_CHANGE_HISTORY_UNVERIFIED"});
});

test("trigger side effects are not treated as the known two-row append", async t => {
  const {filename, record} = fixture(t);
  const store = new CodeChangeStore(filename, {verification:"background"}); t.after(() => store.close());
  await store.prepareForRead();
  store.database.exec(`CREATE TRIGGER unexpected_history_change AFTER INSERT ON code_change_history
    BEGIN UPDATE code_change_history SET entry_hash='corrupt' WHERE version=1; END`);
  assert.throws(() => store.get(record.runId), {code:"CODE_CHANGE_HISTORY_UNVERIFIED"});
  await store.prepareForRead();
  store.save(record, record.version);
  assert.throws(() => store.get(record.runId), {code:"CODE_CHANGE_HISTORY_UNVERIFIED"});
  await assert.rejects(store.prepareForRead(), /integrity/u);
});

test("failed append rolls back durable state and cannot publish a provisional hash head", async t => {
  const {filename, record, headHash} = fixture(t);
  const store = new CodeChangeStore(filename, {verification:"background"}); t.after(() => store.close());
  store.database.exec("CREATE TRIGGER reject_append BEFORE INSERT ON code_change_history BEGIN SELECT RAISE(ABORT,'rejected append'); END");
  await store.prepareForRead();
  assert.throws(() => store.save(record, record.version), /rejected append/u);
  await store.prepareForRead();
  assert.deepEqual(store.get(record.runId), record);
  assert.equal(store.historyProof(record.runId).entries.at(-1).entryHash, headHash);
});

test("verified legacy migration preserves records and canonical hashes and releases all file handles", async t => {
  const {filename, record, headHash} = fixture(t, {legacy:true});
  const store = new CodeChangeStore(filename, {verification:"background"});
  try {
    await store.prepareForRead();
    assert.deepEqual(store.get(record.runId), record);
    assert.equal(store.historyProof(record.runId).entries.at(-1).entryHash, headHash);
    assert.equal(store.database.prepare("SELECT record_json FROM code_change_runs").get().record_json, canonicalJson(record));
  } finally { await store.close(); }
  fs.unlinkSync(filename);
});

test("cancelling an active history verifier awaits natural thread exit and file release", async t => {
  const {filename} = fixture(t, {versions:300, eventBytes:128});
  let observe;
  const progress = new Promise(resolve => { observe = resolve; });
  const events = [], store = new CodeChangeStore(filename, {verification:"background", onDiagnostic:event => {
    events.push(event);
    if (event.type === "persistence.code-store.history-background.progress") observe();
  }});
  const pending = store.prepareForRead(); pending.catch(() => {});
  await progress;
  await store.close();
  await assert.rejects(pending, {code:"CODE_CHANGE_HISTORY_CANCELLED"});
  assert.ok(events.some(event => event.type === "persistence.code-store.history-background.closed" && event.forced === false));
  fs.unlinkSync(filename);
});

test("a verifier deadline rejects and cooperative cancellation is not counted as a verification PASS", async t => {
  const {filename} = fixture(t);
  const job = new CodeChangeHistoryJob(filename, {timeoutMs:1});
  await assert.rejects(job.result, {code:"CODE_CHANGE_HISTORY_DEADLINE"});
  await job.closed;
  assert.equal(Boolean(job.forced), false);
  fs.unlinkSync(filename);
});
