import { sha256CanonicalJson, sha256Text } from "../domain/canonical-json.js";
import { validateAgentTurnInput } from "../domain/agent-messages.js";

export function discussionTurnEvidence({ turnInput, deliveryId, idempotencyKey }) {
  validateAgentTurnInput(turnInput);
  if (typeof deliveryId !== "string" || deliveryId.length === 0) {
    throw new TypeError("deliveryId must be a non-empty string.");
  }
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new TypeError("idempotencyKey must be a non-empty string.");
  }
  return Object.freeze({
    inputId: turnInput.inputId,
    inputHash: sha256CanonicalJson(turnInput),
    deliveryId,
    idempotencyKeyHash: sha256Text(idempotencyKey),
    targetActor: turnInput.targetActor,
    sourceMessageId: turnInput.sourceMessageId,
  });
}

export function discussionSubmissionEvidence({
  turnInput,
  deliveryId,
  sessionId,
  turnId,
  providerReceipt,
  attemptCount,
}) {
  validateAgentTurnInput(turnInput);
  for (const [name, value] of Object.entries({ deliveryId, sessionId, turnId })) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${name} must be a non-empty string.`);
    }
  }
  if (
    providerReceipt === null
    || typeof providerReceipt !== "object"
    || Array.isArray(providerReceipt)
  ) {
    throw new TypeError("providerReceipt must be a plain object.");
  }
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new TypeError("attemptCount must be a positive safe integer.");
  }
  return Object.freeze({
    deliveryId,
    inputId: turnInput.inputId,
    targetActor: turnInput.targetActor,
    sessionId,
    turnId,
    providerReceiptHash: sha256CanonicalJson(providerReceipt),
    attemptCount,
  });
}
