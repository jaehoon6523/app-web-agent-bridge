import {
  SHA256_DIGEST_PATTERN,
  buildAgentRun,
  validateAgentRun,
  validateRunBlocker,
} from "./contracts.js";
import {
  AgentBlockedReason,
  AgentActor,
  AgentTurnInputKind,
  RunBlockerType,
  RunOutcomeType,
  RunPhase,
  isVocabularyValue,
} from "./vocabulary.js";

const TERMINAL_PHASE_SET = new Set([
  RunPhase.COMPLETE,
  RunPhase.FAILED,
  RunPhase.CANCELLED,
]);

const SAFE_RESUME_PHASES = Object.freeze([
  RunPhase.STARTING_SESSIONS,
  RunPhase.CODEX_TURN_PENDING,
  RunPhase.CODEX_TO_WEB_PENDING,
  RunPhase.WEB_TO_CODEX_PENDING,
  RunPhase.CONSENSUS_CHECK,
]);

const TERMINAL_EXITS = Object.freeze([
  RunPhase.FAILED,
  RunPhase.CANCELLED,
]);

export const RUN_LIMIT_FIELDS = Object.freeze([
  "maxTurns",
  "maxProtocolRepairs",
  "maxDeliveryAttempts",
  "maxConsecutiveActorFailures",
]);

export const TERMINAL_RUN_PHASES = Object.freeze([...TERMINAL_PHASE_SET]);

export const ALLOWED_RUN_TRANSITIONS = Object.freeze({
  [RunPhase.CREATED]: Object.freeze([
    RunPhase.STARTING_SESSIONS,
    RunPhase.CANCELLED,
  ]),
  [RunPhase.STARTING_SESSIONS]: Object.freeze([
    RunPhase.CODEX_TURN_PENDING,
    RunPhase.HUMAN_GATE,
    RunPhase.RECOVERY_REQUIRED,
    RunPhase.FAILED,
    RunPhase.CANCELLED,
  ]),
  [RunPhase.CODEX_TURN_PENDING]: Object.freeze([
    RunPhase.CODEX_TURN_RUNNING,
    RunPhase.HUMAN_GATE,
    RunPhase.RECOVERY_REQUIRED,
    RunPhase.FAILED,
    RunPhase.CANCELLED,
  ]),
  [RunPhase.CODEX_TURN_RUNNING]: Object.freeze([
    RunPhase.CODEX_RESPONSE_STORED,
    RunPhase.RECOVERY_REQUIRED,
    RunPhase.FAILED,
    RunPhase.CANCELLED,
  ]),
  [RunPhase.CODEX_RESPONSE_STORED]: Object.freeze([
    RunPhase.CONSENSUS_CHECK,
    RunPhase.HUMAN_GATE,
    RunPhase.RECOVERY_REQUIRED,
    RunPhase.FAILED,
    RunPhase.CANCELLED,
  ]),
  [RunPhase.CODEX_TO_WEB_PENDING]: Object.freeze([
    RunPhase.WEB_TURN_RUNNING,
    RunPhase.HUMAN_GATE,
    RunPhase.RECOVERY_REQUIRED,
    RunPhase.FAILED,
    RunPhase.CANCELLED,
  ]),
  [RunPhase.WEB_TURN_RUNNING]: Object.freeze([
    RunPhase.WEB_RESPONSE_STORED,
    RunPhase.RECOVERY_REQUIRED,
    RunPhase.FAILED,
    RunPhase.CANCELLED,
  ]),
  [RunPhase.WEB_RESPONSE_STORED]: Object.freeze([
    RunPhase.CONSENSUS_CHECK,
    RunPhase.HUMAN_GATE,
    RunPhase.RECOVERY_REQUIRED,
    RunPhase.FAILED,
    RunPhase.CANCELLED,
  ]),
  [RunPhase.WEB_TO_CODEX_PENDING]: Object.freeze([
    RunPhase.CODEX_TURN_RUNNING,
    RunPhase.HUMAN_GATE,
    RunPhase.RECOVERY_REQUIRED,
    RunPhase.FAILED,
    RunPhase.CANCELLED,
  ]),
  [RunPhase.CONSENSUS_CHECK]: Object.freeze([
    RunPhase.CODEX_TO_WEB_PENDING,
    RunPhase.WEB_TO_CODEX_PENDING,
    RunPhase.COMPLETE,
    RunPhase.HUMAN_GATE,
    RunPhase.RECOVERY_REQUIRED,
    RunPhase.FAILED,
    RunPhase.CANCELLED,
  ]),
  [RunPhase.RECOVERY_REQUIRED]: Object.freeze([
    ...SAFE_RESUME_PHASES,
    RunPhase.HUMAN_GATE,
    ...TERMINAL_EXITS,
  ]),
  [RunPhase.HUMAN_GATE]: Object.freeze([
    ...SAFE_RESUME_PHASES,
    ...TERMINAL_EXITS,
  ]),
  [RunPhase.COMPLETE]: Object.freeze([]),
  [RunPhase.FAILED]: Object.freeze([]),
  [RunPhase.CANCELLED]: Object.freeze([]),
});

const RUNNING_ACTOR = Object.freeze({
  [RunPhase.CODEX_TURN_RUNNING]: AgentActor.CODEX_AGENT,
  [RunPhase.WEB_TURN_RUNNING]: AgentActor.CHATGPT_WEB_AGENT,
});

const RESPONSE_COMPLETION = Object.freeze({
  [RunPhase.CODEX_TURN_RUNNING]: RunPhase.CODEX_RESPONSE_STORED,
  [RunPhase.WEB_TURN_RUNNING]: RunPhase.WEB_RESPONSE_STORED,
});

const RESPONSE_SOURCE_ACTOR = Object.freeze({
  [RunPhase.CODEX_RESPONSE_STORED]: AgentActor.CODEX_AGENT,
  [RunPhase.WEB_RESPONSE_STORED]: AgentActor.CHATGPT_WEB_AGENT,
});

const PEER_PENDING_BY_SOURCE_ACTOR = Object.freeze({
  [AgentActor.CODEX_AGENT]: RunPhase.CODEX_TO_WEB_PENDING,
  [AgentActor.CHATGPT_WEB_AGENT]: RunPhase.WEB_TO_CODEX_PENDING,
});

const BOUNDARY_PHASES = new Set([
  RunPhase.CODEX_TURN_RUNNING,
  RunPhase.CODEX_TO_WEB_PENDING,
  RunPhase.WEB_TURN_RUNNING,
  RunPhase.WEB_TO_CODEX_PENDING,
]);

export class RunStateMachineError extends Error {
  constructor(message, code = "INVALID_RUN_STATE_TRANSITION") {
    super(message);
    this.name = "RunStateMachineError";
    this.code = code;
  }
}

function requirePlainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RunStateMachineError(`${name} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RunStateMachineError(`${name} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new RunStateMachineError(`${name} must not contain symbol properties.`);
  }
  return value;
}

function requireExactKeys(value, keys, name) {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new RunStateMachineError(`${name} contains unsupported property ${JSON.stringify(key)}.`);
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new RunStateMachineError(`${name} is missing required property ${JSON.stringify(key)}.`);
    }
  }
}

function requireSafeInteger(value, minimum, name) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RunStateMachineError(`${name} must be a safe integer >= ${minimum}.`);
  }
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RunStateMachineError(`${name} must be a non-empty string.`);
  }
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function immutableClone(value) {
  return deepFreeze(structuredClone(value));
}

function requireMutationInput(input, operation) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new RunStateMachineError(`${operation} input must be an object.`);
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new RunStateMachineError(
      `${operation} expectedVersion must be a positive safe integer.`,
      "INVALID_EXPECTED_VERSION",
    );
  }
  if (typeof input.updatedAt !== "string" || input.updatedAt.length === 0) {
    throw new RunStateMachineError(`${operation} updatedAt must be a non-empty string.`);
  }
  return input;
}

function assertExpectedVersion(state, expectedVersion) {
  if (state.version !== expectedVersion) {
    throw new RunStateMachineError(
      `Run version conflict: expected ${expectedVersion}, current ${state.version}.`,
      "RUN_VERSION_CONFLICT",
    );
  }
}

function requiredActorForPhase(phase) {
  return RUNNING_ACTOR[phase] ?? null;
}

function requireAgentActor(value, name) {
  if (!isVocabularyValue(AgentActor, value)) {
    throw new RunStateMachineError(`${name} must be an AgentActor.`);
  }
  return value;
}

function assertTurnMayStart(
  state,
  targetPhase,
  blocker = state.blocker,
  { allowPausedQueue = false, allowBlockedQueue = false } = {},
) {
  if (state.paused && !allowPausedQueue) {
    throw new RunStateMachineError(
      `Run is paused; transition to ${targetPhase} cannot start a delivery or turn.`,
      "RUN_PAUSED",
    );
  }
  if (blocker !== null && !allowBlockedQueue) {
    throw new RunStateMachineError(
      `Run has an unresolved blocker; transition to ${targetPhase} is refused.`,
      "RUN_BLOCKED",
    );
  }
  if (state.currentTurn >= state.maxTurns) {
    throw new RunStateMachineError(
      `Run has reached maxTurns (${state.maxTurns}); another delivery or turn is refused.`,
      "RUN_TURN_LIMIT_REACHED",
    );
  }
}

function validatePhaseInvariants(state) {
  const requiredActor = requiredActorForPhase(state.phase);
  if (state.activeActor !== requiredActor) {
    throw new RunStateMachineError(
      `activeActor must be ${requiredActor ?? "null"} while phase is ${state.phase}.`,
      "RUN_ACTOR_PHASE_MISMATCH",
    );
  }

  if (state.phase === RunPhase.HUMAN_GATE && state.blocker === null) {
    throw new RunStateMachineError(
      "HUMAN_GATE requires a valid blocker.",
      "RUN_BLOCKER_REQUIRED",
    );
  }

  if (
    state.phase === RunPhase.RECOVERY_REQUIRED
    && state.blocker?.type !== RunBlockerType.RECOVERY_CONFIRMATION
  ) {
    throw new RunStateMachineError(
      "RECOVERY_REQUIRED requires a RECOVERY_CONFIRMATION blocker.",
      "RUN_RECOVERY_BLOCKER_REQUIRED",
    );
  }

  if (TERMINAL_PHASE_SET.has(state.phase) && state.blocker !== null) {
    throw new RunStateMachineError(
      `${state.phase} must not retain a blocker.`,
      "TERMINAL_RUN_BLOCKER_PRESENT",
    );
  }
}

function buildNextState(state, changes) {
  const next = buildAgentRun({
    ...state,
    ...changes,
    version: state.version + 1,
  });
  validatePhaseInvariants(next);
  return next;
}

function requireStringArray(value, name) {
  if (!Array.isArray(value)) {
    throw new RunStateMachineError(`${name} must be an array of strings.`);
  }
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new RunStateMachineError(`${name}[${index}] must be a non-empty string.`);
    }
  });
  return value;
}

export function validateRunLimits(value) {
  const limits = requirePlainObject(value, "RunLimits");
  requireExactKeys(limits, RUN_LIMIT_FIELDS, "RunLimits");
  requireSafeInteger(limits.maxTurns, 1, "RunLimits.maxTurns");
  requireSafeInteger(limits.maxProtocolRepairs, 0, "RunLimits.maxProtocolRepairs");
  requireSafeInteger(limits.maxDeliveryAttempts, 1, "RunLimits.maxDeliveryAttempts");
  requireSafeInteger(
    limits.maxConsecutiveActorFailures,
    1,
    "RunLimits.maxConsecutiveActorFailures",
  );
  return limits;
}

export function createRunLimits(value) {
  validateRunLimits(value);
  return immutableClone(value);
}

export function validateRunOutcome(value) {
  const outcome = requirePlainObject(value, "RunOutcome");
  requireNonEmptyString(outcome.type, "RunOutcome.type");

  switch (outcome.type) {
    case RunOutcomeType.CONSENSUS:
      requireExactKeys(outcome, ["type", "proposalHash"], "RunOutcome");
      if (
        typeof outcome.proposalHash !== "string"
        || !SHA256_DIGEST_PATTERN.test(outcome.proposalHash)
      ) {
        throw new RunStateMachineError(
          "RunOutcome.proposalHash must be a sha256:<64 lowercase hex> digest.",
        );
      }
      break;
    case RunOutcomeType.INCONCLUSIVE:
      requireExactKeys(
        outcome,
        ["type", "reason", "unresolvedFindings"],
        "RunOutcome",
      );
      requireNonEmptyString(outcome.reason, "RunOutcome.reason");
      requireStringArray(outcome.unresolvedFindings, "RunOutcome.unresolvedFindings");
      break;
    case RunOutcomeType.BLOCKED:
      requireExactKeys(outcome, ["type", "gateReason"], "RunOutcome");
      if (!isVocabularyValue(AgentBlockedReason, outcome.gateReason)) {
        throw new RunStateMachineError(
          "RunOutcome.gateReason must be an AgentBlockedReason.",
        );
      }
      break;
    case RunOutcomeType.CANCELLED:
      requireExactKeys(outcome, ["type", "cancelledBy"], "RunOutcome");
      requireNonEmptyString(outcome.cancelledBy, "RunOutcome.cancelledBy");
      break;
    case RunOutcomeType.FAILED:
      requireExactKeys(outcome, ["type", "errorCode"], "RunOutcome");
      requireNonEmptyString(outcome.errorCode, "RunOutcome.errorCode");
      break;
    default:
      throw new RunStateMachineError(`Unknown RunOutcome type: ${String(outcome.type)}.`);
  }
  return outcome;
}

export function createRunOutcome(value) {
  validateRunOutcome(value);
  return immutableClone(value);
}

export function isTerminalRunPhase(phase) {
  return TERMINAL_PHASE_SET.has(phase);
}

export function canTransitionRunState(from, to) {
  if (!isVocabularyValue(RunPhase, from) || !isVocabularyValue(RunPhase, to)) return false;
  return ALLOWED_RUN_TRANSITIONS[from].includes(to);
}

export function assertRunState(state) {
  validateAgentRun(state);
  validatePhaseInvariants(state);
  return state;
}

export function createInitialRunState({
  runId,
  mode,
  objective,
  objectiveHash,
  policyHash,
  maxTurns,
  createdAt,
}) {
  const state = buildAgentRun({
    runId,
    mode,
    objective,
    objectiveHash,
    policyHash,
    phase: RunPhase.CREATED,
    activeActor: null,
    maxTurns,
    currentTurn: 0,
    paused: false,
    blocker: null,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
  validatePhaseInvariants(state);
  return state;
}

function transitionRunStateInternal(state, input, { allowPausedTurnStart = false } = {}) {
  assertRunState(state);
  const request = requireMutationInput(input, "transitionRunState");
  assertExpectedVersion(state, request.expectedVersion);

  if (!isVocabularyValue(RunPhase, request.to)) {
    throw new RunStateMachineError(
      `Unknown target run phase: ${String(request.to)}.`,
      "UNKNOWN_RUN_PHASE",
    );
  }
  if (!canTransitionRunState(state.phase, request.to)) {
    const terminal = isTerminalRunPhase(state.phase) ? " Terminal phases have no exits." : "";
    throw new RunStateMachineError(
      `Run phase transition ${state.phase} -> ${request.to} is not allowed.${terminal}`,
    );
  }

  const nextActor = requiredActorForPhase(request.to);
  if (Object.hasOwn(request, "activeActor") && request.activeActor !== nextActor) {
    throw new RunStateMachineError(
      `activeActor must be ${nextActor ?? "null"} for ${request.to}.`,
      "RUN_ACTOR_PHASE_MISMATCH",
    );
  }

  let nextBlocker = Object.hasOwn(request, "blocker") ? request.blocker : state.blocker;
  if (nextBlocker !== null) validateRunBlocker(nextBlocker);

  if (
    (state.phase === RunPhase.RECOVERY_REQUIRED || state.phase === RunPhase.HUMAN_GATE)
    && request.to !== RunPhase.HUMAN_GATE
    && request.to !== RunPhase.RECOVERY_REQUIRED
    && !TERMINAL_PHASE_SET.has(request.to)
    && nextBlocker !== null
  ) {
    throw new RunStateMachineError(
      `Transitioning out of ${state.phase} requires the blocker to be explicitly cleared.`,
      "RUN_BLOCKER_NOT_RESOLVED",
    );
  }

  if (TERMINAL_PHASE_SET.has(request.to)) {
    if (Object.hasOwn(request, "blocker") && request.blocker !== null) {
      throw new RunStateMachineError(
        `Terminal phase ${request.to} cannot retain a blocker.`,
        "TERMINAL_RUN_BLOCKER_PRESENT",
      );
    }
    nextBlocker = null;
  }

  if (BOUNDARY_PHASES.has(request.to)) {
    const queuesNextDelivery = request.to === RunPhase.CODEX_TO_WEB_PENDING
      || request.to === RunPhase.WEB_TO_CODEX_PENDING;
    assertTurnMayStart(state, request.to, nextBlocker, {
      allowPausedQueue: queuesNextDelivery
        || (allowPausedTurnStart && requiredActorForPhase(request.to) !== null),
      allowBlockedQueue: queuesNextDelivery,
    });
  }
  if (
    request.to === RunPhase.CODEX_TO_WEB_PENDING
    || request.to === RunPhase.WEB_TO_CODEX_PENDING
  ) {
    const sourceActor = requireAgentActor(request.sourceActor, "sourceActor");
    const expectedPendingPhase = PEER_PENDING_BY_SOURCE_ACTOR[sourceActor];
    if (request.to !== expectedPendingPhase) {
      throw new RunStateMachineError(
        `${sourceActor} response requires ${expectedPendingPhase}.`,
        "RUN_ACTOR_ALTERNATION_VIOLATION",
      );
    }
  }

  const completesResponse = RESPONSE_COMPLETION[state.phase] === request.to;
  const currentTurn = state.currentTurn + (completesResponse ? 1 : 0);
  if (currentTurn > state.maxTurns) {
    throw new RunStateMachineError(
      `Completing this response would exceed maxTurns (${state.maxTurns}).`,
      "RUN_TURN_LIMIT_REACHED",
    );
  }

  return buildNextState(state, {
    phase: request.to,
    activeActor: nextActor,
    currentTurn,
    blocker: nextBlocker,
    updatedAt: request.updatedAt,
  });
}

export function transitionRunState(state, input) {
  return transitionRunStateInternal(state, input);
}

function startProtocolRepairTurnInternal(
  state,
  input,
  { allowPausedTurnStart = false } = {},
) {
  assertRunState(state);
  const request = requireMutationInput(input, "startProtocolRepairTurn");
  requireExactKeys(
    request,
    ["actor", "kind", "expectedVersion", "updatedAt"],
    "startProtocolRepairTurn input",
  );
  assertExpectedVersion(state, request.expectedVersion);
  const actor = requireAgentActor(request.actor, "startProtocolRepairTurn actor");
  if (request.kind !== AgentTurnInputKind.PROTOCOL_REPAIR) {
    throw new RunStateMachineError(
      "startProtocolRepairTurn kind must be PROTOCOL_REPAIR.",
      "PROTOCOL_REPAIR_INTENT_REQUIRED",
    );
  }
  const responseActor = RESPONSE_SOURCE_ACTOR[state.phase];
  if (responseActor === undefined) {
    throw new RunStateMachineError(
      `A protocol repair cannot start from ${state.phase}.`,
      "PROTOCOL_REPAIR_PHASE_MISMATCH",
    );
  }
  if (actor !== responseActor) {
    throw new RunStateMachineError(
      `Protocol repair actor ${actor} does not match stored response actor ${responseActor}.`,
      "PROTOCOL_REPAIR_ACTOR_MISMATCH",
    );
  }
  const targetPhase = actor === AgentActor.CODEX_AGENT
    ? RunPhase.CODEX_TURN_RUNNING
    : RunPhase.WEB_TURN_RUNNING;
  assertTurnMayStart(state, targetPhase, state.blocker, {
    allowPausedQueue: allowPausedTurnStart,
  });
  return buildNextState(state, {
    phase: targetPhase,
    activeActor: actor,
    updatedAt: request.updatedAt,
  });
}

export function startProtocolRepairTurn(state, input) {
  return startProtocolRepairTurnInternal(state, input);
}

export function startClaimedAgentTurn(state, input) {
  assertRunState(state);
  const request = requireMutationInput(input, "startClaimedAgentTurn");
  requireExactKeys(
    request,
    ["actor", "kind", "expectedVersion", "updatedAt"],
    "startClaimedAgentTurn input",
  );
  const actor = requireAgentActor(request.actor, "startClaimedAgentTurn actor");
  if (request.kind === AgentTurnInputKind.PROTOCOL_REPAIR) {
    return startProtocolRepairTurnInternal(state, request, { allowPausedTurnStart: true });
  }
  if (
    request.kind !== AgentTurnInputKind.INITIAL_OBJECTIVE
    && request.kind !== AgentTurnInputKind.PEER_RELAY
  ) {
    throw new RunStateMachineError(
      "A claimed discussion turn must be INITIAL_OBJECTIVE, PEER_RELAY, or PROTOCOL_REPAIR.",
      "CLAIMED_TURN_INTENT_REQUIRED",
    );
  }
  return transitionRunStateInternal(state, {
    to: actor === AgentActor.CODEX_AGENT
      ? RunPhase.CODEX_TURN_RUNNING
      : RunPhase.WEB_TURN_RUNNING,
    expectedVersion: request.expectedVersion,
    updatedAt: request.updatedAt,
  }, { allowPausedTurnStart: true });
}

export function adoptRecoveredCompletedResponse(state, input) {
  assertRunState(state);
  const request = requireMutationInput(input, "adoptRecoveredCompletedResponse");
  requireExactKeys(
    request,
    ["actor", "operationId", "expectedVersion", "updatedAt"],
    "adoptRecoveredCompletedResponse input",
  );
  assertExpectedVersion(state, request.expectedVersion);
  const actor = requireAgentActor(request.actor, "adoptRecoveredCompletedResponse actor");
  if (
    state.phase !== RunPhase.RECOVERY_REQUIRED
    || state.blocker?.type !== RunBlockerType.RECOVERY_CONFIRMATION
  ) {
    throw new RunStateMachineError(
      "A completed response can only be adopted from RECOVERY_REQUIRED.",
      "RECOVERY_RESPONSE_PHASE_MISMATCH",
    );
  }
  requireNonEmptyString(request.operationId, "adoptRecoveredCompletedResponse operationId");
  if (request.operationId !== state.blocker.operationId) {
    throw new RunStateMachineError(
      "Recovery operationId does not match the active recovery blocker.",
      "RECOVERY_OPERATION_MISMATCH",
    );
  }
  if (state.currentTurn >= state.maxTurns) {
    throw new RunStateMachineError(
      `Completing this response would exceed maxTurns (${state.maxTurns}).`,
      "RUN_TURN_LIMIT_REACHED",
    );
  }
  const targetPhase = actor === AgentActor.CODEX_AGENT
    ? RunPhase.CODEX_RESPONSE_STORED
    : RunPhase.WEB_RESPONSE_STORED;
  return buildNextState(state, {
    phase: targetPhase,
    activeActor: null,
    currentTurn: state.currentTurn + 1,
    blocker: null,
    updatedAt: request.updatedAt,
  });
}

export function requestPause(state, input) {
  assertRunState(state);
  const request = requireMutationInput(input, "requestPause");
  assertExpectedVersion(state, request.expectedVersion);
  if (isTerminalRunPhase(state.phase)) {
    throw new RunStateMachineError("A terminal run cannot be paused.", "TERMINAL_RUN_MUTATION");
  }
  if (state.paused) return state;
  return buildNextState(state, {
    paused: true,
    updatedAt: request.updatedAt,
  });
}

export function resumeRun(state, input) {
  assertRunState(state);
  const request = requireMutationInput(input, "resumeRun");
  assertExpectedVersion(state, request.expectedVersion);
  if (isTerminalRunPhase(state.phase)) {
    throw new RunStateMachineError("A terminal run cannot be resumed.", "TERMINAL_RUN_MUTATION");
  }
  if (!state.paused) return state;
  return buildNextState(state, {
    paused: false,
    updatedAt: request.updatedAt,
  });
}

export function setRunBlocker(state, input) {
  assertRunState(state);
  const request = requireMutationInput(input, "setRunBlocker");
  assertExpectedVersion(state, request.expectedVersion);
  if (!Object.hasOwn(request, "blocker")) {
    throw new RunStateMachineError("setRunBlocker requires blocker (or null).", "RUN_BLOCKER_REQUIRED");
  }
  if (isTerminalRunPhase(state.phase)) {
    throw new RunStateMachineError(
      "A terminal run's blocker cannot be changed.",
      "TERMINAL_RUN_MUTATION",
    );
  }
  if (request.blocker !== null) validateRunBlocker(request.blocker);
  return buildNextState(state, {
    blocker: request.blocker,
    updatedAt: request.updatedAt,
  });
}

export function enforceTurnLimit(state, input) {
  assertRunState(state);
  const request = requireMutationInput(input, "enforceTurnLimit");
  assertExpectedVersion(state, request.expectedVersion);
  const unresolvedFindings = requireStringArray(
    request.unresolvedFindings,
    "unresolvedFindings",
  );

  if (state.currentTurn < state.maxTurns) {
    return Object.freeze({ state, outcome: null });
  }
  if (state.phase !== RunPhase.CONSENSUS_CHECK) {
    throw new RunStateMachineError(
      "The max-turn outcome can only be recorded from CONSENSUS_CHECK.",
      "TURN_LIMIT_COMPLETION_PHASE_MISMATCH",
    );
  }

  const completed = transitionRunState(state, {
    to: RunPhase.COMPLETE,
    blocker: null,
    expectedVersion: request.expectedVersion,
    updatedAt: request.updatedAt,
  });
  const outcome = createRunOutcome({
    type: RunOutcomeType.INCONCLUSIVE,
    reason: "MAX_TURNS_REACHED",
    unresolvedFindings,
  });
  return Object.freeze({ state: completed, outcome });
}

export { RunPhase };
