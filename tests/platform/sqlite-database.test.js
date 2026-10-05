import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "../../src/persistence/sqlite-database.js";

test("SQLite row lookup distinguishes missing rows from a real nullable row on supported runtimes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE rows(id INTEGER PRIMARY KEY, value TEXT)");
    const lookup = db.prepare("SELECT id,value FROM rows WHERE id=?");
    assert.equal(lookup.get(1), undefined);
    db.exec("INSERT INTO rows VALUES (1,NULL)");
    assert.deepEqual({...lookup.get(1)}, {id:1,value:null});
    assert.equal(lookup.get(2), undefined);
    assert.equal(db.prepare("SELECT value FROM rows WHERE id=1").get().value, null);
  } finally { db.close(); }
});
