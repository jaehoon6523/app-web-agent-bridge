import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkerCompletion, validateWorkerAdapter } from "../src/runtime/workers/contract.js";
import { createGenericJsonlWorker } from "../src/runtime/workers/generic-jsonl-worker.js";
import path from "node:path";
import { randomUUID } from "node:crypto";

test("missing worker executable rejects creation without crashing the controller", async () => {
  await assert.rejects(createGenericJsonlWorker({
    provider: "qwen", executablePath: path.join(process.cwd(), `missing-worker-${randomUUID()}.exe`),
    workspaceRoot: process.cwd(),
  }), { code: "ENOENT" });
});

test("worker exit rejects its pending turn and prevents subsequent submissions", async () => {
  const worker = await createGenericJsonlWorker({
    provider: "qwen", executablePath: process.execPath, workspaceRoot: process.cwd(),
    args: ["-e", "process.stdin.once('data', () => process.exit(7))"],
  });
  try {
    await worker.start();
    const handle = await worker.submitTurn({ text: "test", outputSchema: {} });
    await assert.rejects(handle.completion, /exited code=7/u);
    await assert.rejects(worker.submitTurn({ text: "retry", outputSchema: {} }), /closed/u);
  } finally { await worker.close(); }
});

test("worker adapter contract accepts provider-neutral workers", () => {
  const worker = {
    provider: "qwen",
    start() {},
    submitTurn() {},
    interrupt() {},
    inspect() {},
    close() {},
  };
  assert.equal(validateWorkerAdapter(worker), worker);
});

test("worker adapter contract rejects incomplete workers", () => {
  assert.throws(() => validateWorkerAdapter({ provider: "deepseek" }), /must implement start/u);
});

test("completion persists provider model session usage and text", () => {
  const result = normalizeWorkerCompletion({
    provider: "gemini",
    model: "gemini-example",
    sessionId: "session_1",
    turnId: "turn_1",
    status: "completed",
    text: "{\"summary\":\"ok\"}",
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  assert.equal(result.provider, "gemini");
  assert.equal(result.model, "gemini-example");
  assert.equal(result.sessionId, "session_1");
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
});
