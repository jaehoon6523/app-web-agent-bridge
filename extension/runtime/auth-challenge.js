export function validControllerChallenge(message, protocolVersion, handledChallengeIds, now = Date.now()) {
  return message.protocolVersion === protocolVersion
    && typeof message.challengeId === "string"
    && typeof message.nonce === "string"
    && /^[0-9a-f]{64}$/.test(message.nonce)
    && !handledChallengeIds.has(message.challengeId)
    && (typeof message.expiresAt !== "string" || Date.parse(message.expiresAt) >= now);
}
