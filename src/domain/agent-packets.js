import { sha256CanonicalJson } from "./canonical-json.js";
import {
  AgentPacketType,
  HumanGateReason,
  isVocabularyValue,
} from "./vocabulary.js";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * @type {Readonly<Record<"PROPOSAL" | "CRITIQUE" | "ACCEPT" | "BLOCKED", readonly string[]>>}
 */
const PACKET_KEYS = Object.freeze({
  [AgentPacketType.PROPOSAL]: Object.freeze([
    "type",
    "proposal_id",
    "proposal_sha256",
    "summary",
    "body",
    "assumptions",
    "open_decisions",
  ]),
  [AgentPacketType.CRITIQUE]: Object.freeze([
    "type",
    "target_proposal_sha256",
    "blocking_findings",
    "non_blocking_findings",
    "requested_changes",
  ]),
  [AgentPacketType.ACCEPT]: Object.freeze([
    "type",
    "accepted_proposal_sha256",
    "blocking_findings",
  ]),
  [AgentPacketType.BLOCKED]: Object.freeze([
    "type",
    "reason_code",
    "description",
    "required_decisions",
  ]),
});

export class AgentPacketValidationError extends TypeError {
  constructor(message, path = "packet", code = "INVALID_AGENT_PACKET") {
    super(`${message} at ${path}`);
    this.name = "AgentPacketValidationError";
    this.code = code;
    this.path = path;
  }
}

export class ProtocolErrorPacketAuthorityGapError extends AgentPacketValidationError {
  constructor() {
    super(
      "PROTOCOL_ERROR packet fields are not defined by the current authority",
      "packet.type",
      "PROTOCOL_ERROR_PACKET_SCHEMA_UNDEFINED",
    );
    this.name = "ProtocolErrorPacketAuthorityGapError";
  }
}

function requirePlainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentPacketValidationError("must be a plain object", path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentPacketValidationError("must be a plain object", path);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new AgentPacketValidationError("must not contain symbol properties", path);
  }
  return value;
}

function requireExactKeys(value, expected, path) {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) {
      throw new AgentPacketValidationError(`contains unsupported property ${JSON.stringify(key)}`, path);
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      throw new AgentPacketValidationError(`is missing required property ${JSON.stringify(key)}`, path);
    }
  }
}

function requireNonEmptyString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentPacketValidationError("must be a non-empty string", path);
  }
  return value;
}

function requireHash(value, path) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new AgentPacketValidationError("must be a sha256:<64 lowercase hex> digest", path);
  }
  return value;
}

function requireStringArray(value, path) {
  if (!Array.isArray(value)) {
    throw new AgentPacketValidationError("must be an array", path);
  }
  value.forEach((item, index) => requireNonEmptyString(item, `${path}[${index}]`));
  return value;
}

function validateProposal(packet) {
  requireExactKeys(packet, PACKET_KEYS.PROPOSAL, "packet");
  requireNonEmptyString(packet.proposal_id, "packet.proposal_id");
  requireHash(packet.proposal_sha256, "packet.proposal_sha256");
  requireNonEmptyString(packet.summary, "packet.summary");
  requireNonEmptyString(packet.body, "packet.body");
  requireStringArray(packet.assumptions, "packet.assumptions");
  requireStringArray(packet.open_decisions, "packet.open_decisions");
}

function validateCritique(packet) {
  requireExactKeys(packet, PACKET_KEYS.CRITIQUE, "packet");
  requireHash(packet.target_proposal_sha256, "packet.target_proposal_sha256");
  requireStringArray(packet.blocking_findings, "packet.blocking_findings");
  requireStringArray(packet.non_blocking_findings, "packet.non_blocking_findings");
  requireStringArray(packet.requested_changes, "packet.requested_changes");
}

function validateAccept(packet) {
  requireExactKeys(packet, PACKET_KEYS.ACCEPT, "packet");
  requireHash(packet.accepted_proposal_sha256, "packet.accepted_proposal_sha256");
  requireStringArray(packet.blocking_findings, "packet.blocking_findings");
}

function validateBlocked(packet) {
  requireExactKeys(packet, PACKET_KEYS.BLOCKED, "packet");
  if (!isVocabularyValue(HumanGateReason, packet.reason_code)) {
    throw new AgentPacketValidationError("must be a HumanGateReason", "packet.reason_code");
  }
  requireNonEmptyString(packet.description, "packet.description");
  requireStringArray(packet.required_decisions, "packet.required_decisions");
}

export function validateAgentPacket(value) {
  const packet = requirePlainObject(value, "packet");
  requireNonEmptyString(packet.type, "packet.type");

  switch (packet.type) {
    case AgentPacketType.PROPOSAL:
      validateProposal(packet);
      break;
    case AgentPacketType.CRITIQUE:
      validateCritique(packet);
      break;
    case AgentPacketType.ACCEPT:
      validateAccept(packet);
      break;
    case AgentPacketType.BLOCKED:
      validateBlocked(packet);
      break;
    case AgentPacketType.PROTOCOL_ERROR:
      throw new ProtocolErrorPacketAuthorityGapError();
    default:
      throw new AgentPacketValidationError("has an unknown packet type", "packet.type");
  }

  return packet;
}

export function validateProposalPacket(value) {
  const packet = validateAgentPacket(value);
  if (packet.type !== AgentPacketType.PROPOSAL) {
    throw new AgentPacketValidationError("must have type PROPOSAL", "packet.type");
  }
  return packet;
}

export function validateCritiquePacket(value) {
  const packet = validateAgentPacket(value);
  if (packet.type !== AgentPacketType.CRITIQUE) {
    throw new AgentPacketValidationError("must have type CRITIQUE", "packet.type");
  }
  return packet;
}

export function validateAcceptPacket(value) {
  const packet = validateAgentPacket(value);
  if (packet.type !== AgentPacketType.ACCEPT) {
    throw new AgentPacketValidationError("must have type ACCEPT", "packet.type");
  }
  return packet;
}

export function validateBlockedPacket(value) {
  const packet = validateAgentPacket(value);
  if (packet.type !== AgentPacketType.BLOCKED) {
    throw new AgentPacketValidationError("must have type BLOCKED", "packet.type");
  }
  return packet;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export function buildAgentPacket(value) {
  validateAgentPacket(value);
  return deepFreeze(structuredClone(value));
}

export function parseAgentPacket(input) {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new AgentPacketValidationError(
        `must be valid JSON (${error.message})`,
        "packet",
        "INVALID_AGENT_PACKET_JSON",
      );
    }
  }
  return buildAgentPacket(value);
}

export function agentPacketHash(packet) {
  validateAgentPacket(packet);
  return sha256CanonicalJson(packet);
}

export const packetHash = agentPacketHash;
export { AgentPacketType };
