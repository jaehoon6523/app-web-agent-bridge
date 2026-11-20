import { ExtensionStateError } from "./storage.js";
import { readDeliveryPage } from "./delivery-page.js";

export async function abandonInvalidDelivery({ store, turnGate, tabs, message, send, onChange }) {
  const intent = message.payload;
  let held, stage = "OWNER_CHECK";
  const fail = (code, text) => { throw new ExtensionStateError(code, text); };
  try {
    held = turnGate.reserve(message.requestId);
    if (!intent || !/^delivery_[a-f0-9-]{36}$/u.test(intent.currentDeliveryId)
      || typeof intent.requestId !== "string" || !intent.requestId.trim()
      || intent.runId !== intent.preparationId || !intent.runId?.startsWith("prep_")
      || !Number.isSafeInteger(intent.expectedVersion) || !/^[a-f0-9]{64}$/u.test(intent.intentHash)
      || intent.abandonInvalidResponseConfirmed !== true
      || intent.noAutomaticResendConfirmed !== true || typeof intent.reason !== "string" || intent.reason.trim().length < 3) {
      fail("ABANDONMENT_CONFIRMATION_REQUIRED", "Confirm the exact invalid response and its abandonment.");
    }
    const state = await store.read(), archives = state.invalidDeliveryArchives;
    const previous = archives[intent.currentDeliveryId];
    const respond = receipt => send({type:"web.delivery.invalid-abandoned", requestId:message.requestId, payload:receipt});
    if (Object.values(state.deliveryScopes).some(slot => slot.currentDeliveryId) || (previous && state.currentDeliveryId !== null)) {
      fail("WEB_SESSION_BUSY", "Another delivery still owns a session.");
    }
    if (previous) {
      if (["currentDeliveryId","sessionId","runId","conversationId","conversationUrl","requestId","intentHash","responseSha256","responseBytes"]
        .some(key => previous.receipt[key] !== intent[key])) fail("DELIVERY_RECOVERY_MISMATCH", "A different abandonment was recorded.");
      return respond(previous.receipt);
    }
    const owner = {currentDeliveryId:state.currentDeliveryId, sessionId:state.lastBoundSessionId,
      runId:state.lastBoundRunId, conversationId:state.conversationId, conversationUrl:state.conversationUrl};
    const completed = state.completedDelivery;
    if (Object.entries(owner).some(([key,value]) => !value || intent[key] !== value)
      || completed?.turnId !== intent.currentDeliveryId
      || ["sessionId","runId","conversationId","conversationUrl"].some(key => completed.binding?.[key] !== owner[key])) {
      fail("DELIVERY_RECOVERY_MISMATCH", "The stored completed response belongs to a different delivery.");
    }
    stage = "RESPONSE_INTEGRITY";
    const raw = completed.rawText;
    if (typeof raw !== "string") fail("DELIVERY_RESPONSE_REQUIRED", "The original response is unavailable.");
    const bytes = new TextEncoder().encode(raw);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2,"0")).join("");
    if (intent.responseSha256 !== digest || intent.responseBytes !== bytes.length) {
      fail("DELIVERY_RESPONSE_MISMATCH", "Server and extension response bytes differ.");
    }
    stage = "PAGE_CHECK";
    const page = await readDeliveryPage(tabs, state.tabId);
    const pageIdentityConfirmed = page?.ok === true && page.url === state.conversationUrl
      && typeof state.documentId === "string" && page.documentId === state.documentId && page.frameId === state.frameId;
    if (page?.busy === true || page?.generating === true) fail("WEB_SESSION_BUSY", "The page is still processing a response.");
    if ((!pageIdentityConfirmed || page.busy !== false || page.generating !== false) && intent.pageStateUnconfirmedConfirmed !== true) {
      fail("PAGE_STATE_CONFIRMATION_REQUIRED", "Confirm that the original page state could not be verified.");
    }
    const receipt = {...owner, requestId:intent.requestId, intentHash:intent.intentHash, responseSha256:digest,
      responseBytes:bytes.length, pageReachable:page?.ok === true, pageIdentityConfirmed,
      pageBusy:page?.busy ?? null, generating:page?.generating ?? null, abandonedAt:new Date().toISOString()};
    stage = "EXTENSION_PERSISTENCE";
    await store.updateIf({currentDeliveryId:state.currentDeliveryId, lastBoundSessionId:state.lastBoundSessionId,
      lastBoundRunId:state.lastBoundRunId, conversationId:state.conversationId, conversationUrl:state.conversationUrl,
      tabId:state.tabId, documentId:state.documentId, frameId:state.frameId, completedDelivery:completed,
      deliveryScopes:state.deliveryScopes, invalidDeliveryArchives:archives},
    {invalidDeliveryArchives:{...archives,[intent.currentDeliveryId]:{receipt, response:completed}},
      currentDeliveryId:null, completedDelivery:null, bindingStatus:"NEEDS_REBIND"});
    respond(receipt);
  } catch (error) {
    const known = error instanceof ExtensionStateError;
    send({type:"web.session.error", requestId:message.requestId, payload:{
      code:known ? error.code : "INVALID_ABANDONMENT_EXTENSION_FAILED",
      message:known ? error.message : "The extension could not record the abandonment.",
      details:{stage, requestId:intent?.requestId, deliveryId:intent?.currentDeliveryId}}});
  } finally {
    if (held) turnGate.release(held);
    onChange();
  }
}
