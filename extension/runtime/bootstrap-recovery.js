import { resolveStoredWebTargetProvider } from "./provider-target.js";
import { captureTurnBinding, assertRelaySafeCompletion } from "./turn-guard.js";
import { readDeliveryPage } from "./delivery-page.js";
import { createSuccessTrace } from "./document-binding.js";
export { classifyStoredAmbiguousRoot } from "./binding-recovery.js";

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function recoveryLog(stage, fields) {
  // Logging must never interrupt recovery, including when details cannot be serialized.
  try { console.info("[bridge:submitted-root]", JSON.stringify({ stage, ...fields })); } catch {}
}

// Preserve the delivery; replace its tab binding only after verifying the original response.
export async function recoverSubmittedRoot({ tabs, store, expected }) {
  const saved = await store.read(), provider = resolveStoredWebTargetProvider(saved);
  const completed = saved.completedDelivery, relocate = expected?.allowTabRelocation === true;
  if (!provider || typeof saved.currentDeliveryId !== "string" || !saved.lastBoundRunId?.startsWith("prep_")
    || saved.currentDeliveryId !== expected?.currentDeliveryId || saved.lastBoundSessionId !== expected?.sessionId
    || saved.lastBoundRunId !== expected?.runId
    || (saved.tabId !== expected?.tabId && !(relocate && (saved.tabId === null || completed !== null)))
    || (saved.completedDelivery === null ? saved.conversationUrl !== provider.rootUrl || saved.conversationId !== null
      : saved.conversationUrl !== expected.conversationUrl || saved.conversationId !== expected.conversationId)
    || !expected.conversationId || provider.conversationIdFromUrl(expected.conversationUrl) !== expected.conversationId
    || provider.canonicalize(expected.conversationUrl) !== expected.conversationUrl) {
    fail("DELIVERY_RECOVERY_MISMATCH", "원본 전송과 복구 대상이 일치하지 않습니다.");
  }
  const identity = { requestId:saved.currentDeliveryId, controllerMessageId:saved.currentDeliveryId, runId:saved.lastBoundRunId };
  if (completed !== null) {
    const prior = completed.binding;
    if (completed.turnId !== saved.currentDeliveryId || prior?.sessionId !== saved.lastBoundSessionId
      || prior?.runId !== saved.lastBoundRunId || prior?.bindingStatus !== "BOUND"
      || prior?.conversationUrl !== expected.conversationUrl || prior?.conversationId !== expected.conversationId
      || (saved.tabId !== null && prior?.tabId !== saved.tabId)
      || completed.confidence !== "CONFIRMED_BY_UI_STATE"
      || !completed.evidence?.userMessageId || !completed.evidence?.assistantMessageId
      || completed.evidence.responseAssociation !== "DIRECT_DOM_ORDER") {
      fail("DELIVERY_RECOVERY_MISMATCH", "Stored response ownership is not confirmed.");
    }
    assertRelaySafeCompletion({ ...completed, text:completed.rawText }, captureTurnBinding({ ...saved,
      tabId:prior.tabId, windowId:prior.windowId, documentId:prior.documentId, frameId:prior.frameId,
      conversationUrl:prior.conversationUrl, conversationId:prior.conversationId, bindingStatus:"BOUND" }, identity));
  }
  let target = null;
  if (saved.tabId !== null) {
    try { target = await tabs.get(saved.tabId); }
    catch (error) { if (!relocate) throw error; }
  }
  if (!target && relocate) {
    const candidates = await tabs.query({ url:provider.urlPatterns });
    if (candidates.some(tab => tab.id === saved.tabId)) {
      fail("DELIVERY_RECOVERY_UNCONFIRMED", "The original tab is still listed but cannot be inspected.");
    }
    const matches = candidates.filter(tab => provider.canonicalize(tab.url) === expected.conversationUrl
      && provider.conversationIdFromUrl(tab.url) === expected.conversationId);
    recoveryLog("TAB_LOOKUP", { savedTabId:saved.tabId, candidateCount:candidates.length,
      matchCount:matches.length, matchingTabIds:matches.map(tab => tab.id) });
    if (matches.length !== 1) fail("DELIVERY_RECOVERY_UNCONFIRMED", "A unique original conversation tab is required.");
    target = matches[0];
  }
  if (!target) fail("DELIVERY_RECOVERY_UNCONFIRMED", "The original conversation tab is unavailable.");
  if (Object.values(saved.deliveryScopes).some(slot => slot.currentDeliveryId
    && (slot.tabId === target.id || slot.conversationUrl === expected.conversationUrl))) {
    fail("DELIVERY_RECOVERY_MISMATCH", "Another delivery owns the target tab or conversation.");
  }
  const checkPage = async () => {
    const tab = await tabs.get(target.id), page = await readDeliveryPage(tabs, target.id);
    const checks = {
      tabId:tab.id === target.id, windowId:tab.windowId === target.windowId,
      savedWindow:relocate || tab.windowId === saved.windowId,
      tabUrl:provider.canonicalize(tab.url) === expected.conversationUrl,
      pageOk:Boolean(page?.ok), ready:page?.ready === true,
      idle:page?.busy === false, generationStopped:page?.generating === false,
      pageUrl:page?.url === expected.conversationUrl, conversationId:page?.conversationId === expected.conversationId,
      documentId:typeof page?.documentId === "string" && Boolean(page.documentId), frameId:page?.frameId === 0,
    };
    const failedChecks = Object.keys(checks).filter(key => !checks[key]);
    recoveryLog("CHECK_PAGE", { tabId:tab.id, targetId:target.id, tabWindowId:tab.windowId,
      targetWindowId:target.windowId, checks, failedChecks });
    if (failedChecks.length) {
      fail("DELIVERY_RECOVERY_UNCONFIRMED", "원래 대화와 생성 종료를 확인하지 못했습니다.");
    }
    return page;
  };
  const page = await checkPage();
  const binding = { sessionId:saved.lastBoundSessionId, runId:saved.lastBoundRunId,
    tabId:target.id, windowId:target.windowId, documentId:page.documentId, frameId:0,
    conversationUrl:expected.conversationUrl, conversationId:expected.conversationId, bindingStatus:"BOUND", title:null };
  const frozen = captureTurnBinding({ ...saved, ...binding, bindingStatus:"BOUND" },
    { requestId:saved.currentDeliveryId, controllerMessageId:saved.currentDeliveryId, runId:saved.lastBoundRunId });
  if (completed !== null && completed.binding.tabId === binding.tabId && completed.binding.windowId === binding.windowId
    && completed.binding.documentId === binding.documentId && completed.binding.frameId === binding.frameId) {
    assertRelaySafeCompletion({ ...completed, text:completed.rawText }, frozen);
    return saved;
  }
  recoveryLog("RECHECK_SEND", { tabId:target.id });
  const result = await tabs.sendMessage(target.id, { type:"agent.recheck", payload:{
    recoverSubmitted:true, controllerMessageId:saved.currentDeliveryId, runId:saved.lastBoundRunId,
    expectedConversationUrl:binding.conversationUrl, expectedConversationId:binding.conversationId,
    expectedDocumentId:binding.documentId, expectedFrameId:0,
  } });
  recoveryLog("RECHECK_RESULT", { tabId:target.id, ok:Boolean(result?.ok),
    code:typeof result?.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(result.code) ? result.code : null,
    error:typeof result?.error === "string" ? result.error.slice(0, 500) : null,
    details:result?.details && typeof result.details === "object" ? result.details : null });
  if (!result?.ok) fail(result?.code ?? "RESPONSE_RECHECK_FAILED", "원본 마커와 응답을 검증하지 못했습니다.");
  assertRelaySafeCompletion(result, frozen);
  if (result.confidence !== "CONFIRMED_BY_UI_STATE" || !result.evidence?.userMessageId || !result.evidence?.assistantMessageId
    || result.evidence.responseAssociation !== "DIRECT_DOM_ORDER") {
    fail("AMBIGUOUS_COMPLETION", "원본 요청과 응답의 직접 귀속이 필요합니다.");
  }
  if (completed !== null && (result.text !== completed.rawText
    || result.evidence.userMessageId !== completed.evidence.userMessageId
    || result.evidence.assistantMessageId !== completed.evidence.assistantMessageId)) {
    fail("DELIVERY_RECOVERY_MISMATCH", "The response differs from the stored original response.");
  }
  if ((await checkPage()).documentId !== binding.documentId) fail("WEB_DOCUMENT_CHANGED", "검증 중 문서가 변경됐습니다.");
  Object.assign(binding, { lastObservedUserMessageId:result.evidence.userMessageId,
    lastObservedAssistantMessageId:result.evidence.assistantMessageId });
  const completedDelivery = { turnId:saved.currentDeliveryId, binding, rawText:result.text,
    confidence:result.confidence, confidenceReason:result.confidenceReason ?? null, evidence:result.evidence,
    trace:createSuccessTrace(saved.currentDeliveryId, binding) };
  return store.updateIf(Object.fromEntries(["currentDeliveryId", "lastBoundSessionId", "lastBoundRunId", "tabId", "windowId",
    "documentId", "frameId", "conversationUrl", "conversationId", "bindingStatus", "webProvider", "completedDelivery",
    "deliveryScopes"].map(key => [key,saved[key]])), {
    tabId:binding.tabId, windowId:binding.windowId,
    conversationUrl:binding.conversationUrl, conversationId:binding.conversationId, documentId:binding.documentId,
    frameId:0, bindingStatus:"BOUND", bindingError:null, completedDelivery,
    lastObservedUserMessageId:binding.lastObservedUserMessageId, lastObservedAssistantMessageId:binding.lastObservedAssistantMessageId,
  });
}

function recoverySnapshot(state) {
  return JSON.stringify(Object.fromEntries([
    "currentDeliveryId", "lastBoundSessionId", "lastBoundRunId", "tabId", "windowId", "documentId", "frameId",
    "conversationUrl", "conversationId", "bindingStatus", "webProvider", "completedDelivery", "deliveryScopes",
  ].map(key => [key,state[key]])));
}

export async function inspectSubmittedRoot(message, { tabs, store, turnGate, send, errorPayload, deliveryDetails }) {
  let reservation, reply;
  try {
    reservation = turnGate.reserve(message.requestId);
    const recovered = await recoverSubmittedRoot({ tabs, store, expected:message.payload.recoverSubmitted });
    const payload = await deliveryDetails(recovered);
    if (recoverySnapshot(await store.read()) !== recoverySnapshot(recovered)) {
      fail("DELIVERY_RECOVERY_MISMATCH", "Delivery ownership changed while preparing the reply.");
    }
    reply = { type:"web.delivery.inspected", requestId:message.requestId, payload };
  } catch (error) {
    reply = { type:"web.session.error", requestId:message.requestId, payload:errorPayload(error) };
  } finally { if (reservation) turnGate.release(reservation); }
  if (reply.type === "web.delivery.inspected") reply.payload.extensionBusy = turnGate.active;
  // One send attempt; transport failure must not cause a second response.
  return send(reply);
}

export async function closedBootstrapRootTabs(error, { bootstrap, tabId, tabs, provider }) {
  if (!bootstrap) throw error;
  const candidates = await tabs.query({ url:provider.urlPatterns });
  if (candidates.some(candidate => candidate.id === tabId)) throw error;
  return candidates.filter(candidate => provider.canonicalize(candidate.url) === provider.rootUrl)
    .map(candidate => ({ tabId:candidate.id, windowId:candidate.windowId, url:candidate.url }));
}

export async function refreshCompletedDelivery(message, { chrome, store, turnGate, send, errorPayload,
  ExtensionOperationError, deliveryDetails }) {
  let reservation;
  try {
    reservation = turnGate.reserve(message.requestId);
    const saved = await store.read(), completed = saved.completedDelivery;
    if (!completed || completed.turnId !== saved.currentDeliveryId || !saved.lastBoundRunId?.startsWith("prep_")) {
      throw new ExtensionOperationError("RESPONSE_RECHECK_UNAVAILABLE", "다시 확인할 준비 응답이 없습니다.");
    }
    const result = await chrome.tabs.sendMessage(saved.tabId, { type:"agent.recheck", payload:{
      expectedConversationUrl:saved.conversationUrl, expectedConversationId:saved.conversationId,
      expectedDocumentId:saved.documentId, expectedFrameId:saved.frameId,
      runId:saved.lastBoundRunId, controllerMessageId:completed.turnId,
      userMessageId:completed.evidence?.userMessageId, assistantMessageId:completed.evidence?.assistantMessageId,
      allowManualFollowup:message.payload?.adoptManualFollowup === true,
    } });
    if (!result?.ok) throw new ExtensionOperationError(result?.code ?? "RESPONSE_RECHECK_FAILED", result?.error ?? "응답 재확인에 실패했습니다.");
    const current = await store.read();
    if (current.currentDeliveryId !== completed.turnId || current.lastBoundSessionId !== saved.lastBoundSessionId) {
      throw new ExtensionOperationError("DELIVERY_RECOVERY_MISMATCH", "재확인 중 전송 대상이 변경됐습니다.");
    }
    const adoptedManualFollowup = result.evidence?.responseAssociation === "EXPLICIT_MANUAL_FOLLOWUP";
    await store.update({
      ...(adoptedManualFollowup ? { lastObservedUserMessageId:result.evidence.userMessageId,
        lastObservedAssistantMessageId:result.evidence.assistantMessageId } : {}),
      completedDelivery:{ ...completed, rawText:result.text, confidence:result.confidence,
        confidenceReason:result.confidenceReason ?? null, evidence:result.evidence,
        ...(adoptedManualFollowup ? { adoption:{ type:"EXPLICIT_MANUAL_FOLLOWUP",
          originalAssistantMessageId:result.evidence.originalAssistantMessageId,
          userMessageId:result.evidence.userMessageId, assistantMessageId:result.evidence.assistantMessageId } } : {}),
      },
    });
  } catch (error) {
    send({ type:"web.session.error", requestId:message.requestId, payload:errorPayload(error) });
    return;
  } finally { if (reservation) turnGate.release(reservation); }
  send({ type:"web.delivery.inspected", requestId:message.requestId, payload:await deliveryDetails(await store.read()) });
}

export async function recoverBootstrapAfterNavigation({
  tabs,
  store,
  tab,
  reservedState,
  turnIdentity,
  payload,
  waitForContentScript,
  sleep,
}) {
  const provider = resolveStoredWebTargetProvider(reservedState);
  if (!provider) fail("WEB_PROVIDER_UNAVAILABLE", "The bootstrap Web provider is not registered.");
  const deadline = Date.now() + 30_000;
  let observed = null;
  let url = null;
  let id = null;
  while (Date.now() < deadline) {
    const current = await store.read();
    if (current.currentDeliveryId !== turnIdentity.requestId
      || current.lastBoundSessionId !== reservedState.lastBoundSessionId
      || current.lastBoundRunId !== reservedState.lastBoundRunId
      || current.tabId !== tab.id) {
      fail("TURN_BINDING_CHANGED", "새 대화 전환 중 전송 identity가 변경되었습니다.");
    }
    observed = await tabs.get(tab.id);
    url = provider.canonicalize(observed.url);
    id = provider.conversationIdFromUrl(url);
    if (id) break;
    await sleep(150);
  }
  if (!observed || !url || !id) {
    fail("NEW_CONVERSATION_TIMEOUT", "첫 메시지 전송 후 대화 주소가 생성되지 않았습니다. 자동 재전송하지 않습니다.");
  }
  if (observed.windowId !== reservedState.windowId) {
    fail("TURN_BINDING_CHANGED", "새 대화가 원래 창과 다른 위치에서 열렸습니다.");
  }

  const page = await waitForContentScript(tab.id, 30_000, true);
  if (page.url !== url || page.conversationId !== id || typeof page.documentId !== "string" || page.frameId !== 0) {
    fail("WEB_DOCUMENT_CHANGED", "새 대화 문서의 정확한 바인딩을 확인하지 못했습니다.");
  }
  const promoted = await store.update({
    conversationUrl: url, conversationId: id, documentId: page.documentId, frameId: page.frameId,
    bindingStatus: "BOUND", bindingError: null,
  });
  const frozenTurn = captureTurnBinding(promoted, turnIdentity);
  const result = await tabs.sendMessage(tab.id, {
    type: "agent.observeSubmittedPrompt",
    requestId: turnIdentity.requestId,
    payload: {
      controllerMessageId: turnIdentity.controllerMessageId,
      runId: turnIdentity.runId,
      expectedConversationUrl: url,
      expectedConversationId: id,
      expectedDocumentId: page.documentId,
      expectedFrameId: page.frameId,
      timeoutMs: payload.timeoutMs,
      stableMs: payload.stableMs,
    },
  });
  return { result, frozenTurn };
}
