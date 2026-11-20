import { canonicalConversationUrl, extractConversationId } from "../runtime/web/binding.js";
import { hasControllerPacketMarker } from "./preparation-plain-text.js";

const TEXT = new Set(("name code flow stage provider selectorVersion runtimeVersion extensionVersion extensionId "
+ "sessionId runId preparationId deliveryId blockingDeliveryId currentDeliveryId activeRequestId documentId chromeDocumentId contentDocumentId "
+ "expectedSessionId expectedRunId blockingSessionId blockingRunId persistedDocumentId expectedDocumentId observedDocumentId "
+ "userMessageId assistantMessageId originalAssistantMessageId observedAssistantMessageId expectedUrl observedUrl expectedId observedId "
+ "conversationId conversationUrl observedConversationUrl canonicalUrl pageUrl tabUrl url bindingStatus observedBindingStatus "
+ "state lifecycle processingState status pageStatus originalCode selector tagName display visibility role contentEditable "
+ "fallbackReason authenticationSignal readyState visibilityState causeCode causeName operation result actionId requestId bindingId mode matchStatus persistedUrl persistedConversationId controlLabel testId elementId "
+ "validationStatus validationFormat confidence responseAssociation").split(" "));
const SELECTORS = new Set("composer sendButton stopButton message messageContainer messageContent".split(" "));
const BINDING = new Set("sessionId runId conversationUrl conversationId tabId windowId bindingStatus documentId frameId".split(" "));
const FLAGS = new Set(("ok ready busy generating composerPresent responded injectionAttempted missingReceiver requireComposer "
+ "browserDispatchStarted sendAttempted unsent deliveryReserved contentDispatchStarted extensionBusy pageBusy pageReachable reloadRequired "
+ "acceptedByVisibility connected disabled readOnly editable inForm inMain selected hasFocus documentMatches excludedAncestor policyEnabled hasPacketMarker").split(" "));
const NUMBERS = new Set(("tabId windowId frameId persistedTabId storedTabId expectedTabId expectedFrameId observedTabId "
+ "stageStartedAt stageEndedAt timeoutMs pingAttempts rootCount count matched visible width height eligible rawTextLength").split(" "));
const OBJECTS = new Set(("details evidence cause causeDetails readiness lastReadiness inspectionError lastInspectionError "
+ "diagnostics pageState composerFallback selectorsUsed originalError expected observed requested persisted page binding transport completion").split(" "));
const ARRAYS = new Set(("composerSelectors editableCandidates samples rootTabs candidates controls ancestors failedChecks").split(" "));

function own(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) return descriptor.value;
    return undefined;
  }
  catch { return undefined; }
}

// Copy bounded data while ignoring application-defined accessors and toJSON.
const SUMMARY = Object.freeze({
  UI_CONTRACT_CHANGED: "Web page controls are unavailable or changed. Inspect structured page diagnostics.",
  WEB_DOCUMENT_CHANGED: "The bound Web document changed. Prepare the session again.",
  AMBIGUOUS: "The matching Web conversation cannot be uniquely identified.",
  WEB_TAB_SELECTION_REQUIRED: "Select the matching Web conversation tab; no prompt has been sent.",
  EXTENSION_RUNTIME_STALE: "Reload the extension; another delivery owner was preserved.",
  CONTENT_SCRIPT_TIMEOUT: "Content readiness timed out. Inspect structured readiness diagnostics.",
  DELIVERY_RECOVERY_UNCONFIRMED: "The original delivery conversation could not be confirmed.",
  TURN_INTERRUPTED: "The Web operation was interrupted.",
});
export function diagnosticSummary(code) {
  return typeof code === "string" && Object.hasOwn(SUMMARY, code) ? SUMMARY[code] : "Web operation failed. Inspect the error code and structured diagnostics.";
}
function projectDiagnostics(value) {
  let nodes = 256, chars = 16000;
  const ancestors = new WeakSet();
  function string(value) {
    const clipped = value.slice(0, Math.min(2048, chars)); chars -= clipped.length; return clipped;
  }
  function copy(value, depth, schema = null) {
    if (depth > 10 || --nodes < 0 || !value || typeof value !== "object" || ancestors.has(value)) return null;
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const result = [];
        const length = Math.min(32, own(value, "length") ?? 0);
        for (let i = 0; i < length && nodes > 0; i++) result.push(copy(own(value, String(i)), depth + 1));
        return result;
      }
      const result = {};
      for (const key of schema === "selectorsUsed" ? SELECTORS : ["requested", "persisted"].includes(schema) ? BINDING : new Set([...TEXT, ...FLAGS, ...NUMBERS, ...OBJECTS, ...ARRAYS, "message"])) {
        if (nodes <= 0) break;
        const item = own(value, key);
        if (item === undefined) continue;
        --nodes;
        if (item === null) result[key] = null;
        else if (schema !== "selectorsUsed" && key === "message") result[key] = string(diagnosticSummary(own(value, "code")));
        else if ((schema === "selectorsUsed" || TEXT.has(key)) && typeof item === "string") result[key] = string(item);
        else if (FLAGS.has(key) && typeof item === "boolean") result[key] = item;
        else if (NUMBERS.has(key) && typeof item === "number" && Number.isFinite(item)) result[key] = item;
        else if (OBJECTS.has(key) && typeof item === "object" && !Array.isArray(item)) result[key] = copy(item, depth + 1, key);
        else if (ARRAYS.has(key) && Array.isArray(item)) result[key] = copy(item, depth + 1, key);
      }
      return result;
    } catch { return null; }
    finally { ancestors.delete(value); }
  }
  return copy(value, 0);
}

function projectedError(error, fallback = "WEB_FAILED") {
  const result = projectDiagnostics(error) ?? {};
  return { code:result.code || fallback, message:diagnosticSummary(result.code || fallback),
    details:result.details ?? result.evidence ?? null };
}

export { projectDiagnostics, projectedError };

export function completionError(error, context, delivery, stage, originalCode = error?.code, failedChecks = []) {
  const response = delivery.response;
  const rawText = response?.rawText;
  const { completion } = projectDiagnostics({ completion: {
    stage, originalCode: originalCode ?? null,
    preparationId: context.preparationId, deliveryId: delivery.deliveryId,
    sessionId: context.webSession.sessionId, policyEnabled: context.acceptPlainTextDiscussion === true,
    state: delivery.state, processingState: delivery.processingState ?? null,
    validationStatus: delivery.validation?.status ?? null, validationFormat: delivery.validation?.format ?? null,
    failedChecks: failedChecks.map(({ name }) => ({ name })),
    rawTextLength: typeof rawText === "string" ? rawText.length : null,
    hasPacketMarker: hasControllerPacketMarker(rawText),
    confidence: response?.confidence ?? null, responseAssociation: response?.evidence?.responseAssociation ?? null,
  } });
  return Object.assign(new Error(error?.message ?? diagnosticSummary(originalCode), { cause: error }), error, {
    details: { ...(error?.details ?? error?.evidence ?? {}), completion },
    receiptDiagnostics: { ...(error?.receiptDiagnostics ?? {}), completion },
  });
}

export function bestEffortFailureLog(event, value) {
  try { console.error(event, JSON.stringify(projectDiagnostics(value))); }
  catch { /* Diagnostic output must never replace the operation failure. */ }
}

/** @typedef {{code:string, message:string, diagnostics?:object}} PreparationReceiptError */
/** @param {Error & {code?:string, receiptDiagnostics?:object}} error @returns {PreparationReceiptError} */
export function preparationReceiptError(error) {
  return {code:error.code ?? "PREPARATION_FAILED", message:error.message,
    ...(error.receiptDiagnostics ? {diagnostics:error.receiptDiagnostics} : {})};
}

const PACKET_FORMAT_CODES = new Set([
  "EMPTY_AGENT_RESPONSE",
  "CONTROLLER_PACKET_MISSING",
  "CONTROLLER_PACKET_AMBIGUOUS",
  "CONTROLLER_PACKET_TOO_DEEP",
  "INVALID_PACKET_LIMIT",
  "INVALID_PACKET_JSON",
]);

export const USER_TAB_SELECTION_ERRORS = new Set(["AMBIGUOUS", "STORED_AMBIGUOUS_REBIND_REQUIRED"]);
export function logPreparationFailure(context, deliveryId, error, unsent, onFailure) {
  try {onFailure?.({code:error.code,details:{...error.details,deliveryId,sessionId:context.webSession.sessionId,
    runId:context.preparationId,stage:error.details?.stage ?? (unsent ? "BEFORE_DISPATCH" : "DELIVERY")}});}
  catch { /* Diagnostic output cannot replace the preparation failure. */ }
  bestEffortFailureLog("[bridge:preparation:failed]", {
    preparationId: context.preparationId, sessionId: context.webSession.sessionId, deliveryId,
    code: error.code ?? "WEB_FAILED", unsent, state: context.state, lifecycle: context.lifecycle,
    stage: error.details?.stage ?? (unsent ? "BEFORE_DISPATCH" : "DELIVERY"),
    browserDispatchStarted: unsent ? false : error.details?.browserDispatchStarted ?? null,
    message: error.message, details: error.details ?? null, stack: error.stack ?? null,
    blockingDeliveryId: error.details?.currentDeliveryId ?? null,
    blockingSessionId: error.details?.sessionId ?? null, blockingRunId: error.details?.runId ?? null,
  });
}

export function selectableTabsFor(error, session) {
  if (!USER_TAB_SELECTION_ERRORS.has(error?.code)) return [];
  const source = Array.isArray(error?.details?.rootTabs)
    ? error.details.rootTabs
    : Array.isArray(error?.details?.candidates)
      ? error.details.candidates
      : [];
  const bootstrap = session.conversationUrl === null && session.conversationId === null;
  const seen = new Set();
  const candidates = [];
  for (const candidate of source) {
    if (!Number.isSafeInteger(candidate?.tabId) || candidate.tabId < 0 || seen.has(candidate.tabId)) continue;
    const url = canonicalConversationUrl(candidate.canonicalUrl ?? candidate.url);
    const conversationId = candidate.conversationId ?? extractConversationId(url);
    const matches = bootstrap
      ? url === "https://chatgpt.com/" && conversationId === null
      : url === session.conversationUrl && conversationId === session.conversationId;
    if (!matches) continue;
    seen.add(candidate.tabId);
    candidates.push({
      tabId: candidate.tabId,
      windowId: Number.isSafeInteger(candidate.windowId) ? candidate.windowId : null,
      url,
    });
  }
  return candidates;
}

export function packetFormatError(error) {
  const code = PACKET_FORMAT_CODES.has(error?.code) ? error.code : "INVALID_CONTROLLER_PACKET";
  return Object.freeze({
    code,
    message: typeof error?.message === "string" && error.message
      ? error.message
      : "Controller packet validation failed.",
  });
}

export function normalizePreparationWebFailure(error, expected) {
  if (error?.code !== "REBIND_DURING_ACTIVE_DELIVERY") return error;
  const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details
    : null;
  if (!details) return error;
  const blockingSessionId = typeof details.sessionId === "string" && details.sessionId
    ? details.sessionId
    : null;
  const blockingRunId = typeof details.runId === "string" && details.runId
    ? details.runId
    : null;
  const ownerMismatch = (blockingSessionId !== null && blockingSessionId !== expected.sessionId)
    || (blockingRunId !== null && blockingRunId !== expected.runId);
  if (!ownerMismatch) return error;
  return Object.assign(
    new Error(
      "The connected browser extension is running stale session-binding logic. "
        + "Reload the unpacked extension before retrying; the older delivery was preserved.",
    ),
    {
      code: "EXTENSION_RUNTIME_STALE",
      details: {
        ...details,
        originalCode: error.code,
        expectedSessionId: expected.sessionId,
        expectedRunId: expected.runId,
        blockingSessionId,
        blockingRunId,
        reloadRequired: true,
      },
    },
  );
}
