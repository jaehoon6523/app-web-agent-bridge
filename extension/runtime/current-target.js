import { canonicalChatGptUrl, conversationIdFromUrl } from "./conversation.js";

export class CurrentWebTargetError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "CurrentWebTargetError";
    this.code = code;
    this.details = details;
  }
}

export function isPendingRootPromotion({ state, tab, activeRequestId }) {
  return state.tabId === tab?.id
    && canonicalChatGptUrl(state.conversationUrl) === "https://chatgpt.com/"
    && state.conversationId === null
    && conversationIdFromUrl(tab?.url) !== null
    && typeof state.currentDeliveryId === "string"
    && state.currentDeliveryId === activeRequestId;
}

export async function bindCurrentUserTarget({ tabs, store, state, urlPatterns, waitForContentScript }) {
  const activeTabs = await tabs.query({ active: true, lastFocusedWindow: true, url: urlPatterns });
  if (activeTabs.length !== 1) {
    throw new CurrentWebTargetError("ACTIVE_WEB_TARGET_UNRESOLVED", "현재 사용자가 보고 있는 ChatGPT 탭을 하나로 확정할 수 없습니다.", {
      activeTabCount: activeTabs.length,
    });
  }
  const tab = activeTabs[0];
  await waitForContentScript(tab.id, 30_000, true);
  const page = await tabs.sendMessage(tab.id, { type: "agent.ping" });
  const conversationUrl = canonicalChatGptUrl(page?.url ?? tab.url);
  const conversationId = page?.conversationId ?? conversationIdFromUrl(conversationUrl);
  const root = conversationUrl === "https://chatgpt.com/" && conversationId === null;
  if (!page?.ok || !page.ready || page.busy || page.generating || !conversationUrl
    || (!conversationId && !root) || !page.documentId || page.frameId !== 0) {
    throw new CurrentWebTargetError("ACTIVE_WEB_CONTEXT_UNRESOLVED", "현재 ChatGPT 탭의 document와 실행 가능 상태를 확인할 수 없습니다.", {
      tabId: tab.id, url: conversationUrl, documentId: page?.documentId ?? null,
      frameId: page?.frameId ?? null, pageStatus: page?.pageStatus ?? null,
    });
  }
  return store.bindSession({
    lastBoundSessionId: state.lastBoundSessionId, lastBoundRunId: state.lastBoundRunId,
    tabId: tab.id, windowId: tab.windowId, documentId: page.documentId, frameId: page.frameId,
    conversationUrl, conversationId, bindingStatus: root ? "ROOT_READY" : "BOUND", bindingError: null,
  });
}
