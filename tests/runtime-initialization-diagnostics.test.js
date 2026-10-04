import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../src/persistence/sqlite-store.js";
import { CodeChangeStore } from "../src/persistence/code-change-store.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-diagnostics-"));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return path.join(root, "state.sqlite");
}

test("runtime persistence observations preserve records with a throwing diagnostic sink", t => {
  const filename = fixture(t), events = [];
  const onDiagnostic = event => { events.push(event); throw new Error("observer failure"); };
  const controller = new SqliteStore({filename, onDiagnostic});
  controller.close();
  const store = new CodeChangeStore(filename, {onDiagnostic});
  const record = store.save({runId:"private-run", stage:"CANCELLED", objective:"private-content"});
  assert.deepEqual(store.list(), [record]);
  store.close();
  const reopened = new CodeChangeStore(filename, {onDiagnostic});
  assert.deepEqual(reopened.list(), [record]);
  reopened.close();
  for (const start of events.filter(event => event.type.endsWith(".started"))) {
    assert.ok(events.some(event => event.type === start.type.replace(/started$/u, "completed")));
  }
  assert.doesNotMatch(JSON.stringify(events), /private-run|private-content|state.sqlite|observer failure/u);
});

test("history corruption still fails closed and identifies the failing initialization boundary", t => {
  const filename = fixture(t), events = [];
  const store = new CodeChangeStore(filename);
  store.save({runId:"private-run", stage:"CANCELLED"});
  store.close();
  const db = new DatabaseSync(filename);
  db.exec("UPDATE code_change_history SET record_hash='corrupted'");
  db.close();
  assert.throws(() => new CodeChangeStore(filename, {onDiagnostic:event => events.push(event)}), /integrity/u);
  assert.ok(events.some(event => event.type === "persistence.code-store.initialize.failed"));
  assert.equal(events.some(event => event.type === "persistence.code-store.initialize.completed"), false);
  assert.doesNotMatch(JSON.stringify(events), /corrupted|private-run/u);
  fs.unlinkSync(filename);
});
