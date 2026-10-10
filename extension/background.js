import { createExtensionAgentDiagnostics } from "./runtime/agent-diagnostics.js";
import { discardExactDelivery } from "./runtime/delivery-discard.js";
import { readDeliveryPage } from "./runtime/delivery-page.js";
import { createCoalescedTask } from "./runtime/coalesced-task.js";
import { projectPopupConnectionState } from "./runtime/popup-state.js";
import { createDeliveryReview, createServerDeliveryInspector } from "./runtime/delivery-review.js";
import { inspectBoundDocument, createSuccessTrace, diagnosticError, diagnosticMetadata, errorPayload } from "./runtime/document-binding.js";
import { classifyStoredAmbiguousRoot, recoverBootstrapAfterNavigation } from "./runtime/bootstrap-recovery.js";
import { assertStrongExtensionSharedSecret, computeChallengeHmac } from "./runtime/hmac.js";
import { canonicalChatGptUrl, conversationIdFromUrl, validateLocalControllerUrl } from "./runtime/conversation.js";
import { createControlledPrompt } from "./runtime/markers.js";
import { bindCurrentUserTarget, createStoredTarget, installCurrentTargetTracking, isPendingRootPromotion, pendingDeliveryTargetConflict, resolveCurrentUserTarget, resolvePreparedSessionTarget } from "./runtime/current-target.js";
import { createExtensionStateStore, ensureExtensionIdentity, isLegacyBridgeTestDelivery } from "./runtime/storage.js";
import { clearLegacyTestDelivery } from "./runtime/legacy-cleanup.js";
import { assertRelaySafeCompletion, assertTurnSessionBinding, assertTurnStateBinding, assertTurnTabBinding, captureTurnBinding, createActiveTurnGate } from "./runtime/turn-guard.js";
import { createConversationBootstrapTab, reopenExactConversationTab } from "./runtime/conversation-bootstrap.js";
import { createBrowserRuntime } from "./runtime/browser-runtime.js";
import { handleDeliveryAcknowledgement as acknowledgeDeliveryMessage } from "./runtime/delivery-ack.js";
import { createReconnectController } from "./runtime/reconnect.js";
import { validControllerChallenge } from "./runtime/auth-challenge.js";
import { matchExactWebConversationTabs, resolveStoredWebTargetProvider, resolveWebTargetProvider } from "./runtime/provider-target.js";
import { inspectChatGptTabs, openInspectedChatGptTab, replyToSelectorDiagnostics } from "./runtime/tab-diagnostics.js";
const PROTOCOL_VERSION = 2;
const CHATGPT_URL_PATTERNS = Object.freeze(["https://chatgpt.com/*"]);
const store = createExtensionStateStore(chrome.storage.local);
let socket = null;
let authenticated = false;
let pendingChallengeId = null;
let handledChallengeIds = new Set();
const turnGate = createActiveTurnGate();
const browserRuntime = createBrowserRuntime(chrome);
let lastError = null;
const agentDiagnostics = createExtensionAgentDiagnostics({chromeApi:chrome,store,inspect:() => inspectChatGptTabs(chrome.tabs,{limit:8}),getConnection:() => ({authenticated,connected:socket?.readyState === 1}),send});
function bridgeLog(event, details = {}) { try {agentDiagnostics.recordTransition(event,details);} catch { /* Diagnostic failures cannot change dispatch. */ }console.info(`[bridge:trace:${event}]`, { at: new Date().toISOString(), ...diagnosticMetadata(details) }); }
class ExtensionOperationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ExtensionOperationError"; this.code = code;
    this.details = details;
  }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function connectionState() {
  return projectPopupConnectionState({ store, chromeApi: chrome, turnGate, socket, authenticated, lastError });
}
function broadcastPopupState() {
  void publishState().catch(() => {});
}
const publishState = createCoalescedTask(async () => chrome.runtime.sendMessage({ type: "bridge.state", payload: await connectionState() }));
function send(message, { allowUnauthenticated = false } = {}) {
  try {agentDiagnostics.recordMessage(message);} catch { /* Keep diagnostic recording observational. */ }
  if (socket?.readyState !== WebSocket.OPEN) return false;
  if (!allowUnauthenticated && !authenticated) return false;
  socket.send(JSON.stringify({ ...message, protocolVersion: PROTOCOL_VERSION }));
  return true;
}
const serverDeliveryInspector = createServerDeliveryInspector({ send });
const deliveryReview = createDeliveryReview({ store, turnGate, tabs: chrome.tabs,
  inspectServer: expected => serverDeliveryInspector.inspect(expected), onChange: broadcastPopupState });
const reconnect = createReconnectController({ connect, connected: () => Boolean(socket), onError(error) {
  lastError = error.message; broadcastPopupState();
} });
async function connect({ explicit = false } = {}) {
  if (explicit) reconnect.requested();
  reconnect.cancel();
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
    lastError = error.message;agentDiagnostics.failure(error,"CONFIG");
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
    if (event.code !== 1000) agentDiagnostics.failure({code:event.code === 4409 ? "AUTHENTICATED_EXTENSION_ALREADY_CONNECTED" : "WEB_SOCKET_CLOSED"},"CONNECT",event.code);lastError = event.code === 4409
      ? "컨트롤러에 이미 인증된 확장이 연결되어 있습니다 (4409). 다른 Chrome 프로필·브라우저·중복 설치를 확인한 후 Reconnect를 누르세요. 자동 재접속을 중단했습니다."
      : event.code === 4403 && lastError
      ? lastError
      : event.code === 1000
      ? null
      : `Controller disconnected (${event.code}${event.reason ? `: ${event.reason}` : ""}).`;
    broadcastPopupState();
    reconnect.schedule(event.code);
  });
  nextSocket.addEventListener("error", () => {
    if (socket !== nextSocket) return;
    lastError = "Could not connect to the local controller.";agentDiagnostics.failure({code:"WEB_SOCKET_ERROR"},"CONNECT");
    broadcastPopupState();
  });
}
async function answerAuthenticationChallenge(message) {
  if (!validControllerChallenge(message, PROTOCOL_VERSION, handledChallengeIds)) return;
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
      reconnect.accepted();void agentDiagnostics.publish().catch(() => {});
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
      agentDiagnostics.failure({code:message.code ?? "AUTHENTICATION_FAILED"},"AUTH");lastError = `Controller rejected extension authentication (${message.code || "AUTHENTICATION_FAILED"}).`;
      socket?.close(4403, "Authentication rejected");
    }
    // All other controller commands are ignored until authentication completes.
    return;
  }
  if (agentDiagnostics.accept(message) || serverDeliveryInspector.accept(message)) return;
  switch (message.type) {
    case "controller.diagnostics.inspect":
      await replyToSelectorDiagnostics(chrome.tabs, send, message.requestId, chrome.runtime.getManifest().version, await store.read());
      break;
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
            allowManualFollowup: message.payload?.adoptManualFollowup === true,
          } });
          if (!result?.ok) throw new ExtensionOperationError(result?.code ?? "RESPONSE_RECHECK_FAILED", result?.error ?? "응답 재확인에 실패했습니다.");
          const current = await store.read();
          if (current.currentDeliveryId !== completed.turnId || current.lastBoundSessionId !== saved.lastBoundSessionId) {
            throw new ExtensionOperationError("DELIVERY_RECOVERY_MISMATCH", "재확인 중 전송 대상이 변경됐습니다.");
          }
          const adoptedManualFollowup = result.evidence?.responseAssociation === "EXPLICIT_MANUAL_FOLLOWUP";
          await store.update({
            ...(adoptedManualFollowup ? {
              lastObservedUserMessageId: result.evidence.userMessageId,
              lastObservedAssistantMessageId: result.evidence.assistantMessageId,
            } : {}),
            completedDelivery: {
              ...completed,
              rawText: result.text,
              confidence: result.confidence,
              confidenceReason: result.confidenceReason ?? null,
              evidence: result.evidence,
              ...(adoptedManualFollowup ? { adoption: {
                type: "EXPLICIT_MANUAL_FOLLOWUP",
                originalAssistantMessageId: result.evidence.originalAssistantMessageId,
                userMessageId: result.evidence.userMessageId,
                assistantMessageId: result.evidence.assistantMessageId,
              } } : {}),
            },
          });
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
        const tab = await chrome.tabs.get(state.tabId), provider = resolveStoredWebTargetProvider(state);
        if (!provider || provider.canonicalize(tab.url) !== state.conversationUrl) throw new ExtensionOperationError("DELIVERY_RECOVERY_MISMATCH", "기존 탭이 다른 대화로 이동했습니다.");
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
  let held;
  bridgeLog("prepare:start", { preparationId: message.payload?.preparationId ?? null, sessionId: message.payload?.sessionId ?? null, explicitRebind });
  try {
    held = turnGate.reserve(message.requestId);
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
  } finally { if (held) turnGate.release(held); broadcastPopupState(); }
}
async function handleDeliveryAcknowledgement(message) {
  turnGate.assertIdle("Delivery acknowledgement");
  return acknowledgeDeliveryMessage({ store, turnGate, message, send, broadcastPopupState });
}
async function handleDeliveryDiscard(message) {
  return discardExactDelivery({ store, turnGate, tabs: chrome.tabs, message, send, onChange: broadcastPopupState });
}
async function deliveryDetails(state) {
  const page = await readDeliveryPage(chrome.tabs, state.tabId);
  return {
    currentDeliveryId: state.currentDeliveryId,
    sessionId: state.lastBoundSessionId, runId: state.lastBoundRunId,
    conversationUrl: state.conversationUrl, conversationId: state.conversationId, tabId: state.tabId,
    bindingStatus: state.bindingStatus, extensionBusy: turnGate.active,
    documentId: state.documentId, frameId: state.frameId,
    lastAcknowledgedDelivery: state.lastAcknowledgedDelivery,
    lastDeliveryDiscard: state.lastDeliveryDiscard,
    scopedDeliveries: Object.entries(state.deliveryScopes ?? {}).map(([sessionId, slot]) => ({ sessionId, deliveryId: slot.currentDeliveryId })),
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
    const provider = resolveStoredWebTargetProvider(state);
    if (!provider) throw new ExtensionOperationError("WEB_PROVIDER_UNAVAILABLE", "복구 대상 Web provider를 확인할 수 없습니다.");
    const recoveryTabs = await chrome.tabs.query({ url: provider.urlPatterns }), matched = matchExactWebConversationTabs(recoveryTabs, state);
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
    throw new ExtensionOperationError("DELIVERY_RESPONSE_REQUIRED",
      "페이지의 생성 종료만으로 전송을 정리할 수 없습니다. 저장된 응답을 검증해 ACK하거나 명시적으로 폐기하세요.", details);
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
  const requestedProvider = typeof payload.provider === "string" && payload.provider ? payload.provider : null;
  const provider = resolveWebTargetProvider({ provider:requestedProvider, conversationUrl:payload.conversationUrl ?? null });
  if (!provider) throw new ExtensionOperationError("WEB_PROVIDER_UNAVAILABLE", "The requested Web provider is not registered or does not match the conversation URL.");
  const conversationUrl = payload.conversationUrl === null ? null : provider.canonicalize(payload.conversationUrl);
  const suppliedConversationId = typeof payload.conversationId === "string" && payload.conversationId
    ? payload.conversationId : null;
  const bootstrap = suppliedConversationId === null
    && (conversationUrl === provider.rootUrl || (conversationUrl === null && payload.conversationUrl === null));
  if (!sessionId || !runId || ((!conversationUrl) && !bootstrap) || (!suppliedConversationId && !bootstrap)) {
    throw new ExtensionOperationError(
      "EXACT_SESSION_BINDING_REQUIRED",
      "Session ID, run ID, and either an exact conversation or the provider start page are required.",
    );
  }
  if (!bootstrap && provider.conversationIdFromUrl(conversationUrl) !== suppliedConversationId) {
    throw new ExtensionOperationError(
      "CONVERSATION_ID_MISMATCH",
      "Conversation URL and conversation ID do not identify the same conversation.",
    );
  }
  return {
    sessionId, runId, provider:provider.provider,
    conversationUrl: bootstrap ? null : conversationUrl,
    conversationId: bootstrap ? null : suppliedConversationId,
    bootstrap,
  };
}
function rootBootstrapDetails(stage, extra = {}) {
  return { flow: "ROOT_BOOTSTRAP_V2", stage, extensionId: chrome.runtime?.id ?? null, extensionVersion: chrome.runtime?.getManifest?.().version ?? null, ...extra };
}
function rootBootstrapError(code, message, stage, extra = {}) {
  return new ExtensionOperationError(code, message, rootBootstrapDetails(stage, extra));
}
async function selectRootBootstrapTab(payload, requested) {
  const provider = resolveWebTargetProvider({ provider:requested.provider });
  if (!provider) throw rootBootstrapError("WEB_PROVIDER_UNAVAILABLE", "The requested Web provider is not registered.", "DISCOVER");
  let tabs;
  try { tabs = await chrome.tabs.query({ url: provider.urlPatterns }); }
  catch (error) { throw rootBootstrapError("ROOT_TAB_QUERY_FAILED", error.message, "DISCOVER"); }
  const roots = tabs.filter((tab) => provider.canonicalize(tab?.url) === provider.rootUrl);
  const create = payload.createNewConversation === true || roots.length === 0;
  console.info("[bridge:root:select]", rootBootstrapDetails("SELECT", { sessionId: requested.sessionId, rootCount: roots.length, action: create ? "CREATE" : "REUSE" }));
  if (create) {
    let tab;
    try { tab = await createConversationBootstrapTab(chrome, waitForContentScript, provider); }
    catch (error) { throw rootBootstrapError(error.code ?? "ROOT_TAB_CREATE_FAILED", error.message, "CREATE", { rootCount: roots.length, causeDetails:error.details ?? null }); }
    if (!tab) throw rootBootstrapError("ROOT_TAB_CREATE_FAILED", "Web provider 시작 탭을 만들지 못했습니다.", "CREATE", { rootCount: roots.length });
    return tab;
  }
  if (roots.length > 1) throw rootBootstrapError("AMBIGUOUS", "Web provider 시작 탭이 여러 개여서 선택할 수 없습니다.", "SELECT", { rootTabs: roots.map((tab) => ({ tabId: tab.id, windowId: tab.windowId, url: tab.url })) });
  return roots[0];
}
async function prepareBoundSession(payload) {
  const requested = requireBindingInput(payload);
  const provider = resolveWebTargetProvider({ provider:requested.provider });
  if (!provider) throw new ExtensionOperationError("WEB_PROVIDER_UNAVAILABLE", "The requested Web provider is not registered.");
  const state = await store.read();
  const sameSession = state.lastBoundSessionId === requested.sessionId;
  const sameRun = state.lastBoundRunId === requested.runId;
  const ownsActiveDelivery = state.currentDeliveryId !== null && sameSession && sameRun;
  const persistedBindingDiffers = (state.lastBoundSessionId !== requested.sessionId
    || state.lastBoundRunId !== requested.runId
    || state.conversationUrl !== requested.conversationUrl
    || state.conversationId !== requested.conversationId
  );
  console.info("[bridge:binding:prepare]", {
    requestedSessionId: requested.sessionId, requestedRunId: requested.runId,
    persistedSessionId: state.lastBoundSessionId, persistedRunId: state.lastBoundRunId,
    currentDeliveryId: state.currentDeliveryId, persistedBindingDiffers,
    sameSession, sameRun, ownsActiveDelivery,
    sameConversation: state.conversationUrl === requested.conversationUrl,
    completedDeliveryId: state.completedDelivery?.turnId ?? null,
  });
  if (ownsActiveDelivery && persistedBindingDiffers) {
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
      "This Web session owns an unresolved delivery and cannot replace its persisted binding.",
      details,
    );
  }
  let matched;
  if (requested.bootstrap) {
    let root;
    try { root = await selectRootBootstrapTab(payload, requested); }
    catch (error) { if (sameSession) await store.update({ bindingStatus: error.code === "AMBIGUOUS" ? "AMBIGUOUS" : "NEEDS_REBIND" }); throw error; }
    let page;
    try { if (payload.focus) await focusTab(root); page = await waitForContentScript(root.id, 30_000, true); }
    catch (error) { throw rootBootstrapError(error.code ?? "ROOT_TAB_LOAD_FAILED", error.message, "LOAD", { tabId: root.id, causeDetails:error.details ?? null }); }
    if (!page?.ready || page.busy || page.generating || provider.canonicalize(page.url) !== provider.rootUrl) {
      throw rootBootstrapError("ROOT_NOT_READY", "Web provider 새 대화 입력창을 사용할 수 없습니다.", "READY", { tabId: root.id, page });
    }
    let documentBinding;
    try {
      documentBinding = await inspectBoundDocument(chrome.tabs, root.id, { conversationUrl: provider.rootUrl, conversationId: null, documentId: page.documentId });
      await store.bindSession({ ...documentBinding, lastBoundSessionId: requested.sessionId, lastBoundRunId: requested.runId,
        webProvider: requested.provider, tabId: root.id, windowId: root.windowId, conversationUrl: provider.rootUrl, conversationId: null,
        bindingStatus: "ROOT_READY", bindingError: null, lastActiveWebTarget: createStoredTarget({ provider:requested.provider, tabId: root.id, windowId: root.windowId, ...documentBinding, conversationUrl: provider.rootUrl, conversationId: null }) });
    } catch (error) { throw rootBootstrapError(error.code ?? "ROOT_BIND_FAILED", error.message, "BIND", { tabId: root.id }); }
    console.info("[bridge:root:ready]", rootBootstrapDetails("ROOT_READY", { sessionId: requested.sessionId, tabId: root.id }));
    return { ...documentBinding, sessionId: requested.sessionId, runId: requested.runId, tabId: root.id, windowId: root.windowId,
      conversationUrl: provider.rootUrl, conversationId: null, title: root.title || provider.provider,
      lastObservedUserMessageId: null, lastObservedAssistantMessageId: null, bindingStatus: "ROOT_READY" };
  } else {
    const tabs = await chrome.tabs.query({ url: provider.urlPatterns });
    const preferred = Number.isSafeInteger(state.tabId)
      ? tabs.find((tab) => tab.id === state.tabId
        && provider.canonicalize(tab?.url) === requested.conversationUrl
        && provider.conversationIdFromUrl(tab?.url) === requested.conversationId)
      : null;
    matched = preferred
      ? { status: "BOUND", tab: preferred }
      : (() => {
        const matches = tabs.filter((tab) => provider.canonicalize(tab?.url) === requested.conversationUrl
          && provider.conversationIdFromUrl(tab?.url) === requested.conversationId);
        return matches.length === 1 ? { status:"BOUND", tab:matches[0] }
          : { status:matches.length > 1 ? "AMBIGUOUS" : "NEEDS_REBIND", tab:null };
      })();
    if (matched.status === "NEEDS_REBIND") {
      const reopened = await reopenExactConversationTab(chrome, waitForContentScript, requested, provider);
      if (reopened) matched = { status: "BOUND", tab: reopened };
    }
  }
  if (matched.status !== "BOUND") {
    if (sameSession) await store.update({ bindingStatus: matched.status });
    throw new ExtensionOperationError(matched.status, "The exact Web provider conversation tab could not be uniquely recovered.", {
      mode: "EXACT_CONVERSATION_RECOVERY", requested: {
        sessionId: requested.sessionId, runId: requested.runId,
        conversationUrl: requested.conversationUrl, conversationId: requested.conversationId,
      }, persisted: {
        tabId: state.tabId, windowId: state.windowId, conversationUrl: state.conversationUrl,
        conversationId: state.conversationId, bindingStatus: state.bindingStatus,
      }, candidates: (await chrome.tabs.query({ url: provider.urlPatterns })).map((tab) => ({
        tabId: tab.id, windowId: tab.windowId, url: tab.url,
        canonicalUrl: provider.canonicalize(tab.url), conversationId: provider.conversationIdFromUrl(tab.url),
      })),
    });
  }
  if (payload.focus === true) await focusTab(matched.tab);
  const ready = await waitForContentScript(matched.tab.id, 30_000, true);
  await persistBoundTab(matched.tab, { ...requested, documentId: ready.documentId });
  return getSessionInfo();
}
async function rebindSession(payload) {
  const requested = requireBindingInput(payload);
  const provider = resolveWebTargetProvider({ provider:requested.provider });
  if (!provider) throw new ExtensionOperationError("WEB_PROVIDER_UNAVAILABLE", "The requested Web provider is not registered.");
  if (!Number.isSafeInteger(payload.tabId)) {
    throw new ExtensionOperationError("REBIND_TAB_REQUIRED", "Explicit rebind requires a selected ChatGPT tab ID.");
  }
  const tab = await chrome.tabs.get(payload.tabId);
  if (requested.bootstrap) {
    if (
      provider.canonicalize(tab.url) !== provider.rootUrl
      || provider.conversationIdFromUrl(tab.url) !== null
    ) {
      throw new ExtensionOperationError(
        "REBIND_CONVERSATION_MISMATCH",
        "The selected tab is not the requested Web provider start page.",
      );
    }
    if (payload.focus === true) await focusTab(tab);
    const page = await waitForContentScript(tab.id, 30_000, true);
    if (!page?.ready || page.busy || page.generating || provider.canonicalize(page.url) !== provider.rootUrl || page.conversationId !== null) {
      throw new ExtensionOperationError("ROOT_NOT_READY", "The selected Web provider start tab is not ready.");
    }
    const documentBinding = await inspectBoundDocument(chrome.tabs, tab.id, {
      conversationUrl: provider.rootUrl,
      conversationId: null,
      documentId: page.documentId,
    });
    await store.bindSession({
      ...documentBinding,
      lastBoundSessionId: requested.sessionId,
      lastBoundRunId: requested.runId, webProvider: requested.provider,
      conversationUrl: provider.rootUrl,
      conversationId: null,
      tabId: tab.id,
      windowId: tab.windowId,
      bindingStatus: "ROOT_READY",
      bindingError: null,
      lastActiveWebTarget: createStoredTarget({
        provider:requested.provider, tabId: tab.id, windowId: tab.windowId, ...documentBinding,
        conversationUrl: provider.rootUrl, conversationId: null,
      }),
    });
    return {
      ...documentBinding,
      sessionId: requested.sessionId, runId: requested.runId,
      tabId: tab.id, windowId: tab.windowId,
      conversationUrl: provider.rootUrl, conversationId: null,
      title: tab.title || provider.provider,
      lastObservedUserMessageId: null, lastObservedAssistantMessageId: null,
      bindingStatus: "ROOT_READY",
    };
  }
  if (
    provider.canonicalize(tab.url) !== requested.conversationUrl
    || provider.conversationIdFromUrl(tab.url) !== requested.conversationId
  ) {
    throw new ExtensionOperationError(
      "REBIND_CONVERSATION_MISMATCH",
      "The selected tab does not show the requested Web provider conversation.",
    );
  }
  if (payload.focus === true) await focusTab(tab);
  const ready = await waitForContentScript(tab.id, 30_000, true);
  await persistBoundTab(tab, { ...requested, documentId: ready.documentId });
  return getSessionInfo();
}
async function persistBoundTab(tab, requested) {
  const documentBinding = await inspectBoundDocument(chrome.tabs, tab.id, requested);
  await store.bindSession({
    ...documentBinding,
    lastBoundSessionId: requested.sessionId,
    lastBoundRunId: requested.runId, webProvider: requested.provider,
    conversationUrl: requested.conversationUrl,
    conversationId: requested.conversationId,
    tabId: tab.id,
    windowId: tab.windowId,
    bindingStatus: "BOUND",
    lastActiveWebTarget: createStoredTarget({ provider:requested.provider, tabId: tab.id, windowId: tab.windowId, ...documentBinding,
      conversationUrl: requested.conversationUrl, conversationId: requested.conversationId }),
  });
}
async function requireExactBoundTab(expectedTurn = null) {
  const state = await store.read(), provider = resolveStoredWebTargetProvider(state);
  if (expectedTurn) assertTurnStateBinding(expectedTurn, state);
  if (state.bindingStatus !== "BOUND" || state.tabId === null) {
    throw new ExtensionOperationError("NEEDS_REBIND", "No exact Web provider session is currently bound.");
  }
  if (!provider) throw new ExtensionOperationError("WEB_PROVIDER_UNAVAILABLE", "The bound Web provider is not registered.");
  let tab;
  try {
    tab = await chrome.tabs.get(state.tabId);
  } catch {
    await store.update({ bindingStatus: "NEEDS_REBIND", tabId: null, windowId: null, documentId: null, frameId: null });
    throw new ExtensionOperationError("NEEDS_REBIND", "The bound Web provider tab no longer exists.");
  }
  if (provider.canonicalize(tab.url) !== state.conversationUrl || provider.conversationIdFromUrl(tab.url) !== state.conversationId) {
    await store.update({ bindingStatus: "AMBIGUOUS" });
    throw new ExtensionOperationError(
      "MANUAL_INTERVENTION_DETECTED",
      "The bound tab changed to a different conversation.",
      { observedUrl: provider.canonicalize(tab.url), provider:provider.provider },
    );
  }
  if (expectedTurn) {
    assertTurnTabBinding(
      expectedTurn,
      tab,
      provider.canonicalize(tab.url),
      provider.conversationIdFromUrl(tab.url),
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
      || (payload.sessionId !== undefined && payload.sessionId !== state.lastBoundSessionId)
    ) {
      throw new ExtensionOperationError(
        "DELIVERY_BINDING_MISMATCH",
        "Delivery identity does not match the persisted Web session binding.",
      );
    }
    // Controller turns carry a session ID: send only to its prepared tab, even
    // when the user has focused another ChatGPT conversation in the meantime.
    const target = payload.sessionId === undefined
      ? await resolveCurrentUserTarget({ tabs: chrome.tabs, store, state,
        waitForContentScript })
      : await resolvePreparedSessionTarget({ tabs: chrome.tabs, state, waitForContentScript });
    if (state.currentDeliveryId !== null) {
      const conflict = pendingDeliveryTargetConflict(state, target, message.requestId);
      throw new ExtensionOperationError(conflict.code, conflict.message, conflict.details);
    }
    state = await bindCurrentUserTarget({ store, state, target });
    const reservedState = await store.reserveDelivery(message.requestId);
    deliveryReserved = true;
    const bootstrap = reservedState.bindingStatus === "ROOT_READY", provider = resolveStoredWebTargetProvider(reservedState);
    if (!provider) throw new ExtensionOperationError("WEB_PROVIDER_UNAVAILABLE", "The prepared Web provider is not registered.");
    bridgeLog("prompt:reserved", { deliveryId: message.requestId, tabId: reservedState.tabId, bindingStatus: reservedState.bindingStatus, conversationUrl: reservedState.conversationUrl, conversationId: reservedState.conversationId, bootstrap });
    const turnIdentity = {
      requestId: message.requestId,
      controllerMessageId: payload.controllerMessageId,
      runId: payload.runId,
    };
    let frozenTurn = bootstrap ? null : captureTurnBinding(reservedState, turnIdentity);
    broadcastPopupState();
    const tab = bootstrap ? await chrome.tabs.get(reservedState.tabId) : await requireExactBoundTab(frozenTurn);
    if (bootstrap && provider.canonicalize(tab.url) !== provider.rootUrl) throw new ExtensionOperationError("ROOT_CHANGED", "선택한 새 대화 탭의 주소가 변경되었습니다.");
    await waitForContentScript(tab.id);
    const markedText = createControlledPrompt({
      controllerMessageId: payload.controllerMessageId,
      runId: payload.runId,
      text: payload.text,
    });
    if (!reservedState.documentId || reservedState.frameId !== 0) throw new ExtensionOperationError("WEB_DOCUMENT_CHANGED", "Prepare the current Web provider document before sending.");
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
        result?.error || "The Web provider content script returned no result.",
        result?.evidence || null,
      );
    }
    if (bootstrap && !bootstrapRecovered) {
      const current = await store.read();
      const observed = await chrome.tabs.get(tab.id);
      const url = provider.canonicalize(observed.url), id = provider.conversationIdFromUrl(url);
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
  return browserRuntime.focusTab(tab);
}
async function focusBoundTab() {
  await focusTab(await requireExactBoundTab());
}
async function waitForContentScript(tabId, timeoutMs = 20_000, requireComposer = false) {
  return browserRuntime.waitForContentScript(tabId, timeoutMs, requireComposer);
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
    void store.read().then(async state => {
      if (message.requestId !== state.currentDeliveryId || _sender.tab?.id !== state.tabId
        || _sender.frameId !== 0 || message.payload?.documentId !== state.documentId) return;
      await store.updateIf({ currentDeliveryId: state.currentDeliveryId, documentId: state.documentId, tabId: state.tabId },
        { bindingStatus: "AMBIGUOUS", bindingError: `${message.payload.code}: ${message.payload.message}` });
      if (authenticated) send({ type: "web.manual-intervention", requestId: message.requestId, payload: message.payload });
      broadcastPopupState();
    }).catch(() => {});
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
      await connect({ explicit:true });
      sendResponse({ ok: true });
    })().catch((error) => {agentDiagnostics.failure(error,"CONFIG");sendResponse({ ok: false, error: error.message });});
    return true;
  }
  if (message?.type === "bridge.reconnect") {
    void connect({ explicit:true }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (["bridge.inspectTabs", "bridge.openInspectedTab", "bridge.inspectDelivery", "bridge.discardOrphanDelivery", "bridge.selectDelivery", "bridge.openDelivery", "bridge.openController"].includes(message?.type)) {
    void (async () => {
      if (message.type === "bridge.inspectTabs") return inspectChatGptTabs(chrome.tabs);
      if (message.type === "bridge.openInspectedTab") return openInspectedChatGptTab(chrome.tabs, message.payload);
      if (message.type === "bridge.inspectDelivery") return deliveryReview.inspect();
      if (message.type === "bridge.discardOrphanDelivery") return deliveryReview.discardOrphan(message.payload);
      if (message.type === "bridge.openDelivery") return deliveryReview.openConversation(message.payload);
      if (message.type === "bridge.selectDelivery") return deliveryReview.selectScope(message.payload);
      return deliveryReview.openController();
    })().then(result => sendResponse({ ok: true, result })).catch(error => sendResponse({ ok: false, error: error.message, code: error.code }));
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
async function inspectBoundTabTopology(triggerTabId = null, inspectDocument = false) {
  const state = await store.read(), provider = resolveStoredWebTargetProvider(state);
  if (!["BOUND", "ROOT_READY"].includes(state.bindingStatus)) return;
  let tab = null; try { tab = await chrome.tabs.get(state.tabId); } catch {}
  if (isPendingRootPromotion({ state, tab, activeRequestId: turnGate.activeRequestId })) {
    console.info("[bridge:binding:root-promotion-observed]", { requestId: state.currentDeliveryId, tabId: state.tabId, observedUrl: tab.url });
    return;
  }
  if (state.bindingStatus === "ROOT_READY") return;
  const stillExact = tab && provider
    && provider.canonicalize(tab.url) === state.conversationUrl
    && provider.conversationIdFromUrl(tab.url) === state.conversationId;
  if (stillExact && !inspectDocument) return;
  const page = stillExact ? await readDeliveryPage(chrome.tabs, state.tabId) : null;
  if (stillExact && page?.ok && page.documentId === state.documentId) return;
  const error = diagnosticError(new ExtensionOperationError(stillExact ? "WEB_DOCUMENT_CHANGED" : "AMBIGUOUS", "The persisted Web tab no longer matches the bound conversation or document.", {
    mode: "BOUND_TAB_TOPOLOGY", persistedTabId: state.tabId, persistedUrl: state.conversationUrl,
    persistedConversationId: state.conversationId, observedTabId: tab?.id ?? null,
    observedUrl: tab?.url ?? null, observedConversationId: provider?.conversationIdFromUrl(tab?.url) ?? null,
  }));
  try { await store.updateIf({ bindingStatus: state.bindingStatus, currentDeliveryId: state.currentDeliveryId,
    lastBoundSessionId: state.lastBoundSessionId, lastBoundRunId: state.lastBoundRunId, tabId: state.tabId,
    documentId: state.documentId }, { bindingStatus: "AMBIGUOUS", bindingError: error }); } catch { return; }
  lastError = error;
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
chrome.tabs.onCreated.addListener((tab) => { if (resolveWebTargetProvider({ conversationUrl:tab.url })) void inspectTopology({ tabId: tab.id }).catch(() => {}); });
const inspectTopology = createCoalescedTask(value => inspectBoundTabTopology(value.tabId, value.completed));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.url === "string" || changeInfo.status === "complete")
    void inspectTopology({ tabId, completed: changeInfo.status === "complete" }).catch(() => {});
});
installCurrentTargetTracking({ tabs: chrome.tabs, windows: chrome.windows, store, waitForContentScript, onChange: broadcastPopupState }); setInterval(() => { if (authenticated) send({ type: "extension.heartbeat", payload: { at: Date.now(), busy: turnGate.active } }); }, 20_000); void store.read().then(() => connect());
