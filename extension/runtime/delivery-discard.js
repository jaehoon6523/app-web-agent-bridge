import { ExtensionStateError } from "./storage.js";
import { readDeliveryPage } from "./delivery-page.js";

export function hasExactDiscardReceipt(state, expected) {
  const receipt = state.lastDeliveryDiscard;
  return state.currentDeliveryId === null && receipt?.deliveryId === expected.currentDeliveryId
    && receipt.sessionId === expected.sessionId && receipt.runId === expected.runId
    && receipt.conversationUrl === expected.conversationUrl
    && state.lastBoundSessionId === expected.sessionId && state.lastBoundRunId === expected.runId
    && state.conversationUrl === expected.conversationUrl;
}

export async function discardExactDelivery({ store, turnGate, tabs, message, send, onChange }) {
  let held;
  try {
    held = turnGate.reserve(message.requestId);
    const state = await store.read(), expected = message.payload || {};
    if (expected.unresolvedResultConfirmed !== true || expected.noAutomaticResendConfirmed !== true
      || typeof expected.reason !== "string" || expected.reason.trim().length < 3) {
      throw new ExtensionStateError("DISCARD_CONFIRMATION_REQUIRED", "미확정 결과·자동 재전송 금지와 폐기 사유를 확인하세요.");
    }
    if (typeof expected.currentDeliveryId !== "string" || !expected.currentDeliveryId.trim()) {
      throw new ExtensionStateError("DELIVERY_RECOVERY_MISMATCH", "폐기 대상 전송 식별자가 없습니다.");
    }
    if (expected.terminalDiscardConfirmed === true && Object.values(state.deliveryScopes).some(slot => slot.currentDeliveryId)) {
      throw new ExtensionStateError("WEB_SESSION_BUSY", "다른 세션에 남은 전송을 먼저 확인하세요.");
    }
    if (hasExactDiscardReceipt(state, expected)) {
      send({ type: "web.delivery.discarded", requestId: message.requestId, payload: { ...expected, result: "discarded" } });
      return;
    }
    if (expected.terminalDiscardConfirmed === true && (!expected.ownerSnapshot
      || ["tabId", "documentId", "frameId"].some(key => expected.ownerSnapshot[key] !== state[key]))) {
      throw new ExtensionStateError("DELIVERY_RECOVERY_MISMATCH", "폐기 대상의 저장 탭·문서 소유권이 변경됐습니다.");
    }
    const missingConfirmed = state.currentDeliveryId === null && expected.extensionRecordMissingConfirmed === true
      && !Object.values(state.deliveryScopes).some(slot => slot.currentDeliveryId === expected.currentDeliveryId);
    if ((!missingConfirmed && state.currentDeliveryId !== expected.currentDeliveryId)
      || state.lastBoundSessionId !== expected.sessionId || state.lastBoundRunId !== expected.runId
      || state.conversationUrl !== expected.conversationUrl) {
      throw new ExtensionStateError("DELIVERY_RECOVERY_MISMATCH", "폐기 대상 소유권이 현재 기록과 다릅니다.");
    }
    const page = tabs ? await readDeliveryPage(tabs, state.tabId) : null;
    if (page?.busy || page?.generating) throw new ExtensionStateError("WEB_SESSION_BUSY", "대화 탭의 생성 작업을 먼저 종료하세요.");
    if (expected.terminalDiscardConfirmed === true && (!page?.ok || page.documentId !== state.documentId || page.url !== state.conversationUrl || page.busy !== false || page.generating !== false)
      && expected.pageStateUnconfirmedConfirmed !== true) {
      throw new ExtensionStateError("PAGE_STATE_CONFIRMATION_REQUIRED", "원래 페이지 상태를 확인할 수 없음을 명시적으로 확인하세요.");
    }
    await store.updateIf({ currentDeliveryId: state.currentDeliveryId, lastBoundSessionId: state.lastBoundSessionId,
      lastBoundRunId: state.lastBoundRunId, conversationUrl: state.conversationUrl, documentId: state.documentId,
      tabId: state.tabId, frameId: state.frameId },
    { currentDeliveryId: null, completedDelivery: null, bindingStatus: "NEEDS_REBIND",
      bindingError: "RECOVERY_DISCARDED: " + expected.reason.trim(),
      lastDeliveryDiscard: { deliveryId: expected.currentDeliveryId, sessionId: state.lastBoundSessionId,
        runId: state.lastBoundRunId, conversationUrl: state.conversationUrl,
        reason: expected.reason.trim(), remoteAlreadyMissing: missingConfirmed, at: new Date().toISOString() } });
    send({ type: "web.delivery.discarded", requestId: message.requestId, payload: { ...expected, result: "discarded" } });
  } catch (error) {
    send({ type: "web.session.error", requestId: message.requestId, payload: { code: error.code, message: error.message } });
  } finally {
    if (held) turnGate.release(held);
    onChange?.();
  }
}
