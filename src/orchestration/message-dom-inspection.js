import { randomUUID } from "node:crypto";

export function validateMessageDomRequest(input) {
  const tabId = typeof input?.tabId === "string" && /^\d+$/u.test(input.tabId) ? Number(input.tabId) : input?.tabId;
  if (!Number.isSafeInteger(tabId) || tabId < 0
    || ![input?.conversationUrl, input?.controllerMessageId, input?.runId].every(value => typeof value === "string")
    || !/^https:\/\/chatgpt\.com\/c\/[a-f0-9-]{36}$/u.test(input?.conversationUrl ?? "")
    || !/^delivery_[a-f0-9-]{36}$/u.test(input?.controllerMessageId ?? "")
    || !/^prep_[a-f0-9-]{36}$/u.test(input?.runId ?? "")) {
    throw Object.assign(new Error("Invalid message DOM inspection request."), { code:"INVALID_DOM_INSPECTION_REQUEST" });
  }
  return { tabId, conversationUrl:input.conversationUrl, controllerMessageId:input.controllerMessageId, runId:input.runId };
}

function projectObservation(result) {
  const token = value => typeof value === "string" && value.length <= 160 && /^[\w:.-]*$/u.test(value) ? value : null;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const selectors = ["[data-message-author-role]", "[data-chatgpt-search-unit-key]", "article[data-testid^='conversation-turn-']"];
  const contentSelectors = ["[data-markdown-text-tone='user-message']", "[data-markdown-text-style='assistant-message']",
    "[data-testid='collapsible-user-message-content']", "[data-message-content]", ".markdown"];
  const node = value => ({ tagName:token(value?.tagName), attributes:Object.fromEntries([
    "data-message-id", "data-testid", "data-message-content", "data-message-author-role",
    "data-chatgpt-search-unit-key", "data-chatgpt-search-message-ids", "id"].map(key => {
    const a = value?.attributes?.[key];
    return [key, { present:a?.present === true,
      value:key !== "data-message-content" || ["", "true", "false"].includes(a?.value) ? token(a?.value) : null, length:count(a?.length),
      kind:["ABSENT", "EMPTY", "TOKEN", "REDACTED_CONTENT"].includes(a?.kind) ? a.kind : null }];
  })) });
  const matches = result.matches.map(m => {
    const role = ["user", "assistant"].includes(m.role) ? m.role : null;
    const proof = m.roleProof;
    const headingLabels = role === "user" ? ["내가 한 말:", "You said:"] : ["ChatGPT 답변:", "ChatGPT said:"];
    const roleConfirmed = m.roleConfirmed === true && role !== null
      && proof?.source === "PAGE_ACCESSIBILITY_HEADING" && proof.tagName === "H4"
      && headingLabels.includes(proof.label) && proof.relation === "DIRECT_SIBLING_MESSAGE_BRANCH"
      && proof.headingCount === 1 && proof.messageBranchCount === 1
      && count(m.index) !== null && proof.messageIndex === m.index;
    return { index:count(m.index), role, roleConfirmed,
      roleProof:roleConfirmed ? { source:proof.source, tagName:"H4", label:proof.label,
        relation:proof.relation, headingCount:1, messageBranchCount:1, messageIndex:m.index } : null,
      controllerMatch:m.controllerMatch === true, runMatch:m.runMatch === true,
      controllerMarkerCount:count(m.controllerMarkerCount), runMarkerCount:count(m.runMarkerCount),
      exactMarkers:m.controllerMatch === true && m.runMatch === true && m.controllerMarkerCount === 1 && m.runMarkerCount === 1,
      node:node(m.node), container:node(m.container), content:{ ...node(m.content),
        selector:contentSelectors.includes(m.content?.selector) ? m.content.selector : null, fallback:m.content?.fallback === true } };
  });
  const scope = result.scope ?? {};
  const selector = selectors.includes(result.selector) ? result.selector : null;
  return { tabId:result.tabId, windowId:count(result.windowId), frameId:0, chromeDocumentId:token(result.chromeDocumentId),
    observedUrl:result.observedUrl, observedAt:typeof result.observedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(result.observedAt) ? result.observedAt : null,
    result:result.result === "FOUND" && scope.matchesTruncated === false && scope.matchedCount === 1 && matches.length === 1
      && matches[0].role === "user" && matches[0].roleConfirmed && matches[0].exactMarkers ? "FOUND" : "NOT_CONFIRMED",
    selector, selectorFallback:selector !== null && selector !== selectors[0],
    selectorsTried:selectors,
    scope:{ ...Object.fromEntries(["messageCount", "userCount", "assistantCount", "unknownCount", "firstIndex", "lastIndex", "matchedCount"]
      .map(key => [key, count(scope[key])])), coverage:"CURRENT_DOM_ONLY", historyComplete:false, matchesTruncated:scope.matchesTruncated !== false }, matches };
}

// No adapter/session initialization, receipt access, or diagnostic persistence.
/** @param {{timeoutMs?: number, requestId?: ReturnType<typeof randomUUID>, onDiagnostic?: (detail: {origin: string, stage: string|null, cause: string}) => void}} [options] */
export function collectMessageDomInspection(transport, input, options = {}) {
  const { timeoutMs = 10000, requestId = randomUUID(), onDiagnostic } = options;
  const payload = validateMessageDomRequest(input);
  if (!transport?.authenticated) throw Object.assign(new Error("Connect the extension first."), { code:"EXTENSION_NOT_AUTHENTICATED" });
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, value) => {
      clearTimeout(timer); transport.off("message", receive); transport.off("state", stateChanged);
      error ? reject(error) : resolve(value);
    };
    const receive = message => {
      if (message.type !== "extension.message-dom.inspected" || message.requestId !== requestId) return;
      const result = message.payload;
      if (result?.errorCode) {
        const detail = result.diagnostic;
        const causes = {
          tab_query:["TAB_LOOKUP_EXCEPTION"], tab_url:["URL_MISMATCH", "URL_ACCESS_EXCEPTION"], injection:["SCRIPT_EXECUTION_EXCEPTION"],
          page_url:["URL_MISMATCH"], tab_requery:["TAB_REQUERY_EXCEPTION", "URL_MISMATCH", "OBSERVATION_MISMATCH"]
        };
        if (typeof detail?.stage === "string" && Object.hasOwn(causes, detail.stage) && causes[detail.stage].includes(detail.cause))
          onDiagnostic?.({ origin:"extension", stage:detail.stage, cause:detail.cause });
        return finish(Object.assign(new Error("Message DOM inspection unavailable."),
        { code:["TAB_CHANGED", "INVALID_DOM_INSPECTION_REQUEST", "MESSAGE_DOM_INSPECTION_FAILED"].includes(result.errorCode) ? result.errorCode : "MESSAGE_DOM_INSPECTION_FAILED" }));
      }
      if (result?.tabId !== payload.tabId || result.observedUrl !== payload.conversationUrl || result.frameId !== 0
        || !["FOUND", "NOT_CONFIRMED"].includes(result.result) || !Array.isArray(result.matches) || result.matches.length > 20) {
        onDiagnostic?.({ origin:"server", stage:null, cause:"INVALID_OBSERVATION" });
        return finish(Object.assign(new Error("Invalid message DOM observation."), { code:"INVALID_DOM_OBSERVATION" }));
      }
      try { finish(null, projectObservation(result)); }
      catch { onDiagnostic?.({ origin:"server", stage:null, cause:"INVALID_OBSERVATION" }); finish(Object.assign(new Error("Invalid message DOM observation."), { code:"INVALID_DOM_OBSERVATION" })); }
    };
    const stateChanged = () => { if (!transport.authenticated) finish(Object.assign(new Error("Extension disconnected."), { code:"EXTENSION_DISCONNECTED" })); };
    timer = setTimeout(() => finish(Object.assign(new Error("Message DOM inspection timed out."), { code:"MESSAGE_DOM_INSPECTION_TIMEOUT" })), timeoutMs);
    transport.on("message", receive); transport.on("state", stateChanged);
    try { transport.send({ type:"controller.message-dom.inspect", requestId, payload }); }
    catch (error) { onDiagnostic?.({ origin:"server", stage:null, cause:"TRANSPORT_SEND_EXCEPTION" }); finish(error); }
  });
}

export async function handleMessageDomInspection(transport, req, res) {
  const requestId = randomUUID();
  res.set("Cache-Control", "no-store");
  res.set("X-Inspection-Request-Id", requestId);
  let detail;
  try { res.json(await collectMessageDomInspection(transport, req.query, { requestId, onDiagnostic:d => { detail = d; } })); }
  catch (error) {
    const code = error.code ?? "MESSAGE_DOM_INSPECTION_FAILED";
    const safeCodes = ["TAB_CHANGED", "INVALID_DOM_INSPECTION_REQUEST", "MESSAGE_DOM_INSPECTION_FAILED",
      "EXTENSION_NOT_AUTHENTICATED", "INVALID_DOM_OBSERVATION", "EXTENSION_DISCONNECTED", "MESSAGE_DOM_INSPECTION_TIMEOUT"];
    try {
      const tabId = /^\d+$/u.test(req.query.tabId) ? Number(req.query.tabId) : null;
      console.warn(JSON.stringify({ layer:"server", requestId, tabId:Number.isSafeInteger(tabId) ? tabId : null,
        at:new Date().toISOString(), code:safeCodes.includes(code) ? code : "UNCLASSIFIED",
        ...(detail ?? (code === "MESSAGE_DOM_INSPECTION_TIMEOUT"
          ? { origin:"server", stage:"response_wait", cause:"TIMEOUT" }
          : ["INVALID_DOM_INSPECTION_REQUEST", "EXTENSION_NOT_AUTHENTICATED", "EXTENSION_DISCONNECTED"].includes(code)
            ? { origin:"server", stage:null, cause:code } : { origin:"unknown", stage:null, cause:"UNCLASSIFIED" })) }));
    } catch { /* Preserve the existing HTTP result. */ }
    res.status(error.code === "INVALID_DOM_INSPECTION_REQUEST" ? 400 : 503).json({ code });
  }
}
