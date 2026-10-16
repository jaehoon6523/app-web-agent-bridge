import { canonicalJson } from "../domain/canonical-json.js";
import { parseFinalControllerPacketJsonEnvelope } from "../domain/controller-packet-envelope.js";
import { redactForEvidence } from "../security/redaction.js";

function assertUniquePacketKeys(packetText) {
  const scopes = [];
  // The envelope parser already validated JSON grammar. Inspect member tokens
  // before JSON.parse's last-key-wins result can hide earlier evidence values.
  for (const match of packetText.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/gu)) {
    const token = match[0];
    if (token === "{") { scopes.push(new Set()); continue; }
    if (token === "[") { scopes.push(null); continue; }
    if (token === "}" || token === "]") { scopes.pop(); continue; }
    const members = scopes.at(-1);
    if (!members || !/^\s*:/u.test(packetText.slice(match.index + token.length))) continue;
    // Reuse the envelope's bounded Windows-escape compatibility for unusual keys.
    let key;
    try { key = JSON.parse(token); }
    catch { key = parseFinalControllerPacketJsonEnvelope(`CONTROLLER_PACKET_BEGIN\n${token}\nCONTROLLER_PACKET_END`).parsed; }
    if (members.has(key)) {
      // Never copy an untrusted member name or value into persisted error text.
      throw Object.assign(new Error("Controller packet contains duplicate JSON member names; response evidence was not stored."),
        { code:"DUPLICATE_CONTROLLER_PACKET_KEY" });
    }
    members.add(key);
  }
}

export function redactControllerResponseText(rawText) {
  let parsed;
  try { parsed = parseFinalControllerPacketJsonEnvelope(rawText); }
  catch {
    // Invalid wire bytes belong only in private storage, never in an export.
    return "[Unparseable controller response omitted from public evidence.]";
  }
  assertUniquePacketKeys(parsed.packetText);
  // Redact values before serialization so assignment patterns cannot consume JSON punctuation.
  const body = redactForEvidence(parsed.body), packet = redactForEvidence(parsed.parsed);
  if (body === parsed.body && canonicalJson(packet) === canonicalJson(parsed.parsed)) {
    // Preserve unchanged and previously redacted evidence byte-for-byte across restarts.
    return rawText;
  }
  return `${body}${body ? "\n" : ""}CONTROLLER_PACKET_BEGIN\n${canonicalJson(packet)}\nCONTROLLER_PACKET_END`;
}

export function publicResponsePacket(packet) {
  return packet?.type === "INVALID_RESPONSE"
    ? {type:"INVALID_RESPONSE", error:"Controller response could not be parsed."}
    : redactForEvidence(packet);
}

export function publicResponseBody(response) {
  return response.packet?.type === "INVALID_RESPONSE"
    ? "[Unparseable controller response omitted from public evidence.]"
    : redactForEvidence(response.body ?? "");
}

export function privateResponseRecord(runId, role, deliveryId, sessionId, response) {
  return {version:1, runId, role, deliveryId, sessionId,
    rawText:response.rawText ?? null, body:response.body ?? "", packetText:response.packetText ?? "",
    packet:response.packet ?? null};
}

export function persistWebDeliveryReceipt(service, runId, role, deliveryId, response) {
  const run = service.get(runId);
  const binding = run.conversationBindings.find(item => item.role === role);
  if (response.turnId !== deliveryId || binding.activeDeliveryId !== deliveryId
    || response.binding?.sessionId !== binding.sessionId || response.binding?.runId !== runId) {
    throw Object.assign(new Error("Reviewer response changed its reserved delivery owner."), { code: "DELIVERY_BINDING_MISMATCH" });
  }
  const publicText = redactControllerResponseText(response.rawText ?? response.body ?? "");
  const privateResponseRef = service.artifactStore.putPrivateResponse(
    privateResponseRecord(runId, role, deliveryId, binding.sessionId, response));
  const responseRef = service.artifactStore.put(publicText,
    { mimeType: "text/plain", redacted: true });
  const packetRef = service.artifactStore.put(canonicalJson(publicResponsePacket(response.packet)),
    { mimeType: "application/json", redacted: true });
  const receipt = { deliveryId, sessionId: binding.sessionId, conversationUrl: response.binding.conversationUrl,
    role, responseRef, packetRef, privateResponseRef, state: "ACK_PENDING", validation: response.packet?.type === "INVALID_RESPONSE" ? "REJECTED_FORMAT" : "PARSED",
    at: new Date().toISOString() };
  const previous = (run.webDeliveryReceipts ?? []).find(item => item.deliveryId === deliveryId);
  if (previous) {
    if (previous.responseRef.sha256 !== responseRef.sha256 || previous.packetRef.sha256 !== packetRef.sha256
      || previous.sessionId !== receipt.sessionId || previous.conversationUrl !== receipt.conversationUrl) {
      throw Object.assign(new Error("A persisted delivery receipt has different response evidence."), { code: "DELIVERY_RECEIPT_MISMATCH" });
    }
    if (previous.privateResponseRef && canonicalJson(previous.privateResponseRef) !== canonicalJson(privateResponseRef)) {
      throw Object.assign(new Error("A delivery has conflicting private response evidence."), {code:"DELIVERY_RECEIPT_MISMATCH"});
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
