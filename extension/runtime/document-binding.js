import "./diagnostic-projection.js";
const { projectDiagnostics, projectedError } = globalThis.WebBridgeDiagnosticProjection;
// documentId is the content-script lifetime token, not a Chrome navigation ID.
export async function inspectBoundDocument(tabs, tabId, expected) {
  const page = await tabs.sendMessage(tabId, { type: "agent.ping" }).catch(() => null);
  if (!page?.ok || typeof page.documentId !== "string" || !page.documentId.trim() || page.frameId !== 0
    || page.url !== expected.conversationUrl || page.conversationId !== expected.conversationId
    || (expected.documentId && page.documentId !== expected.documentId)) {
    throw Object.assign(new Error("The bound ChatGPT document changed; prepare the session again."), {
      code: "WEB_DOCUMENT_CHANGED",
    });
  }
  return { documentId: page.documentId, frameId: page.frameId };
}

export function createSuccessTrace(requestId, session) {
  return {
    requestId, actionId: requestId, result: "success",
    tabId: session.tabId, bindingId: `${session.sessionId}:${session.runId}`,
    documentId: session.documentId, frameId: session.frameId,
  };
}

export function diagnosticMetadata(value) {
  return projectDiagnostics(value);
}

export function diagnosticError(error) {
  const safe = projectedError(error, "WEB_EXTENSION_ERROR");
  const details = safe.details;
  const suffix = details && typeof details === "object" ? ` · 진단: ${JSON.stringify(details)}` : "";
  return `${safe.code}: ${safe.message}${suffix}`;
}

export function errorPayload(error) {
  const { code, message, details } = projectedError(error, "WEB_EXTENSION_ERROR");
  return { code, message, details };
}

