import { inspectBoundDocument, createSuccessTrace, diagnosticError, errorPayload } from "./runtime/document-binding.js";
import { classifyStoredAmbiguousRoot, recoverBootstrapAfterNavigation } from "./runtime/bootstrap-recovery.js";
import { assertStrongExtensionSharedSecret, computeChallengeHmac } from "./runtime/hmac.js";
import { canonicalChatGptUrl, conversationIdFromUrl, matchExactConversationTabs, validateLocalControllerUrl } from "./runtime/conversation.js";
import { createControlledPrompt } from "./runtime/markers.js";
import { bindCurrentUserTarget, createStoredTarget, installCurrentTargetTracking, isPendingRootPromotion, pendingDeliveryTargetConflict, resolveCurrentUserTarget } from "./runtime/current-target.js";
import { createExtensionStateStore, ensureExtensionIdentity, isLegacyBridgeTestDelivery } from "./runtime/storage.js";
import { clearLegacyTestDelivery } from "./runtime/legacy-cleanup.js";
import { assertRelaySafeCompletion, assertTurnSessionBinding, assertTurnStateBinding, assertTurnTabBinding, captureTurnBinding, createActiveTurnGate } from "./runtime/turn-guard.js";
const PROTOCOL_VERSION = 2;
const CHATGPT_URL_PATTERNS = Object.freeze(["https://chatgpt.com/*"]);
const store = createExtensionStateStore(chrome.storage.local);
let socket = null;
let authenticated = false;
let pendingChallengeId = null;
let handledChallengeIds = new Set();
const turnGate = createActiveTurnGate();
let lastError = null;
function bridgeLog(event, details = {}) { console.info(`[bridge:trace:${event}]`, { at: new Date().toISOString(), ...details }); }
class ExtensionOperationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ExtensionOperationError"; this.code = code;
    this.details = details;
  }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function connectionState() {
  let state = await store.read();
  const roots = (await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS })).filter(tab => canonicalChatGptUrl(tab.url) === "https://chatgpt.com/");
  const rootPage = roots.length === 1 ? await chrome.tabs.sendMessage(roots[0].id, { type: "agent.ping" }).catch(() => null) : null;
  const bindingRecovery = classifyStoredAmbiguousRoot({ state, roots, rootPage, busy: turnGate.active });
  if (bindingRecovery?.recovered) state = await store.update(bindingRecovery.patch);
  if (state.bindingStatus === "AMBIGUOUS" && !state.bindingError) {
    const tabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
    const bindingError = diagnosticError(new ExtensionOperationError(bindingRecovery?.code ?? "STORED_AMBIGUOUS_REBIND_REQUIRED",
      bindingRecovery?.message ?? "저장된 모호한 바인딩을 자동 복구할 수 없습니다.", {
      mode: "STORED_AMBIGUOUS_RECOVERY", persistedTabId: state.tabId, persistedUrl: state.conversationUrl,
      persistedConversationId: state.conversationId, candidates: tabs.map((tab) => ({
        tabId: tab.id, windowId: tab.windowId, url: tab.url,
        canonicalUrl: canonicalChatGptUrl(tab.url), conversationId: conversationIdFromUrl(tab.url),
      })), }));
    state = await store.update({ bindingError });
  }
  return {
    startTab: rootPage?.ready && !rootPage.busy && !rootPage.generating ? { tabId: roots[0].id, ready: true } : null,
    connected: authenticated && socket?.readyState === WebSocket.OPEN,
    transportConnected: socket?.readyState === WebSocket.OPEN,
    connecting: socket?.readyState === WebSocket.CONNECTING,
    authenticated,
    busy: turnGate.active,
    tabId: state.tabId,
    conversationUrl: state.conversationUrl,
    bindingStatus: state.bindingStatus,
    bindingError: state.bindingError, currentDeliveryId: state.currentDeliveryId, legacyTestDelivery: isLegacyBridgeTestDelivery(state),
    extensionIdentity: state.extensionIdentity || null, bindingRecovery: bindingRecovery ? { code: bindingRecovery.code, message: bindingRecovery.message, recovered: bindingRecovery.recovered } : null,
    lastError,
  };
}
function broadcastPopupState() {
  void connectionState()
    .then((payload) => chrome.runtime.sendMessage({ type: "bridge.state", payload }))
    .catch(() => {});
}
function send(message, { allowUnauthenticated = false } = {}) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  if (!allowUnauthenticated && !authenticated) return false;
  socket.send(JSON.stringify({ ...message, protocolVersion: PROTOCOL_VERSION }));
  return true;
}
async function connect() {
  const state = await store.read();
  let controllerUrl;
  try {
    controllerUrl = validateLocalControllerUrl(state.controllerUrl);
    try {
      assertStrongExtensionSharedSecret(state.sharedSecret);
    } catch {
      throw new ExtensionOperationError(
        "SHARED_SECRET_INVALID",
        "Configure a shared secret containing at least 32 UTF-8 bytes before connecting.",
      );
    }
    await ensureExtensionIdentity(store);
  } catch (error) {
    lastError = error.message;
    broadcastPopupState();
    return;
  }
  const previousSocket = socket;
  socket = null;
  authenticated = false;
  pendingChallengeId = null;
  handledChallengeIds = new Set();
  try {
    previousSocket?.close(1000, "Reconnecting");
  } catch {
    // A new authenticated connection is still attempted below.
  }
  const nextSocket = new WebSocket(controllerUrl);
  socket = nextSocket;
  broadcastPopupState();
  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket) return;
    lastError = null;
    // No identity or state is sent until the controller challenge is authenticated.
    broadcastPopupState();
  });
  nextSocket.addEventListener("message", (event) => {
    if (socket !== nextSocket) return;
    void handleControllerMessage(event.data);
  });
  nextSocket.addEventListener("close", (event) => {
    if (socket !== nextSocket) return;
    socket = null;
    authenticated = false;
    pendingChallengeId = null;
    lastError = event.code === 4403 && lastError
      ? lastError
      : event.code === 1000
      ? null
      : `Controller disconnected (${event.code}${event.reason ? `: ${event.reason}` : ""}).`;
    broadcastPopupState();
  });
  nextSocket.addEventListener("error", () => {
    if (socket !== nextSocket) return;
    lastError = "Could not connect to the local controller.";
    broadcastPopupState();
  });
}
async function answerAuthenticationChallenge(message) {
  if (
    message.protocolVersion !== PROTOCOL_VERSION
    || typeof message.challengeId !== "string"
    || typeof message.nonce !== "string"
    || !/^[0-9a-f]{64}$/.test(message.nonce)
    || handledChallengeIds.has(message.challengeId)
  ) {
    return;
  }
  if (typeof message.expiresAt === "string" && Date.parse(message.expiresAt) < Date.now()) return;
  handledChallengeIds.add(message.challengeId);
  pendingChallengeId = message.challengeId;
  const state = await store.read();
  const extensionIdentity = await ensureExtensionIdentity(store);
  const hmacSha256 = await computeChallengeHmac(message.nonce, state.sharedSecret);
  send({ type: "extension.auth.response", challengeId: message.challengeId, extensionIdentity, hmacSha256 }, { allowUnauthenticated: true });
}
async function handleControllerMessage(raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (!message || typeof message !== "object" || message.protocolVersion !== PROTOCOL_VERSION) return;
  if (!authenticated) {
    if (message.type === "controller.auth.challenge") {
      await answerAuthenticationChallenge(message);
      return;
    }
    if (
      message.type === "controller.auth.accepted"
      && pendingChallengeId
      && message.challengeId === pendingChallengeId
    ) {
      authenticated = true;
      pendingChallengeId = null;
      lastError = null;
      const state = await store.read();
      send({
        type: "extension.hello",
        payload: {
          version: chrome.runtime.getManifest().version,
          extensionIdentity: state.extensionIdentity,
          session: await getSessionInfo().catch(() => null),
          currentDeliveryId: state.currentDeliveryId,
          busy: turnGate.active,
        },
      });
      broadcastPopupState();
      return;
    }
    if (message.type === "controller.auth.rejected") {
      lastError = `Controller rejected extension authentication (${message.code || "AUTHENTICATION_FAILED"}).`;
      socket?.close(4403, "Authentication rejected");
    }
    // All other controller commands are ignored until authentication completes.
    return;
  }
  switch (message.type) {
    case "web.session.prepare":
      await handlePrepare(message, false);
      break;
    case "web.session.rebind":
      await handlePrepare(message, true);
      break;
    case "web.prompt":
      await handlePrompt(message);
      break;
    case "web.cancel":
      await cancelPrompt(message.requestId);
      break;
    case "web.delivery.ack":
      await handleDeliveryAcknowledgement(message);
      break;
    case "web.delivery.discard":
      await handleDeliveryDiscard(message);
      break;
    case "web.delivery.recover":
      await handleDeliveryRecovery(message);
      break;
    case "web.delivery.inspect":
      if (message.payload?.refreshCompleted) {
        let recheckReservation;
        try {
          recheckReservation = turnGate.reserve(message.requestId);
          const saved = await store.read();
          const completed = saved.completedDelivery;
          if (!completed || completed.turnId !== saved.currentDeliveryId || !saved.lastBoundRunId?.startsWith("prep_")) {
            throw new ExtensionOperationError("RESPONSE_RECHECK_UNAVAILABLE", "다시 확인할 준비 응답이 없습니다.");
          }
          const result = await chrome.tabs.sendMessage(saved.tabId, { type: "agent.recheck", payload: {
            expectedConversationUrl: saved.conversationUrl, expectedConversationId: saved.conversationId,
            expectedDocumentId: saved.documentId, expectedFrameId: saved.frameId,
            runId: saved.lastBoundRunId, controllerMessageId: completed.turnId,
            userMessageId: completed.evidence?.userMessageId, assistantMessageId: completed.evidence?.assistantMessageId,
          } });
          if (!result?.ok) throw new ExtensionOperationError(result?.code ?? "RESPONSE_RECHECK_FAILED", result?.error ?? "응답 재확인에 실패했습니다.");
          const current = await store.read();
          if (current.currentDeliveryId !== completed.turnId || current.lastBoundSessionId !== saved.lastBoundSessionId) {
            throw new ExtensionOperationError("DELIVERY_RECOVERY_MISMATCH", "재확인 중 전송 대상이 변경됐습니다.");
          }
          await store.update({ completedDelivery: {
            ...completed,
            rawText: result.text,
            confidence: result.confidence,
            confidenceReason: result.confidenceReason ?? null,
            evidence: result.evidence,
          } });
        } catch (error) {
          send({ type: "web.session.error", requestId: message.requestId, payload: errorPayload(error) });
          break;
        } finally {
          if (recheckReservation) turnGate.release(recheckReservation);
        }
      }
      send({ type: "web.delivery.inspected", requestId: message.requestId, payload: await deliveryDetails(await store.read()) });
      break;
    case "web.delivery.stop":
      await handleDeliveryStop(message);
      break;
    case "web.delivery.focus":
      try {
        const state = await store.read();
        if (state.tabId === null || state.lastBoundSessionId !== message.payload?.sessionId
          || state.conversationUrl !== message.payload?.conversationUrl) {
          throw new ExtensionOperationError("DELIVERY_RECOVERY_MISMATCH", "이전 대화 탭이 변경됐습니다. 상태를 다시 확인하세요.");
        }
        const tab = await chrome.tabs.get(state.tabId);
        if (canonicalChatGptUrl(tab.url) !== state.conversationUrl) throw new ExtensionOperationError("DELIVERY_RECOVERY_MISMATCH", "기존 탭이 다른 대화로 이동했습니다.");
        await focusTab(tab);
        send({ type: "web.delivery.focused", requestId: message.requestId, payload: {} });
      } catch (error) {
        send({ type: "web.session.error", requestId: message.requestId, payload: errorPayload(error) });
      }
      break;
    case "web.session.focus":
      await handleFocus(message);
      break;
    case "controller.ping":
      send({ type: "extension.heartbeat", payload: { at: Date.now(), busy: turnGate.active } });
      break;
    default:
      break;
  }
}
async function handlePrepare(message, explicitRebind) {
  bridgeLog("prepare:start", { preparationId: message.payload?.preparationId ?? null, sessionId: message.payload?.sessionId ?? null, explicitRebind });
  try {
    turnGate.assertIdle(explicitRebind ? "Session rebind" : "Session preparation");
    const session = explicitRebind
      ? await rebindSession(message.payload || {})
      : await prepareBoundSession(message.payload || {});
    lastError = null;
    bridgeLog("prepare:bound", { sessionId: session.sessionId, runId: session.runId, tabId: session.tabId, bindingStatus: session.bindingStatus, conversationUrl: session.conversationUrl, conversationId: session.conversationId });
    await store.update({ bindingError: null });
    broadcastPopupState();
    send({ type: "web.session.ready", requestId: message.requestId, payload: { session } });
  } catch (error) {
    bridgeLog("prepare:failed", { code: error.code ?? null, message: error.message, details: error.details ?? null });
    lastError = diagnosticError(error);
    await store.update({ bindingError: lastError });
    broadcastPopupState();
    if (error?.code === "SESSION_AUTH_REQUIRED") {
      await store.update({ bindingStatus: "AUTH_REQUIRED" });
    }
    if (error?.code === "WEB_SESSION_BUSY") error.details = await deliveryDetails(await store.read());
    send({ type: "web.session.error", requestId: message.requestId, payload: errorPayload(error) });
  }
}
async function handleDeliveryAcknowledgement(message) {
  try {
    turnGate.assertIdle("Delivery acknowledgement");
    console.info("[bridge:delivery:ack-received]", { deliveryId: message.requestId });
    await store.clearDelivery(message.requestId, message.payload?.sessionId ?? null);
    console.info("[bridge:delivery:ack-cleared]", { deliveryId: message.requestId });
    broadcastPopupState();
  } catch (error) {
    send({ type: "web.prompt.error", requestId: message.requestId, payload: errorPayload(error) });
  }
}
async function handleDeliveryDiscard(message) {
  try { turnGate.assertIdle("Delivery discard"); const state = await store.read(), expected = message.payload || {};
    if (expected.unresolvedResultConfirmed !== true || expected.noAutomaticResendConfirmed !== true || typeof expected.reason !== "string" || expected.reason.trim().length < 3) throw new ExtensionOperationError("DISCARD_CONFIRMATION_REQUIRED", "미확정 결과와 자동 재전송 금지를 확인하고 폐기 사유를 입력하세요.");
    if (state.currentDeliveryId !== expected.currentDeliveryId || state.lastBoundSessionId !== expected.sessionId
      || state.lastBoundRunId !== expected.runId || state.conversationUrl !== expected.conversationUrl) throw new ExtensionOperationError("DELIVERY_RECOVERY_MISMATCH", "폐기 대상 전송 identity가 현재 기록과 다릅니다.");
    await store.update({ currentDeliveryId: null, completedDelivery: null, bindingStatus: "NEEDS_REBIND", bindingError: `RECOVERY_DISCARDED: ${expected.reason.trim()}` });
    send({ type: "web.delivery.discarded", requestId: message.requestId, payload: { ...expected, result: "discarded" } });
  } catch (error) { send({ type: "web.session.error", requestId: message.requestId, payload: errorPayload(error) }); }
}
async function deliveryDetails(state) {
  let page = null;
  if (state.tabId !== null) {
    page = await chrome.tabs.sendMessage(state.tabId, { type: "agent.ping" }).catch(() => null);
  }
  return {
    currentDeliveryId: state.currentDeliveryId,
    sessionId: state.lastBoundSessionId, runId: state.lastBoundRunId,
    conversationUrl: state.conversationUrl, conversationId: state.conversationId, tabId: state.tabId,
    bindingStatus: state.bindingStatus, extensionBusy: turnGate.active,
    pageReachable: page?.ok === true, pageStatus: page?.pageStatus ?? null,
    pageBusy: typeof page?.busy === "boolean" ? page.busy : null,
    generating: typeof page?.generating === "boolean" ? page.generating : null,
    observedConversationUrl: page?.url ?? null,
    title: page?.title ?? null, activeRequestId: page?.activeRequestId ?? null,
    lastObservedUserMessageId: state.lastObservedUserMessageId,
    lastObservedAssistantMessageId: state.lastObservedAssistantMessageId,
    completedDelivery: state.completedDelivery?.turnId === state.currentDeliveryId ? state.completedDelivery : null,
  };
}
async function handleDeliveryStop(message) {
  try {
    const state = await store.read(), expected = message.payload || {};
    if (!state.currentDeliveryId || expected.currentDeliveryId !== state.currentDeliveryId
      || expected.runId !== state.lastBoundRunId || expected.sessionId !== state.lastBoundSessionId
      || expected.conversationUrl !== state.conversationUrl) {
      throw new ExtensionOperationError("DELIVERY_RECOVERY_MISMATCH", "종료 대상 전송이 변경됐습니다. 상태를 다시 확인하세요.");
    }
    let details = await deliveryDetails(state);
    if (details.activeRequestId !== state.currentDeliveryId || details.observedConversationUrl !== state.conversationUrl) {
      throw new ExtensionOperationError("DELIVERY_STOP_UNAVAILABLE", "해당 전송의 생성 작업을 식별할 수 없습니다. 대화 탭에서 생성 상태를 확인하세요.", details);
    }
    const stopped = await chrome.tabs.sendMessage(state.tabId, { type: "agent.cancel", requestId: state.currentDeliveryId });
    if (!stopped?.ok || !stopped.cancelled) throw new ExtensionOperationError("INTERRUPT_NOT_CONFIRMED", "생성 종료 요청이 확인되지 않았습니다.", details);
    const deadline = Date.now() + 5000;
    do {
      details = await deliveryDetails(await store.read());
      if (details.currentDeliveryId !== state.currentDeliveryId || details.sessionId !== state.lastBoundSessionId) {
        throw new ExtensionOperationError("DELIVERY_RECOVERY_MISMATCH", "종료 확인 중 전송 대상이 변경됐습니다.", details);
      }
      if (details.pageReachable && details.pageBusy === false && details.generating === false && !details.extensionBusy
        && details.observedConversationUrl === state.conversationUrl) {
        send({ type: "web.delivery.stopped", requestId: message.requestId, payload: details }); return;
      }
      await sleep(150);
    } while (Date.now() < deadline);
    throw new ExtensionOperationError("INTERRUPT_NOT_CONFIRMED", "종료를 요청했지만 생성 종료는 아직 확인되지 않았습니다. 상태를 다시 확인하세요.", details);
  } catch (error) {
    send({ type: "web.session.error", requestId: message.requestId, payload: errorPayload(error) });
  }
}
async function handleDeliveryRecovery(message) {
  let reservation;
  try {
    reservation = turnGate.reserve(message.requestId);
    let state = await store.read();
    const expected = message.payload || {};
    if (!state.currentDeliveryId || expected.currentDeliveryId !== state.currentDeliveryId
      || expected.runId !== state.lastBoundRunId || expected.sessionId !== state.lastBoundSessionId
      || expected.conversationUrl !== state.conversationUrl) {
      throw new ExtensionOperationError("DELIVERY_RECOVERY_MISMATCH", "복구 대상 전송이 변경됐습니다. 준비를 다시 요청하세요.");
    }
    const recoveryTabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
    const matched = matchExactConversationTabs(recoveryTabs, state);
    if (matched.status !== "BOUND") {
      throw new ExtensionOperationError("DELIVERY_RECOVERY_UNCONFIRMED", "이전 전송을 복구할 대화 탭을 확정할 수 없습니다.", {
        stage: "RECOVERY_TAB_LOOKUP", matchStatus: matched.status, currentDeliveryId: state.currentDeliveryId,
        sessionId: state.lastBoundSessionId, runId: state.lastBoundRunId, conversationUrl: state.conversationUrl,
        storedTabId: state.tabId, candidates: recoveryTabs.map(tab => ({ tabId: tab.id, url: tab.url })),
      });
    }
    if (state.tabId !== matched.tab.id) {
      await store.update({ tabId: matched.tab.id, windowId: matched.tab.windowId });
      state = await store.read();
    }
    const details = await deliveryDetails(state);
    if (!details.pageReachable || details.pageBusy !== false || details.generating !== false
      || details.pageStatus !== "READY" || details.observedConversationUrl !== state.conversationUrl) {
      throw new ExtensionOperationError("DELIVERY_RECOVERY_UNCONFIRMED", "이전 대화의 생성 종료를 확인하지 못했습니다. 해당 대화 탭을 확인하세요.", details);
    }
    await store.clearDelivery(state.currentDeliveryId);
    send({ type: "web.delivery.recovered", requestId: message.requestId, payload: { ...details, extensionBusy: false } });
  } catch (error) {
    send({ type: "web.session.error", requestId: message.requestId, payload: errorPayload(error) });
  } finally {
    if (reservation) turnGate.release(reservation);
    broadcastPopupState();
  }
}
async function handleFocus(message) {
  try {
    turnGate.assertIdle("Session focus");
    await focusBoundTab();
  } catch (error) {
    send({ type: "web.session.error", requestId: message.requestId, payload: errorPayload(error) });
  }
}
function requireBindingInput(payload) {
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
  const runId = typeof payload.runId === "string" ? payload.runId : "";
  const conversationUrl = canonicalChatGptUrl(payload.conversationUrl);
  const suppliedConversationId = typeof payload.conversationId === "string" && payload.conversationId
    ? payload.conversationId : null;
  const bootstrap = suppliedConversationId === null
    && (conversationUrl === "https://chatgpt.com/" || (conversationUrl === null && payload.conversationUrl === null));
  if (!sessionId || !runId || ((!conversationUrl) && !bootstrap) || (!suppliedConversationId && !bootstrap)) {
    throw new ExtensionOperationError(
      "EXACT_SESSION_BINDING_REQUIRED",
      "Session ID, run ID, and either an exact conversation or the ChatGPT start page are required.",
    );
  }
  if (!bootstrap && conversationIdFromUrl(conversationUrl) !== suppliedConversationId) {
    throw new ExtensionOperationError(
      "CONVERSATION_ID_MISMATCH",
      "Conversation URL and conversation ID do not identify the same conversation.",
    );
  }
  return {
    sessionId, runId,
    conversationUrl: bootstrap ? null : conversationUrl,
    conversationId: bootstrap ? null : suppliedConversationId,
    bootstrap,
  };
}
async function prepareBoundSession(payload) {
  const requested = requireBindingInput(payload);
  const state = await store.read(), sameSession = state.lastBoundSessionId === requested.sessionId;
  const persistedBindingDiffers = (state.lastBoundSessionId !== requested.sessionId
    || state.lastBoundRunId !== requested.runId
    || state.conversationUrl !== requested.conversationUrl
    || state.conversationId !== requested.conversationId
  );
  console.info("[bridge:binding:prepare]", {
    requestedSessionId: requested.sessionId, requestedRunId: requested.runId,
    persistedSessionId: state.lastBoundSessionId, persistedRunId: state.lastBoundRunId,
    currentDeliveryId: state.currentDeliveryId, persistedBindingDiffers,
    sameConversation: state.conversationUrl === requested.conversationUrl,
    completedDeliveryId: state.completedDelivery?.turnId ?? null,
  });
  if (state.currentDeliveryId !== null && persistedBindingDiffers && sameSession) {
    const details = await deliveryDetails(state);
    console.warn("[bridge:binding:blocked]", {
      currentDeliveryId: details.currentDeliveryId, sessionId: details.sessionId, runId: details.runId,
      pageReachable: details.pageReachable, pageBusy: details.pageBusy,
      generating: details.generating, extensionBusy: details.extensionBusy,
      pageStatus: details.pageStatus, activeRequestId: details.activeRequestId,
      hasCompletedResult: details.completedDelivery !== null,
    });
    throw new ExtensionOperationError(
      "REBIND_DURING_ACTIVE_DELIVERY",
      "A different Web session cannot replace a persisted binding during an active delivery.",
      details,
    );
  }
  let matched;
  if (requested.bootstrap) {
    const tabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
    const roots = tabs.filter((tab) => canonicalChatGptUrl(tab?.url) === "https://chatgpt.com/");
    if (roots.length === 0) {
      if (sameSession) await store.update({ bindingStatus: "NEEDS_REBIND" });
      throw new ExtensionOperationError("NEEDS_REBIND", "Open https://chatgpt.com/ in the selected browser tab before starting a new conversation.", {
        mode: "NEW_CONVERSATION_BOOTSTRAP", rootTabs: [], requestedSessionId: requested.sessionId,
      });
    }
    if (roots.length > 1) {
      if (sameSession) await store.update({ bindingStatus: "AMBIGUOUS" });
      throw new ExtensionOperationError("AMBIGUOUS", "More than one ChatGPT start page is open; the new conversation source cannot be identified.", {
        mode: "NEW_CONVERSATION_BOOTSTRAP", rootTabs: roots.map((tab) => ({ tabId: tab.id, windowId: tab.windowId, url: tab.url })),
      });
    }
    const root = roots[0];
    if (payload.focus) await focusTab(root);
    await waitForContentScript(root.id, 30_000, true);
    const page = await chrome.tabs.sendMessage(root.id, { type: "agent.ping" });
    if (!page?.ready || page.busy || page.generating || page.url !== "https://chatgpt.com/") {
      throw new ExtensionOperationError("ROOT_NOT_READY", "ChatGPT 새 대화 입력창을 사용할 수 없습니다.", page);
    }
    const documentBinding = await inspectBoundDocument(chrome.tabs, root.id, { conversationUrl: "https://chatgpt.com/", conversationId: null });
    await store.bindSession({ ...documentBinding, lastBoundSessionId: requested.sessionId, lastBoundRunId: requested.runId,
      tabId: root.id, windowId: root.windowId, conversationUrl: "https://chatgpt.com/", conversationId: null,
      bindingStatus: "ROOT_READY", bindingError: null, lastActiveChatGptTarget: createStoredTarget({ tabId: root.id, windowId: root.windowId, ...documentBinding, conversationUrl: "https://chatgpt.com/", conversationId: null }) });
    return { ...documentBinding, sessionId: requested.sessionId, runId: requested.runId, tabId: root.id, windowId: root.windowId,
      conversationUrl: "https://chatgpt.com/", conversationId: null, title: root.title || "ChatGPT",
      lastObservedUserMessageId: null, lastObservedAssistantMessageId: null, bindingStatus: "ROOT_READY" };
  } else {
    const tabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
    const preferred = Number.isSafeInteger(state.tabId)
      ? tabs.find((tab) => tab.id === state.tabId
        && canonicalChatGptUrl(tab?.url) === requested.conversationUrl
        && conversationIdFromUrl(tab?.url) === requested.conversationId)
      : null;
    matched = preferred
      ? { status: "BOUND", tab: preferred }
      : matchExactConversationTabs(tabs, requested);
  }
  if (matched.status !== "BOUND") {
    if (sameSession) await store.update({ bindingStatus: matched.status });
    throw new ExtensionOperationError(matched.status, "The exact ChatGPT conversation tab could not be uniquely recovered.", {
      mode: "EXACT_CONVERSATION_RECOVERY", requested: {
        sessionId: requested.sessionId, runId: requested.runId,
        conversationUrl: requested.conversationUrl, conversationId: requested.conversationId,
      }, persisted: {
        tabId: state.tabId, windowId: state.windowId, conversationUrl: state.conversationUrl,
        conversationId: state.conversationId, bindingStatus: state.bindingStatus,
      }, candidates: (await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS })).map((tab) => ({
        tabId: tab.id, windowId: tab.windowId, url: tab.url,
        canonicalUrl: canonicalChatGptUrl(tab.url), conversationId: conversationIdFromUrl(tab.url),
      })),
    });
  }
  if (payload.focus === true) await focusTab(matched.tab);
  await waitForContentScript(matched.tab.id, 30_000, true);
  await persistBoundTab(matched.tab, requested);
  return getSessionInfo();
}
async function rebindSession(payload) {
  const requested = requireBindingInput(payload);
  if (!Number.isSafeInteger(payload.tabId)) {
    throw new ExtensionOperationError("REBIND_TAB_REQUIRED", "Explicit rebind requires a selected ChatGPT tab ID.");
  }
  const tab = await chrome.tabs.get(payload.tabId);
  if (
    canonicalChatGptUrl(tab.url) !== requested.conversationUrl
    || conversationIdFromUrl(tab.url) !== requested.conversationId
  ) {
    throw new ExtensionOperationError(
      "REBIND_CONVERSATION_MISMATCH",
      "The selected tab does not show the requested ChatGPT conversation.",
    );
  }
  if (payload.focus === true) await focusTab(tab);
  await waitForContentScript(tab.id, 30_000, true);
  await persistBoundTab(tab, requested);
  return getSessionInfo();
}
async function persistBoundTab(tab, requested) {
  const documentBinding = await inspectBoundDocument(chrome.tabs, tab.id, requested);
  await store.bindSession({
    ...documentBinding,
    lastBoundSessionId: requested.sessionId,
    lastBoundRunId: requested.runId,
    conversationUrl: requested.conversationUrl,
    conversationId: requested.conversationId,
    tabId: tab.id,
    windowId: tab.windowId,
    bindingStatus: "BOUND",
    lastActiveChatGptTarget: createStoredTarget({ tabId: tab.id, windowId: tab.windowId, ...documentBinding,
      conversationUrl: requested.conversationUrl, conversationId: requested.conversationId }),
  });
}
async function requireExactBoundTab(expectedTurn = null) {
  const state = await store.read();
  if (expectedTurn) assertTurnStateBinding(expectedTurn, state);
  if (state.bindingStatus !== "BOUND" || state.tabId === null) {
    throw new ExtensionOperationError("NEEDS_REBIND", "No exact ChatGPT Web session is currently bound.");
  }
  let tab;
  try {
    tab = await chrome.tabs.get(state.tabId);
  } catch {
    await store.update({ bindingStatus: "NEEDS_REBIND", tabId: null, windowId: null, documentId: null, frameId: null });
    throw new ExtensionOperationError("NEEDS_REBIND", "The bound ChatGPT tab no longer exists.");
  }
  if (
    canonicalChatGptUrl(tab.url) !== state.conversationUrl
    || conversationIdFromUrl(tab.url) !== state.conversationId
  ) {
    await store.update({ bindingStatus: "AMBIGUOUS" });
    throw new ExtensionOperationError(
      "MANUAL_INTERVENTION_DETECTED",
      "The bound tab changed to a different conversation.",
      { observedUrl: canonicalChatGptUrl(tab.url) },
    );
  }
  if (expectedTurn) {
    assertTurnTabBinding(
      expectedTurn,
      tab,
      canonicalChatGptUrl(tab.url),
      conversationIdFromUrl(tab.url),
    );
  }
  if (expectedTurn) assertTurnStateBinding(expectedTurn, await store.read());
  return tab;
}
async function handlePrompt(message) {
  let reservation;
  let deliveryReserved = false, contentDispatchStarted = false;
  try {
    // This synchronous reservation deliberately happens before the first await.
    reservation = turnGate.reserve(message.requestId);
  } catch (error) {
    send({
      type: "web.prompt.error",
      requestId: message.requestId,
      payload: errorPayload(error),
    });
    return;
  }
  const payload = message.payload || {};
  bridgeLog("prompt:start", { deliveryId: message.requestId, controllerMessageId: payload.controllerMessageId ?? null, runId: payload.runId ?? null });
  try {
    let state = await store.read();
    if (
      typeof payload.controllerMessageId !== "string"
      || !payload.controllerMessageId.trim()
      || typeof payload.runId !== "string"
      || !payload.runId.trim()
      || payload.runId !== state.lastBoundRunId
    ) {
      throw new ExtensionOperationError(
        "DELIVERY_BINDING_MISMATCH",
        "Delivery identity does not match the persisted Web session binding.",
      );
    }
    const target = await resolveCurrentUserTarget({ tabs: chrome.tabs, store, state,
      urlPatterns: CHATGPT_URL_PATTERNS, waitForContentScript });
    if (state.currentDeliveryId !== null) {
      const conflict = pendingDeliveryTargetConflict(state, target, message.requestId);
      throw new ExtensionOperationError(conflict.code, conflict.message, conflict.details);
    }
    state = await bindCurrentUserTarget({ store, state, target });
    const reservedState = await store.reserveDelivery(message.requestId);
    deliveryReserved = true;
    const bootstrap = reservedState.bindingStatus === "ROOT_READY";
    bridgeLog("prompt:reserved", { deliveryId: message.requestId, tabId: reservedState.tabId, bindingStatus: reservedState.bindingStatus, conversationUrl: reservedState.conversationUrl, conversationId: reservedState.conversationId, bootstrap });
    const turnIdentity = {
      requestId: message.requestId,
      controllerMessageId: payload.controllerMessageId,
      runId: payload.runId,
    };
    let frozenTurn = bootstrap ? null : captureTurnBinding(reservedState, turnIdentity);
    broadcastPopupState();
    const tab = bootstrap ? await chrome.tabs.get(reservedState.tabId) : await requireExactBoundTab(frozenTurn);
    if (bootstrap && canonicalChatGptUrl(tab.url) !== "https://chatgpt.com/") throw new ExtensionOperationError("ROOT_CHANGED", "선택한 새 대화 탭의 주소가 변경되었습니다.");
    await waitForContentScript(tab.id);
    const markedText = createControlledPrompt({
      controllerMessageId: payload.controllerMessageId,
      runId: payload.runId,
      text: payload.text,
    });
    if (!reservedState.documentId || reservedState.frameId !== 0) throw new ExtensionOperationError("WEB_DOCUMENT_CHANGED", "Prepare the current ChatGPT document before sending.");
    await inspectBoundDocument(chrome.tabs, tab.id, reservedState);
    contentDispatchStarted = true;
    bridgeLog("prompt:dispatch", { deliveryId: message.requestId, tabId: tab.id, bootstrap });
    let result;
    let bootstrapRecovered = false;
    try {
      result = await chrome.tabs.sendMessage(tab.id, {
        type: "agent.prompt",
        requestId: message.requestId,
        payload: {
          text: markedText,
          controllerMessageId: payload.controllerMessageId,
          runId: payload.runId,
          expectedConversationUrl: state.conversationUrl,
          expectedConversationId: state.conversationId,
          expectedDocumentId: reservedState.documentId,
          expectedFrameId: reservedState.frameId,
          timeoutMs: payload.timeoutMs,
          stableMs: payload.stableMs,
        },
      });
    } catch (error) {
      if (!bootstrap) throw error;
      const recovered = await recoverBootstrapAfterNavigation({
        tabs: chrome.tabs, store, tab, reservedState, turnIdentity, payload, waitForContentScript, sleep,
      });
      result = recovered.result;
      frozenTurn = recovered.frozenTurn;
      bootstrapRecovered = true;
    }
    if (!result?.ok) {
      throw new ExtensionOperationError(
        result?.code || "CONTENT_SCRIPT_FAILURE",
        result?.error || "The ChatGPT content script returned no result.",
        result?.evidence || null,
      );
    }
    if (bootstrap && !bootstrapRecovered) {
      const current = await store.read();
      const observed = await chrome.tabs.get(tab.id);
      const url = canonicalChatGptUrl(observed.url), id = conversationIdFromUrl(url);
      // During bootstrap the response may contain a temporary WEB:* ID before
      // the browser URL settles on the real conversation ID.
      if (current.currentDeliveryId !== message.requestId || current.lastBoundSessionId !== reservedState.lastBoundSessionId
        || current.lastBoundRunId !== reservedState.lastBoundRunId
        || current.documentId !== reservedState.documentId || current.frameId !== reservedState.frameId
        || result.evidence?.documentId !== reservedState.documentId || result.evidence?.frameId !== reservedState.frameId
        || current.tabId !== tab.id || !id) {
        throw new ExtensionOperationError("TURN_BINDING_CHANGED", "새 대화 생성 결과와 전송한 탭의 식별자가 일치하지 않습니다.");
      }
      await store.update({ conversationUrl: url, conversationId: id, bindingStatus: "BOUND" });
      bridgeLog("prompt:conversation-bound", { deliveryId: message.requestId, tabId: tab.id, conversationUrl: url, conversationId: id });
      frozenTurn = captureTurnBinding(await store.read(), turnIdentity);
    }
    assertRelaySafeCompletion(result, frozenTurn);
    assertTurnStateBinding(frozenTurn, await store.read());
    await store.update({
      lastObservedUserMessageId: result.evidence?.userMessageId ?? null,
      lastObservedAssistantMessageId: result.evidence?.assistantMessageId ?? null,
    });
    const session = await getSessionInfo(frozenTurn);
    assertTurnSessionBinding(frozenTurn, session);
    const trace = createSuccessTrace(message.requestId, session);
    await store.update({ completedDelivery: {
      trace,
      turnId: message.requestId, binding: session, rawText: result.text,
      confidence: result.confidence, confidenceReason: result.confidenceReason ?? null, evidence: result.evidence,
    } });
    console.info("[bridge:delivery:completed-awaiting-ack]", {
      deliveryId: message.requestId, sessionId: session.sessionId, runId: session.runId,
    });
    send({
      type: "web.prompt.result",
      requestId: message.requestId,
      payload: {
        text: result.text,
        confidence: result.confidence,
        confidenceReason: result.confidenceReason ?? null,
        evidence: result.evidence,
        trace,
        session,
      },
    });
  } catch (error) {
    bridgeLog("prompt:failed", { deliveryId: message.requestId, code: error.code ?? null, message: error.message, details: error.details ?? null, deliveryReserved, contentDispatchStarted });
    if (deliveryReserved && !contentDispatchStarted) await store.clearDelivery(message.requestId);
    console.warn("[bridge:delivery:failed]", {
      deliveryId: message.requestId, code: error.code ?? null,
      deliveryReserved, contentDispatchStarted,
      retainedForRecovery: deliveryReserved && contentDispatchStarted,
    });
    lastError = error.message;
    if (error.code === "SESSION_AUTH_REQUIRED") {
      await store.update({ bindingStatus: "AUTH_REQUIRED" });
    } else if (error.code === "WEB_DOCUMENT_CHANGED") {
      await store.update({ bindingStatus: "NEEDS_REBIND", bindingError: diagnosticError(error) });
    } else if (["MANUAL_INTERVENTION_DETECTED", "TURN_BINDING_CHANGED"].includes(error.code)) {
      await store.update({ bindingStatus: "AMBIGUOUS" });
    }
    const failure = errorPayload(error);
    failure.details = { ...(failure.details && typeof failure.details === "object" ? failure.details : {}),
      dispatchStatus: contentDispatchStarted ? "STARTED_UNCONFIRMED" : "NOT_DISPATCHED", browserDispatchStarted: contentDispatchStarted };
    send({ type: "web.prompt.error", requestId: message.requestId, payload: failure });
  } finally {
    turnGate.release(reservation);
    broadcastPopupState();
    if (authenticated) {
      send({
        type: "extension.state",
        payload: {
          session: await getSessionInfo().catch(() => null),
          currentDeliveryId: (await store.read()).currentDeliveryId,
          busy: turnGate.active,
        },
      });
    }
  }
}
async function cancelPrompt(requestId) {
  const state = await store.read();
  if (state.currentDeliveryId !== requestId || state.tabId === null) return;
  const result = await chrome.tabs.sendMessage(
    state.tabId,
    { type: "agent.cancel", requestId },
  ).catch(() => null);
  if (result?.ok && result.cancelled) {
    send({ type: "web.prompt.cancelled", requestId, payload: {} });
  } else {
    send({
      type: "web.prompt.error",
      requestId,
      payload: errorPayload(new ExtensionOperationError(
        "INTERRUPT_NOT_CONFIRMED",
        "The content script did not confirm interruption of the active Web turn.",
      )),
    });
  }
}
async function getSessionInfo(expectedTurn = null) {
  const state = await store.read();
  if (expectedTurn) assertTurnStateBinding(expectedTurn, state);
  const tab = await requireExactBoundTab(expectedTurn);
  const finalState = await store.read();
  await inspectBoundDocument(chrome.tabs, tab.id, finalState);
  if (expectedTurn) assertTurnStateBinding(expectedTurn, finalState);
  const session = {
    sessionId: finalState.lastBoundSessionId,
    runId: finalState.lastBoundRunId,
    tabId: tab.id,
    windowId: tab.windowId,
    documentId: finalState.documentId,
    frameId: finalState.frameId,
    conversationUrl: finalState.conversationUrl,
    conversationId: finalState.conversationId,
    title: tab.title || "ChatGPT",
    lastObservedUserMessageId: finalState.lastObservedUserMessageId,
    lastObservedAssistantMessageId: finalState.lastObservedAssistantMessageId,
    bindingStatus: finalState.bindingStatus,
  };
  if (expectedTurn) assertTurnSessionBinding(expectedTurn, session);
  return session;
}
async function focusTab(tab) {
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}
async function focusBoundTab() {
  await focusTab(await requireExactBoundTab());
}
function chatGptContentScriptFiles() {
  const entry = chrome.runtime.getManifest().content_scripts?.find((item) =>
    Array.isArray(item.matches) && item.matches.includes("https://chatgpt.com/*"),
  );
  if (!Array.isArray(entry?.js) || entry.js.length === 0) {
    throw new ExtensionOperationError("CONTENT_SCRIPT_CONFIG_INVALID", "ChatGPT content script configuration is missing.");
  }
  return entry.js;
}
async function waitForContentScript(tabId, timeoutMs = 20_000, requireComposer = false) {
  const deadline = Date.now() + timeoutMs;
  let contentScriptResponded = false;
  let injectionAttempted = false;
  while (Date.now() < deadline) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "agent.ping" });
      if (response?.ok) contentScriptResponded = true;
      if (response?.ok && (!requireComposer || response.ready)) return response;
      if (response?.pageStatus && !["READY", "UI_CONTRACT_CHANGED"].includes(response.pageStatus)) {
        throw new ExtensionOperationError(response.pageStatus, response.message || response.pageStatus);
      }
    } catch (error) {
      if (error instanceof ExtensionOperationError) throw error;
      if (!injectionAttempted) {
        injectionAttempted = true;
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (canonicalChatGptUrl(tab?.url)) {
          await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            files: chatGptContentScriptFiles(),
          }).catch(() => null);
        }
      }
    }
    await sleep(350);
  }
  throw new ExtensionOperationError(
    contentScriptResponded && requireComposer ? "UI_CONTRACT_CHANGED" : "CONTENT_SCRIPT_UNAVAILABLE",
    contentScriptResponded && requireComposer
      ? "ChatGPT composer is unavailable in the bound conversation."
      : "ChatGPT content script is unavailable in the bound conversation.",
  );
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "agent.progress") {
    if (!authenticated) return false;
    void store.read().then((state) => {
      if (message.requestId !== state.currentDeliveryId) return;
      send({ type: "web.prompt.progress", requestId: message.requestId, payload: message.payload });
    });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "agent.manualIntervention") {
    void store.update({ bindingStatus: "AMBIGUOUS" }).then(() => {
      if (authenticated) {
        send({ type: "web.manual-intervention", requestId: message.requestId, payload: message.payload });
      }
    });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "bridge.getState") {
    void Promise.all([connectionState(), store.read()])
      .then(([state, stored]) => sendResponse({
        ok: true,
        state,
        config: {
          controllerUrl: stored.controllerUrl,
          sharedSecret: "",
          hasSharedSecret: Boolean(stored.sharedSecret),
        },
      }));
    return true;
  }
  if (message?.type === "bridge.saveConfig") {
    void (async () => {
      const current = await store.read();
      const controllerUrl = validateLocalControllerUrl(String(message.payload?.controllerUrl || "").trim());
      const submittedSecret = String(message.payload?.sharedSecret || "").trim();
      const sharedSecret = submittedSecret || current.sharedSecret;
      try {
        assertStrongExtensionSharedSecret(sharedSecret);
      } catch {
        throw new ExtensionOperationError(
          "SHARED_SECRET_INVALID",
          "The shared secret must contain at least 32 UTF-8 bytes.",
        );
      }
      await store.update({ controllerUrl, sharedSecret });
      await connect();
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "bridge.reconnect") {
    void connect().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "bridge.clearLegacyTestDelivery") {
    void clearLegacyTestDelivery({ store, turnGate, broadcastPopupState })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void store.read().then(async (state) => {
    if (tabId !== state.tabId) return;
    await store.update({ tabId: null, windowId: null, documentId: null, frameId: null, bindingStatus: "NEEDS_REBIND" });
    if (authenticated) send({ type: "extension.state", payload: { session: null, busy: turnGate.active } });
    broadcastPopupState();
  });
});
async function inspectBoundTabTopology(triggerTabId = null) {
  const state = await store.read();
  if (!["BOUND", "ROOT_READY"].includes(state.bindingStatus)) return;
  let tab = null; try { tab = await chrome.tabs.get(state.tabId); } catch {}
  if (isPendingRootPromotion({ state, tab, activeRequestId: turnGate.activeRequestId })) {
    console.info("[bridge:binding:root-promotion-observed]", { requestId: state.currentDeliveryId, tabId: state.tabId, observedUrl: tab.url });
    return;
  }
  if (state.bindingStatus === "ROOT_READY") return;
  const stillExact = tab
    && canonicalChatGptUrl(tab.url) === state.conversationUrl
    && conversationIdFromUrl(tab.url) === state.conversationId;
  if (stillExact) return;
  await store.update({ bindingStatus: "AMBIGUOUS" });
  lastError = diagnosticError(new ExtensionOperationError("AMBIGUOUS", "The persisted ChatGPT tab no longer matches the bound conversation.", {
    mode: "BOUND_TAB_TOPOLOGY", persistedTabId: state.tabId, persistedUrl: state.conversationUrl,
    persistedConversationId: state.conversationId, observedTabId: tab?.id ?? null,
    observedUrl: tab?.url ?? null, observedConversationId: conversationIdFromUrl(tab?.url),
  }));
  await store.update({ bindingError: lastError });
  broadcastPopupState();
  if (state.currentDeliveryId && state.tabId !== null) {
    await chrome.tabs.sendMessage(state.tabId, { type: "agent.cancel", requestId: state.currentDeliveryId }).catch(() => {});
  }
  if (authenticated) {
    send({
      type: "web.manual-intervention",
      requestId: state.currentDeliveryId,
      payload: {
        code: "MANUAL_INTERVENTION_DETECTED",
        reason: "WEB_TAB_TOPOLOGY_CHANGED",
        triggerTabId,
        expectedUrl: state.conversationUrl,
        observedBindingStatus: "AMBIGUOUS",
      },
    });
  }
  broadcastPopupState();
}
chrome.tabs.onCreated.addListener((tab) => { if (canonicalChatGptUrl(tab.url)) void inspectBoundTabTopology(tab.id); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.url === "string" && canonicalChatGptUrl(changeInfo.url)) {
    void inspectBoundTabTopology(tabId);
    return;
  }
  void store.read().then((state) => {
    if (tabId === state.tabId && typeof changeInfo.url === "string") {
      void inspectBoundTabTopology(tabId);
    }
  });
});
installCurrentTargetTracking({ tabs: chrome.tabs, windows: chrome.windows, store, waitForContentScript, onChange: broadcastPopupState }); setInterval(() => { if (authenticated) send({ type: "extension.heartbeat", payload: { at: Date.now(), busy: turnGate.active } }); }, 20_000);
void store.read().then(() => connect());
