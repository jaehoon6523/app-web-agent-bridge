import { sha256CanonicalJson } from "./canonical-json.js";
import {
  AgentBlockedReason,
  AgentPacketType,
  isVocabularyValue,
} from "./vocabulary.js";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * @type {Readonly<Record<"PROPOSAL" | "CRITIQUE" | "ACCEPT" | "BLOCKED", readonly string[]>>}
 */
const PACKET_KEYS = Object.freeze({
  [AgentPacketType.PROPOSAL]: Object.freeze([
    "type",
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

function normalizeTextItem(value) {
  return typeof value === "string" ? value.normalize("NFC").trim() : value;
}

function requireNormalizableTextArray(value, path, requireCanonical) {
  if (!Array.isArray(value)) {
    throw new AgentPacketValidationError("must be an array", path);
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const normalized = normalizeTextItem(item);
    if (typeof normalized !== "string" || normalized.length === 0) {
      throw new AgentPacketValidationError("must be a non-blank string", itemPath);
    }
    if (requireCanonical && item !== normalized) {
      throw new AgentPacketValidationError("must be NFC-normalized and trimmed", itemPath);
    }
  });
  return value;
}

function normalizeTextArray(value) {
  if (!Array.isArray(value)) return value;
  return value.map(normalizeTextItem);
}

function normalizePacketTextArrays(value) {
  const packet = structuredClone(value);
  switch (packet.type) {
    case AgentPacketType.PROPOSAL:
      packet.open_decisions = normalizeTextArray(packet.open_decisions);
      break;
    case AgentPacketType.CRITIQUE:
      packet.blocking_findings = normalizeTextArray(packet.blocking_findings);
      packet.non_blocking_findings = normalizeTextArray(packet.non_blocking_findings);
      packet.requested_changes = normalizeTextArray(packet.requested_changes);
      break;
    case AgentPacketType.ACCEPT:
      packet.blocking_findings = normalizeTextArray(packet.blocking_findings);
      break;
    case AgentPacketType.BLOCKED:
      packet.required_decisions = normalizeTextArray(packet.required_decisions);
      break;
    default:
      break;
  }
  return packet;
}

function validateProposal(packet, requireCanonical) {
  requireExactKeys(packet, PACKET_KEYS.PROPOSAL, "packet");
  requireNonEmptyString(packet.summary, "packet.summary");
  requireNonEmptyString(packet.body, "packet.body");
  requireStringArray(packet.assumptions, "packet.assumptions");
  requireNormalizableTextArray(packet.open_decisions, "packet.open_decisions", requireCanonical);
}

function validateCritique(packet, requireCanonical) {
  requireExactKeys(packet, PACKET_KEYS.CRITIQUE, "packet");
  requireHash(packet.target_proposal_sha256, "packet.target_proposal_sha256");
  requireNormalizableTextArray(packet.blocking_findings, "packet.blocking_findings", requireCanonical);
  requireNormalizableTextArray(
    packet.non_blocking_findings,
    "packet.non_blocking_findings",
    requireCanonical,
  );
  requireNormalizableTextArray(packet.requested_changes, "packet.requested_changes", requireCanonical);
}

function validateAccept(packet, requireCanonical) {
  requireExactKeys(packet, PACKET_KEYS.ACCEPT, "packet");
  requireHash(packet.accepted_proposal_sha256, "packet.accepted_proposal_sha256");
  requireNormalizableTextArray(packet.blocking_findings, "packet.blocking_findings", requireCanonical);
}

function validateBlocked(packet, requireCanonical) {
  requireExactKeys(packet, PACKET_KEYS.BLOCKED, "packet");
  if (!isVocabularyValue(AgentBlockedReason, packet.reason_code)) {
    throw new AgentPacketValidationError("must be an AgentBlockedReason", "packet.reason_code");
  }
  requireNonEmptyString(packet.description, "packet.description");
  requireNormalizableTextArray(packet.required_decisions, "packet.required_decisions", requireCanonical);
}

function validateAgentPacketValue(value, requireCanonical) {
  const packet = requirePlainObject(value, "packet");
  requireNonEmptyString(packet.type, "packet.type");

  switch (packet.type) {
    case AgentPacketType.PROPOSAL:
      validateProposal(packet, requireCanonical);
      break;
    case AgentPacketType.CRITIQUE:
      validateCritique(packet, requireCanonical);
      break;
    case AgentPacketType.ACCEPT:
      validateAccept(packet, requireCanonical);
      break;
    case AgentPacketType.BLOCKED:
      validateBlocked(packet, requireCanonical);
      break;
    default:
      throw new AgentPacketValidationError("has an unknown packet type", "packet.type");
  }

  return packet;
}

export function validateAgentPacket(value) {
  return validateAgentPacketValue(value, true);
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
  validateAgentPacketValue(value, false);
  const packet = normalizePacketTextArrays(value);
  validateAgentPacket(packet);
  return deepFreeze(packet);
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

export { AgentPacketType };
