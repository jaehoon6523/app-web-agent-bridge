import { canonicalChatGptUrl, conversationIdFromUrl } from "./conversation.js";

export async function createConversationBootstrapTab(chromeApi, waitForContentScript) {
  let created;
  try {
    created = await chromeApi.tabs.create({ url:"https://chatgpt.com/", active:false });
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(created?.id)) return null;
  await waitForContentScript(created.id, 30_000, true);
  return chromeApi.tabs.get(created.id);
}

export async function reopenExactConversationTab(chromeApi, waitForContentScript, requested) {
  let created;
  try {
    created = await chromeApi.tabs.create({ url: requested.conversationUrl, active: true });
    if (!Number.isSafeInteger(created?.id)) return null;
    await waitForContentScript(created.id, 30_000, true);
    const tab = await chromeApi.tabs.get(created.id);
    if (canonicalChatGptUrl(tab?.url) === requested.conversationUrl
      && conversationIdFromUrl(tab?.url) === requested.conversationId) return tab;
  } catch { /* An unconfirmed tab cannot become a binding. */ }
  return null;
}
