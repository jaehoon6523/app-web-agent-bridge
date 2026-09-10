import test from "node:test";
import assert from "node:assert/strict";
import { RequirementsPlanner } from "../src/orchestration/requirements-planner.js";

test("web proposes and revises criteria without starting implementation", async () => {
  let binding, submitted, finish;
  const web = {
    async resume(input) { binding = input.binding; },
    async submitTurn(input) {
      submitted = input;
      return { completion: new Promise((resolve) => { finish = () => resolve({ turnId: input.turnId, binding,
        rawText: '<controller_packet>\n' + JSON.stringify({ type: "REQUIREMENTS_PROPOSAL", summary: "제안", questions: [], items: [{ statement: "전송", acceptanceCriteria: "한 번 표시" }] }) + '\n</controller_packet>' }); }) };
    },
    async acknowledgeDelivery() {},
  };
  const planner = new RequirementsPlanner(web);
  const input = { objective: "채팅을 만들어 줘", conversationUrl: "https://chatgpt.com/c/test" };
  const draft = planner.start(input);
  assert.equal(draft.status, "PENDING");
  assert.throws(() => planner.start(input), /기다려/);
  await new Promise(setImmediate); finish(); await new Promise(setImmediate);
  assert.equal(planner.current.status, "READY");
  assert.equal(planner.current.proposal.items[0].acceptanceCriteria, "한 번 표시");
  assert.throws(() => planner.start({ ...input, objective: "다른 부탁", draftId: draft.draftId }), /변경/);
  planner.start({ ...input, draftId: draft.draftId, feedback: "엔터로 전송" });
  await new Promise(setImmediate);
  assert.match(submitted.text, /엔터로 전송/);
  assert.match(submitted.text, /한 번 표시/);
  finish(); await new Promise(setImmediate);
  assert.equal(planner.current.status, "READY");
});

test("invalid web output fails instead of creating acceptance criteria", async () => {
  let binding;
  const planner = new RequirementsPlanner({
    async resume(input) { binding = input.binding; },
    async submitTurn(input) { return { completion: Promise.resolve({ binding, turnId: input.turnId, rawText: "승인했어요" }) }; },
    async acknowledgeDelivery() {},
  });
  planner.start({ objective: "요청", conversationUrl: "https://chatgpt.com/c/test" });
  await new Promise(setImmediate);
  assert.equal(planner.current.status, "FAILED");
  assert.equal(planner.current.proposal, null);
});

test("binding failure retains exact recovery diagnostics and does not submit", async () => {
  const details = { currentDeliveryId: "old-delivery", runId: "old-run", conversationUrl: "https://chatgpt.com/c/old", generating: null };
  let submitted = false;
  const planner = new RequirementsPlanner({
    async resume() { throw Object.assign(new Error("binding blocked"), { code: "REBIND_DURING_ACTIVE_DELIVERY", details }); },
    async submitTurn() { submitted = true; },
  });
  planner.start({ objective: "아무거나", conversationUrl: "https://chatgpt.com/c/new" });
  await new Promise(setImmediate);
  assert.equal(submitted, false);
  assert.equal(planner.current.status, "FAILED");
  assert.equal(planner.current.errorCode, "REBIND_DURING_ACTIVE_DELIVERY");
  assert.deepEqual(planner.current.errorDetails, details);
});

test("a confirmed terminal run can recover before binding and submitting the new request", async () => {
  let count = 0, binding;
  const order = [], details = { currentDeliveryId: "old-delivery", runId: "old-run" };
  const planner = new RequirementsPlanner({
    async resume(input) {
      order.push("resume"); binding = input.binding;
      if (++count === 1) throw Object.assign(new Error("blocked"), { code: "REBIND_DURING_ACTIVE_DELIVERY", details });
    },
    async recoverDelivery(expected) { assert.deepEqual(expected, details); order.push("recover"); return details; },
    async submitTurn(input) {
      order.push("submit"); assert.ok(input.text.endsWith('사용자의 첫 부탁은 "아무거나"야.'));
      return { completion: Promise.resolve({ binding, turnId: input.turnId,
        rawText: '<controller_packet>\n{"type":"REQUIREMENTS_PROPOSAL","summary":"설계","questions":[],"items":[{"statement":"기능","acceptanceCriteria":"동작"}]}\n</controller_packet>' }) };
    },
    async acknowledgeDelivery() { order.push("ack"); },
  }, { canRecoverRun: (id) => id === "old-run" });
  planner.start({ objective: "아무거나", conversationUrl: "https://chatgpt.com/c/new" });
  await new Promise(setImmediate);
  assert.equal(planner.current.status, "READY");
  assert.deepEqual(order, ["resume", "recover", "resume", "submit", "ack"]);
});
