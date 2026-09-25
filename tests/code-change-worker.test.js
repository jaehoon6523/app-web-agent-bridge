import assert from "node:assert/strict";
import test from "node:test";
import { bindCodeChangeCapture } from "../src/runtime/code-change-worker.js";

function fixture({ result = { threadId: "thread", turnId: "turn", status: "completed" }, persist } = {}) {
  const captures = [];
  const persisted = [];
  const approvals = [];
  const steers = [];
  const session = {
    externalSessionId: "thread",
    respondToApproval: (input) => { approvals.push(input); return input; },
    steer: async (input) => { steers.push(input); return { accepted:true }; },
    submitTurn: async () => ({ turnId: "turn", completion: Promise.resolve(result) }),
  };
  const worker = bindCodeChangeCapture({ session, workspace: { capture() {
    captures.push(true);
    return { artifact: { sha256: "captured" } };
  } }, persistCapture: persist ?? (async (value) => persisted.push(value)), close: async () => {} });
  return { worker, captures, persisted, approvals, steers };
}

test("delegates approval responses through the worker boundary", () => {
  const { worker, approvals } = fixture();
  const input = { requestId: "approval_1", turnId: "turn", decision: "accept" };
  assert.deepEqual(worker.respondToApproval(input), input);
  assert.deepEqual(approvals, [input]);
});

test("delegates live guidance to the exact active worker turn", async () => {
  const { worker, steers } = fixture();
  const input = { turnId:"turn", text:"Check the existing helper before adding another one." };
  assert.deepEqual(await worker.steer(input), { accepted:true });
  assert.deepEqual(steers, [input]);
});

test("captures a bound completed turn and waits for Controller persistence", async () => {
  const { worker, captures, persisted } = fixture();
  const handle = await worker.submitTurn({ text: "work" });
  const result = await handle.completion;
  assert.equal(captures.length, 1);
  assert.equal(persisted[0].turnId, "turn");
  assert.equal(result.capture, persisted[0].capture);
});

test("wrong thread, wrong turn and failure cannot produce an artifact", async () => {
  for (const changed of [{ threadId: "other" }, { turnId: "other" }, { status: "failed" }]) {
    const { worker, captures } = fixture({ result: { threadId: "thread", turnId: "turn", status: "completed", ...changed } });
    const handle = await worker.submitTurn({});
    await assert.rejects(handle.completion, /does not match/);
    assert.equal(captures.length, 0);
    await assert.rejects(worker.submitTurn({}), /recovery/);
  }
});

test("persistence failure prevents publishing a capture or automatically resubmitting", async () => {
  const { worker } = fixture({ persist: async () => { throw new Error("storage unavailable"); } });
  const handle = await worker.submitTurn({});
  await assert.rejects(handle.completion, /storage unavailable/);
  await assert.rejects(worker.submitTurn({}), /recovery/);
});
