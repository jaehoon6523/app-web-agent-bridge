import { CHATGPT_WEB_TARGET_PROVIDER, resolveWebTargetProvider } from "./provider-target.js";
import { ExtensionStateError } from "./storage.js";

export function conversationTabCandidates(tabs, provider, url, conversationId) {
  return tabs.filter(tab => [tab.url, tab.pendingUrl].some(value =>
    provider.canonicalize(value) === url && provider.conversationIdFromUrl(value) === conversationId));
}

async function inspectRootTabs(chromeApi, provider, windowId, stage) {
  const fail = (code, message, details = {}) => {
    throw new ExtensionStateError(code, message, { stage, windowId, tabId:null, rootCount:null, ...details });
  };
  let windows, tabs;
  try {
    windows = await chromeApi.windows.getAll({ populate:true, windowTypes:["normal"] });
  } catch { fail("BROWSER_SCOPE_UNCONFIRMED", "Chrome window enumeration failed."); }
  try { tabs = await chromeApi.tabs.query({}); }
  catch { fail("ROOT_TAB_QUERY_FAILED", "Chrome tab enumeration failed."); }
  const regular = windows.filter(window => window.type === "normal" && window.incognito === false
    && Number.isSafeInteger(window.id) && Array.isArray(window.tabs));
  if (!regular.length) fail("BROWSER_SCOPE_UNCONFIRMED", "No regular window is available in the extension profile.");
  for (const window of regular) {
    const visible = tabs.filter(tab => tab.windowId === window.id);
    if (visible.length !== window.tabs.length || visible.some(tab =>
      !window.tabs.some(item => item.id === tab.id && item.url === tab.url && item.pendingUrl === tab.pendingUrl))) {
      fail("WEB_TAB_INVENTORY_CHANGED", "Chrome tabs changed during inspection.", { windowId:window.id });
    }
  }
  const roots = conversationTabCandidates(tabs, provider, provider.rootUrl, null);
  if (roots.length > 1) fail("AMBIGUOUS", "More than one provider start tab is open.", { rootCount:roots.length });
  const root = roots[0] ?? null;
  const target = root?.windowId ?? windowId ?? (regular.length === 1 ? regular[0].id : null);
  if (target === null) fail("ROOT_WINDOW_SELECTION_REQUIRED", "Choose the Chrome window for the start tab.", { rootCount:0 });
  if (!regular.some(window => window.id === target)) {
    fail("BROWSER_SCOPE_UNCONFIRMED", "The target window is outside the verified windows.", { windowId:target, rootCount:roots.length });
  }
  if (root && (root.pendingUrl || provider.canonicalize(root.url) !== provider.rootUrl)) {
    fail("WEB_TAB_INVENTORY_CHANGED", "The start tab is navigating.", { windowId:target, tabId:root.id, rootCount:1 });
  }
  return { windowId:target, root };
}

export async function createConversationBootstrapTab(chromeApi, waitForContentScript, provider = CHATGPT_WEB_TARGET_PROVIDER, windowId = null) {
  const before = await inspectRootTabs(chromeApi, provider, windowId, "BEFORE_CREATE");
  if (before.root) return before.root;
  const created = await chromeApi.tabs.create({ url:provider.rootUrl, active:true, windowId:before.windowId });
  if (!Number.isSafeInteger(created?.id)) return null;
  await waitForContentScript(created.id, 30_000, true, provider.rootUrl);
  const after = await inspectRootTabs(chromeApi, provider, before.windowId, "AFTER_CREATE");
  if (after.windowId !== before.windowId || after.root?.id !== created.id) {
    throw new ExtensionStateError("WEB_TAB_INVENTORY_CHANGED", "The created tab changed before binding.",
      { stage:"AFTER_CREATE", windowId:before.windowId, tabId:created.id, rootCount:after.root ? 1 : 0 });
  }
  return after.root;
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
    await waitForContentScript(created.id, 30_000, true, requested.conversationUrl);
    const tab = await chromeApi.tabs.get(created.id);
    if (targetProvider.canonicalize(tab?.url) === requested.conversationUrl
      && targetProvider.conversationIdFromUrl(tab?.url) === requested.conversationId) return tab;
  } catch { /* An unconfirmed tab cannot become a binding. */ }
  return null;
}
