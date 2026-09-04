import { SHA256_DIGEST_PATTERN } from "./agent-messages.js";
import { AgentActor, isVocabularyValue } from "./vocabulary.js";

export const AGENT_PACKET_REJECTED_EVENT_TYPE = "AGENT_PACKET_REJECTED";

export const AgentPacketParserStage = Object.freeze({
  CONTROLLER_PACKET_EXTRACTION: "CONTROLLER_PACKET_EXTRACTION",
  JSON_PARSE: "JSON_PARSE",
  SCHEMA_VALIDATION: "SCHEMA_VALIDATION",
  DOMAIN_VALIDATION: "DOMAIN_VALIDATION",
  HASH_BINDING: "HASH_BINDING",
});

export const AgentPacketRejectionRecoverability = Object.freeze({
  REPAIRABLE: "REPAIRABLE",
  EXHAUSTED: "EXHAUSTED",
  AMBIGUOUS: "AMBIGUOUS",
});

const EVENT_FIELDS = Object.freeze([
  "eventType",
  "runId",
  "actor",
  "sessionId",
  "turnId",
  "deliveryId",
  "parserStage",
  "errorCode",
  "errorSummary",
  "rawResponseArtifactHash",
  "protocolRepairsUsed",
  "recoverability",
  "createdAt",
]);

const PARSER_STAGES = new Set(Object.values(AgentPacketParserStage));
const RECOVERABILITY_VALUES = new Set(Object.values(AgentPacketRejectionRecoverability));

export class AgentPacketRejectionContractError extends TypeError {
  constructor(message, path = "AgentPacketRejectedEvent", code = "INVALID_AGENT_PACKET_REJECTION") {
    super(`${message} at ${path}`);
    this.name = "AgentPacketRejectionContractError";
    this.code = code;
    this.path = path;
  }
}

function requirePlainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentPacketRejectionContractError("must be a plain object", path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentPacketRejectionContractError("must be a plain object", path);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new AgentPacketRejectionContractError("must not contain symbol properties", path);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, path) {
  requirePlainObject(value, path);
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new AgentPacketRejectionContractError(
        `contains unsupported property ${JSON.stringify(key)}`,
        path,
      );
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new AgentPacketRejectionContractError(
        `is missing required property ${JSON.stringify(key)}`,
        path,
      );
    }
  }
}

function requireNonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentPacketRejectionContractError("must be a non-empty string", path);
  }
  return value;
}

function requireHash(value, path) {
  if (typeof value !== "string" || !SHA256_DIGEST_PATTERN.test(value)) {
    throw new AgentPacketRejectionContractError(
      "must be a sha256:<64 lowercase hex> digest",
      path,
    );
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

export function validateAgentPacketRejectedEvent(value) {
  const event = requirePlainObject(value, "AgentPacketRejectedEvent");
  requireExactKeys(event, EVENT_FIELDS, "AgentPacketRejectedEvent");
  if (event.eventType !== AGENT_PACKET_REJECTED_EVENT_TYPE) {
    throw new AgentPacketRejectionContractError(
      `must be ${AGENT_PACKET_REJECTED_EVENT_TYPE}`,
      "AgentPacketRejectedEvent.eventType",
    );
  }
  requireNonEmptyString(event.runId, "AgentPacketRejectedEvent.runId");
  if (!isVocabularyValue(AgentActor, event.actor)) {
    throw new AgentPacketRejectionContractError(
      "must be an AgentActor",
      "AgentPacketRejectedEvent.actor",
    );
  }
  requireNonEmptyString(event.sessionId, "AgentPacketRejectedEvent.sessionId");
  requireNonEmptyString(event.turnId, "AgentPacketRejectedEvent.turnId");
  requireNonEmptyString(event.deliveryId, "AgentPacketRejectedEvent.deliveryId");
  if (!PARSER_STAGES.has(event.parserStage)) {
    throw new AgentPacketRejectionContractError(
      "must be an AgentPacketParserStage",
      "AgentPacketRejectedEvent.parserStage",
    );
  }
  requireNonEmptyString(event.errorCode, "AgentPacketRejectedEvent.errorCode");
  requireNonEmptyString(event.errorSummary, "AgentPacketRejectedEvent.errorSummary");
  requireHash(
    event.rawResponseArtifactHash,
    "AgentPacketRejectedEvent.rawResponseArtifactHash",
  );
  if (!Number.isSafeInteger(event.protocolRepairsUsed) || event.protocolRepairsUsed < 0) {
    throw new AgentPacketRejectionContractError(
      "must be a non-negative safe integer",
      "AgentPacketRejectedEvent.protocolRepairsUsed",
    );
  }
  if (!RECOVERABILITY_VALUES.has(event.recoverability)) {
    throw new AgentPacketRejectionContractError(
      "must be an AgentPacketRejectionRecoverability",
      "AgentPacketRejectedEvent.recoverability",
    );
  }
  requireNonEmptyString(event.createdAt, "AgentPacketRejectedEvent.createdAt");
  return event;
}

export function buildAgentPacketRejectedEvent(value) {
  const event = structuredClone(value);
  validateAgentPacketRejectedEvent(event);
  return deepFreeze(event);
}

export const AGENT_PACKET_REJECTED_EVENT_FIELDS = EVENT_FIELDS;
