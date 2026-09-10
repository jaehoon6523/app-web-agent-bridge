import {
  assertStrongExtensionSharedSecret,
  computeChallengeHmac,
} from "./runtime/hmac.js";
import {
  canonicalChatGptUrl,
  conversationIdFromUrl,
  matchExactConversationTabs,
  validateLocalControllerUrl,
} from "./runtime/conversation.js";
import { createControlledPrompt } from "./runtime/markers.js";
import {
  createExtensionStateStore,
  ensureExtensionIdentity,
} from "./runtime/storage.js";
import {
  assertRelaySafeCompletion,
  assertTurnSessionBinding,
  assertTurnStateBinding,
  assertTurnTabBinding,
  captureTurnBinding,
  createActiveTurnGate,
} from "./runtime/turn-guard.js";

const PROTOCOL_VERSION = 2;
const CHATGPT_URL_PATTERNS = Object.freeze([
  "https://chatgpt.com/*",
]);
const store = createExtensionStateStore(chrome.storage.local);

let socket = null;
let reconnectTimer = null;
let reconnectDelayMs = 1000;
let authenticated = false;
let pendingChallengeId = null;
let handledChallengeIds = new Set();
const turnGate = createActiveTurnGate();
let lastError = null;

class ExtensionOperationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ExtensionOperationError";
    this.code = code;
    this.details = details;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorPayload(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "WEB_EXTENSION_ERROR",
    message: error?.message || "The ChatGPT Web extension operation failed.",
    details: error?.details ?? null,
  };
}

async function connectionState() {
  const state = await store.read();
  return {
    connected: authenticated && socket?.readyState === WebSocket.OPEN,
    transportConnected: socket?.readyState === WebSocket.OPEN,
    connecting: socket?.readyState === WebSocket.CONNECTING,
    authenticated,
    busy: turnGate.active,
    tabId: state.tabId,
    conversationUrl: state.conversationUrl,
    bindingStatus: state.bindingStatus,
    currentDeliveryId: state.currentDeliveryId,
    extensionIdentity: state.extensionIdentity || null,
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
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
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
    reconnectDelayMs = 1000;
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
    lastError = event.code === 1000
      ? null
      : `Controller disconnected (${event.code}${event.reason ? `: ${event.reason}` : ""}).`;
    broadcastPopupState();
    scheduleReconnect();
  });
  nextSocket.addEventListener("error", () => {
    if (socket !== nextSocket) return;
    lastError = "Could not connect to the local controller.";
    broadcastPopupState();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(30_000, Math.round(reconnectDelayMs * 1.7));
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
  send({
    type: "extension.auth.response",
    challengeId: message.challengeId,
    extensionIdentity,
    hmacSha256,
  }, { allowUnauthenticated: true });
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
    case "web.delivery.recover":
      await handleDeliveryRecovery(message);
      break;
    case "web.delivery.inspect":
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
  try {
    turnGate.assertIdle(explicitRebind ? "Session rebind" : "Session preparation");
    const session = explicitRebind
      ? await rebindSession(message.payload || {})
      : await prepareBoundSession(message.payload || {});
    send({ type: "web.session.ready", requestId: message.requestId, payload: { session } });
  } catch (error) {
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
    await store.clearDelivery(message.requestId);
    broadcastPopupState();
  } catch (error) {
    send({ type: "web.prompt.error", requestId: message.requestId, payload: errorPayload(error) });
  }
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
    const state = await store.read(), expected = message.payload || {};
    if (!state.currentDeliveryId || expected.currentDeliveryId !== state.currentDeliveryId
      || expected.runId !== state.lastBoundRunId || expected.sessionId !== state.lastBoundSessionId
      || expected.conversationUrl !== state.conversationUrl) {
      throw new ExtensionOperationError("DELIVERY_RECOVERY_MISMATCH", "복구 대상 전송이 변경됐습니다. 준비를 다시 요청하세요.");
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
  const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : "";
  if (!sessionId || !runId || !conversationUrl || !conversationId) {
    throw new ExtensionOperationError(
      "EXACT_SESSION_BINDING_REQUIRED",
      "Session ID, run ID, canonical conversation URL, and conversation ID are required.",
    );
  }
  if (conversationIdFromUrl(conversationUrl) !== conversationId) {
    throw new ExtensionOperationError(
      "CONVERSATION_ID_MISMATCH",
      "Conversation URL and conversation ID do not identify the same conversation.",
    );
  }
  return { sessionId, runId, conversationUrl, conversationId };
}

async function prepareBoundSession(payload) {
  const requested = requireBindingInput(payload);
  const state = await store.read();
  const persistedBindingDiffers = (
    state.lastBoundSessionId !== requested.sessionId
    || state.lastBoundRunId !== requested.runId
    || state.conversationUrl !== requested.conversationUrl
    || state.conversationId !== requested.conversationId
  );
  if (state.currentDeliveryId !== null && persistedBindingDiffers) {
    throw new ExtensionOperationError(
      "REBIND_DURING_ACTIVE_DELIVERY",
      "A different Web session cannot replace a persisted binding during an active delivery.",
      await deliveryDetails(state),
    );
  }
  const tabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
  const matched = matchExactConversationTabs(tabs, requested);
  if (matched.status !== "BOUND") {
    await store.update({ bindingStatus: matched.status });
    throw new ExtensionOperationError(matched.status, "The exact ChatGPT conversation tab could not be uniquely recovered.");
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
  await store.update({
    lastBoundSessionId: requested.sessionId,
    lastBoundRunId: requested.runId,
    conversationUrl: requested.conversationUrl,
    conversationId: requested.conversationId,
    tabId: tab.id,
    windowId: tab.windowId,
    bindingStatus: "BOUND",
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
    await store.update({ bindingStatus: "NEEDS_REBIND", tabId: null, windowId: null });
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
  const tabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
  const unique = matchExactConversationTabs(tabs, state);
  if (unique.status !== "BOUND" || unique.tab.id !== state.tabId) {
    await store.update({ bindingStatus: "AMBIGUOUS" });
    throw new ExtensionOperationError(
      "MANUAL_INTERVENTION_DETECTED",
      "The bound conversation is no longer represented by exactly one expected tab.",
      { bindingStatus: unique.status },
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
  try {
    const state = await store.read();
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
    if (state.currentDeliveryId !== null) {
      throw new ExtensionOperationError(
        "RECOVERY_REQUIRED",
        state.currentDeliveryId === message.requestId
          ? "This delivery may already have been submitted and will not be sent again automatically."
          : "A prior delivery remains unacknowledged and must be recovered before another prompt is sent.",
        { currentDeliveryId: state.currentDeliveryId },
      );
    }

    const reservedState = await store.reserveDelivery(message.requestId);
    deliveryReserved = true;
    const frozenTurn = captureTurnBinding(reservedState, {
      requestId: message.requestId,
      controllerMessageId: payload.controllerMessageId,
      runId: payload.runId,
    });
    broadcastPopupState();
    const tab = await requireExactBoundTab(frozenTurn);
    await waitForContentScript(tab.id);
    const markedText = createControlledPrompt({
      controllerMessageId: payload.controllerMessageId,
      runId: payload.runId,
      text: payload.text,
    });
    contentDispatchStarted = true;
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "agent.prompt",
      requestId: message.requestId,
      payload: {
        text: markedText,
        controllerMessageId: payload.controllerMessageId,
        runId: payload.runId,
        expectedConversationUrl: state.conversationUrl,
        expectedConversationId: state.conversationId,
        timeoutMs: payload.timeoutMs,
        stableMs: payload.stableMs,
      },
    });
    if (!result?.ok) {
      throw new ExtensionOperationError(
        result?.code || "CONTENT_SCRIPT_FAILURE",
        result?.error || "The ChatGPT content script returned no result.",
        result?.evidence || null,
      );
    }
    assertRelaySafeCompletion(result, frozenTurn);
    assertTurnStateBinding(frozenTurn, await store.read());
    await store.update({
      lastObservedUserMessageId: result.evidence?.userMessageId ?? null,
      lastObservedAssistantMessageId: result.evidence?.assistantMessageId ?? null,
    });
    const session = await getSessionInfo(frozenTurn);
    assertTurnSessionBinding(frozenTurn, session);
    await store.update({ completedDelivery: {
      turnId: message.requestId, binding: session, rawText: result.text,
      confidence: result.confidence, evidence: result.evidence,
    } });
    send({
      type: "web.prompt.result",
      requestId: message.requestId,
      payload: {
        text: result.text,
        confidence: result.confidence,
        evidence: result.evidence,
        session,
      },
    });
  } catch (error) {
    if (deliveryReserved && !contentDispatchStarted) await store.clearDelivery(message.requestId);
    lastError = error.message;
    if (error.code === "SESSION_AUTH_REQUIRED") {
      await store.update({ bindingStatus: "AUTH_REQUIRED" });
    } else if (["MANUAL_INTERVENTION_DETECTED", "TURN_BINDING_CHANGED"].includes(error.code)) {
      await store.update({ bindingStatus: "AMBIGUOUS" });
    }
    send({ type: "web.prompt.error", requestId: message.requestId, payload: errorPayload(error) });
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
  if (expectedTurn) assertTurnStateBinding(expectedTurn, finalState);
  const session = {
    sessionId: finalState.lastBoundSessionId,
    runId: finalState.lastBoundRunId,
    tabId: tab.id,
    windowId: tab.windowId,
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

async function waitForContentScript(tabId, timeoutMs = 20_000, requireComposer = false) {
  const deadline = Date.now() + timeoutMs;
  let contentScriptResponded = false;
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

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void store.read().then(async (state) => {
    if (tabId !== state.tabId) return;
    await store.update({ tabId: null, windowId: null, bindingStatus: "NEEDS_REBIND" });
    if (authenticated) send({ type: "extension.state", payload: { session: null, busy: turnGate.active } });
    broadcastPopupState();
  });
});

async function inspectBoundTabTopology(triggerTabId = null) {
  const state = await store.read();
  if (state.bindingStatus !== "BOUND") return;
  const tabs = await chrome.tabs.query({ url: CHATGPT_URL_PATTERNS });
  const matched = matchExactConversationTabs(tabs, state);
  const stillExact = matched.status === "BOUND" && matched.tab.id === state.tabId;
  if (stillExact) return;
  await store.update({ bindingStatus: "AMBIGUOUS" });
  if (state.currentDeliveryId && state.tabId !== null) {
    await chrome.tabs.sendMessage(state.tabId, {
      type: "agent.cancel",
      requestId: state.currentDeliveryId,
    }).catch(() => {});
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
        observedBindingStatus: matched.status,
      },
    });
  }
  broadcastPopupState();
}

chrome.tabs.onCreated.addListener((tab) => {
  if (canonicalChatGptUrl(tab.url)) void inspectBoundTabTopology(tab.id);
});

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

setInterval(() => {
  if (authenticated) send({ type: "extension.heartbeat", payload: { at: Date.now(), busy: turnGate.active } });
}, 20_000);

void store.read().then(() => connect());
