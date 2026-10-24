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

export async function openInspectedChatGptTab(tabs, expected, windows = null, { trace = () => {}, isCurrent = () => true } = {}) {
  const assertCurrent = () => {
    if (!isCurrent()) throw Object.assign(new Error("The requesting connection changed."), {code:"TAB_CHANGED"});
    if (expected?.expiresAt != null && (!Number.isFinite(expected.expiresAt) || Date.now() >= expected.expiresAt)) {
      throw Object.assign(new Error("The focus request expired."), {code:"TAB_FOCUS_EXPIRED"});
    }
  };
  assertCurrent();
  if (!Number.isInteger(expected?.tabId) || !canonicalChatGptUrl(expected?.url)) {
    throw new Error("확인한 ChatGPT 탭을 선택하세요.");
  }
  trace("tab-query-started");
  const tab = await tabs.get(expected.tabId).catch(() => null);
  trace("tab-query-completed");
  assertCurrent();
  if (!tab || canonicalChatGptUrl(tab.url) !== expected.url) {
    throw new Error("탭이 닫혔거나 주소가 변경됐습니다. 탭 상태를 다시 확인하세요.");
  }
  trace("tab-activation-started");
  assertCurrent();
  try {
    await tabs.update(tab.id, { active: true });
    trace("tab-activation-completed");
    assertCurrent();
    if (windows && Number.isInteger(tab.windowId)) {
      trace("window-focus-started");
      assertCurrent();
      const focused = await windows.update(tab.windowId, { focused:true });
      trace("window-focus-completed");
      assertCurrent();
      if (focused?.focused !== true) throw new Error("Window focus unconfirmed");
    }
    trace("tab-recheck-started");
    const observed = await tabs.get(tab.id);
    trace("tab-recheck-completed");
    assertCurrent();
    if (!isCurrent() || observed?.active !== true || observed.windowId !== tab.windowId
      || canonicalChatGptUrl(observed.url) !== expected.url) throw new Error("Tab focus unconfirmed");
  } catch {
    // Activation may already have happened. Never label this as not executed.
    throw Object.assign(new Error("탭 이동 결과가 미확인입니다. 현재 탭을 직접 확인하세요."), { code:"TAB_FOCUS_UNCONFIRMED" });
  }
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

let pendingFocus = null;
export async function replyToTabFocus(chromeApi, send, message, {isCurrent = () => true, turnGate = null} = {}) {
  const trace = (phase, code = null) => console.info("[bridge:tab-focus]", JSON.stringify({
    phase, requestId:message.requestId, tabId:message.payload?.tabId ?? null, code,
    extensionVersion:chromeApi.runtime?.getManifest?.().version ?? null,
  }));
  trace("extension-received");
  let response, reservation, ownsFocus = false;
  try {
    if (pendingFocus) throw Object.assign(new Error("A focus operation is still running."), {code:"WEB_SESSION_BUSY"});
    reservation = turnGate?.reserve(message.requestId);
    pendingFocus = message;
    ownsFocus = true;
    const payload = await openInspectedChatGptTab(chromeApi.tabs, message.payload, chromeApi.windows, {trace,isCurrent});
    response = { type:"web.tab.focused", requestId:message.requestId, payload };
  } catch (error) {
    response = { type:"web.session.error", requestId:message.requestId,
      payload:{ code:error.code ?? "TAB_CHANGED", message:error.code === "TAB_FOCUS_UNCONFIRMED"
        ? error.message : "탭을 열지 못했습니다. 최신 후보를 확인하세요.",
        details:{executionOutcome:error.code === "TAB_FOCUS_UNCONFIRMED" ? "UNKNOWN" : "NOT_EXECUTED"} } };
  } finally {
    // Only the operation that actually settled may release its reservation.
    if (ownsFocus && pendingFocus === message) pendingFocus = null;
    if (reservation) turnGate.release(reservation);
  }
  trace("extension-result", response.payload.code ?? null);
  try { trace(send(response) === false ? "response-not-sent" : "response-send-returned"); }
  catch { trace("response-send-failed"); }
}

export async function replyToConnectedTabFocus(chromeApi, send, message, getSocket, isAuthenticated, turnGate = null) {
  const requestSocket = getSocket();
  const isCurrent = () => getSocket() === requestSocket && isAuthenticated() && requestSocket?.readyState === 1;
  await replyToTabFocus(chromeApi, response => isCurrent() ? send(response) : false, message, {isCurrent,turnGate});
}
