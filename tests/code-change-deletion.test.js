import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodeChangeStore } from "../src/persistence/code-change-store.js";
import { canonicalJson, sha256CanonicalJson } from "../src/domain/canonical-json.js";

test("only a finished code change run can be deleted, including its version history", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-delete-"));
  const store = new CodeChangeStore(join(directory, "runs.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive:true, force:true }); });
  const created = store.save({ runId:"run-1", stage:"CREATED" });
  assert.throws(() => store.deleteFinished("run-1", created.version), { code:"RUN_NOT_TERMINAL" });
  const finished = store.save({ ...created, stage:"APPLIED" }, created.version);
  store.beginCommand("receipt-new", "hash-new", "run-1");
  store.finishCommand("receipt-new", { payload:{ runId:"run-1", artifact:"audit" } });
  store.beginCommand("receipt-old", "hash-old");
  store.finishCommand("receipt-old", { payload:{ runId:"run-1", artifact:"audit" } });
  store.beginCommand("receipt-other", "hash-other", "run-2");
  store.finishCommand("receipt-other", { payload:{ runId:"run-2" } });
  assert.throws(() => store.deleteFinished("run-1", created.version), { code:"RUN_VERSION_CONFLICT" });
  assert.equal(store.history("run-1").length, 2);
  const proof = store.historyProof("run-1");
  assert.equal(proof.kind, "LOCAL_UNKEYED_HASH_CHAIN");
  assert.equal(proof.entries[1].previousHash, proof.entries[0].entryHash);
  assert.equal(store.deleteFinished("run-1", finished.version), true);
  assert.equal(store.get("run-1"), null);
  assert.deepEqual(store.history("run-1"), []);
  assert.equal(store.historyProof("run-1"), null);
  assert.equal(store.receipt("receipt-new"), undefined);
  assert.equal(store.receipt("receipt-old"), undefined);
  assert.ok(store.receipt("receipt-other"));
});

test("older receipt databases gain run ownership without losing past receipts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-delete-migration-"));
  const filename = join(directory, "runs.sqlite");
  const database = new DatabaseSync(filename);
  database.exec("CREATE TABLE audit_command_receipts (request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT) STRICT");
  database.prepare("INSERT INTO audit_command_receipts VALUES (?, ?, 'COMPLETED', ?)")
    .run("old-request", "old-hash", JSON.stringify({ payload:{ runId:"run-1" } }));
  database.close();
  const store = new CodeChangeStore(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive:true, force:true }); });
  assert.ok(store.receipt("old-request"));
  store.beginCommand("new-request", "new-hash", "run-2");
  assert.equal(store.receipt("new-request").run_id, "run-2");
});

test("an altered or missing history version blocks current run reads", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-history-"));
  const filename = join(directory, "runs.sqlite");
  const store = new CodeChangeStore(filename);
  const first = store.save({ runId:"run-a", stage:"CREATED" });
  store.save({ ...first, stage:"APPLIED" }, first.version);
  const database = new DatabaseSync(filename);
  t.after(() => { database.close(); store.close(); rmSync(directory, { recursive:true, force:true }); });
  database.prepare("UPDATE code_change_history SET entry_hash=? WHERE run_id=? AND version=1").run("tampered", "run-a");
  assert.throws(() => store.get("run-a"), /integrity/u);
  database.prepare("DELETE FROM code_change_history WHERE run_id=? AND version=1").run("run-a");
  assert.throws(() => store.get("run-a"), /missing versions/u);
});

test("existing unchained history is verified before migration and linked afterward", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-history-migration-"));
  const filename = join(directory, "runs.sqlite");
  const database = new DatabaseSync(filename);
  const record = { runId:"legacy-a", version:1, stage:"APPLIED" };
  const json = canonicalJson(record), hash = sha256CanonicalJson(record);
  database.exec("CREATE TABLE code_change_runs (run_id TEXT PRIMARY KEY, version INTEGER NOT NULL, record_json TEXT NOT NULL, record_hash TEXT NOT NULL) STRICT");
  database.exec("CREATE TABLE code_change_history (run_id TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL, record_hash TEXT NOT NULL, PRIMARY KEY(run_id, version)) STRICT");
  database.prepare("INSERT INTO code_change_runs VALUES (?, ?, ?, ?)").run(record.runId, 1, json, hash);
  database.prepare("INSERT INTO code_change_history VALUES (?, ?, ?, ?)").run(record.runId, 1, json, hash);
  database.close();
  const store = new CodeChangeStore(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive:true, force:true }); });
  assert.equal(store.get(record.runId).stage, "APPLIED");
  const check = new DatabaseSync(filename);
  assert.match(check.prepare("SELECT entry_hash FROM code_change_history WHERE run_id=?").get(record.runId).entry_hash, /^sha256:/u);
  check.close();
});
