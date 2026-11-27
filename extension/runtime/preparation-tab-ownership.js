import { readDeliveryPage } from "./delivery-page.js";

const ownershipKey = tabId => `bridge-preparation-tab:${tabId}`;
const managedSession = sessionId => typeof sessionId === "string"
  && /^web_(?:prep_[a-z0-9-]+|code_[a-z0-9-]+(?:_critic)?)$/iu.test(sessionId);

export async function rememberPreparationTab(chromeApi, tab, sessionId) {
  if (!managedSession(sessionId) || !chromeApi.storage.session) return;
  // Session storage survives worker sleep, but expires with browser tab identities.
  const key = ownershipKey(tab.id);
  await chromeApi.storage.session.set({ [key]:{ sessionId, windowId:tab.windowId } }).catch(() => {});
}

export async function forgetPreparationTab(chromeApi, tabId) {
  await chromeApi.storage.session?.remove(ownershipKey(tabId)).catch(() => {});
}

async function ownershipFor(chromeApi, tabId) {
  if (!Number.isSafeInteger(tabId) || !chromeApi.storage.session) return null;
  const key = ownershipKey(tabId);
  const values = await chromeApi.storage.session.get(key).catch(() => ({}));
  return values[key] ?? null;
}

export async function recordOwnedTabAcknowledgement(chromeApi, state) {
  const record = await ownershipFor(chromeApi, state.tabId);
  if (!record || record.sessionId !== state.lastBoundSessionId || record.windowId !== state.windowId) return false;
  const ack = state.lastAcknowledgedDelivery;
  if (!ack?.deliveryId || ack.sessionId !== record.sessionId || ack.runId !== state.lastBoundRunId
    || ack.conversationUrl !== state.conversationUrl) return false;
  const proof = { ...ack, conversationId:state.conversationId, documentId:state.documentId };
  return chromeApi.storage.session.set({ [ownershipKey(state.tabId)]:{ ...record, ack:proof } }).then(() => true, () => false);
}

export async function handoffOwnedPreparationTab(chromeApi, tab, requested, documentId, sourceSessionId) {
  if (typeof sourceSessionId !== "string" || !/^web_prep_[a-z0-9-]+$/iu.test(sourceSessionId)
    || !requested.runId.startsWith("code_") || requested.sessionId !== `web_${requested.runId}`) return;
  const record = await ownershipFor(chromeApi, tab.id);
  if (record?.sessionId !== sourceSessionId || record.windowId !== tab.windowId
    || record.ack?.conversationUrl !== requested.conversationUrl || record.ack?.conversationId !== requested.conversationId
    || record.ack?.documentId !== documentId) return;
  await rememberPreparationTab(chromeApi, tab, requested.sessionId);
}

export async function closeFinishedPreparationTab(chromeApi, store, expected) {
  const { tabId, windowId, sessionId, runId, deliveryId, conversationUrl, conversationId, documentId } = expected;
  if (!Number.isSafeInteger(tabId) || !managedSession(sessionId)
    || (sessionId !== `web_${runId}` && !(runId?.startsWith("code_") && sessionId === `web_${runId}_critic`))
    || !deliveryId || !conversationId || !documentId) return { status:"SKIPPED", reason:"IDENTITY_UNCONFIRMED" };
  const record = await ownershipFor(chromeApi, tabId);
  if (record?.sessionId !== sessionId || record.windowId !== windowId) {
    return { status:"SKIPPED", reason:"TAB_NOT_BRIDGE_OWNED" };
  }
  const canClose = state => {
    const ack = record.ack;
    return ack?.deliveryId === deliveryId && ack.sessionId === sessionId && ack.runId === runId
      && ack.conversationUrl === conversationUrl && ack.conversationId === conversationId && ack.documentId === documentId
      && !(state.currentDeliveryId && (state.lastBoundSessionId === sessionId || state.tabId === tabId
        || state.conversationUrl === conversationUrl))
      && !Object.entries(state.deliveryScopes).some(([owner, slot]) =>
        owner === sessionId || slot.tabId === tabId || slot.conversationUrl === conversationUrl)
      && (state.lastBoundSessionId === sessionId || (state.tabId !== tabId && state.conversationUrl !== conversationUrl))
      && (state.lastBoundSessionId !== sessionId || (state.lastBoundRunId === runId && state.tabId === tabId
        && state.windowId === windowId && state.documentId === documentId && state.bindingStatus === "BOUND"));
  };
  if (!canClose(await store.read())) return { status:"SKIPPED", reason:"ACK_OR_BINDING_UNCONFIRMED" };
  const page = await readDeliveryPage(chromeApi.tabs, tabId);
  if (page?.ok !== true || page.frameId !== 0 || page.documentId !== documentId
    || page.url !== conversationUrl || page.conversationId !== conversationId
    || page.busy !== false || page.generating !== false || page.activeRequestId) {
    return { status:"SKIPPED", reason:"DOCUMENT_OR_ACTIVITY_UNCONFIRMED" };
  }
  if (!canClose(await store.read())) return { status:"SKIPPED", reason:"ACK_OR_BINDING_UNCONFIRMED" };
  const tab = await chromeApi.tabs.get(tabId).catch(() => null);
  if (!tab || tab.windowId !== windowId || tab.url !== conversationUrl || tab.pendingUrl || tab.pinned) {
    return { status:"SKIPPED", reason:"TAB_CHANGED" };
  }
  await chromeApi.tabs.remove(tabId);
  await forgetPreparationTab(chromeApi, tabId);
  return { status:"CLOSED", tabId };
}
