import { CHATGPT_WEB_TARGET_PROVIDER } from "./provider-target.js";
import { ExtensionStateError } from "./storage.js";

export function conversationTabCandidates(tabs, provider, url, conversationId) {
  return tabs.filter(tab => [tab.url, tab.pendingUrl].some(value =>
    provider.canonicalize(value) === url && provider.conversationIdFromUrl(value) === conversationId));
}

async function inspectRootTabs(chromeApi, provider) {
  let windows, tabs;
  try {
    windows = await chromeApi.windows.getAll({ populate:true, windowTypes:["normal"] });
    tabs = await chromeApi.tabs.query({});
  } catch {
    throw new ExtensionStateError("BROWSER_SCOPE_UNCONFIRMED", "The extension could not verify its browser window.");
  }
  const [window] = windows;
  if (windows.length !== 1 || window.type !== "normal" || window.incognito !== false
    || !Number.isSafeInteger(window.id) || !Array.isArray(window.tabs) || window.tabs.length === 0) {
    throw new ExtensionStateError("BROWSER_SCOPE_UNCONFIRMED", "Select an existing start tab in the connected Chrome profile.");
  }
  const visible = tabs.filter(tab => tab.windowId === window.id);
  if (visible.length !== window.tabs.length || visible.some(tab =>
    !window.tabs.some(item => item.id === tab.id && item.url === tab.url && item.pendingUrl === tab.pendingUrl))) {
    throw new ExtensionStateError("BROWSER_SCOPE_UNCONFIRMED", "Browser tabs changed while checking the target window.");
  }
  const roots = conversationTabCandidates(tabs, provider, provider.rootUrl, null);
  if (roots.length > 1) throw new ExtensionStateError("AMBIGUOUS", "More than one provider start tab is open.");
  return { windowId:window.id, root:roots[0] ?? null };
}

export async function createConversationBootstrapTab(chromeApi, waitForContentScript, provider = CHATGPT_WEB_TARGET_PROVIDER) {
  const before = await inspectRootTabs(chromeApi, provider);
  if (before.root) return before.root;
  const created = await chromeApi.tabs.create({ url:provider.rootUrl, active:true, windowId:before.windowId });
  if (!Number.isSafeInteger(created?.id)) return null;
  await waitForContentScript(created.id, 30_000, true);
  const after = await inspectRootTabs(chromeApi, provider);
  return after.windowId === before.windowId && after.root?.id === created.id
    && provider.canonicalize(after.root.url) === provider.rootUrl ? after.root : null;
}
