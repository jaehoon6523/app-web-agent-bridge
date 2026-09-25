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
  const runs = new Map(), calls = [], prompts = [];
  let binding, active = null, count = 0, failAck = false, inspection = {}, afterAck = {}, discarded = null;
  const web = {
    async inspect() {
      return { binding: binding ?? null };
    },
    async resume(input) {
      validateWebSessionBinding(input.binding);
      binding = input.binding.conversationUrl === null
        ? { ...input.binding, conversationUrl: "https://chatgpt.com/", conversationId: null, bindingStatus: "ROOT_READY", tabId: 1, windowId: 2, documentId: "document-1", frameId: 0 }
        : { ...input.binding, bindingStatus: "BOUND", tabId: 1, windowId: 2, documentId: "document-1", frameId: 0 };
      calls.push(binding.sessionId); return binding;
    },
    async submitTurn(input) {
      prompts.push(input.text);
      if (binding.bindingStatus === "ROOT_READY") binding = { ...binding, conversationUrl: "https://chatgpt.com/c/new-conversation", conversationId: "new-conversation", bindingStatus: "BOUND" };
      active = input.turnId; count++;
      const parsed = count === 1 ? { type: "REQUIREMENTS_PROPOSAL", summary: "무엇을 만들까요?", questions: ["원하는 기능?"], items: [] }
        : { type: "REQUIREMENTS_PROPOSAL", summary: "채팅", questions: [], items: [{ statement: "메시지 전송", acceptanceCriteria: "목록에 한 번 표시" }] };
      binding = { ...binding, lastObservedUserMessageId: "u" + count, lastObservedAssistantMessageId: "a" + count };
      return { completion: Promise.resolve({ turnId: active, binding, confidence: "CONFIRMED_BY_UI_STATE",
        trace: { requestId: active, actionId: active, bindingId: `${binding.sessionId}:${binding.runId}`,
          tabId: binding.tabId, documentId: binding.documentId, frameId: binding.frameId, result: "success" },
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
  return { root, runs, calls, prompts, web, get service() { return service; }, ackFailure(value) { failAck = value; },
    get discarded() { return discarded; },
    observe(value) { inspection = value; }, afterAck(value) { afterAck = value; },
    restart() { service.close(); service = new PreparationService(options); },
    start() { return service.execute("preparation.start", { requestId: "start",
      objective: "  아무거나\n", targetRoot: root, conversationUrl: "https://chatgpt.com/c/test" }); },
    command(type, extras = {}) { return service.execute(type, { requestId: type + Math.random(), preparationId: service.current.preparationId, ...extras }); },
  };
}
test("follow-up preparation binds an applied task in the same folder and keeps a new approval boundary", async (t) => {
  const f = fixture(t);
  f.runs.set("applied-1", { runId:"applied-1", phase:"APPLIED", projectRef:{ targetRoot:f.root },
    objective:"첫 인사", candidate:{ candidateId:"candidate-1" },
    requirements:{ items:[{ statement:"인사 표시", acceptanceCriteria:"화면에 표시" }] } });
  await f.service.execute("preparation.start", { requestId:"follow-up", objective:"인사를 바꿔줘",
    targetRoot:f.root, conversationUrl:"https://chatgpt.com/c/test", followUpRunId:"applied-1" });
  await settled(f.service);
  assert.equal(f.service.current.followUp.runId, "applied-1");
  assert.equal(f.service.current.agreement.status, "DISCUSSING");
  assert.match(f.prompts[0], /이전 적용 작업/u);
  assert.match(f.prompts[0], /인사 표시/u);
  assert.match(f.prompts[0], /이전 요구사항·승인·감사 PASS는 새 작업에 적용되지 않는다/u);
  f.restart();
  assert.equal(f.service.current.followUp.candidateId, "candidate-1");
});
test("follow-up rejects unavailable, unfinished, and different-folder tasks before web dispatch", async (t) => {
  const f = fixture(t);
  const attempt = (id, requestId) => f.service.execute("preparation.start", { requestId,
    objective:"다음 작업", targetRoot:f.root, conversationUrl:"https://chatgpt.com/c/test", followUpRunId:id });
  await assert.rejects(attempt("deleted", "deleted"), { code:"FOLLOW_UP_UNAVAILABLE" });
  f.runs.set("pending", { runId:"pending", phase:"AWAITING_APPLY", projectRef:{ targetRoot:f.root } });
  await assert.rejects(attempt("pending", "pending"), { code:"FOLLOW_UP_UNAVAILABLE" });
  f.runs.set("other", { runId:"other", phase:"APPLIED", projectRef:{ targetRoot:"/another-project" } });
  await assert.rejects(attempt("other", "other"), { code:"FOLLOW_UP_PROJECT_MISMATCH" });
  assert.equal(f.service.current, null);
  assert.equal(f.prompts.length, 0);
});
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
  const resume = f.web.resume;
  let rootFocus = null;
  f.web.resume = async (input) => {
    rootFocus = input.focus;
    return resume(input);
  };
  const first = await f.service.execute("preparation.start", {
    requestId: "start-root", objective: "아무거나", targetRoot: f.root,
    conversationUrl: "https://chatgpt.com/", autoApproveOnReady: true,
  });
  assert.equal(first.conversationUrl, "https://chatgpt.com/");
  assert.equal(first.autoApproveOnReady, true);
  assert.equal(first.webSession.conversationUrl, null);
  await settled(f.service);
  assert.equal(rootFocus, true);
  assert.equal(f.service.current.state, "DISCUSSING");
  assert.equal(f.service.current.conversationUrl, "https://chatgpt.com/c/new-conversation");
  assert.equal(f.service.current.webSession.conversationId, "new-conversation");
  assert.equal(f.service.current.autoApproveOnReady, true);
});

test("confirmed project conversation persists and is reused only for its exact folder and URL", async (t) => {
  const f = fixture(t);
  const first = await f.service.execute("preparation.start", {
    requestId:"project-first", objective:"첫 작업", targetRoot:f.root, conversationUrl:"https://chatgpt.com/",
  });
  await settled(f.service);
  const savedUrl = f.service.current.conversationUrl;
  assert.equal(savedUrl, "https://chatgpt.com/c/new-conversation");
  assert.equal(f.service.data.projectConversations[f.root].conversationUrl, savedUrl);
  await f.command("preparation.cancel");
  f.restart();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "project-chat-other-"));
  t.after(() => fs.rmSync(other, { recursive:true, force:true }));
  const reuse = (requestId, targetRoot, conversationUrl) => f.service.execute("preparation.start", {
    requestId, objective:"다음 작업", targetRoot, conversationUrl, reuseProjectConversation:true,
  });
  await assert.rejects(reuse("wrong-folder", other, savedUrl), { code:"PROJECT_CONVERSATION_UNAVAILABLE" });
  await assert.rejects(reuse("wrong-url", f.root, "https://chatgpt.com/"), { code:"PROJECT_CONVERSATION_CHANGED" });
  const next = await reuse("project-next", f.root, savedUrl);
  assert.equal(next.projectConversationSource, first.preparationId);
  assert.equal(next.conversationUrl, savedUrl);
  assert.equal(next.webSession.conversationId, "new-conversation");
  assert.equal(f.calls.length, 1, "No second Web turn is sent before exact binding succeeds");
  await settled(f.service);
  assert.match(f.prompts.at(-1), /이전 승인·완료 기준·후보·적용 권한은 새 작업으로 승계되지 않는다/);
});

test("a new root preparation preserves a prior recovery-required delivery without inspecting or discarding it", async (t) => {
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
  assert.equal(old.lifecycle, "ACTIVE");
  assert.equal(old.webSession.activeDeliveryId, oldDeliveryId);
  assert.equal(f.service.current.preparationId, next.preparationId);
  assert.equal(f.discarded, null);
});

test("cross-session active-delivery block is classified as stale extension runtime", async (t) => {
  const f = fixture(t);
  let sent = 0;
  f.web.resume = async ({ binding }) => {
    assert.ok(binding.sessionId.startsWith("web_prep_"));
    assert.ok(binding.runId.startsWith("prep_"));
    throw Object.assign(
      new Error("A different Web session cannot replace a persisted binding during an active delivery."),
      {
        code: "REBIND_DURING_ACTIVE_DELIVERY",
        details: {
          currentDeliveryId: "delivery-old",
          sessionId: "web_prep_old",
          runId: "prep_old",
          conversationUrl: "https://chatgpt.com/",
          bindingStatus: "AMBIGUOUS",
          extensionBusy: false,
          pageReachable: false,
        },
      },
    );
  };
  f.web.submitTurn = async () => {
    sent += 1;
    throw new Error("unexpected send");
  };
  await f.service.execute("preparation.start", {
    requestId: "stale-extension-runtime",
    objective: "new",
    targetRoot: f.root,
    conversationUrl: "https://chatgpt.com/",
  });
  await settled(f.service);
  const context = f.service.current;
  assert.equal(context.state, "WEB_BLOCKED");
  assert.equal(context.lifecycle, "ABANDONED");
  assert.equal(context.webSession.activeDeliveryId, null);
  assert.equal(context.error.code, "EXTENSION_RUNTIME_STALE");
  assert.equal(context.error.details.originalCode, "REBIND_DURING_ACTIVE_DELIVERY");
  assert.equal(context.error.details.expectedSessionId, context.webSession.sessionId);
  assert.equal(context.error.details.expectedRunId, context.preparationId);
  assert.equal(context.error.details.blockingSessionId, "web_prep_old");
  assert.equal(context.error.details.blockingRunId, "prep_old");
  assert.equal(context.error.details.currentDeliveryId, "delivery-old");
  assert.equal(context.error.details.reloadRequired, true);
  assert.equal(sent, 0);
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

test("a new preparation never inspects or recovers another Web session's delivery", async (t) => {
  const f = fixture(t);
  const inspections = [];
  let recovered = 0;
  const inspect = f.web.inspectDelivery;
  f.web.inspectDelivery = async (...args) => {
    const result = await inspect(...args);
    inspections.push(result);
    return result;
  };
  f.web.recoverDelivery = async () => { recovered++; throw new Error("must not recover another session"); };
  await f.start(); await settled(f.service);
  assert.equal(recovered, 0);
  assert.ok(inspections.length > 0);
  assert.ok(inspections.every((item) => item.sessionId === f.service.current.webSession.sessionId),
    "every inspection must belong to the new preparation session");
  assert.equal(f.service.current.state, "DISCUSSING");
});
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

test("reconcile restores a missing local adapter binding before acknowledgement", async (t) => {
  const f = fixture(t); f.ackFailure(true); await f.start(); await settled(f.service);
  const session = f.service.current.webSession;
  const identity = { sessionId: session.sessionId, conversationId: session.conversationId,
    conversationUrl: session.conversationUrl, deliveryId: session.activeDeliveryId };
  f.web.inspect = async () => ({ binding:null });
  f.ackFailure(false);
  await f.command("web.reconcile", identity);
  assert.equal(f.calls.length, 2, "missing local binding must resume exactly once");
  assert.equal(f.service.current.deliveries[0].state, "ACKNOWLEDGED");
});

test("reconcile rejects a rebound adapter with different durable identity", async (t) => {
  const f = fixture(t); f.ackFailure(true); await f.start(); await settled(f.service);
  const session = f.service.current.webSession;
  const identity = { sessionId: session.sessionId, conversationId: session.conversationId,
    conversationUrl: session.conversationUrl, deliveryId: session.activeDeliveryId };
  f.web.inspect = async () => ({ binding:null });
  f.web.resume = async ({ binding }) => ({ ...binding, runId:"different-run", bindingStatus:"BOUND" });
  f.ackFailure(false);
  await assert.rejects(f.command("web.reconcile", identity), { code:"DELIVERY_RECOVERY_MISMATCH" });
  assert.equal(f.service.current.deliveries[0].state, "RESPONSE_COMPLETED");
  assert.equal(f.service.current.webSession.activeDeliveryId, identity.deliveryId);
});

test("explicit preparation reconcile allows one manual follow-up adoption", async (t) => {
  const f = fixture(t); f.ackFailure(true); await f.start(); await settled(f.service);
  const session = f.service.current.webSession;
  const identity = { sessionId: session.sessionId, conversationId: session.conversationId,
    conversationUrl: session.conversationUrl, deliveryId: session.activeDeliveryId };
  const originalInspect = f.web.inspectDelivery.bind(f.web);
  let options = null;
  f.web.inspectDelivery = async (value = {}) => {
    if (value.refreshCompleted) options = structuredClone(value);
    return originalInspect(value);
  };
  f.ackFailure(false);
  await f.command("web.reconcile", identity);
  assert.deepEqual(options, { refreshCompleted:true, adoptManualFollowup:true });
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
