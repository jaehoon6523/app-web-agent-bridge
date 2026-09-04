import { validateBlockedPacket } from "./agent-packets.js";
import { sha256CanonicalJson } from "./canonical-json.js";

export function deriveAgentBlockedDecisionIds(message) {
  if (typeof message?.messageId !== "string" || message.messageId.length === 0) {
    throw new TypeError("Agent BLOCKED decision identity requires messageId.");
  }
  const packet = validateBlockedPacket(message.normalizedPacket);
  const texts = packet.required_decisions.length > 0
    ? packet.required_decisions
    : [packet.description];
  return Object.freeze(texts.map((text, index) => (
    `decision_${sha256CanonicalJson({ messageId: message.messageId, index, text }).slice(7)}`
  )));
}
