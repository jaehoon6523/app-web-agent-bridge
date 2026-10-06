import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodeChangeStore } from "../../src/persistence/code-change-store.js";
import { seedHistory } from "../helpers/code-history-fixture.js";

test("repeated real external commits cannot reset the history verification 60 second budget", {timeout:75000}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-history-budget-"));
  const filename = path.join(root, "state.sqlite");
  seedHistory(filename, {versions:128, eventBytes:8});
  const writer = new DatabaseSync(filename);
  let commits = 0, invalidations = 0;
  const store = new CodeChangeStore(filename, {verification:"background", onDiagnostic:event => {
    if (event.type === "persistence.code-store.history-background.progress") {
      writer.prepare("INSERT INTO audit_command_receipts VALUES (?,?,'INTENT',NULL,NULL)").run(`external-${++commits}`, "hash");
    }
    if (event.type === "persistence.code-store.history-background.invalidated") invalidations++;
  }});
  const started = performance.now();
  try {
    await assert.rejects(store.prepareForRead(), {code:"CODE_CHANGE_HISTORY_DEADLINE"});
    const elapsed = performance.now() - started;
    assert.ok(commits > 1 && invalidations > 1, "multiple actual generations must be rejected");
    assert.ok(elapsed >= 59000 && elapsed < 65000, `absolute budget elapsed=${elapsed}`);
    assert.throws(() => store.list(), {code:"CODE_CHANGE_HISTORY_UNVERIFIED"});
    console.log(JSON.stringify({commits, invalidations, elapsedMs:elapsed}));
  } finally {
    await store.close(); writer.close(); fs.rmSync(root, {recursive:true, force:true});
  }
});
