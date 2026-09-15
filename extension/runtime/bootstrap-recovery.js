import { canonicalChatGptUrl, conversationIdFromUrl } from "./conversation.js";
import { captureTurnBinding } from "./turn-guard.js";
export { classifyStoredAmbiguousRoot } from "./binding-recovery.js";

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export async function recoverBootstrapAfterNavigation({
  tabs,
  store,
  tab,
  reservedState,
  turnIdentity,
  payload,
  waitForContentScript,
  sleep,
}) {
  const deadline = Date.now() + 30_000;
  let observed = null;
  let url = null;
  let id = null;
  while (Date.now() < deadline) {
    const current = await store.read();
    if (current.currentDeliveryId !== turnIdentity.requestId
      || current.lastBoundSessionId !== reservedState.lastBoundSessionId
      || current.lastBoundRunId !== reservedState.lastBoundRunId
      || current.tabId !== tab.id) {
      fail("TURN_BINDING_CHANGED", "새 대화 전환 중 전송 identity가 변경되었습니다.");
    }
    observed = await tabs.get(tab.id);
    url = canonicalChatGptUrl(observed.url);
    id = conversationIdFromUrl(url);
    if (id) break;
    await sleep(150);
  }
  if (!observed || !url || !id) {
    fail("NEW_CONVERSATION_TIMEOUT", "첫 메시지 전송 후 대화 주소가 생성되지 않았습니다. 자동 재전송하지 않습니다.");
  }
  if (observed.windowId !== reservedState.windowId) {
    fail("TURN_BINDING_CHANGED", "새 대화가 원래 창과 다른 위치에서 열렸습니다.");
  }

  const page = await waitForContentScript(tab.id, 30_000, true);
  if (page.url !== url || page.conversationId !== id || typeof page.documentId !== "string" || page.frameId !== 0) {
    fail("WEB_DOCUMENT_CHANGED", "새 대화 문서의 정확한 바인딩을 확인하지 못했습니다.");
  }
  const promoted = await store.update({
    conversationUrl: url, conversationId: id, documentId: page.documentId, frameId: page.frameId,
    bindingStatus: "BOUND", bindingError: null,
  });
  const frozenTurn = captureTurnBinding(promoted, turnIdentity);
  const result = await tabs.sendMessage(tab.id, {
    type: "agent.observeSubmittedPrompt",
    requestId: turnIdentity.requestId,
    payload: {
      controllerMessageId: turnIdentity.controllerMessageId,
      runId: turnIdentity.runId,
      expectedConversationUrl: url,
      expectedConversationId: id,
      expectedDocumentId: page.documentId,
      expectedFrameId: page.frameId,
      timeoutMs: payload.timeoutMs,
      stableMs: payload.stableMs,
    },
  });
  return { result, frozenTurn };
}
