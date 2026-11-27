import { assertPacketJsonDepth, ControllerPacketEnvelopeError,
  parseFinalControllerPacketJsonEnvelope } from "../domain/controller-packet-envelope.js";
import { hasControllerPacketMarker } from "./preparation-plain-text.js";

export const PREPARATION_JSON_OBJECT = "JSON_OBJECT_V1";

export function parsePreparationResponse(rawText, responseFormat) {
  if (responseFormat === undefined) return parseFinalControllerPacketJsonEnvelope(rawText);
  if (responseFormat !== PREPARATION_JSON_OBJECT) {
    throw new ControllerPacketEnvelopeError("Unsupported preparation response format.", "INVALID_PACKET_JSON");
  }
  if (typeof rawText !== "string" || rawText.trim() === "") {
    throw new ControllerPacketEnvelopeError("Agent response must be a non-empty string.", "EMPTY_AGENT_RESPONSE");
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // Only ordinary prose is eligible for the explicit plain-text discussion option.
    const prose = /^\p{L}.*(?:\s|[.!?。])[\s\S]*$/u.test(rawText.trim())
      && !/[\[\]{}:"\x60]|~{3}/u.test(rawText)
      && !hasControllerPacketMarker(rawText)
      && !/^\s*(?:true|false|null)\b/u.test(rawText);
    throw new ControllerPacketEnvelopeError("Preparation response must contain exactly one JSON object.",
      prose ? "CONTROLLER_PACKET_MISSING" : "INVALID_PACKET_JSON");
  }
  assertPacketJsonDepth(parsed, 20);
  return { parsed, packetText: rawText.trim() };
}
