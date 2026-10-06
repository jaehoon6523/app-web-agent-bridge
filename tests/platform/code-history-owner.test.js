import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedHistory } from "../helpers/code-history-fixture.js";
import { resources } from "../../scripts/e2e/helpers/resources.mjs";

async function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-history-owner-"));
  const owner = resources(t);
  owner.add("workspace", () => fs.rmSync(root, {recursive:true, force:true}), 30);
  const filename = path.join(root, "state.sqlite");
  const {record} = seedHistory(filename);
  // All owner modules retain production bytes. Only the actual Worker program
  // is controlled, while Store, Job and the main SQLite handle are real.
  fs.cpSync(new URL("../../src", import.meta.url), path.join(root, "src"), {recursive:true});
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(root, "src/persistence/code-change-history-worker.js"), source);
  const {CodeChangeStore} = await import(pathToFileURL(path.join(root, "src/persistence/code-change-store.js")));
  const store = new CodeChangeStore(filename, {verification:"background"});
  owner.add("store", () => Promise.resolve(store.close()).catch(() => {}), 20);
  return {store, filename, record};
}

for (const [label, source, closureFails] of [
  ["nonzero", "process.exitCode=7", true],
  ["error", "throw Error('controlled fault')", true],
  ["no result", "process.exitCode=0", false],
]) {
  test(`real Store refuses ${label} Worker proof and reports owner closure separately`, async t => {
    const {store, record} = await fixture(t, source);
    await assert.rejects(store.prepareForRead(), {code:"CODE_CHANGE_HISTORY_WORKER_EXIT"});
    assert.throws(() => store.get(record.runId), {code:"CODE_CHANGE_HISTORY_UNVERIFIED"});
    if (closureFails) await assert.rejects(Promise.resolve(store.close()), {code:"CODE_CHANGE_HISTORY_WORKER_EXIT"});
    else await store.close();
    assert.throws(() => store.prepareForRead(), {code:"CODE_CHANGE_STORE_CLOSED"});
  });
}

test("real Store close with a noncooperative Worker rejects forced closure and settles prepare", {timeout:10000}, async t => {
  const {store, filename} = await fixture(t, "setInterval(()=>{},1000)");
  const pending = store.prepareForRead();
  let settled = false;
  pending.finally(() => {settled=true;}).catch(() => {});
  const closure = store.close();
  await assert.rejects(closure, {code:"CODE_CHANGE_HISTORY_FORCED_CLEANUP"});
  assert.equal(settled, true);
  await assert.rejects(pending, {code:"CODE_CHANGE_HISTORY_FORCED_CLEANUP"});
  await assert.rejects(store.close(), {code:"CODE_CHANGE_HISTORY_FORCED_CLEANUP"});
  fs.unlinkSync(filename);
});
