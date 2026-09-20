import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../domain/canonical-json.js";
import { createWebSessionBinding } from "../runtime/web/binding.js";
import { parseFinalControllerPacketJsonEnvelope } from "../domain/controller-packet-envelope.js";

function fail(message, code = "PREPARATION_CONFLICT", details = null) { throw Object.assign(new Error(message), { code, details }); }
const stamp = () => new Date().toISOString();
const terminal = new Set(["APPLIED", "CANCELLED", "FAILED", "INCONCLUSIVE", "COMPLETE"]);
const RESULT_STATES = new Set(["AWAITING_APPLY", "APPLIED", "COMPLETE", "CANCELLED", "INCONCLUSIVE", "FAILED"]);
const PACKET_FORMAT_CODES = new Set([
  "EMPTY_AGENT_RESPONSE",
  "CONTROLLER_PACKET_MISSING",
  "CONTROLLER_PACKET_AMBIGUOUS",
  "CONTROLLER_PACKET_TOO_DEEP",
  "INVALID_PACKET_LIMIT",
  "INVALID_PACKET_JSON",
]);

function packetFormatError(error) {
  const code = PACKET_FORMAT_CODES.has(error?.code) ? error.code : "INVALID_CONTROLLER_PACKET";
  return Object.freeze({
    code,
    message: typeof error?.message === "string" && error.message
      ? error.message
      : "Controller packet validation failed.",
  });
}

function normalizePreparationWebFailure(error, expected) {
  if (error?.code !== "REBIND_DURING_ACTIVE_DELIVERY") return error;
  const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details
    : null;
  if (!details) return error;
  const blockingSessionId = typeof details.sessionId === "string" && details.sessionId
    ? details.sessionId
    : null;
  const blockingRunId = typeof details.runId === "string" && details.runId
    ? details.runId
    : null;
  const ownerMismatch = (blockingSessionId !== null && blockingSessionId !== expected.sessionId)
    || (blockingRunId !== null && blockingRunId !== expected.runId);
  if (!ownerMismatch) return error;
  return Object.assign(
    new Error(
      "The connected browser extension is running stale session-binding logic. "
        + "Reload the unpacked extension before retrying; the older delivery was preserved.",
    ),
    {
      code: "EXTENSION_RUNTIME_STALE",
      details: {
        ...details,
        originalCode: error.code,
        expectedSessionId: expected.sessionId,
        expectedRunId: expected.runId,
        blockingSessionId,
        blockingRunId,
        reloadRequired: true,
      },
    },
  );
}

function isValidRequirementsProposal(packet) {
  return packet?.type === "REQUIREMENTS_PROPOSAL"
    && typeof packet.summary === "string"
    && Array.isArray(packet.questions)
    && packet.questions.every((question) => typeof question === "string" && question.trim())
    && Array.isArray(packet.items)
    && packet.items.length <= 30
    && (packet.items.length > 0 || packet.questions.length > 0)
    && packet.items.every((item) => (
      typeof item?.statement === "string" && item.statement.trim()
      && typeof item?.acceptanceCriteria === "string" && item.acceptanceCriteria.trim()
    ));
}

export function workflowForRun(run) {
  const phase = run.phase ?? run.stage;
  const result = phase;
  const state = RESULT_STATES.has(result) ? result : ({
    CREATED: "RUN_CREATED", CANDIDATE_CAPTURE: "VERIFYING", REPORT_REPAIR: "REVIEW_RUNNING",
    EVIDENCE_SUPPLEMENT: "REVIEW_RUNNING",
  }[phase] ?? (["RUN_CREATED", "PROVISIONING", "WORKER_RUNNING", "VERIFYING", "REVIEW_RUNNING", "REWORK", "APPLYING", "STOPPING", "HOLD", "RECOVERY_REQUIRED"].includes(phase) ? phase : "RECOVERY_REQUIRED"));
  return { stage: RESULT_STATES.has(state) ? "RESULT" : "WORK", state, runId: run.runId, runVersion: run.version };
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
  snapshot() {
    const context = this.current;
    let changed = false;
    for (const delivery of context?.deliveries ?? []) {
      const response = delivery.response;
      if (!response?.rawText || (response.packet && response.packet.type !== "PLANNING_RESPONSE")) continue;
      try {
        const envelope = parseFinalControllerPacketJsonEnvelope(response.rawText);
        response.packet = envelope.parsed;
        response.packetText = envelope.packetText;
        changed = true;
      } catch (error) {
        const formatError = packetFormatError(error);
        delivery.validation ??= { status: "FAILED", checks: [] };
        if (delivery.validation.format !== "INVALID"
          || delivery.validation.formatError?.code !== formatError.code
          || delivery.validation.formatError?.message !== formatError.message) {
          delivery.validation.format = "INVALID";
          delivery.validation.formatError = formatError;
          changed = true;
        }
      }
    }
    if (changed) this.save();
    return structuredClone(context);
  }
  receipt(requestId) {
    const receipt = this.data.receipts[requestId];
    return { requestId, status: receipt?.status ?? "NOT_FOUND" };
  }
  async execute(type, input) {
    if (this.closed) fail("Server is closing.");
    if (!input || typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 200) {
      fail("requestId is required.", "INVALID_COMMAND");
    }
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
    return context;
  }
  async dispatch(type, input) {
    if (type === "preparation.start") {
      await this.assertStart();
      if (!this.available()) fail("Connect the browser extension.", "WEB_BLOCKED");
      const conversationUrl = typeof input.conversationUrl === "string" ? input.conversationUrl.trim() : "";
      if (typeof input.objective !== "string" || !input.objective.trim()
        || !/^https:\/\/chatgpt\.com\/(?:c\/[^/?#\s]+)?\/?$/u.test(conversationUrl)) fail("Objective and a ChatGPT conversation URL or the ChatGPT start page are required.", "INVALID_INPUT");
      if (typeof input.targetRoot !== "string" || !path.isAbsolute(input.targetRoot)) fail("Select an absolute project folder.", "INVALID_INPUT");
      const targetRoot = fs.realpathSync(input.targetRoot);
      if (!fs.statSync(targetRoot).isDirectory() || path.parse(targetRoot).root === targetRoot) fail("Select a project folder.", "INVALID_INPUT");
      const preparationId = "prep_" + randomUUID();
      const context = {
        preparationId, version: 1, stage: "PREPARE", state: "INITIALIZING", lifecycle: "ACTIVE",
        objective: input.objective, targetRoot, conversationUrl,
        webSession: { sessionId: "web_" + preparationId,
          conversationId: conversationUrl === "https://chatgpt.com/" ? null : conversationUrl.split("/").at(-1),
          conversationUrl: conversationUrl === "https://chatgpt.com/" ? null : conversationUrl,
          tabId: null, windowId: null, bindingState: "UNBOUND",
          activeDeliveryId: null, lastObservedUserMessageId: null, lastObservedAssistantMessageId: null },
        discussion: [], agreement: { status: "DISCUSSING", summary: "", unresolvedQuestions: [], requirements: [] },
        deliveries: [], repository: null, resultingRunId: null, reservedRunId: null, error: null,
        createdAt: stamp(), updatedAt: stamp(),
      };
      this.data.currentId = preparationId; this.data.contexts[preparationId] = context;
      console.info("[bridge:preparation:start]", { preparationId, sessionId: context.webSession.sessionId });
      this.reserve(context, input.objective, input.requestId);
      return this.snapshot();
    }
    const context = this.context(input);
    if (type === "preparation.approve" && context.resultingRunId) return { runId: context.resultingRunId };
    if (context.lifecycle !== "ACTIVE" || (context.agreement.status === "APPROVED" && type !== "preparation.approve")) fail("Approved or closed preparation is immutable.");
    if (type === "preparation.reply") {
      if (!this.capabilities().includes(type)) fail("Reply is unavailable.");
      if (typeof input.content !== "string" || !input.content.trim()) fail("Enter an answer.", "INVALID_INPUT");
      this.reserve(context, input.content, input.requestId); return this.snapshot();
    }
    if (type === "preparation.discard") {
      const delivery = context.deliveries.find((d) => d.deliveryId === context.webSession.activeDeliveryId);
      if (!delivery) fail("No unresolved delivery is available for discard.", "RECOVERY_REQUIRED");
      if (input.unresolvedResultConfirmed !== true || input.noAutomaticResendConfirmed !== true) {
        fail("Confirm that the original result was not observed and will not be resent.", "DISCARD_CONFIRMATION_REQUIRED");
      }
      if (typeof input.reason !== "string" || input.reason.trim().length < 3) fail("Enter a discard reason.", "INVALID_INPUT");
      const observed = await this.web.inspectDelivery();
      if (observed.currentDeliveryId !== null && observed.currentDeliveryId !== delivery.deliveryId) {
        fail("The extension delivery belongs to a different preparation.", "DELIVERY_RECOVERY_MISMATCH", {
          expectedDeliveryId: delivery.deliveryId,
          observedDeliveryId: observed.currentDeliveryId,
          observedSessionId: observed.sessionId ?? null,
          observedRunId: observed.runId ?? null,
        });
      }
      if (typeof this.web?.discardDelivery !== "function") {
        fail("The browser extension cannot confirm delivery discard.", "RECOVERY_REQUIRED", observed);
      }
      if (observed.currentDeliveryId !== null) {
        await this.web.discardDelivery({ ...observed, unresolvedResultConfirmed: true,
          noAutomaticResendConfirmed: true, reason: input.reason.trim() });
      }
      delivery.state = "RECOVERY_DISCARDED";
      delivery.discardedAt = stamp(); delivery.discardReason = input.reason.trim();
      delivery.discardEvidence = { sessionId: delivery.sessionId, conversationId: delivery.conversationId,
        conversationUrl: context.webSession.conversationUrl, deliveryId: delivery.deliveryId,
        remoteDeliveryId: observed.currentDeliveryId, remoteAlreadyCleared: observed.currentDeliveryId === null };
      context.webSession.activeDeliveryId = null; context.lifecycle = "ABANDONED";
      context.state = "RECOVERY_REQUIRED"; context.error = { code: "RECOVERY_DISCARDED", message: "Unresolved delivery was explicitly discarded by the operator." };
      context.recovery = { kind: "RECOVERY_DISCARDED", deliveryId: delivery.deliveryId,
        at: delivery.discardedAt, reason: delivery.discardReason, evidence: delivery.discardEvidence };
      this.touch(context); return this.snapshot();
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
  reserve(context, content, commandRequestId) {
    const session = context.webSession, deliveryId = "delivery_" + randomUUID();
    context.error = null; context.diagnostics = null;
    context.agreement.status = "DISCUSSING"; context.state = "INITIALIZING";
    context.discussion.push({ turnId: "turn_" + randomUUID(), preparationId: context.preparationId,
      sequence: context.discussion.length + 1, actor: "USER", content, deliveryId: null, createdAt: stamp() });
    context.deliveries.push({ commandRequestId, deliveryId, preparationId: context.preparationId, sessionId: session.sessionId,
      conversationId: session.conversationId, state: "RESERVED", response: null, createdAt: stamp() });
    session.activeDeliveryId = deliveryId; this.touch(context);
    // No Web response is awaited by the HTTP request. The intent is durable first.
    const job = new Promise((resolve) => setImmediate(resolve)).then(() => this.generate(context, deliveryId))
      .catch((rawError) => {
        if (this.closed) return;
        const error = normalizePreparationWebFailure(rawError, {
          sessionId: session.sessionId,
          runId: context.preparationId,
        });
        const delivery = context.deliveries.find((d) => d.deliveryId === deliveryId);
        const unsent = delivery.state === "RESERVED" || error.details?.browserDispatchStarted === false;
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
          message: error.message, details: error.details ?? null,
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
    // Exact conversations stay background-safe. Root bootstrap is user-visible:
    // focus/open ChatGPT so the user does not wait on a page that is not present.
    const request = { focus: session.conversationUrl === null && session.conversationId === null, binding: createWebSessionBinding({
      sessionId: session.sessionId, runId, title: null, bindingStatus: "NEEDS_REBIND",
      conversationId: session.conversationId, conversationUrl: session.conversationUrl,
      tabId: session.tabId, windowId: session.windowId,
      documentId: session.documentId ?? null, frameId: session.frameId ?? null,
      lastObservedUserMessageId: session.lastObservedUserMessageId,
      lastObservedAssistantMessageId: session.lastObservedAssistantMessageId,
    }) };
    const binding = await this.web.resume(request);
    if (this.closed) return;
    if (binding.sessionId !== session.sessionId) fail("Web binding changed.");
    if (session.conversationUrl !== null && binding.conversationId !== session.conversationId) fail("Web binding changed.");
    if (session.conversationUrl === null && binding.bindingStatus !== "ROOT_READY" && (!binding.conversationUrl || !binding.conversationId)) fail("A new ChatGPT conversation was not established.", "NEW_CONVERSATION_NOT_READY");
    Object.assign(session, {
      conversationUrl: binding.conversationUrl,
      conversationId: binding.conversationId,
      tabId: binding.tabId, windowId: binding.windowId, bindingState: binding.bindingStatus,
      documentId: binding.documentId, frameId: binding.frameId,
    });
    context.conversationUrl = binding.conversationUrl;
    delivery.state = "DISPATCHING"; context.state = "WAITING_WEB_RESPONSE"; this.touch(context);
    const instructions = '너는 구현 설계자다. 구현, 저장소 변경, 승인하지 말고 사용자와 작업 범위 및 완료 기준을 합의한다. 모호한 요청은 질문이나 선택지를 반환하고 완료 기준을 억지로 만들지 않는다. 한국어로 답한다. 응답 마지막에 독립된 <controller_packet> 및 </controller_packet> 줄로 JSON을 감싼다: {"type":"REQUIREMENTS_PROPOSAL","summary":"설명","questions":["미해결 질문"],"items":[{"statement":"기능","acceptanceCriteria":"관찰 가능한 동작"}]}. packet 내부는 JSON.parse가 성공하는 엄격한 JSON이어야 한다. Windows 경로는 C:/path 형식의 슬래시를 우선 사용하고, 역슬래시를 쓸 때는 JSON 문자열에서 \\\\로 escape한다. 태그에 Markdown escape나 코드 fence를 붙이지 않는다. 출력 직전에 JSON 문자열과 독립된 태그 줄을 스스로 검증한다. 질문만 있으면 items는 빈 배열이다. 검증 방식은 코드 스냅샷 검토이며 실행 테스트를 수행했다고 주장하지 않는다.\n첫 메시지에서 다음 개발 진입 데이터를 모두 확인한다:\n- 작업 대상: 무엇을 어느 저장소·경로에서 변경하는가\n- 구현 범위: 포함할 기능과 제외할 범위\n- 요구사항: 각 기능의 구체적인 statement\n- 완료 기준: 각 요구사항의 관찰 가능한 acceptanceCriteria\n- 검증 방법: 실행할 테스트·명령과 기대 결과\n- 한도와 제약: 실행 한도, 금지된 변경, 외부 연동 조건\n- 승인 조건: 위 항목에 미해결 질문이 없고 사용자가 승인해야 구현을 시작한다\n이미 제공된 값은 다시 묻지 말고, 빠진 값만 질문한다. 질문이 남아 있으면 status는 DISCUSSING, 모든 항목이 합의되면 questions는 빈 배열이고 status는 READY가 되도록 제안한다.\n기존 준비 문맥:\n';
    const responseFormatFallback = '중요: 요구사항 제안 packet을 정확히 만들 수 없거나 필요한 정보가 부족하면 <controller_packet>을 추측해서 만들지 말고, 태그가 전혀 없는 평문으로 부족한 정보와 질문만 설명한다. 평문 응답은 오류가 아니라 사용자 확인을 위한 정상적인 대화 응답이다.\n';
    const jsonPathRule = "\nJSON packet 문자열에 Windows 경로를 넣을 때는 C:/Users/...처럼 슬래시를 사용하거나 백슬래시를 JSON 규칙대로 이스케이프한다. 원시 C:\\Users\\... 형태는 절대 출력하지 않는다.\n";
    const requirementsScopeRule = "\n중요: requirements items에는 구현 결과의 코드 스냅샷에서 판정 가능한 제품·코드 요구사항만 넣는다. 승인 게이트, 승인 전 저장소 변경 금지, 컨트롤러 상태 전환 같은 실행 절차는 컨트롤러 정책이므로 requirements items로 만들지 않는다.\n";
    const controllerFacts = [
      `컨트롤러 확정 사실(다시 질문하지 말 것): 준비 ID=${context.preparationId}`,
      `프로젝트 루트=${context.targetRoot}`,
      `ChatGPT 대화 URL=${context.conversationUrl}`,
      `대화 ID=${context.webSession.conversationId}`,
      `사용자의 최초 요청=${context.objective}`,
      "승인 전 저장소 변경 금지=예",
      "현재 검증 정책=코드 스냅샷 검토이며 실행 테스트를 수행했다고 주장하지 않음",
      "위 사실을 바탕으로 실제 수정 대상 파일·기능처럼 사용자만 결정할 수 있는 정보가 없을 때만 질문한다.",
      "질문은 한 번에 하나만 하며, 이미 제공된 경로·URL·ID·제약을 다시 묻지 않는다.",
    ].join("\\n") + "\\n";
    const text = instructions
      + JSON.stringify({ preparationId: context.preparationId, discussion: context.discussion, agreement: context.agreement })
      + "\n사용자의 첫 부탁:\n" + context.objective + requirementsScopeRule;
    const handle = await this.web.submitTurn({ runId, turnId: deliveryId, controllerMessageId: deliveryId, text: responseFormatFallback + jsonPathRule + controllerFacts + text,
      parseResponse: (raw) => ({ body: raw, packetText: raw, packet: { type: "PLANNING_RESPONSE" } }) });
    if (delivery.state === "DISPATCHING") delivery.state = "SUBMITTED";
    this.touch(context);
    const response = await handle.completion;
    if (this.closed) return;
    if (response.turnId !== deliveryId || response.binding?.sessionId !== session.sessionId
      || response.binding?.runId !== runId || response.binding?.bindingStatus !== "BOUND") fail("Response identity changed.");
    Object.assign(session, {
      conversationUrl: response.binding.conversationUrl, conversationId: response.binding.conversationId,
      tabId: response.binding.tabId, windowId: response.binding.windowId,
      documentId: response.binding.documentId, frameId: response.binding.frameId, bindingState: "BOUND",
    });
    context.conversationUrl = session.conversationUrl;
    delivery.conversationId = session.conversationId;
    delivery.response = response; delivery.trace = response.trace; delivery.state = "RESPONSE_COMPLETED"; this.touch(context);
    await this.complete(context, delivery);
  }
  async complete(context, delivery) {
    const session = context.webSession;
    const observed = await this.web.inspectDelivery();
    this.setDiagnostics(context, observed);
    const pointerMatches = observed.currentDeliveryId === delivery.deliveryId;
    let response = delivery.response;
    let parsed = null;
    let packetParseError = null;
    try {
      const envelope = parseFinalControllerPacketJsonEnvelope(response.rawText);
      parsed = envelope.parsed;
      response = delivery.response = { ...response, packet: parsed, packetText: envelope.packetText };
    } catch (error) {
      packetParseError = error;
    }
    const userMessageId = response?.evidence?.userMessageId ?? response?.binding?.lastObservedUserMessageId;
    const assistantMessageId = response?.evidence?.assistantMessageId ?? response?.binding?.lastObservedAssistantMessageId;
    const packetValid = !packetParseError && isValidRequirementsProposal(parsed);
    const check = (name, expected, actual) => ({ name, expected: expected ?? null, actual: actual ?? null,
      passed: expected !== undefined && actual === expected });
    const checks = [
      check("대화 연결", true, context.diagnostics.exactConversation),
      check("응답 전송 ID", delivery.deliveryId, response?.turnId),
      check("응답 세션 ID", session.sessionId, response?.binding?.sessionId),
      check("응답 작업 ID", context.preparationId, response?.binding?.runId),
      check("응답 대화 ID", session.conversationId, response?.binding?.conversationId),
      check("action request ID", delivery.deliveryId, response?.trace?.requestId),
      check("action ID", delivery.deliveryId, response?.trace?.actionId),
      check("binding ID", `${session.sessionId}:${context.preparationId}`, response?.trace?.bindingId),
      check("action tab ID", session.tabId, response?.trace?.tabId),
      check("action document ID", session.documentId, response?.trace?.documentId),
      check("action frame ID", session.frameId, response?.trace?.frameId),
      check("action result", "success", response?.trace?.result),
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
    // A valid final packet can confirm a response even when the page's user
    // turn was virtualized before the DOM association completed.
    const confidenceCheck = checks.at(-1);
    if (response?.confidence === "HEURISTIC" && packetValid && assistantMessageId) {
      confidenceCheck.passed = true;
      confidenceCheck.evidence = "VALID_FINAL_CONTROLLER_PACKET";
    }
    delivery.validation = { status: checks.every(item => item.passed) ? "CONFIRMED" : "FAILED", checks };
    this.touch(context);
    if (delivery.validation.status === "FAILED") {
      const failed = checks.filter(item => !item.passed);
      console.warn("[bridge:completion:unconfirmed]", { deliveryId: delivery.deliveryId, checks: failed });
      throw Object.assign(new Error("응답 확인 실패: " + failed.map(item => item.name).join(", ")),
        { code: "COMPLETION_EVIDENCE_MISMATCH", details: { checks: failed } });
    }
    if (packetParseError) {
      delivery.validation.format = "INVALID";
      delivery.validation.formatError = packetFormatError(packetParseError);
      this.touch(context);
      fail("응답에 준비 제안 형식이 없습니다. 원문은 보존되어 있으며 승인할 수 없습니다.", "INVALID_AGREEMENT");
    }
    if (!isValidRequirementsProposal(parsed)) {
      delivery.validation.format = "INVALID";
      delivery.validation.formatError = {
        code: "INVALID_REQUIREMENTS_PROPOSAL",
        message: "The packet JSON is valid but does not satisfy the requirements proposal contract.",
      };
      this.touch(context);
      fail("Invalid designer response.", "INVALID_AGREEMENT");
    }
    delivery.validation.format = "CONFIRMED";
    delete delivery.validation.formatError;
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
    // A server restart can leave the binding marked RECOVERY_REQUIRED even
    // after the extension has reconnected to the exact session. Binding health
    // is separate from delivery validation: keep the preparation/delivery
    // recovery state until the response is validated, but restore the session
    // connection state once its identity is proven again.
    if (exactConversation && session.bindingState === "RECOVERY_REQUIRED") {
      session.bindingState = "BOUND";
    }
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
    // Reconcile must reread the bound ChatGPT session when a response may be
    // partial or malformed. ACK_PENDING is already a durable response whose
    // only remaining work is acknowledgement, so leave that path read-only.
    const refreshCompleted = type === "web.reconcile"
      && pendingDelivery?.processingState !== "ACK_PENDING";
    const observed = await this.web.inspectDelivery({ refreshCompleted,
      adoptManualFollowup: refreshCompleted && type === "web.reconcile" });
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
    if (active && (["RECOVERY_REQUIRED", "AMBIGUOUS", "WEB_BLOCKED"].includes(context.state)
      || context.error?.code === "DELIVERY_RECOVERY_UNCONFIRMED"
      || context.error?.code === "REBIND_DURING_ACTIVE_DELIVERY")) caps.push("preparation.discard");
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
  close() {
    this.closed = true;
    this.unsubscribe?.();
    for (const job of this.jobs.values()) {
      if (job && typeof job.cancel === "function") job.cancel();
    }
    this.jobs.clear();
    this.db.close();
  }
}
