import { canonicalJson } from "../domain/canonical-json.js";
import { redactForEvidence } from "../security/redaction.js";

export function persistWebDeliveryReceipt(service, runId, role, deliveryId, response) {
  const run = service.get(runId);
  const binding = run.conversationBindings.find(item => item.role === role);
  if (response.turnId !== deliveryId || binding.activeDeliveryId !== deliveryId
    || response.binding?.sessionId !== binding.sessionId || response.binding?.runId !== runId) {
    throw Object.assign(new Error("Reviewer response changed its reserved delivery owner."), { code: "DELIVERY_BINDING_MISMATCH" });
  }
  const responseRef = service.artifactStore.put(redactForEvidence(response.rawText ?? response.body ?? ""),
    { mimeType: "text/plain", redacted: true });
  const packetRef = service.artifactStore.put(canonicalJson(redactForEvidence(response.packet)),
    { mimeType: "application/json", redacted: true });
  const receipt = { deliveryId, sessionId: binding.sessionId, conversationUrl: response.binding.conversationUrl,
    role, responseRef, packetRef, state: "ACK_PENDING", validation: response.packet?.type === "INVALID_RESPONSE" ? "REJECTED_FORMAT" : "PARSED",
    at: new Date().toISOString() };
  const previous = (run.webDeliveryReceipts ?? []).find(item => item.deliveryId === deliveryId);
  if (previous) {
    if (previous.responseRef.sha256 !== responseRef.sha256 || previous.packetRef.sha256 !== packetRef.sha256
      || previous.sessionId !== receipt.sessionId || previous.conversationUrl !== receipt.conversationUrl) {
      throw Object.assign(new Error("A persisted delivery receipt has different response evidence."), { code: "DELIVERY_RECEIPT_MISMATCH" });
    }
    return previous;
  }
  // The adapter has checked identity/trace and parsed the response. Persist both
  // accepted and format-rejected packets before acknowledging their receipt.
  service.update(runId, { webDeliveryReceipts: [...(run.webDeliveryReceipts ?? []), receipt] });
  return receipt;
}

export function markWebDeliveryAcknowledged(service, runId, deliveryId) {
  const run = service.get(runId);
  return { webDeliveryReceipts: (run.webDeliveryReceipts ?? []).map(receipt =>
    receipt.deliveryId === deliveryId ? { ...receipt, state: "ACKNOWLEDGED" } : receipt) };
}
