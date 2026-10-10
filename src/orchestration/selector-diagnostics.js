import { randomUUID } from "node:crypto";
import { diagnosticId } from "../diagnostics/diagnostic-schema.js";
import { projectDiagnostics } from "./preparation-diagnostics.js";

const identifier = value => typeof value === "string" && /^(?:delivery_)?[a-f0-9-]{36}$/u.test(value) ? value : null;
const conversation = value => typeof value === "string" && /^https:\/\/chatgpt\.com\/(?:c\/[a-f0-9-]{36})?$/u.test(value) ? value : null;
function receipt(value) {return value ? {deliveryId:identifier(value.deliveryId),sessionId:diagnosticId(value.sessionId),
  runId:diagnosticId(value.runId),conversationUrl:conversation(value.conversationUrl)} : null;}
function deliveryObservation(value) {
  if (!value || typeof value !== "object") return null;
  return {currentDeliveryId:identifier(value.currentDeliveryId),sessionId:diagnosticId(value.sessionId),runId:diagnosticId(value.runId),
    conversationUrl:conversation(value.conversationUrl),documentId:diagnosticId(value.documentId),frameId:value.frameId === 0 ? 0 : null,
    lastAcknowledgedDelivery:receipt(value.lastAcknowledgedDelivery),lastDeliveryDiscard:receipt(value.lastDeliveryDiscard),
    scopedDeliveries:(Array.isArray(value.scopedDeliveries) ? value.scopedDeliveries : []).slice(0,8).map(slot =>
      ({sessionId:diagnosticId(slot?.sessionId),currentDeliveryId:identifier(slot?.currentDeliveryId),runId:diagnosticId(slot?.runId),
        tabId:Number.isSafeInteger(slot?.tabId) && slot.tabId >= 0 ? slot.tabId : null})),
    tabId:Number.isSafeInteger(value.tabId) && value.tabId >= 0 ? value.tabId : null,
    bindingStatus:["BOUND", "AMBIGUOUS", "NEEDS_REBIND", "UNBOUND"].includes(value.bindingStatus) ? value.bindingStatus : null,
    responseObserved:typeof value.responseObserved === "boolean" ? value.responseObserved : null,
    acknowledgedDeliveryId:identifier(value.acknowledgedDeliveryId)};
}
const pending = new WeakMap();
const cancellations = new WeakMap();
export function cancelSelectorDiagnostics(transport) { cancellations.get(transport)?.(); }
// A shared, bounded read. Inspection never prepares, injects or sends a prompt.
export function collectSelectorDiagnostics(transport, { timeoutMs = 10000 } = {}) {
  if (!transport?.authenticated) return Promise.reject(Object.assign(new Error("Connect the extension first."), { code:"EXTENSION_NOT_AUTHENTICATED" }));
  if (pending.has(transport)) return pending.get(transport);
  const requestId = randomUUID();
  const result = new Promise((resolve, reject) => {
    let timer, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; cancellations.delete(transport);
      clearTimeout(timer); transport.off("message", receive);
      error ? reject(error) : resolve(value);
    };
    const receive = message => {
      if (message.type !== "extension.diagnostics.inspected" || message.requestId !== requestId) return;
      const tabs = message.payload?.tabs;
      if (!Array.isArray(tabs)) return finish(Object.assign(new Error("Tab inspection failed."), {code:"TAB_INSPECTION_FAILED"}));
      finish(null, { inspectedAt:new Date().toISOString(), tabs:tabs.slice(0, 8).map(projectDiagnostics), delivery:deliveryObservation(message.payload?.delivery) });
    };
    timer = setTimeout(() => finish(Object.assign(new Error("Tab inspection timed out."), { code:"TAB_INSPECTION_TIMEOUT" })), timeoutMs);
    cancellations.set(transport, () => finish(Object.assign(new Error("Inspection cancelled."), {code:"TAB_INSPECTION_CANCELLED"})));
    transport.on("message", receive);
    try { transport.send({ type:"controller.diagnostics.inspect", requestId }); }
    catch (error) { finish(error); }
  });
  pending.set(transport, result);
  result.finally(() => pending.delete(transport)).catch(() => {});
  return result;
}
