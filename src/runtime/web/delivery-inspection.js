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
  const diagnostic = diagnosticRequestId ? { httpRequestId:diagnosticRequestId, extensionRequestId:null,
    extensionRequestType:"web.delivery.inspect", sendOutcome:"NOT_ATTEMPTED", failureBoundary:"UNKNOWN",
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
  const message = await state.request({ type:"web.delivery.inspect", ...(payload ? { payload } : {}) },
    new Set(["web.delivery.inspected", "web.session.error"]), refreshCompleted || recoverSubmitted ? 30_000 : 10_000);
  if (message.type === "web.session.error") throw state.messageError(message);
  if (recoverSubmitted) {
    const response = message.payload?.completedDelivery, next = response?.binding;
    if (response?.turnId !== recoverSubmitted.currentDeliveryId || next?.sessionId !== recoverSubmitted.sessionId
      || next?.runId !== recoverSubmitted.runId
      || (next?.tabId !== recoverSubmitted.tabId && recoverSubmitted.allowTabRelocation !== true)
      || next?.conversationUrl !== recoverSubmitted.conversationUrl || next?.conversationId !== recoverSubmitted.conversationId
      || message.payload.currentDeliveryId !== response.turnId || response.confidence !== "CONFIRMED_BY_UI_STATE"
      || message.payload.sessionId !== next.sessionId || message.payload.runId !== next.runId
      || message.payload.tabId !== next.tabId || message.payload.documentId !== next.documentId
      || message.payload.observedDocumentId !== next.documentId || message.payload.frameId !== next.frameId
      || message.payload.observedConversationUrl !== next.conversationUrl || message.payload.conversationId !== next.conversationId
      || message.payload.pageReachable !== true || message.payload.generating !== false
      || message.payload.pageBusy !== false || message.payload.extensionBusy !== false
      || typeof response.rawText !== "string" || !response.rawText.trim()
      || !response.evidence?.userMessageId || !response.evidence?.assistantMessageId
      || response.evidence.conversationUrl !== next.conversationUrl || response.evidence.conversationId !== next.conversationId
      || response.evidence.documentId !== next.documentId || response.evidence.frameId !== next.frameId
      || response.evidence.responseAssociation !== "DIRECT_DOM_ORDER") {
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
