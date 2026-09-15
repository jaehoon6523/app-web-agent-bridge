import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PreparationService, workflowForRun } from "../src/orchestration/preparation-service.js";
import { normalizeDashboardState } from "../public/dashboard-model.js";
import { validateWebSessionBinding } from "../src/runtime/web/binding.js";

const tick = () => new Promise(setImmediate);
async function settled(service) {
  for (let i = 0; i < 50 && service.jobs.size; i++) await tick();
  assert.equal(service.jobs.size, 0);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-preparation-"));
  const runs = new Map(), calls = [];
  let binding, active = null, count = 0, failAck = false, inspection = {}, afterAck = {}, discarded = null;
  const web = {
    async resume(input) {
      validateWebSessionBinding(input.binding);
      binding = input.binding.conversationUrl === null
        ? { ...input.binding, conversationUrl: "https://chatgpt.com/", conversationId: null, bindingStatus: "ROOT_READY", tabId: 1, windowId: 2, documentId: "document-1", frameId: 0 }
        : { ...input.binding, bindingStatus: "BOUND", tabId: 1, windowId: 2, documentId: "document-1", frameId: 0 };
      calls.push(binding.sessionId); return binding;
    },
    async submitTurn(input) {
      if (binding.bindingStatus === "ROOT_READY") binding = { ...binding, conversationUrl: "https://chatgpt.com/c/new-conversation", conversationId: "new-conversation", bindingStatus: "BOUND" };
      active = input.turnId; count++;
      const parsed = count === 1 ? { type: "REQUIREMENTS_PROPOSAL", summary: "무엇을 만들까요?", questions: ["원하는 기능?"], items: [] }
        : { type: "REQUIREMENTS_PROPOSAL", summary: "채팅", questions: [], items: [{ statement: "메시지 전송", acceptanceCriteria: "목록에 한 번 표시" }] };
      binding = { ...binding, lastObservedUserMessageId: "u" + count, lastObservedAssistantMessageId: "a" + count };
      return { completion: Promise.resolve({ turnId: active, binding, confidence: "CONFIRMED_BY_UI_STATE",
        rawText: "<controller_packet>\n" + JSON.stringify(parsed) + "\n</controller_packet>" }) };
    },
    async inspectDelivery() { if (!binding) return { currentDeliveryId: null }; return { currentDeliveryId: active, sessionId: binding.sessionId, runId: binding.runId,
      conversationId: binding.conversationId, conversationUrl: binding.conversationUrl, observedConversationUrl: binding.conversationUrl,
      pageReachable: true, generating: false, pageBusy: false, extensionBusy: false,
      lastObservedUserMessageId: "u" + count, lastObservedAssistantMessageId: "a" + count, ...inspection }; },
    async acknowledgeDelivery() { if (failAck) throw new Error("lost ACK"); active = null; Object.assign(inspection, afterAck); },
    async discardDelivery(expected) {
      discarded = structuredClone(expected);
      active = null;
      Object.assign(inspection, { currentDeliveryId: null });
      return { ...expected, result: "discarded" };
    },
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
  return { root, runs, calls, web, get service() { return service; }, ackFailure(value) { failAck = value; },
    get discarded() { return discarded; },
    observe(value) { inspection = value; }, afterAck(value) { afterAck = value; },
    restart() { service.close(); service = new PreparationService(options); },
    start() { return service.execute("preparation.start", { requestId: "start",
      objective: "  아무거나\n", targetRoot: root, conversationUrl: "https://chatgpt.com/c/test" }); },
    command(type, extras = {}) { return service.execute(type, { requestId: type + Math.random(), preparationId: service.current.preparationId, ...extras }); },
  };
}
test("unresolved delivery can be explicitly discarded with confirmations and remains auditable", async (t) => {
  const f = fixture(t);
  await f.start();
  const before = f.service.current;
  const deliveryId = before.webSession.activeDeliveryId;
  f.web.inspectDelivery = async () => ({ currentDeliveryId: deliveryId, sessionId: before.webSession.sessionId,
    runId: before.preparationId, conversationUrl: before.webSession.conversationUrl, conversationId: before.webSession.conversationId });
  await f.command("preparation.discard", { unresolvedResultConfirmed: true, noAutomaticResendConfirmed: true, reason: "Original conversation is unavailable." });
  const after = f.service.current;
  const delivery = after.deliveries.find((item) => item.deliveryId === deliveryId);
  assert.equal(delivery.state, "RECOVERY_DISCARDED");
  assert.equal(after.webSession.activeDeliveryId, null);
  assert.equal(after.lifecycle, "ABANDONED");
  assert.equal(after.recovery.kind, "RECOVERY_DISCARDED");
  assert.equal(after.recovery.evidence.conversationUrl, before.webSession.conversationUrl);
  assert.equal(f.discarded.runId, before.preparationId);
  assert.equal(f.discarded.conversationUrl, before.webSession.conversationUrl);
  assert.ok(after.recovery.at);
});

test("discard refuses a delivery owned by a different extension preparation", async (t) => {
  const f = fixture(t);
  await f.start();
  const before = f.service.current;
  f.web.inspectDelivery = async () => ({ currentDeliveryId: "delivery-other", sessionId: "session-other", runId: "run-other" });
  await assert.rejects(
    f.command("preparation.discard", { unresolvedResultConfirmed: true, noAutomaticResendConfirmed: true, reason: "Check ownership." }),
    (error) => error.code === "DELIVERY_RECOVERY_MISMATCH",
  );
  assert.equal(f.discarded, null);
  assert.equal(f.service.current.webSession.activeDeliveryId, before.webSession.activeDeliveryId);
});

test("root bootstrap timeout discard uses the canonical preparation and session identity", async (t) => {
  const f = fixture(t);
  await f.service.execute("preparation.start", { requestId: "start-root-discard",
    objective: "안녕", targetRoot: f.root, conversationUrl: "https://chatgpt.com/" });
  const context = f.service.current;
  const delivery = context.deliveries.find((item) => item.deliveryId === context.webSession.activeDeliveryId);
  f.web.inspectDelivery = async () => ({ currentDeliveryId: delivery.deliveryId, sessionId: context.webSession.sessionId,
    runId: context.preparationId, conversationUrl: "https://chatgpt.com/", conversationId: null });
  context.state = "RECOVERY_REQUIRED";
  context.error = { code: "NEW_CONVERSATION_TIMEOUT", message: "Conversation URL was not created.", details: null };
  context.webSession.bindingState = "RECOVERY_REQUIRED";
  context.webSession.conversationUrl = "https://chatgpt.com/";
  context.webSession.conversationId = null;
  delivery.state = "RECOVERY_REQUIRED";
  delete delivery.runId;
  delete delivery.conversationUrl;
  await f.command("preparation.discard", { unresolvedResultConfirmed: true,
    noAutomaticResendConfirmed: true, reason: "No ChatGPT response was observed." });
  assert.equal(f.discarded.currentDeliveryId, delivery.deliveryId);
  assert.equal(f.discarded.sessionId, context.webSession.sessionId);
  assert.equal(f.discarded.runId, context.preparationId);
  assert.equal(f.discarded.conversationUrl, "https://chatgpt.com/");
  assert.equal(f.discarded.conversationId, null);
  assert.equal(context.lifecycle, "ABANDONED");
});
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

test("ChatGPT start page bootstraps a newly created exact conversation", async (t) => {
  const f = fixture(t);
  const first = await f.service.execute("preparation.start", {
    requestId: "start-root", objective: "아무거나", targetRoot: f.root,
    conversationUrl: "https://chatgpt.com/",
  });
  assert.equal(first.conversationUrl, "https://chatgpt.com/");
  assert.equal(first.webSession.conversationUrl, null);
  await settled(f.service);
  assert.equal(f.service.current.state, "DISCUSSING");
  assert.equal(f.service.current.conversationUrl, "https://chatgpt.com/c/new-conversation");
  assert.equal(f.service.current.webSession.conversationId, "new-conversation");
});

test("a new root preparation supersedes a prior recovery-required delivery", async (t) => {
  const f = fixture(t);
  const submitTurn = f.web.submitTurn;
  f.web.submitTurn = async (input) => {
    await submitTurn(input);
    throw Object.assign(new Error("lost response"), { code: "MANUAL_INTERVENTION_DETECTED" });
  };
  await f.service.execute("preparation.start", {
    requestId: "start-old", objective: "old", targetRoot: f.root, conversationUrl: "https://chatgpt.com/",
  });
  await settled(f.service);
  const old = f.service.current;
  assert.equal(old.state, "RECOVERY_REQUIRED");
  const oldDeliveryId = old.webSession.activeDeliveryId;
  const next = await f.service.execute("preparation.start", {
    requestId: "start-new", objective: "new", targetRoot: f.root, conversationUrl: "https://chatgpt.com/",
  });
  assert.equal(old.lifecycle, "ABANDONED");
  assert.equal(f.service.current.preparationId, next.preparationId);
  assert.equal(f.discarded.currentDeliveryId, oldDeliveryId);
});

test("connection must succeed before entering preparation; absent tab never sends or enables approval", async (t) => {
  const f = fixture(t);
  let rejectConnection, sent = 0;
  f.web.resume = ({ focus }) => {
    assert.equal(focus, false);
    return new Promise((resolve, reject) => { rejectConnection = reject; });
  };
  f.web.submitTurn = async () => { sent++; throw new Error("unexpected send"); };
  await f.start(); await tick();
  const snapshot = { runs: [], run: null, commandCapabilities: [] };
  const pending = await f.service.project(snapshot);
  assert.equal(pending.workflow.stage, "START");
  assert.equal(pending.workflow.state, "CONNECTING_WEB");
  rejectConnection(Object.assign(new Error("Conversation tab missing"), { code: "NEEDS_REBIND" }));
  await settled(f.service);
  const failed = await f.service.project(snapshot);
  assert.equal(failed.workflow.stage, "START");
  assert.equal(failed.preparation.state, "WEB_BLOCKED");
  assert.equal(sent, 0);
  assert.ok(failed.commandCapabilities.includes("preparation.start"));
  assert.ok(!failed.commandCapabilities.includes("preparation.approve"));
});

test("result projection never attaches an unrelated preparation or its commands", async (t) => {
  const f = fixture(t); await f.start(); await settled(f.service);
  const run = { runId: "old-run", phase: "CANCELLED", version: 2 };
  const snapshot = { run, runs: [run], commandCapabilities: ["state.get"] };
  const selected = await f.service.project(snapshot, { runId: run.runId });
  assert.equal(selected.workflow.stage, "RESULT");
  assert.equal(selected.workflow.preparationId, null);
  assert.equal(selected.preparation, null);
  assert.deepEqual(selected.commandCapabilities, ["state.get"]);
  await f.command("preparation.cancel");
  const automatic = await f.service.project(snapshot);
  assert.equal(automatic.workflow.preparationId, null);
  assert.equal(automatic.preparation, null);
  assert.ok(automatic.commandCapabilities.includes("preparation.start"));
});

test("first response must be stored and acknowledged before preparation is shown", async (t) => {
  const f = fixture(t), submit = f.web.submitTurn;
  let release;
  f.web.submitTurn = async (input) => {
    const handle = await submit(input);
    return { completion: new Promise(resolve => { release = async () => resolve(await handle.completion); }) };
  };
  await f.start(); await tick(); await tick();
  const snapshot = { runs: [], run: null, commandCapabilities: [] };
  const pending = await f.service.project(snapshot);
  assert.equal(pending.workflow.stage, "START");
  assert.equal(pending.workflow.state, "WAITING_WEB_RESPONSE");
  assert.equal(normalizeDashboardState(pending).workflow.state, "WAITING_WEB_RESPONSE");
  assert.equal(pending.run, null);
  assert.ok(!pending.commandCapabilities.includes("preparation.approve"));
  await release(); await settled(f.service);
  assert.equal((await f.service.project(snapshot)).workflow.stage, "PREPARE");
});

test("run transitions preserve in-progress and terminal meaning across frontend validation", () => {
  for (const [phase, stage] of [["STOPPING", "WORK"], ["HOLD", "WORK"], ["RECOVERY_REQUIRED", "WORK"],
    ["COMPLETE", "RESULT"], ["CANCELLED", "RESULT"], ["APPLIED", "RESULT"], ["APPLYING", "WORK"]]) {
    const run = { runId: "run-test", version: 1, phase };
    const workflow = workflowForRun(run);
    assert.equal(workflow.stage, stage);
    assert.equal(workflow.state, phase);
    assert.equal(normalizeDashboardState({ run, workflow }).workflow.stage, stage);
  }
});

test("heuristic response with a valid final controller packet is accepted", async (t) => {
  const f = fixture(t), submit = f.web.submitTurn;
  f.web.submitTurn = async (input) => {
    const handle = await submit(input);
    return { completion: handle.completion.then(response => ({ ...response, confidence: "HEURISTIC" })) };
  };
  await f.start(); await settled(f.service);
  const context = f.service.current;
  assert.equal(context.error, null);
  assert.ok(context.deliveries[0].response);
  assert.equal(context.webSession.activeDeliveryId, null);
  assert.equal(context.discussion.length, 2);
  assert.equal((await f.service.project({ runs: [], run: null, commandCapabilities: [] })).workflow.stage, "PREPARE");
  assert.ok(!f.service.capabilities().includes("preparation.approve"));
});

for (const recoverable of [true, false]) {
  test(`old manual delivery recovery gates new submission: ${recoverable}`, async (t) => {
    const f = fixture(t), resume = f.web.resume, inspect = f.web.inspectDelivery;
    let attempts = 0, recovered = false;
    const previous = { currentDeliveryId: "turn_123", runId: "manual_run_123", sessionId: "manual_session_123",
      conversationUrl: "https://chatgpt.com/c/old", completedDelivery: null };
    f.web.resume = async (input) => {
      if (++attempts === 1) throw Object.assign(new Error("blocked"), { code: "REBIND_DURING_ACTIVE_DELIVERY", details: previous });
      return resume(input);
    };
    f.web.recoverDelivery = async (expected) => {
      assert.deepEqual(expected, previous);
      if (!recoverable) throw Object.assign(new Error("Old tab missing"), { code: "DELIVERY_RECOVERY_UNCONFIRMED" });
      recovered = true;
    };
    f.web.inspectDelivery = async () => attempts === 1 ? { ...previous, currentDeliveryId: null } : inspect();
    await f.start(); await settled(f.service);
    assert.equal(recovered, recoverable);
    assert.equal(attempts, recoverable ? 2 : 1);
    assert.equal(f.service.current.state, recoverable ? "DISCUSSING" : "WEB_BLOCKED");
    assert.deepEqual(f.service.current.previousTestDelivery, previous);
    if (!recoverable) assert.match(f.service.current.error.message, /https:\/\/chatgpt.com\/c\/old/);
  });
}
test("refresh/restart restores same preparation and receipt; approval retry yields one run", async (t) => {
  const f = fixture(t); await f.start(); await settled(f.service);
  await f.command("preparation.reply", { content: "채팅" }); await settled(f.service);
  const before = f.service.snapshot(); f.restart();
  assert.deepEqual(f.service.snapshot(), before);
  const input = { requestId: "approve", preparationId: before.preparationId };
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
test("preparation commands no longer require a version and request IDs remain idempotent", async (t) => {
  const f = fixture(t); await f.start(); await settled(f.service);
  await assert.rejects(f.service.execute("preparation.start", { requestId: "start", objective: "different" }), /different command/);
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
