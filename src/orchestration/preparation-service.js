import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../domain/canonical-json.js";
import { createWebSessionBinding } from "../runtime/web/binding.js";
import { parseFinalControllerPacketJsonEnvelope } from "../domain/controller-packet-envelope.js";

function fail(message, code = "PREPARATION_CONFLICT") { throw Object.assign(new Error(message), { code }); }
const stamp = () => new Date().toISOString();
const terminal = new Set(["APPLIED", "CANCELLED", "FAILED", "INCONCLUSIVE", "COMPLETE"]);

export function workflowForRun(run) {
  const phase = run.phase ?? run.stage;
  const result = phase;
  const results = new Set(["AWAITING_APPLY", "APPLIED", "COMPLETE", "CANCELLED", "INCONCLUSIVE", "FAILED"]);
  const state = results.has(result) ? result : ({
    CREATED: "RUN_CREATED", CANDIDATE_CAPTURE: "VERIFYING", REPORT_REPAIR: "REVIEW_RUNNING",
    EVIDENCE_SUPPLEMENT: "REVIEW_RUNNING",
  }[phase] ?? (["RUN_CREATED", "PROVISIONING", "WORKER_RUNNING", "VERIFYING", "REVIEW_RUNNING", "REWORK", "APPLYING", "STOPPING", "HOLD", "RECOVERY_REQUIRED"].includes(phase) ? phase : "RECOVERY_REQUIRED"));
  return { stage: results.has(state) ? "RESULT" : "WORK", state, runId: run.runId, runVersion: run.version };
}

/** Owns preparation identity, durable receipts, and all PREPARE transitions.
 * @param is intentionally kept in the injected boundaries for testability.
 */
export class PreparationService {
  /** @param {{filename:string, web:any, available:Function, assertStart:Function, approve:Function, findRun:Function}} options */
  constructor({ filename, web, available, assertStart, approve, findRun }) {
    this.web = web; this.available = available; this.assertStart = assertStart;
    this.approveRun = approve; this.findRun = findRun; this.jobs = new Map(); this.closed = false;
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS preparation_state (id INTEGER PRIMARY KEY, json TEXT NOT NULL) STRICT;");
    const row = this.db.prepare("SELECT json FROM preparation_state WHERE id=1").get();
    this.data = row ? JSON.parse(String(row.json)) : { currentId: null, contexts: {}, receipts: {} };
    for (const context of Object.values(this.data.contexts)) {
      if (context.lifecycle !== "ACTIVE") continue;
      if (context.resultingRunId) continue;
      if (context.webSession.activeDeliveryId || context.state === "APPROVING") {
        context.state = "RECOVERY_REQUIRED"; context.webSession.bindingState = "RECOVERY_REQUIRED";
        context.version++; context.updatedAt = stamp();
      }
    }
    this.save();
    this.unsubscribe = web?.onEvent?.((event) => {
      const context = this.current;
      if (this.closed || !context || event.type !== "TEXT_DELTA" || event.sessionId !== context.webSession.sessionId) return;
      const delivery = context.deliveries.find((d) => d.deliveryId === event.turnId && d.deliveryId === context.webSession.activeDeliveryId);
      if (delivery && ["DISPATCHING", "SUBMITTED"].includes(delivery.state)) {
        delivery.state = "RESPONSE_STARTED"; this.touch(context);
      }
    });
  }
  get current() { return this.data.contexts[this.data.currentId] ?? null; }
  get busy() { return this.jobs.size > 0 || this.current?.lifecycle === "ACTIVE"; }
  save() {
    if (this.closed) return;
    this.db.prepare("INSERT INTO preparation_state VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(canonicalJson(this.data));
  }
  touch(context) { context.version++; context.updatedAt = stamp(); this.save(); }
  snapshot() { return structuredClone(this.current); }
  receipt(requestId) {
    const receipt = this.data.receipts[requestId];
    return { requestId, status: receipt?.status ?? "NOT_FOUND" };
  }
  async execute(type, input) {
    if (this.closed) fail("Server is closing.");
    if (!input || typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 200
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) fail("requestId and expectedVersion are required.", "INVALID_COMMAND");
    const hash = canonicalJson({ type, input });
    const previous = this.data.receipts[input.requestId];
    if (previous) {
      if (previous.hash !== hash) fail("requestId identifies a different command.", "REQUEST_ID_CONFLICT");
      if (previous.status === "FAILED") fail(previous.error.message, previous.error.code);
      if (previous.status === "COMPLETED") return structuredClone(previous.result);
      fail("Previous request is processing or requires recovery. No automatic resubmission.", "UNKNOWN_RESULT");
    }
    if (this.jobs.has("mutation")) fail("Another preparation command is processing.");
    const receipt = { hash, status: "PROCESSING", result: null, error: null };
    this.data.receipts[input.requestId] = receipt; this.save();
    this.jobs.set("mutation", true);
    try {
      const result = await this.dispatch(type, input);
      receipt.result = structuredClone(result); receipt.status = "COMPLETED"; this.save();
      return result;
    } catch (error) {
      receipt.error = { code: error.code ?? "PREPARATION_FAILED", message: error.message };
      receipt.status = "FAILED"; this.save(); throw error;
    } finally { this.jobs.delete("mutation"); }
  }
  context(input) {
    const context = this.current;
    if (!context || context.preparationId !== input.preparationId) fail("Preparation identity changed.");
    if (input.expectedVersion !== context.version) fail("Preparation version changed.", "PREPARATION_VERSION_CONFLICT");
    return context;
  }
  async dispatch(type, input) {
    if (type === "preparation.start") {
      if (input.expectedVersion !== 0 || this.current?.lifecycle === "ACTIVE") fail("Finish or explicitly cancel the current preparation.");
      await this.assertStart();
      if (!this.available()) fail("Connect the browser extension.", "WEB_BLOCKED");
      if (typeof input.objective !== "string" || !input.objective.trim()
        || !/^https:\/\/chatgpt\.com\/c\/[^/?#\s]+$/u.test(input.conversationUrl)) fail("Objective and exact conversation URL are required.", "INVALID_INPUT");
      if (typeof input.targetRoot !== "string" || !path.isAbsolute(input.targetRoot)) fail("Select an absolute project folder.", "INVALID_INPUT");
      const targetRoot = fs.realpathSync(input.targetRoot);
      if (!fs.statSync(targetRoot).isDirectory() || path.parse(targetRoot).root === targetRoot) fail("Select a project folder.", "INVALID_INPUT");
      const preparationId = "prep_" + randomUUID();
      const context = {
        preparationId, version: 1, stage: "PREPARE", state: "INITIALIZING", lifecycle: "ACTIVE",
        objective: input.objective, targetRoot, conversationUrl: input.conversationUrl,
        webSession: { sessionId: "web_" + preparationId, conversationId: input.conversationUrl.split("/").at(-1),
          conversationUrl: input.conversationUrl, tabId: null, windowId: null, bindingState: "UNBOUND",
          activeDeliveryId: null, lastObservedUserMessageId: null, lastObservedAssistantMessageId: null },
        discussion: [], agreement: { status: "DISCUSSING", summary: "", unresolvedQuestions: [], requirements: [] },
        deliveries: [], repository: null, resultingRunId: null, reservedRunId: null, error: null,
        createdAt: stamp(), updatedAt: stamp(),
      };
      this.data.currentId = preparationId; this.data.contexts[preparationId] = context;
      console.info("[bridge:preparation:start]", { preparationId, sessionId: context.webSession.sessionId });
      this.reserve(context, input.objective);
      return this.snapshot();
    }
    const context = this.context(input);
    if (type === "preparation.approve" && context.resultingRunId) return { runId: context.resultingRunId };
    if (context.lifecycle !== "ACTIVE" || (context.agreement.status === "APPROVED" && type !== "preparation.approve")) fail("Approved or closed preparation is immutable.");
    if (type === "preparation.reply") {
      if (!this.capabilities().includes(type)) fail("Reply is unavailable.");
      if (typeof input.content !== "string" || !input.content.trim()) fail("Enter an answer.", "INVALID_INPUT");
      this.reserve(context, input.content); return this.snapshot();
    }
    if (type === "preparation.cancel") {
      if (!this.capabilities().includes(type)) fail("Inspect and stop the active delivery before cancellation.");
      const delivery = context.deliveries.find((d) => d.deliveryId === context.webSession.activeDeliveryId);
      if (delivery) {
        const observed = await this.web.inspectDelivery(); this.setDiagnostics(context, observed);
        if (!context.diagnostics.canRecover) fail("Delivery termination is not confirmed.");
        await this.web.acknowledgeDelivery({ turnId: delivery.deliveryId });
        const ack = await this.web.inspectDelivery();
        if (ack.currentDeliveryId !== null || ack.sessionId !== context.webSession.sessionId
          || ack.conversationUrl !== context.webSession.conversationUrl) fail("Cancellation ACK is not confirmed.");
        delivery.state = "ACKNOWLEDGED"; delivery.cancelled = true; context.webSession.activeDeliveryId = null;
      }
      context.lifecycle = "ABANDONED"; this.touch(context); return this.snapshot();
    }
    if (type === "preparation.approve") {
      if (!this.capabilities().includes(type)) fail("Agreement is not ready for approval.");
      await this.assertStart();
      context.state = "APPROVING"; context.agreement.status = "APPROVED";
      context.reservedRunId ??= "code_" + randomUUID(); this.touch(context);
      try {
        const result = await this.approveRun(structuredClone(context));
        context.repository = result.repository; context.resultingRunId = result.runId;
        context.agreement.status = "APPROVED"; context.stage = "WORK"; context.lifecycle = "COMPLETED";
        this.touch(context); return { runId: result.runId };
      } catch (error) {
        const run = await this.findRun(context.reservedRunId);
        if (run) {
          context.resultingRunId = run.runId; context.agreement.status = "APPROVED";
          context.stage = "WORK"; context.lifecycle = "COMPLETED"; this.touch(context);
          return { runId: run.runId };
        }
        context.state = "FAILED"; context.error = { code: error.code ?? "APPROVAL_FAILED", message: error.message };
        this.touch(context); throw error;
      }
    }
    if (type.startsWith("web.")) return this.webCommand(context, type, input);
    fail("Unsupported preparation command.", "INVALID_COMMAND");
  }
  reserve(context, content) {
    const session = context.webSession, deliveryId = "delivery_" + randomUUID();
    context.error = null; context.diagnostics = null;
    context.agreement.status = "DISCUSSING"; context.state = "INITIALIZING";
    context.discussion.push({ turnId: "turn_" + randomUUID(), preparationId: context.preparationId,
      sequence: context.discussion.length + 1, actor: "USER", content, deliveryId: null, createdAt: stamp() });
    context.deliveries.push({ deliveryId, preparationId: context.preparationId, sessionId: session.sessionId,
      conversationId: session.conversationId, state: "RESERVED", response: null, createdAt: stamp() });
    session.activeDeliveryId = deliveryId; this.touch(context);
    // No Web response is awaited by the HTTP request. The intent is durable first.
    const job = new Promise((resolve) => setImmediate(resolve)).then(() => this.generate(context, deliveryId))
      .catch((error) => {
        if (this.closed) return;
        const delivery = context.deliveries.find((d) => d.deliveryId === deliveryId);
        const unsent = delivery.state === "RESERVED";
        delivery.state = unsent ? "FAILED" : delivery.response ? "RESPONSE_COMPLETED" : "RECOVERY_REQUIRED";
        if (unsent) context.webSession.activeDeliveryId = null;
        context.state = unsent ? "WEB_BLOCKED" : "RECOVERY_REQUIRED";
        if (unsent && !context.deliveries.some((item) => item.state === "ACKNOWLEDGED")) {
          context.lifecycle = "ABANDONED";
          session.bindingState = "UNBOUND";
        }
        context.error = { code: error.code ?? "WEB_FAILED", message: error.message, details: error.details ?? null };
        console.warn("[bridge:preparation:failed]", {
          preparationId: context.preparationId, sessionId: session.sessionId, deliveryId,
          code: error.code ?? "WEB_FAILED", unsent, state: context.state,
          blockingDeliveryId: error.details?.currentDeliveryId ?? null,
          blockingSessionId: error.details?.sessionId ?? null,
          blockingRunId: error.details?.runId ?? null,
        });
        this.touch(context);
      }).finally(() => this.jobs.delete(context.preparationId));
    this.jobs.set(context.preparationId, job);
  }
  async generate(context, deliveryId) {
    if (this.closed) return;
    const session = context.webSession, delivery = context.deliveries.find((d) => d.deliveryId === deliveryId);
    const runId = context.preparationId;
    session.bindingState = "BINDING"; this.touch(context);
    console.info("[bridge:preparation:binding]", { preparationId: runId, sessionId: session.sessionId, deliveryId });
    const request = { focus: true, binding: createWebSessionBinding({
      sessionId: session.sessionId, runId, title: null, bindingStatus: "NEEDS_REBIND",
      conversationId: session.conversationId, conversationUrl: session.conversationUrl,
      tabId: session.tabId, windowId: session.windowId,
      lastObservedUserMessageId: session.lastObservedUserMessageId,
      lastObservedAssistantMessageId: session.lastObservedAssistantMessageId,
    }) };
    let binding;
    try { binding = await this.web.resume(request); }
    catch (error) {
      const previous = error.details;
      if (error.code !== "REBIND_DURING_ACTIVE_DELIVERY"
        || !/^manual_run_\d+$/.test(previous?.runId ?? "")
        || !/^manual_session_\d+$/.test(previous?.sessionId ?? "")
        || !/^turn_\d+$/.test(previous?.currentDeliveryId ?? "")) throw error;
      // Preserve the old test's evidence before releasing its transport reservation.
      context.previousTestDelivery = structuredClone(previous); this.touch(context);
      try {
        await this.web.recoverDelivery(previous);
        const observed = await this.web.inspectDelivery();
        if (observed.currentDeliveryId !== null || observed.sessionId !== previous.sessionId
          || observed.runId !== previous.runId || observed.conversationUrl !== previous.conversationUrl) {
          fail("이전 테스트 전송의 정리가 확인되지 않았습니다.", "DELIVERY_RECOVERY_MISMATCH");
        }
      } catch (recoveryError) {
        recoveryError.message = "이전 브릿지 테스트 대화(" + previous.conversationUrl
          + ")를 브라우저에서 하나만 열고 생성이 끝난 뒤 다시 시작하세요. " + recoveryError.message;
        throw recoveryError;
      }
      binding = await this.web.resume(request);
    }
    if (this.closed) return;
    if (binding.sessionId !== session.sessionId || binding.conversationId !== session.conversationId) fail("Web binding changed.");
    Object.assign(session, { tabId: binding.tabId, windowId: binding.windowId, bindingState: "BOUND" });
    delivery.state = "DISPATCHING"; context.state = "WAITING_WEB_RESPONSE"; this.touch(context);
    const text = '너는 구현 설계자다. 구현, 저장소 변경, 승인하지 말고 사용자와 작업 범위 및 완료 기준을 합의한다. 모호한 요청은 질문이나 선택지를 반환하고 완료 기준을 억지로 만들지 않는다. 한국어로 답한다. 응답 마지막에 독립된 <controller_packet> 및 </controller_packet> 줄로 JSON을 감싼다: {"type":"REQUIREMENTS_PROPOSAL","summary":"설명","questions":["미해결 질문"],"items":[{"statement":"기능","acceptanceCriteria":"관찰 가능한 동작"}]}. 질문만 있으면 items는 빈 배열이다. 검증 방식은 코드 스냅샷 검토이며 실행 테스트를 수행했다고 주장하지 않는다.\n기존 준비 문맥:\n'
      + JSON.stringify({ preparationId: context.preparationId, discussion: context.discussion, agreement: context.agreement })
      + "\n사용자의 첫 부탁:\n" + context.objective;
    const handle = await this.web.submitTurn({ runId, turnId: deliveryId, controllerMessageId: deliveryId, text,
      parseResponse: (raw) => ({ body: raw, packetText: raw, packet: { type: "PLANNING_RESPONSE" } }) });
    if (delivery.state === "DISPATCHING") delivery.state = "SUBMITTED";
    this.touch(context);
    const response = await handle.completion;
    if (this.closed) return;
    if (response.turnId !== deliveryId || response.binding?.sessionId !== session.sessionId
      || response.binding?.runId !== runId || response.binding?.conversationId !== session.conversationId) fail("Response identity changed.");
    delivery.response = response; delivery.state = "RESPONSE_COMPLETED"; this.touch(context);
    await this.complete(context, delivery);
  }
  async complete(context, delivery) {
    const session = context.webSession;
    const observed = await this.web.inspectDelivery();
    this.setDiagnostics(context, observed);
    const pointerMatches = observed.currentDeliveryId === delivery.deliveryId;
    const response = delivery.response;
    const userMessageId = response?.evidence?.userMessageId ?? response?.binding?.lastObservedUserMessageId;
    const assistantMessageId = response?.evidence?.assistantMessageId ?? response?.binding?.lastObservedAssistantMessageId;
    const check = (name, expected, actual) => ({ name, expected: expected ?? null, actual: actual ?? null,
      passed: expected !== undefined && actual === expected });
    const checks = [
      check("대화 연결", true, context.diagnostics.exactConversation),
      check("응답 전송 ID", delivery.deliveryId, response?.turnId),
      check("응답 세션 ID", session.sessionId, response?.binding?.sessionId),
      check("응답 작업 ID", context.preparationId, response?.binding?.runId),
      check("응답 대화 ID", session.conversationId, response?.binding?.conversationId),
      check("전송 소유권", true, observed.currentDeliveryId === null || pointerMatches),
      check("생성 종료", false, observed.generating),
      check("페이지 처리 종료", false, observed.pageBusy),
      check("확장 처리 종료", false, observed.extensionBusy),
      check("사용자 메시지 증거", true, Boolean(userMessageId)),
      check("답변 메시지 증거", true, Boolean(assistantMessageId)),
      check("사용자 메시지 일치", userMessageId, observed.lastObservedUserMessageId),
      check("답변 메시지 일치", assistantMessageId, observed.lastObservedAssistantMessageId),
      check("응답 신뢰도", "CONFIRMED_BY_UI_STATE", response?.confidence),
    ];
    delivery.validation = { status: checks.every(item => item.passed) ? "CONFIRMED" : "FAILED", checks };
    this.touch(context);
    if (delivery.validation.status === "FAILED") {
      const failed = checks.filter(item => !item.passed);
      console.warn("[bridge:completion:unconfirmed]", { deliveryId: delivery.deliveryId, checks: failed });
      throw Object.assign(new Error("응답 확인 실패: " + failed.map(item => item.name).join(", ")),
        { code: "COMPLETION_EVIDENCE_MISMATCH", details: { checks: failed } });
    }
    let parsed;
    try { parsed = parseFinalControllerPacketJsonEnvelope(delivery.response.rawText).parsed; }
    catch {
      delivery.validation.format = "INVALID"; this.touch(context);
      fail("응답에 준비 제안 형식이 없습니다. 원문은 보존되어 있으며 승인할 수 없습니다.", "INVALID_AGREEMENT");
    }
    if (parsed.type !== "REQUIREMENTS_PROPOSAL" || typeof parsed.summary !== "string"
      || !Array.isArray(parsed.questions) || parsed.questions.some((q) => typeof q !== "string" || !q.trim())
      || !Array.isArray(parsed.items) || parsed.items.length > 30
      || (!parsed.items.length && !parsed.questions.length)
      || parsed.items.some((r) => typeof r.statement !== "string" || !r.statement.trim()
        || typeof r.acceptanceCriteria !== "string" || !r.acceptanceCriteria.trim())) fail("Invalid designer response.", "INVALID_AGREEMENT");
    delivery.validation.format = "CONFIRMED";
    delivery.processingState = "ACK_PENDING"; this.touch(context);
    if (pointerMatches) {
      await this.web.acknowledgeDelivery({ turnId: delivery.deliveryId });
      const ack = await this.web.inspectDelivery();
      this.setDiagnostics(context, ack);
      if (ack.currentDeliveryId !== null || !context.diagnostics.exactConversation
        || ack.conversationUrl !== session.conversationUrl || ack.generating !== false
        || ack.pageBusy !== false || ack.extensionBusy !== false
        || ack.lastObservedUserMessageId !== userMessageId
        || ack.lastObservedAssistantMessageId !== assistantMessageId) fail("응답은 저장됐지만 전송 정리 확인이 끝나지 않았습니다.", "ACK_UNCONFIRMED");
    }
    await this.web.confirmDeliveryAcknowledgement?.({ turnId: delivery.deliveryId, sessionId: session.sessionId,
      runId: context.preparationId, conversationUrl: session.conversationUrl });
    if (!context.discussion.some((t) => t.deliveryId === delivery.deliveryId)) context.discussion.push({
      turnId: "turn_" + randomUUID(), preparationId: context.preparationId, sequence: context.discussion.length + 1,
      actor: "WEB_DESIGNER", content: parsed.summary, deliveryId: delivery.deliveryId, createdAt: stamp(),
    });
    context.agreement = { status: parsed.questions.length ? "DISCUSSING" : "READY",
      summary: parsed.summary, unresolvedQuestions: parsed.questions, requirements: parsed.items };
    Object.assign(session, { activeDeliveryId: null, lastObservedUserMessageId: observed.lastObservedUserMessageId,
      lastObservedAssistantMessageId: observed.lastObservedAssistantMessageId });
    delivery.state = "ACKNOWLEDGED"; delivery.processingState = "COMPLETE"; context.error = null;
    context.state = context.agreement.status === "READY" ? "AGREEMENT_READY" : "DISCUSSING"; this.touch(context);
  }
  setDiagnostics(context, observed) {
    const session = context.webSession;
    const exactConversation = observed.pageReachable === true && observed.observedConversationUrl === session.conversationUrl
      && observed.sessionId === session.sessionId && observed.conversationId === session.conversationId
      && observed.runId === context.preparationId;
    const exactDelivery = exactConversation && typeof session.activeDeliveryId === "string"
      && observed.currentDeliveryId === session.activeDeliveryId;
    context.diagnostics = { ...observed, exactConversation,
      canFocus: exactConversation, canStop: exactDelivery && observed.generating === true && observed.activeRequestId === session.activeDeliveryId,
      canRecover: exactDelivery && observed.generating === false && observed.pageBusy === false && observed.extensionBusy === false };
    console.info("[bridge:preparation:diagnostics]", {
      preparationId: context.preparationId, sessionId: session.sessionId,
      expectedDeliveryId: session.activeDeliveryId,
      observedSessionId: observed.sessionId, observedRunId: observed.runId,
      observedDeliveryId: observed.currentDeliveryId, exactConversation, exactDelivery,
      generating: observed.generating, pageBusy: observed.pageBusy, extensionBusy: observed.extensionBusy,
      canRecover: context.diagnostics.canRecover,
    });
  }
  async webCommand(context, type, input) {
    const session = context.webSession;
    for (const [key, value] of Object.entries({ sessionId: session.sessionId, conversationId: session.conversationId,
      conversationUrl: session.conversationUrl, deliveryId: session.activeDeliveryId })) {
      if (input[key] !== value) fail("Web identity mismatch: " + key, "DELIVERY_RECOVERY_MISMATCH");
    }
    if (!this.capabilities().includes(type)) fail("Web operation is unavailable.");
    const pendingDelivery = context.deliveries.find(item => item.deliveryId === session.activeDeliveryId);
    const refreshCompleted = type === "web.reconcile" && pendingDelivery?.processingState !== "ACK_PENDING";
    const observed = await this.web.inspectDelivery({ refreshCompleted });
    this.setDiagnostics(context, observed); this.touch(context);
    const completed = observed.completedDelivery;
    if (completed && completed.turnId === session.activeDeliveryId && completed.binding?.sessionId === session.sessionId
      && completed.binding?.runId === context.preparationId && completed.binding?.conversationId === session.conversationId) {
      const delivery = context.deliveries.find((d) => d.deliveryId === session.activeDeliveryId);
      if (delivery && (!delivery.response || type === "web.reconcile")) {
        if (delivery.response) (delivery.responseHistory ??= []).push(delivery.response);
        delivery.response = completed; delivery.state = "RESPONSE_COMPLETED"; this.touch(context);
      }
    }
    if (type === "web.inspect") return this.snapshot();
    if (session.activeDeliveryId !== input.deliveryId) fail("Delivery changed while inspecting.", "DELIVERY_RECOVERY_MISMATCH");
    const expected = { ...input, runId: context.preparationId, currentDeliveryId: input.deliveryId };
    if (!context.diagnostics.exactConversation) fail("Conversation is ambiguous.", "DELIVERY_RECOVERY_MISMATCH");
    if (type === "web.focus") await this.web.focusDelivery(expected);
    else if (type === "web.stop") {
      if (!context.diagnostics.canStop) fail("Generating delivery is not confirmed.");
      this.setDiagnostics(context, await this.web.stopDelivery(expected)); this.touch(context);
      const delivery = context.deliveries.find((d) => d.deliveryId === session.activeDeliveryId);
      if (delivery) { delivery.stopped = true; this.touch(context); }
    } else if (type === "web.reconcile") {
      const delivery = context.deliveries.find((d) => d.deliveryId === session.activeDeliveryId);
      if (!delivery?.response || this.jobs.has(context.preparationId)) fail("No durable completed response; inspect the conversation. No clear or resend.", "RECOVERY_REQUIRED");
      await this.complete(context, delivery);
    }
    return this.snapshot();
  }
  capabilities() {
    const context = this.current;
    if (!context || context.lifecycle !== "ACTIVE") return this.available() ? ["preparation.start"] : [];
    const caps = [];
    const active = context.deliveries.find((d) => d.deliveryId === context.webSession.activeDeliveryId);
    if (context.agreement.status !== "APPROVED" && !this.jobs.has(context.preparationId)
      && context.diagnostics?.canRecover && (active?.response || active?.stopped)) caps.push("preparation.cancel");
    if (!context.webSession.activeDeliveryId && !this.jobs.has(context.preparationId)) {
      if (context.agreement.status !== "APPROVED") {
        caps.push("preparation.cancel");
        if (this.available()) caps.push("preparation.reply");
      }
      if (["READY", "APPROVED"].includes(context.agreement.status) && this.available()) caps.push("preparation.approve");
    }
    if (this.available()) {
      caps.push("web.inspect");
      if (context.diagnostics?.canFocus) caps.push("web.focus");
      if (context.diagnostics?.canStop) caps.push("web.stop");
      if (context.deliveries.some((d) => d.deliveryId === context.webSession.activeDeliveryId && d.response)
        && !this.jobs.has(context.preparationId)) caps.push("web.reconcile");
    }
    return caps;
  }
  async project(snapshot, { runId = null, start = false } = {}) {
    let context = this.current;
    if (context?.reservedRunId && !context.resultingRunId) {
      const existing = await this.findRun(context.reservedRunId);
      if (existing) {
        context.resultingRunId = existing.runId; context.agreement.status = "APPROVED";
        context.lifecycle = "COMPLETED"; context.stage = "WORK"; this.touch(context);
      }
    }
    if (context?.resultingRunId) {
      for (const receipt of Object.values(this.data.receipts)) {
        if (receipt.status !== "PROCESSING") continue;
        const command = JSON.parse(receipt.hash);
        if (command.type === "preparation.approve" && command.input.preparationId === context.preparationId) {
          receipt.status = "COMPLETED"; receipt.result = { runId: context.resultingRunId }; this.save();
        }
      }
    }
    if (runId) context = Object.values(this.data.contexts).find((c) => c.resultingRunId === runId) ?? null;
    const active = context?.lifecycle === "ACTIVE";
    const connecting = active && !context.discussion.some((turn) => turn.actor === "WEB_DESIGNER") && !runId;
    const showPrepare = active && !connecting && !runId;
    const showStart = !showPrepare && !runId && (start || !snapshot.run)
      && !snapshot.runs.some((r) => !terminal.has(r.phase));
    const workflow = connecting ? { stage: "START", state: context.state === "INITIALIZING" ? "CONNECTING_WEB" : context.state }
      : showPrepare ? { stage: "PREPARE", state: context.state }
      : showStart ? { stage: "START", state: "START_IDLE" }
      : snapshot.run ? workflowForRun(snapshot.run) : { stage: "START", state: "START_IDLE" };
    const showingRun = ["WORK", "RESULT"].includes(workflow.stage);
    if (showingRun) {
      context = Object.values(this.data.contexts).find((c) => c.resultingRunId === workflow.runId) ?? null;
    }
    Object.assign(workflow, { preparationId: context?.preparationId ?? null, preparationVersion: context?.version ?? null,
      runId: workflow.runId ?? null, runVersion: workflow.runVersion ?? null });
    const canStart = !snapshot.runs.some((r) => !terminal.has(r.phase));
    const caps = showingRun ? snapshot.commandCapabilities.filter((c) => c !== "run.start") : [];
    if (!runId) caps.push(...this.capabilities().filter((c) =>
      c === "preparation.start" ? canStart : !showingRun));
    return { ...snapshot, workflow, preparation: structuredClone(context),
      run: showingRun ? snapshot.run : null,
      deliveries: showingRun ? snapshot.deliveries : structuredClone(context?.deliveries ?? []),
      commandCapabilities: caps };
  }
  close() { this.closed = true; this.unsubscribe?.(); this.db.close(); }
}
