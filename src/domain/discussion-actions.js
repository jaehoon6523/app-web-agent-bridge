import {
  AgentMessageKind,
  AgentPacketType,
  AgentTurnInputKind,
  HumanGateReason,
  RunPhase,
  isVocabularyValue,
} from "./vocabulary.js";
import { DISCUSSION_ACTION_MATRIX_VERSION } from "./run-policy.js";

export const DiscussionAction = Object.freeze({
  PROPOSE: "PROPOSE",
  CRITIQUE: "CRITIQUE",
  REVISE: "REVISE",
  ACCEPT: "ACCEPT",
  BLOCKED: "BLOCKED",
});

const SUPPORTED_INPUT_KINDS = new Set([
  AgentTurnInputKind.INITIAL_OBJECTIVE,
  AgentTurnInputKind.PEER_RELAY,
  AgentTurnInputKind.PROTOCOL_REPAIR,
]);

const SUPPORTED_PEER_MESSAGE_KINDS = new Set([
  AgentMessageKind.PROPOSAL,
  AgentMessageKind.REVISION,
  AgentMessageKind.CRITIQUE,
  AgentMessageKind.ACCEPTANCE,
]);

const SUPPORTED_PACKET_TYPES = new Set([
  AgentPacketType.PROPOSAL,
  AgentPacketType.CRITIQUE,
  AgentPacketType.ACCEPT,
  AgentPacketType.BLOCKED,
]);

export const PACKET_TYPE_BY_ACTION = Object.freeze({
  [DiscussionAction.PROPOSE]: AgentPacketType.PROPOSAL,
  [DiscussionAction.CRITIQUE]: AgentPacketType.CRITIQUE,
  [DiscussionAction.REVISE]: AgentPacketType.PROPOSAL,
  [DiscussionAction.ACCEPT]: AgentPacketType.ACCEPT,
  [DiscussionAction.BLOCKED]: AgentPacketType.BLOCKED,
});

export const DISCUSSION_ACTION_MATRIX = Object.freeze({
  INITIAL_OBJECTIVE: Object.freeze([
    DiscussionAction.PROPOSE,
    DiscussionAction.BLOCKED,
  ]),
  PEER_PROPOSAL: Object.freeze([
    DiscussionAction.CRITIQUE,
    DiscussionAction.ACCEPT,
    DiscussionAction.BLOCKED,
  ]),
  PEER_REVISION: Object.freeze([
    DiscussionAction.CRITIQUE,
    DiscussionAction.ACCEPT,
    DiscussionAction.BLOCKED,
  ]),
  PEER_CRITIQUE: Object.freeze([
    DiscussionAction.REVISE,
    DiscussionAction.BLOCKED,
  ]),
  PEER_ACCEPTANCE: Object.freeze([
    DiscussionAction.ACCEPT,
    DiscussionAction.CRITIQUE,
    DiscussionAction.BLOCKED,
  ]),
});

export const BLOCKED_ROUTE_BY_REASON = Object.freeze({
  [HumanGateReason.PRODUCT_DECISION_REQUIRED]: RunPhase.HUMAN_GATE,
  [HumanGateReason.RUNTIME_APPROVAL_REQUIRED]: RunPhase.HUMAN_GATE,
  [HumanGateReason.SESSION_AUTH_REQUIRED]: RunPhase.HUMAN_GATE,
  [HumanGateReason.RECOVERY_AMBIGUOUS]: RunPhase.RECOVERY_REQUIRED,
  [HumanGateReason.CONSENSUS_NOT_REACHED]: RunPhase.HUMAN_GATE,
  [HumanGateReason.POLICY_VIOLATION]: RunPhase.FAILED,
  [HumanGateReason.MANUAL_INTERVENTION_DETECTED]: RunPhase.HUMAN_GATE,
});

export class DiscussionActionPolicyError extends TypeError {
  constructor(message, code = "INVALID_DISCUSSION_ACTION_CONTEXT") {
    super(message);
    this.name = "DiscussionActionPolicyError";
    this.code = code;
  }
}

function requireNull(value, name) {
  if (value !== null) {
    throw new DiscussionActionPolicyError(`${name} must be null.`);
  }
}

function uniquePacketTypes(actions) {
  return Object.freeze([...new Set(actions.map((action) => PACKET_TYPE_BY_ACTION[action]))]);
}

function restrictedPacketMap(actions) {
  return Object.freeze(Object.fromEntries(
    actions.map((action) => [action, PACKET_TYPE_BY_ACTION[action]]),
  ));
}

function resolvedPolicy(actions, expectedPacketType = null) {
  const allowedActions = Object.freeze([...actions]);
  const allowedPacketTypes = expectedPacketType === null
    ? uniquePacketTypes(allowedActions)
    : Object.freeze([expectedPacketType]);
  return Object.freeze({
    actionMatrixVersion: DISCUSSION_ACTION_MATRIX_VERSION,
    allowedActions,
    allowedPacketTypes,
    packetTypeByAction: restrictedPacketMap(allowedActions),
    expectedPacketType,
  });
}

export function resolveDiscussionActionPolicy({
  inputKind,
  peerMessageKind = null,
  expectedPacketType = null,
}) {
  if (!SUPPORTED_INPUT_KINDS.has(inputKind)) {
    throw new DiscussionActionPolicyError(
      "inputKind has no authorized DISCUSSION action policy.",
    );
  }

  if (inputKind === AgentTurnInputKind.INITIAL_OBJECTIVE) {
    requireNull(peerMessageKind, "peerMessageKind");
    requireNull(expectedPacketType, "expectedPacketType");
    return resolvedPolicy(DISCUSSION_ACTION_MATRIX.INITIAL_OBJECTIVE);
  }

  if (inputKind === AgentTurnInputKind.PEER_RELAY) {
    if (!SUPPORTED_PEER_MESSAGE_KINDS.has(peerMessageKind)) {
      throw new DiscussionActionPolicyError(
        "peerMessageKind has no authorized PEER_RELAY action policy.",
      );
    }
    requireNull(expectedPacketType, "expectedPacketType");
    return resolvedPolicy(DISCUSSION_ACTION_MATRIX[`PEER_${peerMessageKind}`]);
  }

  requireNull(peerMessageKind, "peerMessageKind");
  if (!SUPPORTED_PACKET_TYPES.has(expectedPacketType)) {
    throw new DiscussionActionPolicyError(
      "expectedPacketType must be an authorized discussion packet type for PROTOCOL_REPAIR.",
      "INVALID_PROTOCOL_REPAIR_EXPECTATION",
    );
  }
  return resolvedPolicy([], expectedPacketType);
}

export function assertDiscussionPacketTypeAllowed(context, packetType) {
  const policy = resolveDiscussionActionPolicy(context);
  if (!policy.allowedPacketTypes.includes(packetType)) {
    throw new DiscussionActionPolicyError(
      `Packet type ${String(packetType)} is not allowed for ${context.inputKind}.`,
      "DISCUSSION_PACKET_TYPE_NOT_ALLOWED",
    );
  }
  return packetType;
}

export function blockedRoutingResult(reasonCode) {
  if (!isVocabularyValue(HumanGateReason, reasonCode)) {
    throw new DiscussionActionPolicyError(
      "reasonCode must be a HumanGateReason.",
      "UNKNOWN_BLOCKED_REASON",
    );
  }
  const route = BLOCKED_ROUTE_BY_REASON[reasonCode];
  if (route === undefined) {
    throw new DiscussionActionPolicyError(
      `BLOCKED reason ${reasonCode} has no routing result.`,
      "BLOCKED_ROUTE_UNDEFINED",
    );
  }
  return Object.freeze({
    packetType: AgentPacketType.BLOCKED,
    reasonCode,
    route,
  });
}
