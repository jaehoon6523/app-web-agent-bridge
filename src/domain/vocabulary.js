/**
 * @template {string} T
 * @param {readonly T[]} values
 * @returns {{readonly [K in T]: K}}
 */
function enumObject(values) {
  return /** @type {{readonly [K in T]: K}} */ (
    Object.freeze(Object.fromEntries(values.map((value) => [value, value])))
  );
}

export const AgentActor = enumObject([
  "CODEX_AGENT",
  "CHATGPT_WEB_AGENT",
]);

export const RunMode = enumObject([
  "DISCUSSION",
  "CODE_CHANGE",
]);

export const RunPhase = enumObject([
  "CREATED",
  "STARTING_SESSIONS",
  "CODEX_TURN_PENDING",
  "CODEX_TURN_RUNNING",
  "CODEX_RESPONSE_STORED",
  "CODEX_TO_WEB_PENDING",
  "WEB_TURN_RUNNING",
  "WEB_RESPONSE_STORED",
  "WEB_TO_CODEX_PENDING",
  "CONSENSUS_CHECK",
  "HUMAN_GATE",
  "RECOVERY_REQUIRED",
  "COMPLETE",
  "FAILED",
  "CANCELLED",
]);

export const HumanGateReason = enumObject([
  "PRODUCT_DECISION_REQUIRED",
  "RUNTIME_APPROVAL_REQUIRED",
  "SESSION_AUTH_REQUIRED",
  "RECOVERY_AMBIGUOUS",
  "CONSENSUS_NOT_REACHED",
  "POLICY_VIOLATION",
  "MANUAL_INTERVENTION_DETECTED",
]);

export const SessionProvider = enumObject([
  "CODEX_APP_SERVER",
  "CHATGPT_WEB",
]);

export const AgentSessionStatus = enumObject([
  "CREATING",
  "READY",
  "RUNNING",
  "WAITING",
  "DISCONNECTED",
  "AUTH_REQUIRED",
  "FAILED",
  "CLOSED",
]);

export const RelayMessageKind = enumObject([
  "INITIAL_OBJECTIVE",
  "PROPOSAL",
  "CRITIQUE",
  "REVISION",
  "ACCEPTANCE",
  "BLOCKER",
  "PROTOCOL_REPAIR",
]);

export const AgentPacketType = enumObject([
  "PROPOSAL",
  "CRITIQUE",
  "ACCEPT",
  "BLOCKED",
  "PROTOCOL_ERROR",
]);

export const RunBlockerType = enumObject([
  "RUNTIME_APPROVAL",
  "USER_DECISION",
  "SESSION_AUTH",
  "RECOVERY_CONFIRMATION",
]);

export const RunOutcomeType = enumObject([
  "CONSENSUS",
  "INCONCLUSIVE",
  "BLOCKED",
  "CANCELLED",
  "FAILED",
]);

export const AGENT_ACTORS = Object.freeze(Object.values(AgentActor));
export const RUN_MODES = Object.freeze(Object.values(RunMode));
export const RUN_PHASES = Object.freeze(Object.values(RunPhase));
export const HUMAN_GATE_REASONS = Object.freeze(Object.values(HumanGateReason));
export const SESSION_PROVIDERS = Object.freeze(Object.values(SessionProvider));
export const AGENT_SESSION_STATUSES = Object.freeze(Object.values(AgentSessionStatus));
export const RELAY_MESSAGE_KINDS = Object.freeze(Object.values(RelayMessageKind));
export const AGENT_PACKET_TYPES = Object.freeze(Object.values(AgentPacketType));
export const RUN_BLOCKER_TYPES = Object.freeze(Object.values(RunBlockerType));
export const RUN_OUTCOME_TYPES = Object.freeze(Object.values(RunOutcomeType));

export function isVocabularyValue(vocabulary, value) {
  return typeof value === "string" && Object.hasOwn(vocabulary, value);
}
