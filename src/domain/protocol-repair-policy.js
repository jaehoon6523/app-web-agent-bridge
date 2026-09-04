import { validateAgentMessage, validateAgentTurnInput } from "./agent-messages.js";
import { AgentPacketParserStage } from "./agent-packet-rejection.js";
import { sha256CanonicalJson } from "./canonical-json.js";
import { resolveDiscussionActionPolicy } from "./discussion-actions.js";
import { DISCUSSION_ACTION_MATRIX_VERSION } from "./run-policy.js";
import {
  AgentPacketType,
  AgentTurnInputKind,
  isVocabularyValue,
} from "./vocabulary.js";

export const PROTOCOL_REPAIR_POLICY_SCHEMA = "discussion-protocol-repair-policy-v1";
export const PROTOCOL_REPAIR_PAYLOAD_FIELDS = Object.freeze([
  "rejectedDeliveryId",
  "parserStage",
  "errorCode",
  "errorSummary",
  "allowedPacketTypes",
  "repairPolicyHash",
]);

export class ProtocolRepairPolicyError extends TypeError {
  constructor(message, code = "INVALID_PROTOCOL_REPAIR_POLICY") {
    super(message);
    this.name = "ProtocolRepairPolicyError";
    this.code = code;
  }
}

function requirePlainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolRepairPolicyError(`${name} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new ProtocolRepairPolicyError(`${name} must be a plain string-keyed object.`);
  }
  return value;
}

function requireExactKeys(value, fields, name) {
  requirePlainObject(value, name);
  const expected = new Set(fields);
  if (
    Object.keys(value).length !== fields.length
    || Object.keys(value).some((key) => !expected.has(key))
    || fields.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new ProtocolRepairPolicyError(`${name} has an invalid closed shape.`);
  }
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProtocolRepairPolicyError(`${name} must be a non-empty string.`);
  }
}

export function validateProtocolRepairPayload(value) {
  const payload = requireExactKeys(value, PROTOCOL_REPAIR_PAYLOAD_FIELDS, "protocol repair payload");
  requireNonEmptyString(payload.rejectedDeliveryId, "protocol repair payload.rejectedDeliveryId");
  if (!isVocabularyValue(AgentPacketParserStage, payload.parserStage)) {
    throw new ProtocolRepairPolicyError(
      "protocol repair payload.parserStage must be an AgentPacketParserStage.",
    );
  }
  requireNonEmptyString(payload.errorCode, "protocol repair payload.errorCode");
  requireNonEmptyString(payload.errorSummary, "protocol repair payload.errorSummary");
  if (
    !Array.isArray(payload.allowedPacketTypes)
    || payload.allowedPacketTypes.length === 0
    || new Set(payload.allowedPacketTypes).size !== payload.allowedPacketTypes.length
    || payload.allowedPacketTypes.some(
      (packetType) => !isVocabularyValue(AgentPacketType, packetType),
    )
  ) {
    throw new ProtocolRepairPolicyError(
      "protocol repair payload.allowedPacketTypes must be a non-empty unique AgentPacketType list.",
    );
  }
  if (
    typeof payload.repairPolicyHash !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(payload.repairPolicyHash)
  ) {
    throw new ProtocolRepairPolicyError(
      "protocol repair payload.repairPolicyHash must be a SHA-256 digest.",
    );
  }
  return payload;
}

function sourceForRejectedInput(rejectedTurnInput, sourceMessage) {
  if (rejectedTurnInput.kind === AgentTurnInputKind.INITIAL_OBJECTIVE) {
    if (sourceMessage !== null) {
      throw new ProtocolRepairPolicyError("INITIAL_OBJECTIVE repair policy must not have a source message.");
    }
    return null;
  }
  if (rejectedTurnInput.kind !== AgentTurnInputKind.PEER_RELAY) {
    throw new ProtocolRepairPolicyError(
      "Protocol repair policy can only be derived from an original discussion turn.",
      "PROTOCOL_REPAIR_ORIGIN_INVALID",
    );
  }
  validateAgentMessage(sourceMessage);
  if (
    sourceMessage.messageId !== rejectedTurnInput.sourceMessageId
    || sourceMessage.runId !== rejectedTurnInput.runId
    || sourceMessage.objectiveHash !== rejectedTurnInput.objectiveHash
    || sourceMessage.policyHash !== rejectedTurnInput.policyHash
    || sourceMessage.actor === rejectedTurnInput.targetActor
  ) {
    throw new ProtocolRepairPolicyError(
      "PEER_RELAY repair policy source does not match the rejected turn input.",
      "PROTOCOL_REPAIR_SOURCE_MISMATCH",
    );
  }
  return sourceMessage;
}

export function deriveProtocolRepairPolicy({ rejectedTurnInput, sourceMessage = null }) {
  validateAgentTurnInput(rejectedTurnInput);
  const source = sourceForRejectedInput(rejectedTurnInput, sourceMessage);
  const actionPolicy = resolveDiscussionActionPolicy({
    inputKind: rejectedTurnInput.kind,
    peerMessageKind: source?.kind ?? null,
  });
  const allowedPacketTypes = Object.freeze([...actionPolicy.allowedPacketTypes]);
  const repairPolicyHash = sha256CanonicalJson({
    schema: PROTOCOL_REPAIR_POLICY_SCHEMA,
    actionMatrixVersion: DISCUSSION_ACTION_MATRIX_VERSION,
    rejectedTurn: {
      inputId: rejectedTurnInput.inputId,
      runId: rejectedTurnInput.runId,
      targetActor: rejectedTurnInput.targetActor,
      kind: rejectedTurnInput.kind,
      sourceMessageId: rejectedTurnInput.sourceMessageId,
      payloadHash: rejectedTurnInput.payloadHash,
      objectiveHash: rejectedTurnInput.objectiveHash,
      policyHash: rejectedTurnInput.policyHash,
    },
    sourceMessage: source === null ? null : {
      messageId: source.messageId,
      kind: source.kind,
      actor: source.actor,
      contentHash: source.contentHash,
    },
    allowedPacketTypes,
  });
  return Object.freeze({ allowedPacketTypes, repairPolicyHash });
}

export function assertProtocolRepairPolicyBinding({
  repairPayload,
  rejectedTurnInput,
  sourceMessage = null,
}) {
  validateProtocolRepairPayload(repairPayload);
  const derived = deriveProtocolRepairPolicy({ rejectedTurnInput, sourceMessage });
  if (
    repairPayload.repairPolicyHash !== derived.repairPolicyHash
    || repairPayload.allowedPacketTypes.length !== derived.allowedPacketTypes.length
    || repairPayload.allowedPacketTypes.some(
      (packetType, index) => packetType !== derived.allowedPacketTypes[index],
    )
  ) {
    throw new ProtocolRepairPolicyError(
      "Protocol repair payload does not match the policy derived from its rejected turn.",
      "PROTOCOL_REPAIR_POLICY_MISMATCH",
    );
  }
  return derived;
}
