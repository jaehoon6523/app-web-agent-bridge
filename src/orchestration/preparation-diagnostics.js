const TEXT = new Set(("name code flow stage provider selectorVersion runtimeVersion extensionVersion extensionId "
+ "sessionId runId preparationId deliveryId blockingDeliveryId currentDeliveryId activeRequestId documentId chromeDocumentId contentDocumentId "
+ "expectedSessionId expectedRunId blockingSessionId blockingRunId persistedDocumentId expectedDocumentId observedDocumentId "
+ "userMessageId assistantMessageId originalAssistantMessageId observedAssistantMessageId expectedUrl observedUrl expectedId observedId "
+ "conversationId conversationUrl observedConversationUrl canonicalUrl pageUrl tabUrl url bindingStatus observedBindingStatus "
+ "state lifecycle processingState status pageStatus originalCode selector tagName display visibility role contentEditable "
+ "fallbackReason authenticationSignal readyState visibilityState causeCode causeName operation result actionId requestId bindingId mode matchStatus persistedUrl persistedConversationId controlLabel testId elementId").split(" "));
const SELECTORS = new Set("composer sendButton stopButton message messageContainer messageContent".split(" "));
const BINDING = new Set("sessionId runId conversationUrl conversationId tabId windowId bindingStatus documentId frameId".split(" "));
const FLAGS = new Set(("ok ready busy generating composerPresent responded injectionAttempted missingReceiver requireComposer "
+ "browserDispatchStarted unsent deliveryReserved contentDispatchStarted extensionBusy pageBusy pageReachable reloadRequired "
+ "acceptedByVisibility connected disabled readOnly editable inForm inMain selected hasFocus documentMatches excludedAncestor").split(" "));
const NUMBERS = new Set(("tabId windowId frameId persistedTabId storedTabId expectedTabId expectedFrameId observedTabId "
+ "timeoutMs pingAttempts rootCount count matched visible width height eligible").split(" "));
const OBJECTS = new Set(("details evidence cause causeDetails readiness lastReadiness inspectionError lastInspectionError "
+ "diagnostics pageState composerFallback selectorsUsed originalError expected observed requested persisted page binding transport").split(" "));
const ARRAYS = new Set(("composerSelectors editableCandidates samples rootTabs candidates controls ancestors").split(" "));

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

export function bestEffortFailureLog(event, value) {
  try { console.error(event, JSON.stringify(projectDiagnostics(value))); }
  catch { /* Diagnostic output must never replace the operation failure. */ }
}
