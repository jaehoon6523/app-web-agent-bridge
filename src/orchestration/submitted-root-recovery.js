import { canonicalConversationUrl, extractConversationId } from "../runtime/web/binding.js";

export function submittedRootRecovery(context) {
  const session = context.webSession, error = context.error;
  const delivery = context.deliveries.find(item => item.deliveryId === session.activeDeliveryId);
  const url = error?.details?.observedUrl, id = error?.details?.observedId;
  if (context.state !== "RECOVERY_REQUIRED" || delivery?.response || delivery?.unsent !== false
    || error?.code !== "MANUAL_INTERVENTION_DETECTED" || error.details?.browserDispatchStarted !== true
    || session.conversationUrl !== "https://chatgpt.com/" || session.conversationId !== null
    || !id || canonicalConversationUrl(url) !== url || extractConversationId(url) !== id) return null;
  return { currentDeliveryId:delivery.deliveryId, sessionId:session.sessionId, runId:context.preparationId,
    tabId:session.tabId, conversationUrl:url, conversationId:id, allowTabRelocation:true };
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
  Object.assign(session, { tabId:binding.tabId, conversationUrl:binding.conversationUrl, conversationId:binding.conversationId,
    documentId:binding.documentId, frameId:binding.frameId, windowId:binding.windowId, bindingState:"BOUND",
    lastObservedUserMessageId:binding.lastObservedUserMessageId, lastObservedAssistantMessageId:binding.lastObservedAssistantMessageId });
  context.conversationUrl = binding.conversationUrl;
}
