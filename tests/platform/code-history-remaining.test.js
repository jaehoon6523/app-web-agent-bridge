import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CodeChangeStore } from "../../src/persistence/code-change-store.js";
import { seedHistory } from "../helpers/code-history-fixture.js";
import { resources } from "../../scripts/e2e/helpers/resources.mjs";

function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-history-remaining-"));
  const owner = resources(t);
  owner.add("workspace", () => fs.rmSync(root, {recursive:true, force:true}), 30);
  const filename = path.join(root, "state.sqlite");
  const seeded = seedHistory(filename, options);
  const writer = new DatabaseSync(filename);
  owner.add("writer", () => writer.close(), 20);
  const open = mode => {
    const store = new CodeChangeStore(filename, {verification:mode});
    owner.add("store", () => store.close(), 20);
    return store;
  };
  return {filename, writer, open, ...seeded};
}

// Independent serializer/digest: no production canonical/hash helper oracle.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = value => "sha256:" + createHash("sha256").update(canonical(value)).digest("hex");

for (const legacy of [false, true]) {
  test(`same-version independent runs reject corruption in a ${legacy ? "legacy" : "chained"} sibling before any proof adoption`, async t => {
    const {writer, open, record} = fixture(t);
    let previous = null;
    for (const row of writer.prepare("SELECT * FROM code_change_history ORDER BY version").all()) {
      const sibling = {...JSON.parse(row.record_json), runId:"sibling"};
      const recordHash = hash(sibling);
      const entryHash = hash({kind:"CODE_CHANGE_HISTORY",runId:"sibling",version:row.version,recordHash,previousHash:previous});
      writer.prepare("INSERT INTO code_change_history VALUES (?,?,?,?,?,?)").run("sibling", row.version, canonical(sibling), recordHash, legacy ? null : previous, legacy ? null : entryHash);
      previous = entryHash;
      if (row.version === record.version) writer.prepare("INSERT INTO code_change_runs VALUES (?,?,?,?)").run("sibling", row.version, canonical(sibling), recordHash);
    }
    writer.exec("UPDATE code_change_history SET record_hash='corrupt' WHERE run_id='sibling' AND version=2");
    const store = open("background");
    await assert.rejects(store.prepareForRead(), /integrity/);
    for (const runId of [record.runId, "sibling"]) {
      assert.throws(() => store.get(runId), {code:"CODE_CHANGE_HISTORY_UNVERIFIED"});
      assert.throws(() => store.historyProof(runId), {code:"CODE_CHANGE_HISTORY_UNVERIFIED"});
    }
    assert.equal(writer.prepare("SELECT count(*) AS n FROM code_change_history WHERE run_id='sibling' AND entry_hash IS NOT NULL").get().n, legacy ? 0 : record.version);
    writer.exec("BEGIN IMMEDIATE; DELETE FROM code_change_history WHERE run_id='sibling'; DELETE FROM code_change_runs WHERE run_id='sibling'; COMMIT");
    await store.prepareForRead();
    assert.deepEqual(store.get(record.runId), record);
    assert.equal(store.get("sibling"), null);
  });
}

for (const method of ["get", "history", "historyProof"]) {
  for (const phase of ["before", "after"]) {
    test(`${method} rejects an external committed corruption ${phase} its real record SELECT`, async t => {
      const {writer, open, record} = fixture(t);
      const store = open("background");
      await store.prepareForRead();
      const native = store.database.prepare.bind(store.database);
      let injected = false;
      store.database.prepare = sql => {
        const statement = native(sql);
        if (sql === "SELECT * FROM main.code_change_runs WHERE run_id=?") {
          const get = statement.get.bind(statement);
          statement.get = (...args) => {
            const corrupt = () => {writer.exec("UPDATE code_change_history SET entry_hash='corrupt' WHERE version=2"); injected = true;};
            if (phase === "before") corrupt();
            const row = get(...args);
            if (phase === "after") corrupt();
            return row;
          };
        }
        return statement;
      };
      try {assert.throws(() => store[method](record.runId), {code:"CODE_CHANGE_HISTORY_UNVERIFIED"});}
      finally {store.database.prepare = native;}
      assert.equal(injected, true);
      await assert.rejects(store.prepareForRead(), /integrity/);
    });
  }
}

for (const legacy of [false, true]) {
  test(`rollback-journal background verification ${legacy ? "migrates legacy" : "reads chained"} history and closes`, async t => {
    const {writer, open, record} = fixture(t, {legacy});
    assert.equal(writer.prepare("PRAGMA journal_mode=DELETE").get().journal_mode, "delete");
    const store = open("background");
    await store.prepareForRead();
    assert.deepEqual(store.get(record.runId), record);
    assert.equal(store.save({...record, objective:"rollback journal append"}, record.version).version, record.version + 1);
    await store.close();
    const reopened = open("synchronous");
    assert.equal(reopened.history(record.runId).length, record.version + 1);
  });
}

for (const mode of ["synchronous", "background"]) {
  test(`${mode}: save/delete refuse a caller transaction and preserve caller work`, async t => {
    const {open, record} = fixture(t);
    const store = open(mode);
    await store.prepareForRead();
    store.database.exec("BEGIN; CREATE TABLE caller_owned(value TEXT); INSERT INTO caller_owned VALUES ('keep')");
    assert.throws(() => store.save(record, record.version), /within a transaction/);
    assert.throws(() => store.deleteFinished(record.runId, record.version), /within a transaction/);
    assert.equal(store.database.prepare("SELECT value FROM caller_owned").get().value, "keep");
    store.database.exec("ROLLBACK");
    await store.prepareForRead();
    assert.deepEqual(store.get(record.runId), record);
  });
}
