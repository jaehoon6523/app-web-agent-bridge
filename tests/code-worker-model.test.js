import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { CodexProcessManager } from "../src/runtime/codex/index.js";
import { createRegisteredCodeWorker } from "../src/runtime/workers/registry.js";
import { setupAudit } from "./helpers/audit-fixtures.js";

const fakeServer = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
const codex = { executablePath: process.execPath, approvalPolicy: "untrusted" };

function fakeCodex(t, directory) {
  const file = path.join(directory, "codex-wire.json");
  const create = CodexProcessManager.create.bind(CodexProcessManager);
  const spawn = t.mock.method(CodexProcessManager, "create", (options) => create({
    ...options,
    appServerArgs: [fakeServer, "--state-file", file, "--default-model", "gpt-6.1-sol"],
  }));
  return { spawn, read: () => JSON.parse(readFileSync(file, "utf8")) };
}

test("CODE_WORKER_MODEL overrides the fake Codex default on thread/start and turn/start", async (t) => {
  const directory = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "bridge-worker-model-")));
  const wire = fakeCodex(t, directory);
  const bindings = [];
  const captures = [];
  let worker;
  try {
    worker = await createRegisteredCodeWorker({
      workerConfig: loadConfig({ env: { CODE_WORKER_MODEL: "gpt-6-sol" } }).codeWorker,
      codex,
      workspace: { root: directory, capture: () => ({ patch: "fixture" }) },
      persistThreadId: async (binding) => bindings.push(binding),
      persistCapture: async (capture) => captures.push(capture),
    });
    await worker.start();
    const fields = { ok: { type: "boolean" }, prompt: { type: "string" },
      outputSchemaReceived: { type: "boolean" }, sandboxType: { type: "string" } };
    const handle = await worker.submitTurn({
      text: "model transport fixture",
      outputSchema: { type: "object", properties: fields, required: Object.keys(fields), additionalProperties: false },
    });
    const [completion] = await Promise.allSettled([handle.completion]);
    const observed = wire.read().threads;
    assert.deepEqual(observed.map((thread) => ({
      model: thread.requestedModel,
      turns: thread.turns.map((turn) => turn.requestedModel),
    })), [{ model: "gpt-6-sol", turns: ["gpt-6-sol"] }]);
    assert.equal(completion.status, "fulfilled");
    const result = completion.value;
    assert.equal(result.status, "completed");
    assert.equal(result.threadId, bindings[0].threadId);
    assert.equal(result.turnId, handle.turnId);
    assert.deepEqual(captures, [{ threadId: result.threadId, turnId: result.turnId, capture: result.capture }]);
  } finally {
    await worker?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("model_not_found persists one failed Worker turn without redispatch, capture or application", async (t) => {
  const workerConfig = loadConfig({ env: { CODE_WORKER_MODEL: "gpt-6.1-sol" } }).codeWorker;
  const fixture = setupAudit(t, {
    reviewVerdicts: ["SATISFIED"],
    createWorker: createRegisteredCodeWorker,
  });
  fixture.options.workerConfig = workerConfig;
  fixture.options.codex = codex;
  await fixture.reopen();
  const wire = fakeCodex(t, fixture.directory);
  const run = await fixture.run();
  assert.equal(run.stage, "RECOVERY_REQUIRED");
  assert.match(run.error, /model_not_found/u);
  assert.equal(run.workerTurns.length, 1);
  assert.equal(run.workerTurns[0].turnId, run.workerTurnId);
  assert.equal(run.workerTurns[0].status, "failed");
  assert.equal(run.workerTurns[0].model, "gpt-6.1-sol");
  assert.match(run.workerTurns[0].metadata.error, /model_not_found/u);
  assert.equal(run.workerTurns[0].outputRef, null);
  assert.ok(run.capture == null);
  assert.ok(run.application == null);
  assert.equal(fixture.reviews(), 0);
  assert.equal(readFileSync(path.join(fixture.target, "file.txt"), "utf8"), "base\n");
  await fixture.reopen();
  const recovered = fixture.service.get(run.runId);
  assert.equal(recovered.stage, "RECOVERY_REQUIRED");
  assert.deepEqual(recovered.workerTurns, run.workerTurns);
  await assert.rejects(fixture.start(), { code: "RUN_BUSY" });
  assert.deepEqual(fixture.service.get(run.runId), recovered);
  assert.ok(!fixture.service.snapshot(run.runId, {}).commandCapabilities.includes("run.retry"));
  assert.equal(wire.spawn.mock.callCount(), 1);
  assert.equal(wire.read().turnSequence, 1);
});
