import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../src/persistence/sqlite-store.js";
import { initializeSqliteSchema } from "../src/persistence/schema.js";
import { persistPreparation } from "../src/orchestration/preparation-persistence.js";

const composite = (primary, cleanup) => error => error instanceof AggregateError
  && error.cause === primary && error.errors[0] === primary && error.errors[1] === cleanup;

test("real preparation rollback preserves primary BUSY and cleanup failure without retry", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE preparation_state(id INTEGER PRIMARY KEY,json TEXT)");
  const primary = Object.assign(new Error("primary busy"), {code:"ERR_SQLITE_ERROR",errcode:5});
  const cleanup = new Error("rollback reporting failed");
  const exec = db.exec.bind(db);
  let attempts = 0, committed = false;
  db.exec = sql => {if(sql === "BEGIN IMMEDIATE") attempts++; const result=exec(sql); if(sql === "ROLLBACK") throw cleanup; return result;};
  try {
    await assert.rejects(persistPreparation(db, () => {throw primary;}, () => {committed=true;}, () => false), composite(primary,cleanup));
    assert.equal(attempts, 1); assert.equal(committed, false);
    assert.equal(db.prepare("SELECT count(*) AS n FROM preparation_state").get().n, 0);
    exec("BEGIN; ROLLBACK");
  } finally {db.close();}
});

test("real controller Store rollback preserves both failures and a later transaction still works", () => {
  const store = new SqliteStore(":memory:");
  const primary = new Error("primary controller failure"), cleanup = new Error("rollback reporting failed");
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {const result=exec.call(this,sql); if(sql === "ROLLBACK") throw cleanup; return result;};
  try {assert.throws(() => store.withTransaction(() => {throw primary;}), composite(primary,cleanup));}
  finally {DatabaseSync.prototype.exec=exec;}
  try {assert.equal(store.withTransaction(() => "later committed"), "later committed");}
  finally {store.close();}
});

test("schema COMMIT reporting failure is preserved with the actual native failed rollback", () => {
  const db = new DatabaseSync(":memory:");
  const primary = new Error("commit reporting failed");
  const exec = db.exec.bind(db);
  db.exec = sql => {const result=exec(sql); if(sql === "COMMIT") throw primary; return result;};
  try {
    assert.throws(() => initializeSqliteSchema(db), error => error instanceof AggregateError
      && error.cause === primary && error.errors[0] === primary && /no transaction is active/.test(error.errors[1].message));
  } finally {db.close();}
});
