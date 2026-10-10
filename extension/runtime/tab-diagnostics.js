import { diagnosticMetadata } from "./document-binding.js";
import { canonicalChatGptUrl } from "./conversation.js";
import { inspectDeliveryPage, pageDiagnosticMetadata } from "./delivery-page.js";

// Inspection never injects content, changes ownership, or sends a prompt.
export async function inspectChatGptTabs(tabs, { limit = Infinity } = {}) {
  const candidates = (await tabs.query({ url: ["https://chatgpt.com/*"] }))
    .filter(tab => canonicalChatGptUrl(tab.url)).slice(0, limit);
  return Promise.all(candidates.map(async tab => {
    const { page, transport, tab:observedTab } = await inspectDeliveryPage(tabs, tab.id);
    const pageUrl = canonicalChatGptUrl(page?.pageUrl ?? page?.url);
    return { tabId: tab.id, url: canonicalChatGptUrl(tab.url), reachable: page?.ok === true,
      pageUrl, ready: page?.ok === true && page.ready === true && page.composerPresent === true
        && page.busy === false && page.generating === false && pageUrl === canonicalChatGptUrl(tab.url)
        && (!observedTab || canonicalChatGptUrl(observedTab.url) === canonicalChatGptUrl(tab.url)),
      busy: page?.busy ?? null, generating: page?.generating ?? null,
      composerPresent: page?.inspectionError ? null : page?.composerPresent ?? null, pageStatus: page?.pageStatus ?? null,
      runtimeVersion: page?.runtimeVersion ?? null, documentId: page?.documentId ?? null,
      frameId:page?.frameId ?? null, transport,
      observedTabUrl:canonicalChatGptUrl(observedTab?.url), inspectedAt:new Date().toISOString(),
      ...pageDiagnosticMetadata(page) };
  }));
}

export async function openInspectedChatGptTab(tabs, expected) {
  if (!Number.isInteger(expected?.tabId) || !canonicalChatGptUrl(expected?.url)) {
    throw new Error("확인한 ChatGPT 탭을 선택하세요.");
  }
  const tab = await tabs.get(expected.tabId).catch(() => null);
  if (!tab || canonicalChatGptUrl(tab.url) !== expected.url) {
    throw new Error("탭이 닫혔거나 주소가 변경됐습니다. 탭 상태를 다시 확인하세요.");
  }
  await tabs.update(tab.id, { active: true });
  return { opened: true, tabId: tab.id };
}

export async function replyToSelectorDiagnostics(tabs, send, requestId, extensionVersion, state = null) {
  try {
    const results = await inspectChatGptTabs(tabs, { limit:8 });
    send({ type:"extension.diagnostics.inspected", requestId,
      payload:{ tabs:results.map(tab => diagnosticMetadata({ ...tab, extensionVersion })),
        delivery:state ? { currentDeliveryId:state.currentDeliveryId, tabId:state.tabId,
          bindingStatus:state.bindingStatus,sessionId:state.lastBoundSessionId,runId:state.lastBoundRunId,
          conversationUrl:canonicalChatGptUrl(state.conversationUrl),documentId:state.documentId,frameId:state.frameId,
          lastAcknowledgedDelivery:state.lastAcknowledgedDelivery,lastDeliveryDiscard:state.lastDeliveryDiscard,
          scopedDeliveries:Object.entries(state.deliveryScopes ?? {}).slice(0,8).map(([sessionId,slot]) =>
            ({sessionId,currentDeliveryId:slot.currentDeliveryId,runId:slot.lastBoundRunId,tabId:slot.tabId})),
          responseObserved:Boolean(state.currentDeliveryId && state.completedDelivery?.turnId === state.currentDeliveryId),
          acknowledgedDeliveryId:state.lastAcknowledgedDelivery?.deliveryId ?? null } : null } });
  } catch {
    send({ type:"extension.diagnostics.inspected", requestId, payload:{ errorCode:"TAB_INSPECTION_FAILED" } });
  }
}
