import { validateRunLimits } from "../domain/run-state-machine.js";
import { RunLimitExceededError } from "../persistence/run-limits.js";

export const DeliveryRetryEvidence = Object.freeze({
  PRE_SUBMISSION_CONNECTION_FAILURE: "PRE_SUBMISSION_CONNECTION_FAILURE",
  PROVIDER_CONFIRMED_NOT_RECEIVED: "PROVIDER_CONFIRMED_NOT_RECEIVED",
  EXTENSION_SEND_NOT_EXECUTED: "EXTENSION_SEND_NOT_EXECUTED",
  EXPLICIT_RETRY_SAFE_FAILURE: "EXPLICIT_RETRY_SAFE_FAILURE",
});

export const ActorFailureDecision = Object.freeze({
  CONTINUE: "CONTINUE",
  STOP: "STOP",
});

const RETRY_SAFE_EVIDENCE = new Set(Object.values(DeliveryRetryEvidence));

function requireCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function assertNextAllowed(limits, currentCount, limitName, countName) {
  validateRunLimits(limits);
  requireCount(currentCount, countName);
  const maximum = limits[limitName];
  if (currentCount >= maximum) {
    throw new RunLimitExceededError(limitName, maximum);
  }
  return currentCount + 1;
}

export function nextTurnNumber(limits, currentTurn) {
  return assertNextAllowed(limits, currentTurn, "maxTurns", "currentTurn");
}

export function nextProtocolRepairCount(limits, currentProtocolRepairs) {
  return assertNextAllowed(
    limits,
    currentProtocolRepairs,
    "maxProtocolRepairs",
    "currentProtocolRepairs",
  );
}

export function nextDeliveryAttemptCount(limits, currentDeliveryAttempts) {
  return assertNextAllowed(
    limits,
    currentDeliveryAttempts,
    "maxDeliveryAttempts",
    "currentDeliveryAttempts",
  );
}

export function nextConsecutiveActorFailureCount(limits, currentConsecutiveActorFailures) {
  return assertNextAllowed(
    limits,
    currentConsecutiveActorFailures,
    "maxConsecutiveActorFailures",
    "currentConsecutiveActorFailures",
  );
}

export function observeProviderTurn(limits, currentProviderTurnsUsed, {
  submitted,
  terminal,
}) {
  validateRunLimits(limits);
  requireCount(currentProviderTurnsUsed, "currentProviderTurnsUsed");
  if (typeof submitted !== "boolean" || typeof terminal !== "boolean") {
    throw new TypeError("submitted and terminal must be booleans");
  }
  if (terminal && !submitted) {
    throw new TypeError("a provider turn cannot be terminal before it was submitted");
  }
  if (!terminal) return currentProviderTurnsUsed;
  return assertNextAllowed(
    limits,
    currentProviderTurnsUsed,
    "maxTurns",
    "currentProviderTurnsUsed",
  );
}

export function canAutomaticallyRetryDelivery(limits, {
  state,
  attemptCount,
  retryEvidence,
}) {
  validateRunLimits(limits);
  requireCount(attemptCount, "attemptCount");
  if (attemptCount < 1) {
    throw new TypeError("attemptCount must include the initial attempt and be at least 1");
  }
  if (typeof state !== "string" || state.length === 0) {
    throw new TypeError("state must be a non-empty string");
  }
  if (!RETRY_SAFE_EVIDENCE.has(retryEvidence)) {
    throw new TypeError("retryEvidence must be explicit retry-safe evidence");
  }
  return state === "FAILED" && attemptCount < limits.maxDeliveryAttempts;
}

export function actorFailureBudgetAfterFailure(limits, currentConsecutiveActorFailures) {
  const count = nextConsecutiveActorFailureCount(limits, currentConsecutiveActorFailures);
  return Object.freeze({
    count,
    decision: count >= limits.maxConsecutiveActorFailures
      ? ActorFailureDecision.STOP
      : ActorFailureDecision.CONTINUE,
  });
}

export function resetActorFailureBudgetAfterStrictPacket() {
  return 0;
}
