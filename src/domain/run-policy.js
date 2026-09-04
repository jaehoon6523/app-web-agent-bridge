import { sha256CanonicalJson } from "./canonical-json.js";
import { AgentActor, RunMode } from "./vocabulary.js";

export const RUN_POLICY_SCHEMA_VERSION = "run-policy-v1";
export const AGENT_PACKET_SCHEMA_VERSION = "agent-packet-v1";
export const PROPOSAL_HASH_VERSION = "proposal-ref-v1";
export const DISCUSSION_ACTION_MATRIX_VERSION = "discussion-actions-v1";
export const CONSENSUS_VERSION = "consensus-v1";

const RUN_POLICY_KEYS = Object.freeze([
  "schema",
  "mode",
  "startingActor",
  "limits",
  "packetSchemaVersion",
  "proposalHashVersion",
  "actionMatrixVersion",
  "consensusVersion",
]);

const DEFAULT_LIMIT_VALUES = Object.freeze({
  maxTurns: 12,
  maxProtocolRepairs: 1,
  maxDeliveryAttempts: 3,
  maxConsecutiveActorFailures: 2,
});
const RUN_LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_LIMIT_VALUES));

function requirePlainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${name} must not contain symbol properties.`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, name) {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new TypeError(`${name} contains unsupported property ${JSON.stringify(key)}.`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${name} is missing required property ${JSON.stringify(key)}.`);
    }
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function requireFixedValue(actual, expected, name) {
  if (actual !== expected) {
    throw new TypeError(`${name} must be ${JSON.stringify(expected)}.`);
  }
}

function validateDiscussionMaxTurns(value) {
  if (!Number.isSafeInteger(value) || value < 2 || value % 2 !== 0) {
    throw new TypeError("RunPolicy.limits.maxTurns must be an even safe integer >= 2.");
  }
  return value;
}

function requireSafeInteger(value, minimum, name) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}.`);
  }
  return value;
}

export function validateRunPolicy(value) {
  const policy = requirePlainObject(value, "RunPolicy");
  requireExactKeys(policy, RUN_POLICY_KEYS, "RunPolicy");
  requireFixedValue(policy.schema, RUN_POLICY_SCHEMA_VERSION, "RunPolicy.schema");
  requireFixedValue(policy.mode, RunMode.DISCUSSION, "RunPolicy.mode");
  requireFixedValue(
    policy.startingActor,
    AgentActor.CODEX_AGENT,
    "RunPolicy.startingActor",
  );
  requireFixedValue(
    policy.packetSchemaVersion,
    AGENT_PACKET_SCHEMA_VERSION,
    "RunPolicy.packetSchemaVersion",
  );
  requireFixedValue(
    policy.proposalHashVersion,
    PROPOSAL_HASH_VERSION,
    "RunPolicy.proposalHashVersion",
  );
  requireFixedValue(
    policy.actionMatrixVersion,
    DISCUSSION_ACTION_MATRIX_VERSION,
    "RunPolicy.actionMatrixVersion",
  );
  requireFixedValue(
    policy.consensusVersion,
    CONSENSUS_VERSION,
    "RunPolicy.consensusVersion",
  );

  const limits = requirePlainObject(policy.limits, "RunPolicy.limits");
  requireExactKeys(limits, RUN_LIMIT_KEYS, "RunPolicy.limits");
  validateDiscussionMaxTurns(policy.limits.maxTurns);
  requireSafeInteger(
    policy.limits.maxProtocolRepairs,
    0,
    "RunPolicy.limits.maxProtocolRepairs",
  );
  requireSafeInteger(
    policy.limits.maxDeliveryAttempts,
    1,
    "RunPolicy.limits.maxDeliveryAttempts",
  );
  requireSafeInteger(
    policy.limits.maxConsecutiveActorFailures,
    1,
    "RunPolicy.limits.maxConsecutiveActorFailures",
  );
  requireFixedValue(
    policy.limits.maxProtocolRepairs,
    DEFAULT_LIMIT_VALUES.maxProtocolRepairs,
    "RunPolicy.limits.maxProtocolRepairs",
  );
  requireFixedValue(
    policy.limits.maxDeliveryAttempts,
    DEFAULT_LIMIT_VALUES.maxDeliveryAttempts,
    "RunPolicy.limits.maxDeliveryAttempts",
  );
  requireFixedValue(
    policy.limits.maxConsecutiveActorFailures,
    DEFAULT_LIMIT_VALUES.maxConsecutiveActorFailures,
    "RunPolicy.limits.maxConsecutiveActorFailures",
  );
  return policy;
}

export function freezeRunPolicy(value) {
  validateRunPolicy(value);
  return deepFreeze(structuredClone(value));
}

export function createDiscussionRunPolicy(options = {}) {
  const supplied = requirePlainObject(options, "RunPolicy options");
  for (const key of Object.keys(supplied)) {
    if (key !== "maxTurns") {
      throw new TypeError(
        `RunPolicy options contains unsupported property ${JSON.stringify(key)}.`,
      );
    }
  }
  const maxTurns = Object.hasOwn(supplied, "maxTurns")
    ? supplied.maxTurns
    : DEFAULT_LIMIT_VALUES.maxTurns;

  return freezeRunPolicy({
    schema: RUN_POLICY_SCHEMA_VERSION,
    mode: RunMode.DISCUSSION,
    startingActor: AgentActor.CODEX_AGENT,
    limits: {
      ...DEFAULT_LIMIT_VALUES,
      maxTurns,
    },
    packetSchemaVersion: AGENT_PACKET_SCHEMA_VERSION,
    proposalHashVersion: PROPOSAL_HASH_VERSION,
    actionMatrixVersion: DISCUSSION_ACTION_MATRIX_VERSION,
    consensusVersion: CONSENSUS_VERSION,
  });
}

export function calculateRunPolicyHash(policy) {
  validateRunPolicy(policy);
  return sha256CanonicalJson(policy);
}

export const DEFAULT_DISCUSSION_RUN_LIMITS = deepFreeze(
  structuredClone(DEFAULT_LIMIT_VALUES),
);
export const DEFAULT_DISCUSSION_RUN_POLICY = createDiscussionRunPolicy();
