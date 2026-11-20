import { WebProtocolError } from "./protocol.js";
import { createWebSessionBinding } from "./binding.js";

const RECONCILE_DIAGNOSTIC_CODES = new Set(["WEB_EXTENSION_ERROR", "WEB_RESPONSE_TIMEOUT", "EXTENSION_DISCONNECTED",
  "SESSION_AUTH_REQUIRED", "CAPTCHA_REQUIRED", "WEB_SESSION_BUSY", "DELIVERY_RECOVERY_MISMATCH", "MANUAL_INTERVENTION_DETECTED"]);

export function markReconcileDiagnostic(diagnostic, failureBoundary, responseType = null, errorCode = null) {
  if (!diagnostic) return;
  diagnostic.failureBoundary = failureBoundary;
  if (responseType) diagnostic.responseType = responseType;
  if (RECONCILE_DIAGNOSTIC_CODES.has(errorCode)) diagnostic.extensionErrorCode = errorCode;
}

export async function inspectDeliveryRequest(state, { refreshCompleted = false, adoptManualFollowup = false, recoverSubmitted = null } = {},
  diagnosticRequestId = null) {
  const requestType = recoverSubmitted?.documentId ? "web.delivery.inspect-pinned-root" : "web.delivery.inspect";
  const diagnostic = diagnosticRequestId ? { httpRequestId:diagnosticRequestId, extensionRequestId:null,
    extensionRequestType:requestType, sendOutcome:"NOT_ATTEMPTED", failureBoundary:"UNKNOWN",
    responseType:null, extensionErrorCode:null } : null;
  if (diagnostic) {
    const request = state.request, messageError = state.messageError;
    state = { ...state,
      request:(message, types, timeoutMs, explicitRequestId = null) => request(message, types, timeoutMs, explicitRequestId, diagnostic)
        .then(response => { diagnostic.responseType = response.type; return response; }),
      messageError:message => {
        markReconcileDiagnostic(diagnostic, "EXTENSION_ERROR_RESPONSE", message.type, message.payload?.code);
        return messageError(message);
      },
    };
  }
  try {
  if (recoverSubmitted && state.binding && (state.binding.sessionId !== recoverSubmitted.sessionId
    || state.binding.runId !== recoverSubmitted.runId
    || (state.binding.tabId !== recoverSubmitted.tabId && recoverSubmitted.allowTabRelocation !== true))) {
    throw new WebProtocolError("Recovery belongs to a different session", "DELIVERY_RECOVERY_MISMATCH");
  }
  if (recoverSubmitted && (state.activeTurnId !== null || state.sessionOperation !== null || state.pendingCount > 0
    || (state.ambiguousTurnId !== null && state.ambiguousTurnId !== recoverSubmitted.currentDeliveryId))) {
    throw new WebProtocolError("Another Web operation owns the session", "WEB_SESSION_BUSY");
  }
  const payload = recoverSubmitted ? { recoverSubmitted } : refreshCompleted
    ? { refreshCompleted:true, ...(adoptManualFollowup ? { adoptManualFollowup:true } : {}) }
    : null;
  const message = await state.request({ type:requestType, ...(payload ? { payload } : {}) },
    new Set(["web.delivery.inspected", "web.session.error"]), refreshCompleted || recoverSubmitted ? 30_000 : 10_000);
  if (message.type === "web.session.error") throw state.messageError(message);
  if (recoverSubmitted) {
    const response = message.payload?.completedDelivery, next = response?.binding;
    const destination = recoverSubmitted.replacement ?? recoverSubmitted;
    const checks = {
      turnId: response?.turnId === recoverSubmitted.currentDeliveryId,
      sessionId: next?.sessionId === recoverSubmitted.sessionId,
      runId: next?.runId === recoverSubmitted.runId,
      tabIdRelocation: next?.tabId === recoverSubmitted.tabId || recoverSubmitted.allowTabRelocation === true,
      conversationUrl: next?.conversationUrl === recoverSubmitted.conversationUrl,
      conversationId: next?.conversationId === recoverSubmitted.conversationId,
      payloadCurrentDeliveryId: message.payload.currentDeliveryId === response?.turnId,
      confidence: response?.confidence === "CONFIRMED_BY_UI_STATE",
      payloadSessionId: message.payload.sessionId === next?.sessionId,
      payloadRunId: message.payload.runId === next?.runId,
      payloadTabId: message.payload.tabId === next?.tabId,
      payloadDocumentId: message.payload.documentId === next?.documentId,
      payloadObservedDocumentId: message.payload.observedDocumentId === next?.documentId,
      payloadFrameId: message.payload.frameId === next?.frameId,
      payloadObservedConversationUrl: message.payload.observedConversationUrl === next?.conversationUrl,
      payloadConversationId: message.payload.conversationId === next?.conversationId,
      payloadPageReachable: message.payload.pageReachable === true,
      payloadGenerating: message.payload.generating === false,
      payloadPageBusy: message.payload.pageBusy === false,
      payloadExtensionBusy: message.payload.extensionBusy === false,
      rawTextString: typeof response?.rawText === "string",
      rawTextNonEmpty: typeof response?.rawText === "string" && response.rawText.trim().length > 0,
      evidenceUserMessageId: !!response?.evidence?.userMessageId,
      evidenceAssistantMessageId: !!response?.evidence?.assistantMessageId,
      evidenceConversationUrl: response?.evidence?.conversationUrl === next?.conversationUrl,
      evidenceConversationId: response?.evidence?.conversationId === next?.conversationId,
      evidenceDocumentId: response?.evidence?.documentId === next?.documentId,
      evidenceFrameId: response?.evidence?.frameId === next?.frameId,
      evidenceResponseAssociation: response?.evidence?.responseAssociation === "DIRECT_DOM_ORDER",
      bindingPresent:Boolean(next),
      pinnedIdentity: !recoverSubmitted.documentId || (next?.tabId === destination.tabId
        && next?.documentId === destination.documentId && next?.windowId === destination.windowId && next?.frameId === destination.frameId
        && response?.evidence?.userMessageId === recoverSubmitted.userMessageId
        && response?.evidence?.assistantMessageId === recoverSubmitted.assistantMessageId),
    };
    const failedChecks = Object.keys(checks).filter(key => !checks[key]);
    if (failedChecks.length) {
      markReconcileDiagnostic(diagnostic, "INSPECTION_VALIDATION", message.type, "DELIVERY_RECOVERY_MISMATCH");
      if (diagnostic) Object.assign(diagnostic, { failedChecks });
      throw new WebProtocolError("Recovered response identity mismatch", "DELIVERY_RECOVERY_MISMATCH");
    }
    state.acceptReturnedBinding(next, { expectedBinding:createWebSessionBinding({ ...next,
      conversationUrl:null, conversationId:null, bindingStatus:"NEEDS_REBIND" }),
      allowConversationBootstrap:true, allowTabRelocation:recoverSubmitted.allowTabRelocation === true });
    state.setAmbiguousTurnId(response.turnId);
    state.setReady(true);
  }
  return message.payload;
  } catch (error) {
    if (diagnostic) {
      if (diagnostic.failureBoundary === "UNKNOWN") {
        diagnostic.failureBoundary = diagnostic.responseType ? "INSPECTION_VALIDATION" : "INSPECTION_PRE_DISPATCH";
      }
      try { error.receiptDiagnostics = { ...diagnostic }; } catch {}
    }
    throw error;
  }
}
