import { canonicalChatGptUrl } from "./conversation.js";
import { readDeliveryPage } from "./delivery-page.js";
import { classifyStoredAmbiguousRoot } from "./binding-recovery.js";
import { isLegacyBridgeTestDelivery } from "./storage.js";

export async function projectPopupConnectionState({ store, chromeApi, turnGate, socket, authenticated, lastError }) {
  let state = await store.read();
  const patterns = ["https://chatgpt.com/*"];
  const roots = (await chromeApi.tabs.query({ url: patterns })).filter(tab => canonicalChatGptUrl(tab.url) === "https://chatgpt.com/");
  const rootPage = roots.length === 1 ? await readDeliveryPage(chromeApi.tabs, roots[0].id) : null;
  let bindingRecovery = classifyStoredAmbiguousRoot({ state, roots, rootPage, busy: turnGate.active });
  if (bindingRecovery?.recovered) {
    try {
      state = await store.updateIf({ bindingStatus: state.bindingStatus, currentDeliveryId: state.currentDeliveryId,
        documentId: state.documentId, tabId: state.tabId, lastBoundSessionId: state.lastBoundSessionId,
        lastBoundRunId: state.lastBoundRunId }, bindingRecovery.patch);
    } catch {
      state = await store.read();
      bindingRecovery = classifyStoredAmbiguousRoot({ state, roots, rootPage, busy: turnGate.active });
    }
  }
  if (state.bindingStatus === "AMBIGUOUS" && !state.bindingError) {
    const code = bindingRecovery?.code ?? "STORED_AMBIGUOUS_REBIND_REQUIRED";
    const message = bindingRecovery?.message ?? "저장된 모호한 바인딩을 자동 복구할 수 없습니다.";
    try { state = await store.updateIf({ bindingStatus: "AMBIGUOUS", bindingError: null }, { bindingError: `${code}: ${message}` }); }
    catch { state = await store.read(); }
  }
  const scopedDeliveries = Object.entries(state.deliveryScopes ?? {}).map(([sessionId, slot]) =>
    ({ sessionId, deliveryId: slot.currentDeliveryId }));
  const boundPage = state.tabId === roots[0]?.id ? rootPage : await readDeliveryPage(chromeApi.tabs, state.tabId);
  return {
    startTab: rootPage?.ready && !rootPage.busy && !rootPage.generating ? { tabId: roots[0].id, ready: true } : null,
    connected: authenticated && socket?.readyState === 1, transportConnected: socket?.readyState === 1,
    connecting: socket?.readyState === 0, authenticated, busy: turnGate.active,
    tabId: state.tabId, conversationUrl: state.conversationUrl, bindingStatus: state.bindingStatus,
    bindingError: state.bindingError, currentDeliveryId: state.currentDeliveryId,
    deliveryPhase: state.currentDeliveryId ? state.completedDelivery?.turnId === state.currentDeliveryId
      ? "RESPONSE_OBSERVED" : turnGate.active || (boundPage?.activeRequestId === state.currentDeliveryId && boundPage.documentId === state.documentId)
        ? "IN_FLIGHT" : "UNRESOLVED" : "IDLE",
    scopedDeliveries, pendingDeliveryCount: scopedDeliveries.length + (state.currentDeliveryId ? 1 : 0),
    legacyTestDelivery: isLegacyBridgeTestDelivery(state), extensionIdentity: state.extensionIdentity || null,
    bindingRecovery: bindingRecovery ? { code: bindingRecovery.code, message: bindingRecovery.message, recovered: bindingRecovery.recovered } : null,
    extensionVersion: chromeApi.runtime?.getManifest?.().version ?? null,
    contentVersion: boundPage?.runtimeVersion ?? null, lastError,
  };
}
