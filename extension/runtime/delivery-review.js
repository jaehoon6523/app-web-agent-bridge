import { ExtensionStateError } from "./storage.js";
import { resolveStoredWebTargetProvider } from "./provider-target.js";
import { hasExactDiscardReceipt } from "./delivery-discard.js";
import { readDeliveryPage } from "./delivery-page.js";
import { validateLocalControllerUrl } from "./conversation.js";

export function deliveryOwner(state) {
  return { currentDeliveryId: state.currentDeliveryId, sessionId: state.lastBoundSessionId,
    runId: state.lastBoundRunId, conversationUrl: state.conversationUrl,
    documentId: state.documentId, frameId: state.frameId, tabId: state.tabId };
}

function assertOwner(state, expected) {
  const owner = deliveryOwner(state);
  if (!owner.currentDeliveryId || Object.keys(owner).some(key => owner[key] !== expected?.[key])) {
    throw new ExtensionStateError("DELIVERY_RECOVERY_MISMATCH", "전송 대상이 변경됐습니다. 상태를 다시 확인하세요.");
  }
}

export function createServerDeliveryInspector({ send, timeoutMs = 10_000 }) {
  const pending = new Map();
  return {
    inspect(expected) {
      const requestId = "inspect_" + crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new ExtensionStateError("SERVER_DELIVERY_UNAVAILABLE", "서버 전송 기록 확인 응답이 없습니다."));
        }, timeoutMs);
        pending.set(requestId, { expected, resolve, reject, timer });
        if (!send({ type: "extension.delivery.inspect", requestId, payload: expected })) {
          clearTimeout(timer); pending.delete(requestId);
          reject(new ExtensionStateError("SERVER_DELIVERY_UNAVAILABLE", "컨트롤러에 연결한 뒤 상태를 확인하세요."));
        }
      });
    },
    accept(message) {
      const item = pending.get(message.requestId);
      if (!item || message.type !== "controller.delivery.inspected") return false;
      clearTimeout(item.timer); pending.delete(message.requestId);
      if (Object.keys(item.expected).some(key => item.expected[key] !== message.payload?.expected?.[key])) {
        item.reject(new ExtensionStateError("DELIVERY_RECOVERY_MISMATCH", "서버 조회 대상이 다릅니다."));
      } else item.resolve(message.payload);
      return true;
    },
  };
}

export function createDeliveryReview({ store, turnGate, tabs, inspectServer, onChange }) {
  async function inspect() {
    const state = await store.read(), owner = deliveryOwner(state);
    if (!owner.currentDeliveryId) return { owner, phase: "IDLE", server: null };
    const page = await readDeliveryPage(tabs, state.tabId);
    const server = await inspectServer(owner).catch(() => ({ status: "UNAVAILABLE", records: [] }));
    assertOwner(await store.read(), owner);
    const completed = state.completedDelivery?.turnId === owner.currentDeliveryId;
    const durableAck = server.status === "MATCHED" && server.records[0]?.processingState === "ACK_PENDING"
      && server.records[0]?.responseStored === true;
    return { owner, phase: durableAck ? "ACK_PENDING" : completed ? "RESPONSE_OBSERVED"
      : page?.activeRequestId === owner.currentDeliveryId ? "IN_FLIGHT" : "UNRESOLVED",
      server, page: { reachable: page?.ok === true, busy: page?.busy ?? null,
        generating: page?.generating ?? null, documentMatches: page?.documentId === state.documentId,
        activeRequestId: page?.activeRequestId ?? null }, extensionBusy: turnGate.active };
  }
  async function discardOrphan(expected) {
    if (expected?.unresolvedResultConfirmed !== true || expected?.noAutomaticResendConfirmed !== true
      || expected?.serverMissingConfirmed !== true || typeof expected?.reason !== "string" || expected.reason.trim().length < 3) {
      throw new ExtensionStateError("DISCARD_CONFIRMATION_REQUIRED", "서버 기록 없음·미확정 결과·자동 재전송 금지를 확인하고 사유를 입력하세요.");
    }
    const held = turnGate.reserve("discard_" + crypto.randomUUID());
    try {
      const state = await store.read();
      if (hasExactDiscardReceipt(state, expected)) return { discarded: true, owner: expected };
      assertOwner(state, expected);
      const owner = deliveryOwner(state), server = await inspectServer(owner);
      if (server.status !== "MISSING") throw new ExtensionStateError("SERVER_DELIVERY_NOT_MISSING",
        "서버 기록이 없다고 확정하지 못했습니다. 컨트롤러에서 해당 작업을 확인하세요.");
      const page = await readDeliveryPage(tabs, state.tabId);
      if (page?.busy || page?.generating) throw new ExtensionStateError("WEB_SESSION_BUSY", "대화 탭의 생성 작업을 먼저 종료하세요.");
      if ((!page?.ok || page.busy !== false || page.generating !== false)
        && expected.pageStateUnconfirmedConfirmed !== true) {
        throw new ExtensionStateError("PAGE_STATE_CONFIRMATION_REQUIRED", "페이지의 생성 종료를 확인할 수 없다는 점도 명시적으로 확인하세요.");
      }
      await store.updateIf({ currentDeliveryId: owner.currentDeliveryId, lastBoundSessionId: owner.sessionId,
        lastBoundRunId: owner.runId, conversationUrl: owner.conversationUrl, documentId: owner.documentId,
        frameId: owner.frameId, tabId: owner.tabId },
      { currentDeliveryId: null, completedDelivery: null, bindingStatus: "NEEDS_REBIND",
        bindingError: "RECOVERY_DISCARDED: 확장에만 남은 전송을 사용자가 폐기했습니다.",
        lastDeliveryDiscard: { deliveryId: owner.currentDeliveryId, sessionId: owner.sessionId,
          runId: owner.runId, conversationUrl: owner.conversationUrl, documentId: owner.documentId,
          frameId: owner.frameId, tabId: owner.tabId, reason: expected.reason.trim(),
          serverStatus: "MISSING", at: new Date().toISOString() } });
      onChange?.();
      return { discarded: true, owner };
    } finally { turnGate.release(held); }
  }
  async function openConversation(expected) {
    const state = await store.read(); assertOwner(state, expected);
    const provider = resolveStoredWebTargetProvider(state);
    if (!provider || provider.canonicalize(state.conversationUrl) !== state.conversationUrl) {
      throw new ExtensionStateError("DELIVERY_RECOVERY_MISMATCH", "전송의 대화 주소를 확인할 수 없습니다.");
    }
    const tab = state.tabId !== null ? await tabs.get(state.tabId).catch(() => null) : null;
    if (tab && provider.canonicalize(tab.url) === state.conversationUrl) return tabs.update(tab.id, { active: true });
    return tabs.create({ url: state.conversationUrl, active: true });
  }
  async function selectScope(expected) {
    const held = turnGate.reserve("scope_" + crypto.randomUUID());
    try { await store.selectDeliveryScope(expected); onChange?.(); return { selected: true }; }
    finally { turnGate.release(held); }
  }
  async function openController() {
    const state = await store.read(), url = new URL(validateLocalControllerUrl(state.controllerUrl));
    url.protocol = "http:"; url.pathname = state.currentDeliveryId ? "/delivery-recovery.html" : "/"; url.search = "";
    if (state.currentDeliveryId) for (const [key, value] of Object.entries({ currentDeliveryId: state.currentDeliveryId,
      sessionId: state.lastBoundSessionId, runId: state.lastBoundRunId, conversationUrl: state.conversationUrl })) url.searchParams.set(key, value);
    return tabs.create({ url: url.href, active: true });
  }
  return { inspect, discardOrphan, openConversation, selectScope, openController };
}
