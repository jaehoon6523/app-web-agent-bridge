import { validateAgentPacket } from "./agent-packets.js";
import { sha256CanonicalJson, sha256Text } from "./canonical-json.js";
import {
  AgentActor,
  AgentMessageKind,
  AgentPacketType,
  AgentTurnInputKind,
  isVocabularyValue,
} from "./vocabulary.js";

export const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class AgentCommunicationContractError extends TypeError {
  constructor(message, path = "value", code = "INVALID_AGENT_COMMUNICATION_CONTRACT") {
    super(`${message} at ${path}`);
    this.name = "AgentCommunicationContractError";
    this.code = code;
    this.path = path;
  }
}

const TURN_INPUT_FIELDS = Object.freeze([
  "inputId",
  "runId",
  "targetActor",
  "kind",
  "sourceMessageId",
  "instructionId",
  "promptTemplateVersion",
  "payload",
  "payloadHash",
  "promptHash",
  "objectiveHash",
  "policyHash",
  "createdAt",
]);

const AGENT_MESSAGE_FIELDS = Object.freeze([
  "messageId",
  "runId",
  "sequence",
  "actor",
  "sessionId",
  "turnId",
  "kind",
  "content",
  "contentHash",
  "normalizedPacket",
  "objectiveHash",
  "policyHash",
  "createdAt",
]);

const MESSAGE_PACKET_TYPES = Object.freeze({
  [AgentMessageKind.PROPOSAL]: AgentPacketType.PROPOSAL,
  [AgentMessageKind.REVISION]: AgentPacketType.PROPOSAL,
  [AgentMessageKind.CRITIQUE]: AgentPacketType.CRITIQUE,
  [AgentMessageKind.ACCEPTANCE]: AgentPacketType.ACCEPT,
  [AgentMessageKind.BLOCKER]: AgentPacketType.BLOCKED,
});

function requirePlainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentCommunicationContractError("must be a plain object", path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentCommunicationContractError("must be a plain object", path);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new AgentCommunicationContractError("must not contain symbol properties", path);
  }
  return value;
}

function requireExactKeys(value, keys, path) {
  requirePlainObject(value, path);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new AgentCommunicationContractError(
        `contains unsupported property ${JSON.stringify(key)}`,
        path,
      );
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new AgentCommunicationContractError(
        `is missing required property ${JSON.stringify(key)}`,
        path,
      );
    }
  }
}

function requireBuilderKeys(value, required, optional, path) {
  requirePlainObject(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new AgentCommunicationContractError(
        `contains unsupported property ${JSON.stringify(key)}`,
        path,
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new AgentCommunicationContractError(
        `is missing required property ${JSON.stringify(key)}`,
        path,
      );
    }
  }
}

function requireNonEmptyString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentCommunicationContractError("must be a non-empty string", path);
  }
  return value;
}

function requireNullableString(value, path) {
  if (value !== null) requireNonEmptyString(value, path);
  return value;
}

function requireHash(value, path) {
  if (typeof value !== "string" || !SHA256_DIGEST_PATTERN.test(value)) {
    throw new AgentCommunicationContractError(
      "must be a sha256:<64 lowercase hex> digest",
      path,
    );
  }
  return value;
}

function requireEnum(value, vocabulary, name, path) {
  if (!isVocabularyValue(vocabulary, value)) {
    throw new AgentCommunicationContractError(`must be a ${name}`, path);
  }
  return value;
}

function immutableClone(value, path) {
  let clone;
  try {
    clone = structuredClone(value);
    sha256CanonicalJson(clone);
  } catch (cause) {
    throw new AgentCommunicationContractError(
      `must be canonical JSON data (${cause.message})`,
      path,
    );
  }
  return deepFreeze(clone);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export function validateAgentTurnInput(value) {
  const input = requirePlainObject(value, "AgentTurnInput");
  requireExactKeys(input, TURN_INPUT_FIELDS, "AgentTurnInput");
  requireNonEmptyString(input.inputId, "AgentTurnInput.inputId");
  requireNonEmptyString(input.runId, "AgentTurnInput.runId");
  requireEnum(input.targetActor, AgentActor, "AgentActor", "AgentTurnInput.targetActor");
  requireEnum(
    input.kind,
    AgentTurnInputKind,
    "AgentTurnInputKind",
    "AgentTurnInput.kind",
  );
  requireNullableString(input.sourceMessageId, "AgentTurnInput.sourceMessageId");
  if (
    (input.kind === AgentTurnInputKind.INITIAL_OBJECTIVE
      || input.kind === AgentTurnInputKind.PROTOCOL_REPAIR)
    && input.sourceMessageId !== null
  ) {
    throw new AgentCommunicationContractError(
      `must be null for ${input.kind}`,
      "AgentTurnInput.sourceMessageId",
      "TURN_INPUT_SOURCE_FORBIDDEN",
    );
  }
  if (input.kind === AgentTurnInputKind.PEER_RELAY && input.sourceMessageId === null) {
    throw new AgentCommunicationContractError(
      "must identify the source AgentMessage for PEER_RELAY",
      "AgentTurnInput.sourceMessageId",
      "TURN_INPUT_SOURCE_REQUIRED",
    );
  }
  requireNonEmptyString(input.instructionId, "AgentTurnInput.instructionId");
  requireNonEmptyString(
    input.promptTemplateVersion,
    "AgentTurnInput.promptTemplateVersion",
  );
  const calculatedPayloadHash = sha256CanonicalJson(input.payload);
  requireHash(input.payloadHash, "AgentTurnInput.payloadHash");
  if (input.payloadHash !== calculatedPayloadHash) {
    throw new AgentCommunicationContractError(
      "does not match payload",
      "AgentTurnInput.payloadHash",
      "HASH_MISMATCH",
    );
  }
  requireHash(input.promptHash, "AgentTurnInput.promptHash");
  requireHash(input.objectiveHash, "AgentTurnInput.objectiveHash");
  requireHash(input.policyHash, "AgentTurnInput.policyHash");
  requireNonEmptyString(input.createdAt, "AgentTurnInput.createdAt");
  return input;
}

export function buildAgentTurnInput(value) {
  const required = TURN_INPUT_FIELDS.filter((field) => field !== "payloadHash");
  requireBuilderKeys(value, required, ["payloadHash"], "AgentTurnInput input");
  const draft = immutableClone(value, "AgentTurnInput input");
  const input = {
    ...draft,
    payloadHash: value.payloadHash ?? sha256CanonicalJson(draft.payload),
  };
  validateAgentTurnInput(input);
  return deepFreeze(input);
}

export function validateAgentMessage(value) {
  const message = requirePlainObject(value, "AgentMessage");
  requireExactKeys(message, AGENT_MESSAGE_FIELDS, "AgentMessage");
  requireNonEmptyString(message.messageId, "AgentMessage.messageId");
  requireNonEmptyString(message.runId, "AgentMessage.runId");
  if (!Number.isSafeInteger(message.sequence) || message.sequence < 1) {
    throw new AgentCommunicationContractError(
      "must be a safe integer greater than or equal to 1",
      "AgentMessage.sequence",
    );
  }
  requireEnum(message.actor, AgentActor, "AgentActor", "AgentMessage.actor");
  requireNonEmptyString(message.sessionId, "AgentMessage.sessionId");
  requireNonEmptyString(message.turnId, "AgentMessage.turnId");
  requireEnum(message.kind, AgentMessageKind, "AgentMessageKind", "AgentMessage.kind");
  requireNonEmptyString(message.content, "AgentMessage.content");
  requireHash(message.contentHash, "AgentMessage.contentHash");
  if (message.contentHash !== sha256Text(message.content)) {
    throw new AgentCommunicationContractError(
      "does not match content",
      "AgentMessage.contentHash",
      "HASH_MISMATCH",
    );
  }
  validateAgentPacket(message.normalizedPacket);
  const expectedPacketType = MESSAGE_PACKET_TYPES[message.kind];
  if (message.normalizedPacket.type !== expectedPacketType) {
    throw new AgentCommunicationContractError(
      `must be ${expectedPacketType} for ${message.kind}`,
      "AgentMessage.normalizedPacket.type",
      "AGENT_MESSAGE_PACKET_KIND_MISMATCH",
    );
  }
  requireHash(message.objectiveHash, "AgentMessage.objectiveHash");
  requireHash(message.policyHash, "AgentMessage.policyHash");
  requireNonEmptyString(message.createdAt, "AgentMessage.createdAt");
  return message;
}

export function buildAgentMessage(value) {
  const required = AGENT_MESSAGE_FIELDS.filter((field) => field !== "contentHash");
  requireBuilderKeys(value, required, ["contentHash"], "AgentMessage input");
  const draft = immutableClone(value, "AgentMessage input");
  const message = {
    ...draft,
    contentHash: value.contentHash ?? sha256Text(draft.content),
  };
  validateAgentMessage(message);
  return deepFreeze(message);
}

export const AGENT_TURN_INPUT_FIELDS = TURN_INPUT_FIELDS;
export { AGENT_MESSAGE_FIELDS };
