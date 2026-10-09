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
  if (Array.isArray(value)) return value.map(diagnosticMetadata);
  if (!value || typeof value !== "object") return value;
  const privateKeys = new Set(["text", "body", "rawText", "packetText", "packet", "response", "sharedSecret", "secret", "hmacSha256", "nonce"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !privateKeys.has(key))
    .map(([key, item]) => [key, diagnosticMetadata(item)]));
}

export function diagnosticError(error) {
  const details = diagnosticMetadata(error?.details);
  const suffix = details && typeof details === "object" ? ` · 진단: ${JSON.stringify(details)}` : "";
  return `${error?.code || "WEB_EXTENSION_ERROR"}: ${error?.message || "The ChatGPT Web extension operation failed."}${suffix}`;
}

export function errorPayload(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "WEB_EXTENSION_ERROR",
    message: error?.message || "The ChatGPT Web extension operation failed.",
    details: error?.details ?? null,
  };
}

