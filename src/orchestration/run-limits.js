import { validateRunLimits } from "../domain/run-state-machine.js";
import { RunLimitExceededError } from "../persistence/run-limits.js";

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

