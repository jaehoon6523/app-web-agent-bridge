import { createHash } from "node:crypto";
import { canonicalJson } from "../domain/canonical-json.js";
import { persistPreparation } from "./preparation-persistence.js";
import { parsePreparationResponse } from "./preparation-response-format.js";

const digest = text => createHash("sha256").update(text).digest("hex");
const fail = (code, message, details) => { throw Object.assign(new Error(message), {code, details}); };
const invalidFormats = new Set(["CONTROLLER_PACKET_MISSING", "CONTROLLER_PACKET_AMBIGUOUS",
  "INVALID_PACKET_JSON", "CONTROLLER_PACKET_TOO_DEEP", "INVALID_REQUIREMENTS_PROPOSAL"]);

export function invalidAbandonmentCandidate(context, delivery) {
  return context?.lifecycle === "ACTIVE" && context.state === "RECOVERY_REQUIRED"
    && context.agreement?.status !== "APPROVED" && delivery?.state === "RESPONSE_COMPLETED"
    && delivery.processingState == null && delivery.validation?.status === "CONFIRMED"
    && delivery.validation?.format === "INVALID" && invalidFormats.has(delivery.validation.formatError?.code)
    && typeof delivery.response?.rawText === "string" && delivery.response.rawText.trim() !== "";
}

export function isValidRequirementsProposal(packet) {
  return packet?.type === "REQUIREMENTS_PROPOSAL"
    && typeof packet.summary === "string"
    && Array.isArray(packet.questions)
    && packet.questions.every((question) => typeof question === "string" && question.trim())
    && Array.isArray(packet.items)
    && packet.items.length <= 30
    && (packet.items.length > 0 || packet.questions.length > 0)
    && packet.items.every((item) => (
      typeof item?.statement === "string" && item.statement.trim()
      && typeof item?.acceptanceCriteria === "string" && item.acceptanceCriteria.trim()
    ));
}

export async function abandonInvalidPreparation(service, input) {
  const type = "preparation.discard";
  const hash = canonicalJson({type, input}), previous = service.data.receipts[input.requestId];
  if (previous && previous.hash !== hash) fail("REQUEST_ID_CONFLICT", "Request ID belongs to another command.");
  if (previous?.status === "COMPLETED") return structuredClone(previous.result);
  const context = service.context(input), session = context.webSession;
  const delivery = context.deliveries.find(d => d.deliveryId === session.activeDeliveryId);
  const existing = delivery?.invalidAbandonmentIntent;
  if (existing ? existing.requestId !== input.requestId || previous?.status !== "PROCESSING" : Boolean(previous)) {
    fail("REQUEST_ID_CONFLICT", "Continue only the original abandonment request.");
  }
  if (!existing) service.checkVersion(context, input.expectedVersion);
  if (service.jobs.size !== 1 || !invalidAbandonmentCandidate(context, delivery)) {
    fail("INVALID_ABANDONMENT_UNAVAILABLE", "This preparation does not own an idle, invalid completed response.");
  }
  const owner = {sessionId:session.sessionId, runId:context.preparationId,
    conversationId:session.conversationId, conversationUrl:session.conversationUrl};
  if (input.deliveryId !== delivery.deliveryId || delivery.response.turnId !== delivery.deliveryId
    || delivery.sessionId !== owner.sessionId || delivery.conversationId !== owner.conversationId
    || Object.entries(owner).some(([key, value]) => !value || input[key] !== value || delivery.response.binding?.[key] !== value)) {
    fail("DELIVERY_RECOVERY_MISMATCH", "The stored response or request identifies a different delivery.");
  }
  if (input.abandonInvalidResponseConfirmed !== true || input.noAutomaticResendConfirmed !== true
    || input.pageStateUnconfirmedConfirmed !== true
    || typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.length > 500) {
    fail("ABANDONMENT_CONFIRMATION_REQUIRED", "Confirm abandonment, no resending and a reason.");
  }
  const raw = delivery.response.rawText;
  let formatError;
  try {
    if (!isValidRequirementsProposal(parsePreparationResponse(raw, delivery.responseFormat).parsed)) formatError = "INVALID_REQUIREMENTS_PROPOSAL";
  } catch (error) { formatError = error.code; }
  if (!formatError || formatError !== delivery.validation.formatError.code) {
    fail("INVALID_ABANDONMENT_UNAVAILABLE", "The current response does not match its recorded validation failure.");
  }
  const intent = { ...owner, currentDeliveryId:delivery.deliveryId, preparationId:context.preparationId,
    expectedVersion:input.expectedVersion, requestId:input.requestId, intentHash:digest(hash),
    responseBytes:Buffer.byteLength(raw), responseSha256:digest(raw), formatError:delivery.validation.formatError.code,
    abandonInvalidResponseConfirmed:true, noAutomaticResendConfirmed:true,
    pageStateUnconfirmedConfirmed:input.pageStateUnconfirmedConfirmed === true, reason:input.reason,
    recordedAt:existing?.recordedAt ?? new Date().toISOString() };
  if (existing && canonicalJson(existing) !== canonicalJson(intent)) fail("DELIVERY_RECOVERY_MISMATCH", "The response or abandonment intent changed.");
  const assertSafe = () => {
    if (Object.values(service.data.contexts).some(other => other !== context
      && (other.lifecycle === "ACTIVE" || other.webSession?.activeDeliveryId))) {
      fail("WEB_SESSION_BUSY", "Another preparation still owns work.");
    }
    if (!service.assertInvalidAbandonment) fail("ABANDONMENT_SAFETY_UNAVAILABLE", "Abandonment safety check is unavailable.");
    service.assertInvalidAbandonment();
  };
  const before = canonicalJson(context);
  assertSafe();
  const publish = async (draft, receipt, baseline, checkSafety = false) => {
    try {
      await persistPreparation(service.db, () => {
        if (service.current !== context || canonicalJson(context) !== baseline || service.jobs.size !== 1) {
          fail("PREPARATION_VERSION_CONFLICT", "Preparation changed during abandonment.");
        }
        if (checkSafety) assertSafe();
        return canonicalJson({...service.data, contexts:{...service.data.contexts,[context.preparationId]:draft},
          receipts:{...service.data.receipts,[input.requestId]:receipt}});
      }, () => {
        Object.assign(context, draft);
        service.data.receipts[input.requestId] = receipt;
      }, () => service.closed);
    } catch (error) {
      if (error instanceof AggregateError) {
        service.closed = true;
        fail("RECOVERY_PERSISTENCE_UNCERTAIN", "Abandonment persistence outcome is unknown.");
      }
      throw error;
    }
  };
  if (!existing) {
    const observed = await service.web.inspectDelivery();
    if (observed.invalidAbandonmentProtocol !== 1) fail("EXTENSION_UPDATE_REQUIRED", "The connected extension does not support invalid-response abandonment.");
    if (observed.currentDeliveryId !== delivery.deliveryId || observed.completedDelivery?.turnId !== delivery.deliveryId
      || observed.completedDelivery?.rawText !== raw || Object.entries(owner).some(([key,value]) => observed[key] !== value)) {
      fail("DELIVERY_RESPONSE_MISMATCH", "The extension does not hold the exact same completed response.");
    }
    if (observed.extensionBusy !== false || observed.pageBusy === true || observed.generating === true
      || observed.scopedDeliveries?.some(slot => slot.deliveryId)) fail("WEB_SESSION_BUSY", "A Web delivery is still active.");
    const draft = structuredClone(context);
    draft.deliveries.find(d => d.deliveryId === delivery.deliveryId).invalidAbandonmentIntent = intent;
    await publish(draft, {hash, status:"PROCESSING", error:null, result:null}, before, true);
  }
  const pending = canonicalJson(context);
  let remote;
  try {
    remote = await service.web.discardDelivery(intent, true);
  } catch (error) {
    const stage = error.details?.stage;
    const failure = ["DELIVERY_RECOVERY_MISMATCH","DELIVERY_RESPONSE_MISMATCH","DELIVERY_RESPONSE_REQUIRED","WEB_SESSION_BUSY",
      "ABANDONMENT_CONFIRMATION_REQUIRED","PAGE_STATE_CONFIRMATION_REQUIRED","INVALID_ABANDONMENT_EXTENSION_FAILED",
      "WEB_RESPONSE_TIMEOUT","EXTENSION_DISCONNECTED"].includes(error.code) ? error.code : "INVALID_ABANDONMENT_EXTENSION_FAILED";
    fail(failure, "The extension has not confirmed the abandonment. Continue the same request.", {
      stage:["OWNER_CHECK","RESPONSE_INTEGRITY","PAGE_CHECK","EXTENSION_PERSISTENCE"].includes(stage) ? stage : "EXTENSION_CONFIRMATION",
      requestId:input.requestId, deliveryId:input.deliveryId, intentPersisted:true,
    });
  }
  const keys = [...Object.keys(owner), "currentDeliveryId", "requestId", "intentHash", "responseSha256", "responseBytes"];
  if (keys.some(key => remote?.[key] !== intent[key]) || !Number.isFinite(Date.parse(remote?.abandonedAt))
    || typeof remote.pageReachable !== "boolean" || typeof remote.pageIdentityConfirmed !== "boolean"
    || remote.pageBusy === true || remote.generating === true
    || ((!remote.pageIdentityConfirmed || remote.pageBusy !== false || remote.generating !== false)
      && !intent.pageStateUnconfirmedConfirmed)) {
    fail("ABANDONMENT_RECEIPT_MISMATCH", "The extension did not confirm this exact abandonment.");
  }
  const draft = structuredClone(context), abandoned = draft.deliveries.find(d => d.deliveryId === delivery.deliveryId);
  const code = "INVALID_RESPONSE_TERMINALLY_ABANDONED";
  abandoned.state = code;
  abandoned.invalidAbandonmentReceipt = Object.fromEntries([...keys,"abandonedAt","pageReachable","pageIdentityConfirmed","pageBusy","generating"]
    .map(key => [key, remote[key] ?? null]));
  draft.webSession.activeDeliveryId = null;
  draft.lifecycle = "ABANDONED";
  draft.error = {code, message:"The invalid response was preserved and the preparation was abandoned."};
  draft.recovery = {kind:code, deliveryId:delivery.deliveryId, requestId:input.requestId, reason:intent.reason.trim(), at:remote.abandonedAt};
  draft.version++;
  draft.updatedAt = new Date().toISOString();
  const result = {preparationId:context.preparationId, deliveryId:delivery.deliveryId, lifecycle:draft.lifecycle, status:code, version:draft.version};
  await publish(draft, {hash,status:"COMPLETED",error:null,result}, pending);
  return result;
}
