import { CHATGPT_WEB_TARGET_PROVIDER, resolveWebTargetProvider } from "./provider-target.js";

export async function createConversationBootstrapTab(chromeApi, waitForContentScript, provider = CHATGPT_WEB_TARGET_PROVIDER) {
  let created;
  try { created = await chromeApi.tabs.create({ url:provider.rootUrl, active:true }); }
  catch { return null; }
  if (!Number.isSafeInteger(created?.id)) return null;
  await waitForContentScript(created.id, 30_000, true);
  const tab = await chromeApi.tabs.get(created.id);
  return provider.canonicalize(tab?.url) === provider.rootUrl
    && provider.conversationIdFromUrl(tab?.url) === null ? tab : null;
}

export async function reopenExactConversationTab(chromeApi, waitForContentScript, requested, provider = null) {
  const targetProvider = provider ?? resolveWebTargetProvider({
    provider:requested?.provider ?? null,
    conversationUrl:requested?.conversationUrl ?? null,
  });
  if (!targetProvider) return null;
  let created;
  try {
    created = await chromeApi.tabs.create({ url:requested.conversationUrl, active:true });
    if (!Number.isSafeInteger(created?.id)) return null;
    await waitForContentScript(created.id, 30_000, true);
    const tab = await chromeApi.tabs.get(created.id);
    if (targetProvider.canonicalize(tab?.url) === requested.conversationUrl
      && targetProvider.conversationIdFromUrl(tab?.url) === requested.conversationId) return tab;
  } catch { /* An unconfirmed tab cannot become a binding. */ }
  return null;
}
