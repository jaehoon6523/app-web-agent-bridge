import { canonicalConversationUrl, extractConversationId } from "../runtime/web/binding.js";

export function submittedRootRecovery(context, target) {
  const session = context.webSession, error = context.error;
  const delivery = context.deliveries.find(item => item.deliveryId === session.activeDeliveryId);
  // A disconnect can hide the completion receipt from the server after Chrome stored it.
  if (error?.code === "WEB_TURN_AMBIGUOUS" && context.state === "RECOVERY_REQUIRED"
    && delivery?.state === "RECOVERY_REQUIRED" && delivery.unsent === false && !delivery.response
    && session.conversationUrl === "https://chatgpt.com/" && session.conversationId === null
    && Number.isSafeInteger(session.tabId) && session.frameId === 0 && session.documentId) {
    const observed = context.diagnostics, response = observed?.completedDelivery, binding = response?.binding;
    if (observed?.currentDeliveryId === delivery.deliveryId && observed.sessionId === session.sessionId
      && observed.runId === context.preparationId && observed.tabId === session.tabId
      && response?.turnId === delivery.deliveryId && response.confidence === "CONFIRMED_BY_UI_STATE"
      && response.evidence?.responseAssociation === "DIRECT_DOM_ORDER"
      && binding?.sessionId === session.sessionId && binding.runId === context.preparationId
      && binding.tabId === session.tabId && binding.windowId === session.windowId && binding.bindingStatus === "BOUND"
      && binding.conversationId && canonicalConversationUrl(binding.conversationUrl) === binding.conversationUrl
      && extractConversationId(binding.conversationUrl) === binding.conversationId) {
      return { currentDeliveryId:delivery.deliveryId, sessionId:session.sessionId, runId:context.preparationId,
        tabId:session.tabId, conversationUrl:binding.conversationUrl, conversationId:binding.conversationId, allowTabRelocation:false };
    }
  }
  const exact = error?.code === "UI_CONTRACT_CHANGED";
  if (context.state !== "RECOVERY_REQUIRED" || delivery?.response || delivery?.unsent !== false
    || error?.details?.browserDispatchStarted !== true || session.conversationUrl !== "https://chatgpt.com/"
    || session.conversationId !== null) return null;
  if (exact && (delivery.state !== "RECOVERY_REQUIRED" || delivery.processingState != null
    || !Number.isSafeInteger(session.tabId) || !Number.isSafeInteger(session.windowId)
    || session.frameId !== 0 || !session.documentId
    || ![target?.userMessageId, target?.assistantMessageId].every(value => typeof value === "string" && value.trim())
    || target.userMessageId === target.assistantMessageId)) return null;
  if (!exact && error.code !== "MANUAL_INTERVENTION_DETECTED") return null;
  const url = exact ? target.conversationUrl : error.details.observedUrl;
  const id = exact ? target.conversationId : error.details.observedId;
  if (!id || canonicalConversationUrl(url) !== url || extractConversationId(url) !== id) return null;
  const replacement = exact ? target.replacement : undefined;
  if (replacement !== undefined && (!Number.isSafeInteger(replacement?.tabId) || replacement.tabId < 0
    || !Number.isSafeInteger(replacement.windowId) || replacement.windowId < 0 || replacement.frameId !== 0
    || typeof replacement.documentId !== "string" || !replacement.documentId.trim()
    || replacement.documentId === session.documentId)) return null;
  return { currentDeliveryId:delivery.deliveryId, sessionId:session.sessionId, runId:context.preparationId,
    tabId:session.tabId, conversationUrl:url, conversationId:id, allowTabRelocation:!exact || Boolean(replacement),
    ...(exact ? { windowId:session.windowId, documentId:session.documentId, frameId:session.frameId,
      userMessageId:target.userMessageId, assistantMessageId:target.assistantMessageId,
      ...(replacement ? {replacement:{tabId:replacement.tabId, windowId:replacement.windowId,
        documentId:replacement.documentId, frameId:0}} : {}) } : {}) };
}

export function bindSubmittedRootRecovery(context, session, observed, expected) {
  const response = observed.completedDelivery, binding = response?.binding;
  if (response?.turnId !== session.activeDeliveryId || binding?.sessionId !== session.sessionId
    || binding?.runId !== context.preparationId
    || (binding?.tabId !== session.tabId && expected.allowTabRelocation !== true)
    || !Number.isSafeInteger(binding?.tabId) || binding.tabId < 0 || binding?.bindingStatus !== "BOUND"
    || binding?.conversationUrl !== expected.conversationUrl || binding?.conversationId !== expected.conversationId
    || observed.currentDeliveryId !== session.activeDeliveryId || observed.sessionId !== session.sessionId
    || observed.runId !== context.preparationId || observed.conversationId !== binding.conversationId
    || observed.tabId !== binding.tabId || observed.documentId !== binding.documentId
    || observed.observedDocumentId !== binding.documentId || observed.frameId !== binding.frameId
    || response.confidence !== "CONFIRMED_BY_UI_STATE" || response.evidence?.responseAssociation !== "DIRECT_DOM_ORDER"
    || observed.observedConversationUrl !== binding.conversationUrl || observed.pageReachable !== true
    || observed.generating !== false || observed.pageBusy !== false || observed.extensionBusy !== false) {
    throw Object.assign(new Error("Recovered response identity is not confirmed."), { code:"DELIVERY_RECOVERY_MISMATCH" });
  }
  const destination = expected.replacement ?? expected;
  const rebinding = response.evidence?.recoveryRebinding;
  if (expected.documentId && (binding.tabId !== destination.tabId || binding.windowId !== destination.windowId
    || binding.documentId !== destination.documentId || binding.frameId !== destination.frameId
    || response.evidence.userMessageId !== expected.userMessageId
    || response.evidence.assistantMessageId !== expected.assistantMessageId
    || response.evidence.conversationUrl !== expected.conversationUrl || response.evidence.conversationId !== expected.conversationId
    || response.evidence.documentId !== destination.documentId || response.evidence.frameId !== destination.frameId
    || (expected.replacement && ["tabId","windowId","documentId","frameId"].some(key =>
      rebinding?.from?.[key] !== expected[key] || rebinding?.to?.[key] !== destination[key])))) {
    throw Object.assign(new Error("Recovered document or message identity changed."), { code:"DELIVERY_RECOVERY_MISMATCH" });
  }
  Object.assign(session, { tabId:binding.tabId, conversationUrl:binding.conversationUrl, conversationId:binding.conversationId,
    documentId:binding.documentId, frameId:binding.frameId, windowId:binding.windowId, bindingState:"BOUND",
    lastObservedUserMessageId:binding.lastObservedUserMessageId, lastObservedAssistantMessageId:binding.lastObservedAssistantMessageId });
  context.conversationUrl = binding.conversationUrl;
}
