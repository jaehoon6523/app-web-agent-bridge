import { validateRunLimits, validateRunOutcome } from "../domain/run-state-machine.js";
import { buildAgentTurnInput, SHA256_DIGEST_PATTERN } from "../domain/agent-messages.js";
import {
  AGENT_PACKET_REJECTED_EVENT_TYPE,
  AgentPacketParserStage,
  AgentPacketRejectionRecoverability,
  buildAgentPacketRejectedEvent,
} from "../domain/agent-packet-rejection.js";
import {
  AgentActor,
  AgentPacketType,
  AgentTurnInputKind,
  RunOutcomeType,
  isVocabularyValue,
} from "../domain/vocabulary.js";
import { createRunOutcome } from "../domain/run-state-machine.js";
import { nextProtocolRepairCount } from "./run-limits.js";

export const ProtocolFailureDecisionStatus = Object.freeze({
  REPAIR_REQUIRED: "REPAIR_REQUIRED",
  FAILED: "FAILED",
  AUTHORITY_REQUIRED: "AUTHORITY_REQUIRED",
});

export const AGENT_PROTOCOL_REPAIR_EXHAUSTED = "AGENT_PROTOCOL_REPAIR_EXHAUSTED";
export const EXPECTED_PACKET_TYPE_REQUIRED = "EXPECTED_PACKET_TYPE_REQUIRED";

const ATTRIBUTION_FIELDS = Object.freeze([
  "runId",
  "actor",
  "sessionId",
  "turnId",
  "deliveryId",
  "objectiveHash",
  "policyHash",
]);

const REPAIR_INPUT_DRAFT_FIELDS = Object.freeze([
  "inputId",
  "instructionId",
  "promptTemplateVersion",
  "promptHash",
  "createdAt",
]);

export const PROTOCOL_REPAIR_PAYLOAD_FIELDS = Object.freeze([
  "rejectedDeliveryId",
  "parserStage",
  "errorCode",
  "errorSummary",
  "expectedPacketType",
]);

const DECISION_FIELDS = Object.freeze([
  "status",
  "rejectionEvent",
  "protocolRepairsUsed",
  "repairContext",
  "outcome",
  "reason",
]);

const REPAIR_CONTEXT_FIELDS = Object.freeze([
  "runId",
  "targetActor",
  "objectiveHash",
  "policyHash",
  "expectedPacketType",
]);

export class ProtocolFailureDecisionError extends TypeError {
  constructor(message, code = "INVALID_PROTOCOL_FAILURE_INPUT") {
    super(message);
    this.name = "ProtocolFailureDecisionError";
    this.code = code;
  }
}

function requirePlainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolFailureDecisionError(`${name} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProtocolFailureDecisionError(`${name} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ProtocolFailureDecisionError(`${name} must not contain symbol properties.`);
  }
  return value;
}

function requireExactKeys(value, fields, name) {
  requirePlainObject(value, name);
  const expected = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new ProtocolFailureDecisionError(
        `${name} contains unsupported property ${JSON.stringify(key)}.`,
      );
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw new ProtocolFailureDecisionError(
        `${name} is missing required property ${JSON.stringify(field)}.`,
      );
    }
  }
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProtocolFailureDecisionError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireHash(value, name) {
  if (typeof value !== "string" || !SHA256_DIGEST_PATTERN.test(value)) {
    throw new ProtocolFailureDecisionError(
      `${name} must be a sha256:<64 lowercase hex> digest.`,
    );
  }
  return value;
}

export function validateProtocolRepairPayload(value) {
  const payload = requireExactKeys(
    value,
    PROTOCOL_REPAIR_PAYLOAD_FIELDS,
    "protocol repair payload",
  );
  requireNonEmptyString(payload.rejectedDeliveryId, "protocol repair payload.rejectedDeliveryId");
  if (!isVocabularyValue(AgentPacketParserStage, payload.parserStage)) {
    throw new ProtocolFailureDecisionError(
      "protocol repair payload.parserStage must be an AgentPacketParserStage.",
    );
  }
  requireNonEmptyString(payload.errorCode, "protocol repair payload.errorCode");
  requireNonEmptyString(payload.errorSummary, "protocol repair payload.errorSummary");
  if (!isVocabularyValue(AgentPacketType, payload.expectedPacketType)) {
    throw new ProtocolFailureDecisionError(
      "protocol repair payload.expectedPacketType must be an AgentPacketType.",
    );
  }
  return payload;
}

export function buildProtocolRepairPayload(decision) {
  validateProtocolFailureDecision(decision);
  if (
    decision?.status !== ProtocolFailureDecisionStatus.REPAIR_REQUIRED
    || decision.repairContext === null
  ) {
    throw new ProtocolFailureDecisionError(
      "A REPAIR_REQUIRED decision is required to build a protocol repair payload.",
      "PROTOCOL_REPAIR_NOT_AUTHORIZED",
    );
  }
  const payload = validateProtocolRepairPayload({
    rejectedDeliveryId: decision.rejectionEvent.deliveryId,
    parserStage: decision.rejectionEvent.parserStage,
    errorCode: decision.rejectionEvent.errorCode,
    errorSummary: decision.rejectionEvent.errorSummary,
    expectedPacketType: decision.repairContext.expectedPacketType,
  });
  return deepFreeze(structuredClone(payload));
}

function requireConfirmedAttribution(value) {
  const attribution = requireExactKeys(value, ATTRIBUTION_FIELDS, "confirmedAttribution");
  requireNonEmptyString(attribution.runId, "confirmedAttribution.runId");
  if (!isVocabularyValue(AgentActor, attribution.actor)) {
    throw new ProtocolFailureDecisionError(
      "confirmedAttribution.actor must be an AgentActor.",
      "RESPONSE_ATTRIBUTION_NOT_CONFIRMED",
    );
  }
  requireNonEmptyString(attribution.sessionId, "confirmedAttribution.sessionId");
  requireNonEmptyString(attribution.turnId, "confirmedAttribution.turnId");
  requireNonEmptyString(attribution.deliveryId, "confirmedAttribution.deliveryId");
  requireHash(attribution.objectiveHash, "confirmedAttribution.objectiveHash");
  requireHash(attribution.policyHash, "confirmedAttribution.policyHash");
  return attribution;
}

function requireRepairCount(value, limits) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolFailureDecisionError(
      "protocolRepairsUsed must be a non-negative safe integer.",
    );
  }
  if (value > limits.maxProtocolRepairs) {
    throw new ProtocolFailureDecisionError(
      "protocolRepairsUsed must not exceed limits.maxProtocolRepairs.",
      "PROTOCOL_REPAIR_COUNTER_INVALID",
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

function result(value) {
  const decision = structuredClone(value);
  validateProtocolFailureDecision(decision);
  return deepFreeze(decision);
}

function requireNull(value, name) {
  if (value !== null) {
    throw new ProtocolFailureDecisionError(`${name} must be null.`);
  }
}

function requireDecisionRepairContext(value, rejectionEvent) {
  const context = requireExactKeys(value, REPAIR_CONTEXT_FIELDS, "repairContext");
  requireNonEmptyString(context.runId, "repairContext.runId");
  if (!isVocabularyValue(AgentActor, context.targetActor)) {
    throw new ProtocolFailureDecisionError("repairContext.targetActor must be an AgentActor.");
  }
  requireHash(context.objectiveHash, "repairContext.objectiveHash");
  requireHash(context.policyHash, "repairContext.policyHash");
  if (!isVocabularyValue(AgentPacketType, context.expectedPacketType)) {
    throw new ProtocolFailureDecisionError(
      "repairContext.expectedPacketType must be an AgentPacketType.",
    );
  }
  if (context.runId !== rejectionEvent.runId) {
    throw new ProtocolFailureDecisionError(
      "repairContext.runId must match rejectionEvent.runId.",
      "PROTOCOL_FAILURE_DECISION_BINDING_MISMATCH",
    );
  }
  if (context.targetActor !== rejectionEvent.actor) {
    throw new ProtocolFailureDecisionError(
      "repairContext.targetActor must match rejectionEvent.actor.",
      "PROTOCOL_FAILURE_DECISION_BINDING_MISMATCH",
    );
  }
  return context;
}

export function validateProtocolFailureDecision(value) {
  const decision = requireExactKeys(value, DECISION_FIELDS, "ProtocolFailureDecision");
  const rejectionEvent = buildAgentPacketRejectedEvent(decision.rejectionEvent);
  if (!Number.isSafeInteger(decision.protocolRepairsUsed) || decision.protocolRepairsUsed < 0) {
    throw new ProtocolFailureDecisionError(
      "protocolRepairsUsed must be a non-negative safe integer.",
    );
  }
  if (decision.protocolRepairsUsed !== rejectionEvent.protocolRepairsUsed) {
    throw new ProtocolFailureDecisionError(
      "protocolRepairsUsed must match rejectionEvent.protocolRepairsUsed.",
      "PROTOCOL_FAILURE_DECISION_BINDING_MISMATCH",
    );
  }

  switch (decision.status) {
    case ProtocolFailureDecisionStatus.REPAIR_REQUIRED:
      if (rejectionEvent.recoverability !== AgentPacketRejectionRecoverability.REPAIRABLE) {
        throw new ProtocolFailureDecisionError(
          "REPAIR_REQUIRED requires REPAIRABLE recoverability.",
          "PROTOCOL_FAILURE_DECISION_BINDING_MISMATCH",
        );
      }
      if (decision.protocolRepairsUsed < 1) {
        throw new ProtocolFailureDecisionError(
          "REPAIR_REQUIRED must record a reserved protocol repair.",
          "PROTOCOL_FAILURE_DECISION_BINDING_MISMATCH",
        );
      }
      requireDecisionRepairContext(decision.repairContext, rejectionEvent);
      requireNull(decision.outcome, "REPAIR_REQUIRED outcome");
      requireNull(decision.reason, "REPAIR_REQUIRED reason");
      break;
    case ProtocolFailureDecisionStatus.FAILED:
      if (rejectionEvent.recoverability !== AgentPacketRejectionRecoverability.EXHAUSTED) {
        throw new ProtocolFailureDecisionError(
          "FAILED requires EXHAUSTED recoverability.",
          "PROTOCOL_FAILURE_DECISION_BINDING_MISMATCH",
        );
      }
      requireNull(decision.repairContext, "FAILED repairContext");
      validateRunOutcome(decision.outcome);
      if (
        decision.outcome.type !== RunOutcomeType.FAILED
        || decision.outcome.errorCode !== AGENT_PROTOCOL_REPAIR_EXHAUSTED
      ) {
        throw new ProtocolFailureDecisionError(
          `FAILED outcome must be ${AGENT_PROTOCOL_REPAIR_EXHAUSTED}.`,
          "PROTOCOL_FAILURE_DECISION_BINDING_MISMATCH",
        );
      }
      requireNull(decision.reason, "FAILED reason");
      break;
    case ProtocolFailureDecisionStatus.AUTHORITY_REQUIRED:
      if (rejectionEvent.recoverability !== AgentPacketRejectionRecoverability.AMBIGUOUS) {
        throw new ProtocolFailureDecisionError(
          "AUTHORITY_REQUIRED requires AMBIGUOUS recoverability.",
          "PROTOCOL_FAILURE_DECISION_BINDING_MISMATCH",
        );
      }
      requireNull(decision.repairContext, "AUTHORITY_REQUIRED repairContext");
      requireNull(decision.outcome, "AUTHORITY_REQUIRED outcome");
      if (decision.reason !== EXPECTED_PACKET_TYPE_REQUIRED) {
        throw new ProtocolFailureDecisionError(
          `AUTHORITY_REQUIRED reason must be ${EXPECTED_PACKET_TYPE_REQUIRED}.`,
          "PROTOCOL_FAILURE_DECISION_BINDING_MISMATCH",
        );
      }
      break;
    default:
      throw new ProtocolFailureDecisionError(
        "ProtocolFailureDecision.status is not supported.",
      );
  }
  return decision;
}

/**
 * Produces a persistence-neutral decision for a terminal response whose run,
 * actor, session, turn, and delivery have already been independently matched.
 * Ambiguous response attribution must be routed to recovery before calling
 * this function; this function never invents those identifiers.
 * @param {any} [input]
 */
export function decideAgentPacketRejection(input = {}) {
  const {
    confirmedAttribution,
    parserStage,
    errorCode,
    errorSummary,
    rawResponseArtifactHash,
    limits,
    protocolRepairsUsed,
    expectedPacketType = null,
    createdAt,
  } = input;
  const attribution = requireConfirmedAttribution(confirmedAttribution);
  validateRunLimits(limits);
  const currentRepairCount = requireRepairCount(protocolRepairsUsed, limits);

  const canRepair = currentRepairCount < limits.maxProtocolRepairs;
  if (!canRepair) {
    const rejectionEvent = buildAgentPacketRejectedEvent({
      eventType: AGENT_PACKET_REJECTED_EVENT_TYPE,
      runId: attribution.runId,
      actor: attribution.actor,
      sessionId: attribution.sessionId,
      turnId: attribution.turnId,
      deliveryId: attribution.deliveryId,
      parserStage,
      errorCode,
      errorSummary,
      rawResponseArtifactHash,
      protocolRepairsUsed: currentRepairCount,
      recoverability: AgentPacketRejectionRecoverability.EXHAUSTED,
      createdAt,
    });
    return result({
      status: ProtocolFailureDecisionStatus.FAILED,
      rejectionEvent,
      protocolRepairsUsed: currentRepairCount,
      repairContext: null,
      outcome: createRunOutcome({
        type: RunOutcomeType.FAILED,
        errorCode: AGENT_PROTOCOL_REPAIR_EXHAUSTED,
      }),
      reason: null,
    });
  }

  if (!isVocabularyValue(AgentPacketType, expectedPacketType)) {
    const rejectionEvent = buildAgentPacketRejectedEvent({
      eventType: AGENT_PACKET_REJECTED_EVENT_TYPE,
      runId: attribution.runId,
      actor: attribution.actor,
      sessionId: attribution.sessionId,
      turnId: attribution.turnId,
      deliveryId: attribution.deliveryId,
      parserStage,
      errorCode,
      errorSummary,
      rawResponseArtifactHash,
      protocolRepairsUsed: currentRepairCount,
      recoverability: AgentPacketRejectionRecoverability.AMBIGUOUS,
      createdAt,
    });
    return result({
      status: ProtocolFailureDecisionStatus.AUTHORITY_REQUIRED,
      rejectionEvent,
      protocolRepairsUsed: currentRepairCount,
      repairContext: null,
      outcome: null,
      reason: EXPECTED_PACKET_TYPE_REQUIRED,
    });
  }

  const nextRepairCount = nextProtocolRepairCount(limits, currentRepairCount);
  const rejectionEvent = buildAgentPacketRejectedEvent({
    eventType: AGENT_PACKET_REJECTED_EVENT_TYPE,
    runId: attribution.runId,
    actor: attribution.actor,
    sessionId: attribution.sessionId,
    turnId: attribution.turnId,
    deliveryId: attribution.deliveryId,
    parserStage,
    errorCode,
    errorSummary,
    rawResponseArtifactHash,
    protocolRepairsUsed: nextRepairCount,
    recoverability: AgentPacketRejectionRecoverability.REPAIRABLE,
    createdAt,
  });
  return result({
    status: ProtocolFailureDecisionStatus.REPAIR_REQUIRED,
    rejectionEvent,
    protocolRepairsUsed: nextRepairCount,
    repairContext: {
      runId: attribution.runId,
      targetActor: attribution.actor,
      objectiveHash: attribution.objectiveHash,
      policyHash: attribution.policyHash,
      expectedPacketType,
    },
    outcome: null,
    reason: null,
  });
}

/**
 * Binds caller-owned prompt material to the route fixed by a repair decision.
 * The caller remains responsible for rendering a prompt whose hash is the
 * supplied promptHash; dispatch and durable outbox creation belong to the
 * atomic response handler.
 */
export function buildProtocolRepairTurnInput(decision, draft) {
  validateProtocolFailureDecision(decision);
  if (
    decision?.status !== ProtocolFailureDecisionStatus.REPAIR_REQUIRED
    || decision.repairContext === null
  ) {
    throw new ProtocolFailureDecisionError(
      "A REPAIR_REQUIRED decision is required to build a protocol repair input.",
      "PROTOCOL_REPAIR_NOT_AUTHORIZED",
    );
  }
  const input = requireExactKeys(draft, REPAIR_INPUT_DRAFT_FIELDS, "repair input draft");
  return buildAgentTurnInput({
    inputId: input.inputId,
    runId: decision.repairContext.runId,
    targetActor: decision.repairContext.targetActor,
    kind: AgentTurnInputKind.PROTOCOL_REPAIR,
    sourceMessageId: null,
    instructionId: input.instructionId,
    promptTemplateVersion: input.promptTemplateVersion,
    payload: buildProtocolRepairPayload(decision),
    promptHash: input.promptHash,
    objectiveHash: decision.repairContext.objectiveHash,
    policyHash: decision.repairContext.policyHash,
    createdAt: input.createdAt,
  });
}
