import { diagnosticMetadata } from "./document-binding.js";

function receiverFailure(error) {
  const message = String(error?.message ?? "");
  if (/No tab with id/iu.test(message)) return "TAB_NOT_FOUND";
  if (/Receiving end does not exist/iu.test(message)) return "RECEIVER_MISSING";
  if (/message port closed|channel closed/iu.test(message)) return "PORT_CLOSED";
  if (/context invalidated/iu.test(message)) return "CONTEXT_INVALIDATED";
  if (/cannot access|missing host permission|permission denied/iu.test(message)) return "PERMISSION_DENIED";
  return "MESSAGE_FAILED";
}

async function probePage(tabs, tabId, includeDiagnostics, timeoutMs) {
  if (!Number.isSafeInteger(tabId)) return { page:null, transport:{ status:"TAB_ID_UNAVAILABLE" } };
  let timer;
  try {
    const reply = Promise.resolve().then(() => tabs.sendMessage(tabId,
      { type:"agent.ping", ...(includeDiagnostics ? { includeDiagnostics:true } : {}) }, { frameId:0 }))
      .then(page => ({ page:page ?? null, transport:{ status:page?.ok === true ? "RESPONDED" : "INVALID_RESPONSE" } }));
    return await Promise.race([reply,
      new Promise(resolve => { timer = setTimeout(() => resolve({ page:null,
        transport:{ status:"MESSAGE_TIMEOUT" } }), timeoutMs); })]);
  } catch (error) {
    // Never echo Chrome's raw error: it can contain URLs or arbitrary content.
    return { page:null, transport:{ status:receiverFailure(error) } };
  }
  finally { clearTimeout(timer); }
}

export async function readDeliveryPage(tabs, tabId) {
  return (await probePage(tabs, tabId, false, 2000)).page;
}

// This read-only route distinguishes tab lookup from content-message failure.
export async function inspectDeliveryPage(tabs, tabId, { timeoutMs = 2000 } = {}) {
  if (!Number.isSafeInteger(tabId)) return probePage(tabs, tabId, true, timeoutMs);
  let tab = null, tabStatus = "NOT_INSPECTED", timer;
  if (typeof tabs.get === "function") {
    try {
      tab = await Promise.race([Promise.resolve().then(() => tabs.get(tabId)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Tab lookup timeout"),
          { code:"TAB_LOOKUP_TIMEOUT" })), timeoutMs); })]);
      tabStatus = tab ? "FOUND" : "TAB_NOT_FOUND";
    } catch (error) {
      tabStatus = error?.code === "TAB_LOOKUP_TIMEOUT" ? error.code
        : /No tab with id/iu.test(String(error?.message ?? "")) ? "TAB_NOT_FOUND" : "TAB_LOOKUP_FAILED";
    } finally { clearTimeout(timer); }
    if (tabStatus === "TAB_NOT_FOUND") return { page:null, tab:null, transport:{ status:tabStatus, tabStatus } };
  }
  const result = await probePage(tabs, tabId, true, timeoutMs);
  return { ...result, tab, transport:{ ...result.transport, tabStatus, loadingStatus:tab?.status ?? null } };
}

// Allowlisted metadata only: never forward ping titles, values, HTML, or bodies.
export function pageDiagnosticMetadata(page) {
  const fields = (source, keys) => Object.fromEntries(keys.filter(key => source?.[key] !== undefined)
    .map(key => [key, source[key]]));
  const counts = items => Array.isArray(items) ? items.map(item => ({ ...fields(item, ["selector", "matched", "visible"]),
    ...(Array.isArray(item.samples) ? { samples:item.samples.map(sample => fields(sample,
      ["tagName", "display", "visibility", "width", "height", "acceptedByVisibility", "connected", "disabled", "readOnly", "editable",
        "role", "contentEditable", "inForm", "inMain", "fallbackReason", "excludedAncestor", "controls", "ancestors"])) } : {}) })) : [];
  return diagnosticMetadata({ pageState:page?.pageState ? fields(page.pageState,
    ["readyState", "visibilityState", "hasFocus", "authenticationSignal"]) : null,
  diagnostics:page?.diagnostics ? { selectorVersion:page.diagnostics.selectorVersion ?? null,
    composerSelectors:counts(page.diagnostics.composerSelectors), editableCandidates:counts(page.diagnostics.editableCandidates),
    composerFallback:page.diagnostics.composerFallback ? fields(page.diagnostics.composerFallback,
      ["selector", "eligible", "selected"]) : null } : null,
  inspectionError:page?.inspectionError ? fields(page.inspectionError, ["code", "message"]) : null });
}
