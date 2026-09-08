import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkerCompletion, validateWorkerAdapter } from "../src/runtime/workers/contract.js";

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
