import { defaultWebTargetProviderRegistry, resolveWebTargetProvider } from "./provider-target.js";

export class CurrentWebTargetError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "CurrentWebTargetError";
    this.code = code;
    this.details = details;
  }
}

function providerForState(state, registry) {
  if (!state?.conversationUrl) return null;
  return resolveWebTargetProvider({
    provider:state.webProvider ?? null,
    conversationUrl:state.conversationUrl,
    registry,
  });
}

function providerPatterns(registry) {
  return [...new Set(registry.list().flatMap((provider) => provider.urlPatterns))];
}

export function isPendingRootPromotion({
  state, tab, activeRequestId, registry = defaultWebTargetProviderRegistry,
}) {
  const provider = providerForState(state, registry);
  return state.tabId === tab?.id
    && provider?.canonicalize(state.conversationUrl) === provider?.rootUrl
    && state.conversationId === null
    && provider?.conversationIdFromUrl(tab?.url) !== null
    && typeof state.currentDeliveryId === "string"
    && state.currentDeliveryId === activeRequestId;
}

export function createStoredTarget(value) {
  return Object.freeze({ ...value, observedAt: Date.now() });
}

function targetFromPage(tab, page, registry, expectedProvider = null) {
  const rawUrl = page?.url ?? tab?.url;
  const provider = resolveWebTargetProvider({
    provider:expectedProvider,
    conversationUrl:rawUrl ?? null,
    registry,
  });
  const conversationUrl = provider?.canonicalize(rawUrl);
  const conversationId = provider?.conversationIdFromUrl(conversationUrl);
  if (!provider || !Number.isSafeInteger(tab?.id) || !Number.isSafeInteger(tab?.windowId)
    || !page?.ok || !conversationUrl || !page.documentId || page.frameId !== 0
    || (page.conversationId ?? null) !== conversationId) return null;
  return createStoredTarget({
    provider:provider.provider,
    tabId:tab.id,
    windowId:tab.windowId,
    documentId:page.documentId,
    frameId:0,
    conversationUrl,
    conversationId,
  });
}

export function pendingDeliveryTargetConflict(state, target, requestId) {
  const sameTarget = state.tabId === target.tabId && state.documentId === target.documentId && state.frameId === target.frameId;
  return { code: sameTarget ? "RECOVERY_REQUIRED" : "STALE_DELIVERY_CONTEXT",
    message: sameTarget && state.currentDeliveryId === requestId
      ? "This delivery may already have been submitted and will not be sent again automatically."
      : sameTarget ? "A prior delivery remains unacknowledged and must be recovered before another prompt is sent."
        : "이전 전송 대상과 현재 사용자가 선택한 Web 페이지가 다릅니다. 이전 전송을 현재 페이지로 복구하지 않습니다.",
    details: { currentDeliveryId: state.currentDeliveryId, persistedTabId: state.tabId, persistedDocumentId: state.documentId,
      currentTabId: target.tabId, currentDocumentId: target.documentId } };
}

export async function observeActiveWebTarget({
  tabs, store, tabId, waitForContentScript, registry = defaultWebTargetProviderRegistry,
}) {
  const tab = await tabs.get(tabId).catch(() => null);
  const provider = registry.providerForUrl(tab?.url);
  if (!provider) return null;
  await waitForContentScript(tab.id, 30_000, false);
  const page = await tabs.sendMessage(tab.id, { type: "agent.ping" }).catch(() => null);
  const target = targetFromPage(tab, page, registry, provider.provider);
  if (target) await store.update({ lastActiveWebTarget: target });
  return target;
}

export const observeActiveChatGptTarget = observeActiveWebTarget;

export function installCurrentTargetTracking({
  tabs, windows, store, waitForContentScript, onChange, registry = defaultWebTargetProviderRegistry,
}) {
  const observe = (tabId) => void observeActiveWebTarget({ tabs, store, tabId, waitForContentScript, registry })
    .then((target) => { if (target) onChange?.(); }).catch(() => {});
  tabs.onActivated.addListener(({ tabId }) => observe(tabId));
  windows?.onFocusChanged?.addListener((windowId) => {
    if (windowId === windows.WINDOW_ID_NONE) return;
    void tabs.query({ active: true, windowId }).then((found) => { if (found.length === 1) observe(found[0].id); });
  });
  tabs.onRemoved.addListener((tabId) => void store.read()
    .then((state) => state.lastActiveWebTarget?.tabId === tabId ? store.update({ lastActiveWebTarget:null }) : null)
    .then(() => onChange?.()).catch(() => {}));
  void tabs.query({ active:true, lastFocusedWindow:true })
    .then((found) => { if (found.length === 1) observe(found[0].id); });
}

export async function resolveCurrentUserTarget({
  tabs, store, state, waitForContentScript, registry = defaultWebTargetProviderRegistry,
}) {
  const activeTabs = await tabs.query({
    active:true,
    lastFocusedWindow:true,
    url:providerPatterns(registry),
  });
  if (activeTabs.length > 1) {
    throw new CurrentWebTargetError("ACTIVE_WEB_TARGET_UNRESOLVED", "현재 사용자가 보고 있는 Web 탭을 하나로 확정할 수 없습니다.", {
      activeTabCount: activeTabs.length,
    });
  }
  const candidate = activeTabs[0] ? { tabId:activeTabs[0].id }
    : state.lastActiveWebTarget
      ?? (["BOUND", "ROOT_READY"].includes(state.bindingStatus) && Number.isSafeInteger(state.tabId)
        ? { tabId:state.tabId } : null);
  if (!candidate) {
    throw new CurrentWebTargetError("ACTIVE_WEB_TARGET_UNRESOLVED", "최근 사용자가 선택한 Web 탭이 없습니다.", {
      activeTabCount:0, lastActiveTabId:null,
    });
  }
  const tab = activeTabs[0] ?? await tabs.get(candidate.tabId).catch(() => null);
  const provider = registry.providerForUrl(tab?.url);
  if (!tab || !provider) {
    if (state.lastActiveWebTarget?.tabId === candidate.tabId) await store.update({ lastActiveWebTarget:null });
    throw new CurrentWebTargetError("ACTIVE_WEB_TARGET_UNAVAILABLE", "마지막으로 사용한 Web 탭이 닫혔거나 등록되지 않은 페이지로 이동했습니다.", {
      activeTabCount:activeTabs.length, lastActiveTabId:candidate.tabId,
    });
  }
  await waitForContentScript(tab.id, 30_000, true);
  const page = await tabs.sendMessage(tab.id, { type:"agent.ping" });
  const target = targetFromPage(tab, page, registry, provider.provider);
  const root = target?.conversationUrl === provider.rootUrl && target.conversationId === null;
  if (!target || !page.ready || page.busy || page.generating || (!target.conversationId && !root)) {
    throw new CurrentWebTargetError("ACTIVE_WEB_CONTEXT_UNRESOLVED", "현재 Web 탭의 document와 실행 가능 상태를 확인할 수 없습니다.", {
      provider:provider.provider, tabId:tab.id, url:target?.conversationUrl ?? null,
      documentId:page?.documentId ?? null, frameId:page?.frameId ?? null, pageStatus:page?.pageStatus ?? null,
    });
  }
  await store.update({ lastActiveWebTarget:target });
  return target;
}

export async function resolvePreparedSessionTarget({
  tabs, state, waitForContentScript, registry = defaultWebTargetProviderRegistry,
}) {
  if (!["BOUND", "ROOT_READY"].includes(state.bindingStatus) || !Number.isSafeInteger(state.tabId)) {
    throw new CurrentWebTargetError("NEEDS_REBIND", "The requested Web session has no prepared tab.");
  }
  const provider = providerForState(state, registry);
  const tab = await tabs.get(state.tabId).catch(() => null);
  if (!provider || !tab || provider.canonicalize(tab.url) !== state.conversationUrl
    || provider.conversationIdFromUrl(tab.url) !== state.conversationId) {
    throw new CurrentWebTargetError("NEEDS_REBIND", "The prepared Web provider tab changed or closed.");
  }
  await waitForContentScript(tab.id, 30_000, true);
  const page = await tabs.sendMessage(tab.id, { type:"agent.ping" });
  const target = targetFromPage(tab, page, registry, provider.provider);
  if (!target || !page.ready || page.busy || page.generating
    || target.conversationUrl !== state.conversationUrl
    || target.conversationId !== state.conversationId) {
    throw new CurrentWebTargetError("NEEDS_REBIND", "The prepared Web provider document is not ready or changed.");
  }
  return target;
}

export async function bindCurrentUserTarget({ store, state, target }) {
  return store.bindSession({
    lastBoundSessionId:state.lastBoundSessionId,
    lastBoundRunId:state.lastBoundRunId,
    webProvider:target.provider,
    tabId:target.tabId,
    windowId:target.windowId,
    documentId:target.documentId,
    frameId:target.frameId,
    conversationUrl:target.conversationUrl,
    conversationId:target.conversationId,
    bindingStatus:target.conversationId === null ? "ROOT_READY" : "BOUND",
    bindingError:null,
  });
}
