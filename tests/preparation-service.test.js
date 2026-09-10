import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PreparationService } from "../src/orchestration/preparation-service.js";
import { validateWebSessionBinding } from "../src/runtime/web/binding.js";

const tick = () => new Promise(setImmediate);
async function settled(service) {
  for (let i = 0; i < 50 && service.jobs.size; i++) await tick();
  assert.equal(service.jobs.size, 0);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-preparation-"));
  const runs = new Map(), calls = [];
  let binding, active = null, count = 0, failAck = false, inspection = {}, afterAck = {};
  const web = {
    async resume(input) { validateWebSessionBinding(input.binding); binding = { ...input.binding, bindingStatus: "BOUND", tabId: 1, windowId: 2 }; calls.push(binding.sessionId); return binding; },
    async submitTurn(input) {
      active = input.turnId; count++;
      const parsed = count === 1 ? { type: "REQUIREMENTS_PROPOSAL", summary: "무엇을 만들까요?", questions: ["원하는 기능?"], items: [] }
        : { type: "REQUIREMENTS_PROPOSAL", summary: "채팅", questions: [], items: [{ statement: "메시지 전송", acceptanceCriteria: "목록에 한 번 표시" }] };
      binding = { ...binding, lastObservedUserMessageId: "u" + count, lastObservedAssistantMessageId: "a" + count };
      return { completion: Promise.resolve({ turnId: active, binding, confidence: "CONFIRMED_BY_UI_STATE",
        rawText: "<controller_packet>\n" + JSON.stringify(parsed) + "\n</controller_packet>" }) };
    },
    async inspectDelivery() { return { currentDeliveryId: active, sessionId: binding.sessionId, runId: binding.runId,
      conversationId: binding.conversationId, conversationUrl: binding.conversationUrl, observedConversationUrl: binding.conversationUrl,
      pageReachable: true, generating: false, pageBusy: false, extensionBusy: false,
      lastObservedUserMessageId: "u" + count, lastObservedAssistantMessageId: "a" + count, ...inspection }; },
    async acknowledgeDelivery() { if (failAck) throw new Error("lost ACK"); active = null; Object.assign(inspection, afterAck); },
  };
  const options = { filename: path.join(root, "state.sqlite"), web, available: () => true, assertStart: async () => {},
    findRun: async (id) => runs.get(id),
    approve: async (context) => {
      assert.equal(context.agreement.status, "APPROVED");
      assert.equal(context.webSession.activeDeliveryId, null);
      const run = { runId: context.reservedRunId, preparationId: context.preparationId, baseCommit: "base", version: 1, phase: "WORKER_RUNNING" };
      runs.set(run.runId, run); return { ...run, repository: { baseCommit: "base" } };
    } };
  let service = new PreparationService(options);
  t.after(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, runs, calls, get service() { return service; }, ackFailure(value) { failAck = value; },
    observe(value) { inspection = value; }, afterAck(value) { afterAck = value; },
    restart() { service.close(); service = new PreparationService(options); },
    start() { return service.execute("preparation.start", { requestId: "start", expectedVersion: 0,
      objective: "  아무거나\n", targetRoot: root, conversationUrl: "https://chatgpt.com/c/test" }); },
    command(type, extras = {}) { return service.execute(type, { requestId: type + Math.random(), expectedVersion: service.current.version, preparationId: service.current.preparationId, ...extras }); },
  };
}
test("start returns server identity before dispatch; question-only reply retains session and discussion", async (t) => {
  const f = fixture(t), first = await f.start();
  assert.equal(f.calls.length, 0);
  assert.equal(first.state, "INITIALIZING");
  assert.equal(first.objective, "  아무거나\n");
  assert.equal(first.deliveries[0].state, "RESERVED");
  await settled(f.service);
  assert.equal(f.service.current.state, "DISCUSSING");
  assert.equal(f.service.current.agreement.requirements.length, 0);
  assert.equal(f.service.current.deliveries[0].state, "ACKNOWLEDGED");
  await f.command("preparation.reply", { content: "채팅" }); await settled(f.service);
  assert.equal(new Set(f.calls).size, 1);
  assert.equal(f.service.current.state, "AGREEMENT_READY");
  assert.deepEqual(f.service.current.discussion.map((turn) => turn.sequence), [1, 2, 3, 4]);
  assert.equal(fs.existsSync(path.join(f.root, ".git")), false);
});
test("refresh/restart restores same preparation and receipt; approval retry yields one run", async (t) => {
  const f = fixture(t); await f.start(); await settled(f.service);
  await f.command("preparation.reply", { content: "채팅" }); await settled(f.service);
  const before = f.service.snapshot(); f.restart();
  assert.deepEqual(f.service.snapshot(), before);
  const input = { requestId: "approve", expectedVersion: before.version, preparationId: before.preparationId };
  const first = await f.service.execute("preparation.approve", input);
  const second = await f.service.execute("preparation.approve", input);
  assert.deepEqual(first, second); assert.equal(f.runs.size, 1);
  f.restart();
  assert.deepEqual(await f.service.execute("preparation.approve", input), first);
  await assert.rejects(f.command("preparation.reply", { content: "changed" }), /immutable/);
});
test("unacknowledged completed response reconciles without another Web turn", async (t) => {
  const f = fixture(t); f.ackFailure(true); await f.start(); await settled(f.service);
  assert.equal(f.service.current.state, "RECOVERY_REQUIRED");
  assert.equal(f.service.current.deliveries[0].state, "RESPONSE_COMPLETED");
  const session = f.service.current.webSession;
  const identity = { sessionId: session.sessionId, conversationId: session.conversationId,
    conversationUrl: session.conversationUrl, deliveryId: session.activeDeliveryId };
  await assert.rejects(f.command("web.reconcile", { ...identity, deliveryId: "wrong" }), /mismatch/);
  f.restart(); f.ackFailure(false);
  await f.command("web.reconcile", identity);
  assert.equal(f.service.current.deliveries[0].state, "ACKNOWLEDGED");
  assert.equal(f.service.current.webSession.activeDeliveryId, null);
  assert.equal(f.calls.length, 1);
});
test("stale version and reusing a request ID with different input are rejected", async (t) => {
  const f = fixture(t); await f.start(); await settled(f.service);
  await assert.rejects(f.command("preparation.reply", { expectedVersion: 1, content: "x" }), /version changed/);
  await assert.rejects(f.service.execute("preparation.start", { requestId: "start", expectedVersion: 0, objective: "different" }), /different command/);
});

for (const [label, observation] of Object.entries({
  run: { runId: "other" }, conversation: { conversationId: "other" },
  navigated: { observedConversationUrl: "https://chatgpt.com/c/other" },
  generating: { generating: true }, worker: { extensionBusy: true },
  response: { lastObservedAssistantMessageId: "other" },
})) {
  test(`ACK cannot settle delivery after ${label} evidence changes`, async (t) => {
    const f = fixture(t); f.afterAck(observation); await f.start(); await settled(f.service);
    assert.equal(f.service.current.state, "RECOVERY_REQUIRED");
    assert.equal(f.service.current.deliveries[0].state, "RESPONSE_COMPLETED");
    assert.ok(f.service.current.webSession.activeDeliveryId);
    assert.equal(f.service.current.discussion.length, 1);
  });
}

test("inspection never offers stop without an active delivery", async (t) => {
  const f = fixture(t); await f.start(); await settled(f.service);
  const session = f.service.current.webSession;
  f.observe({ generating: true, activeRequestId: null });
  await f.command("web.inspect", { sessionId: session.sessionId, conversationId: session.conversationId,
    conversationUrl: session.conversationUrl, deliveryId: null });
  assert.equal(f.service.current.diagnostics.canStop, false);
  assert.equal(f.service.capabilities().includes("web.stop"), false);
});

for (const mismatch of [{ conversationId: "other" }, { deliveryId: "other" }]) {
  test(`stop rejects mismatched ${Object.keys(mismatch)[0]} without dispatch`, async (t) => {
    const f = fixture(t); f.ackFailure(true); await f.start(); await settled(f.service);
    const session = f.service.current.webSession;
    f.observe({ generating: true, activeRequestId: session.activeDeliveryId });
    const identity = { sessionId: session.sessionId, conversationId: session.conversationId,
      conversationUrl: session.conversationUrl, deliveryId: session.activeDeliveryId };
    await f.command("web.inspect", identity);
    assert.equal(f.service.capabilities().includes("web.stop"), true);
    await assert.rejects(f.command("web.stop", { ...identity, ...mismatch }), { code: "DELIVERY_RECOVERY_MISMATCH" });
    assert.equal(f.service.current.webSession.activeDeliveryId, session.activeDeliveryId);
    assert.equal(f.calls.length, 1);
  });
}
