import { canonicalChatGptUrl } from "./conversation.js";
import { inspectDeliveryPage, pageDiagnosticMetadata } from "./delivery-page.js";

// Inspection never injects content, changes ownership, or sends a prompt.
export async function inspectChatGptTabs(tabs) {
  const candidates = (await tabs.query({ url: ["https://chatgpt.com/*"] }))
    .filter(tab => canonicalChatGptUrl(tab.url));
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
