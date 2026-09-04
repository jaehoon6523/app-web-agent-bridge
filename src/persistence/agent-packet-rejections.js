import {
  AGENT_PACKET_REJECTED_EVENT_TYPE,
  AgentPacketRejectionRecoverability,
  buildAgentPacketRejectedEvent,
} from "../domain/agent-packet-rejection.js";
import {
  canonicalJson,
  sha256CanonicalJson,
  sha256Text,
} from "../domain/canonical-json.js";
import { validateAgentRun } from "../domain/contracts.js";
import {
  AgentActor,
  AgentTurnInputKind,
  RunPhase,
} from "../domain/vocabulary.js";
import { getAgentTurnInputEntity } from "./agent-communications.js";
import { getAgentSessionEntity } from "./sqlite-entities.js";
import { DeliveryState } from "./schema.js";
import { getTurnSubmissionEvidenceByDeliveryEntity } from "./turn-submission-links.js";

const PAYLOAD_KEYS = Object.freeze(["run", "details"]);

function integrity(errors, context, message, options = undefined) {
  throw new errors.EventChainIntegrityError(`${context} ${message}`, options);
}

function requireDeliveryId(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("deliveryId must be a non-empty string");
  }
  return value;
}

function requireExactObject(value, keys, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${context} must be a plain object`);
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new TypeError(`${context} contains unsupported property ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${context} is missing ${key}`);
  }
  return value;
}

function decodeRejectionRow(row, errors) {
  const context = `agent packet rejection event ${row.run_id}/${row.sequence}`;
  try {
    const payload = JSON.parse(row.payload_json);
    if (canonicalJson(payload) !== row.payload_json) {
      throw new TypeError("payload must be canonical JSON");
    }
    requireExactObject(payload, PAYLOAD_KEYS, "payload");
    validateAgentRun(payload.run);
    const rejection = buildAgentPacketRejectedEvent(payload.details);
    if (
      payload.run.runId !== row.run_id
      || rejection.runId !== row.run_id
      || rejection.eventType !== row.event_type
      || rejection.createdAt !== row.created_at
    ) {
      throw new TypeError("event metadata is not bound to its payload");
    }
    const expectedPhase = rejection.actor === AgentActor.CODEX_AGENT
      ? RunPhase.CODEX_RESPONSE_STORED
      : RunPhase.WEB_RESPONSE_STORED;
    if (payload.run.phase !== expectedPhase || payload.run.activeActor !== null) {
      throw new TypeError("event run state does not match the rejected Agent response");
    }
    return rejection;
  } catch (cause) {
    integrity(errors, context, "has invalid canonical payload", { cause });
  }
}

function rejectionRows(database, runId = null) {
  return runId === null
    ? database.prepare(`
        SELECT run_id, sequence, event_type, payload_json, created_at
        FROM domain_events
        WHERE event_type = ?
        ORDER BY run_id, sequence
      `).all(AGENT_PACKET_REJECTED_EVENT_TYPE)
    : database.prepare(`
        SELECT run_id, sequence, event_type, payload_json, created_at
        FROM domain_events
        WHERE run_id = ? AND event_type = ?
        ORDER BY sequence
      `).all(runId, AGENT_PACKET_REJECTED_EVENT_TYPE);
}

function verifyRejectionLinks(database, row, rejection, errors) {
  const context = `agent packet rejection event ${row.run_id}/${row.sequence}`;
  const delivery = database.prepare(`
    SELECT run_id, input_id, state, provider_receipt_json
    FROM delivery_attempts WHERE delivery_id = ?
  `).get(rejection.deliveryId);
  if (!delivery || delivery.run_id !== row.run_id) {
    integrity(errors, context, "delivery ownership is inconsistent");
  }
  if (delivery.state !== DeliveryState.RESPONSE_COMPLETED) {
    integrity(
      errors,
      context,
      `delivery ${rejection.deliveryId} must remain RESPONSE_COMPLETED`,
    );
  }

  try {
    const providerReceipt = JSON.parse(delivery.provider_receipt_json);
    if (
      canonicalJson(providerReceipt) !== delivery.provider_receipt_json
      || providerReceipt === null
      || typeof providerReceipt !== "object"
      || Array.isArray(providerReceipt)
      || providerReceipt.externalTurnId !== rejection.turnId
    ) {
      throw new TypeError("provider receipt does not identify the rejected turn");
    }
  } catch (cause) {
    integrity(errors, context, "provider receipt/rejection turn link is inconsistent", { cause });
  }

  const input = getAgentTurnInputEntity(database, delivery.input_id, errors);
  if (
    !input
    || input.runId !== row.run_id
    || input.targetActor !== rejection.actor
  ) {
    integrity(errors, context, "delivery/input attribution is inconsistent");
  }

  const session = getAgentSessionEntity(database, rejection.sessionId, errors);
  if (
    !session
    || session.runId !== row.run_id
    || session.actor !== rejection.actor
  ) {
    integrity(errors, context, "session attribution is inconsistent");
  }

  const submission = getTurnSubmissionEvidenceByDeliveryEntity(
    database,
    rejection.deliveryId,
    errors,
  );
  if (
    submission === null
    || submission.sessionId !== rejection.sessionId
    || submission.turnId !== rejection.turnId
  ) {
    integrity(errors, context, "submission/rejection session and turn attribution is inconsistent");
  }

  const conflictingMessage = database.prepare(`
    SELECT message_id FROM agent_messages
    WHERE input_id = ? OR (session_id = ? AND turn_id = ?)
    LIMIT 1
  `).get(delivery.input_id, rejection.sessionId, rejection.turnId);
  if (conflictingMessage) {
    integrity(
      errors,
      context,
      `conflicts with canonical AgentMessage ${conflictingMessage.message_id}`,
    );
  }

  const requiresRepair = rejection.recoverability
    === AgentPacketRejectionRecoverability.REPAIRABLE;
  if ((rejection.repair !== null) !== requiresRepair) {
    integrity(errors, context, "repair link does not match rejection recoverability");
  }
  if (rejection.repair !== null) {
    const repairInput = getAgentTurnInputEntity(database, rejection.repair.inputId, errors);
    const repairDelivery = database.prepare(`
      SELECT run_id, input_id, idempotency_key
      FROM delivery_attempts
      WHERE delivery_id = ?
    `).get(rejection.repair.deliveryId);
    if (
      !repairInput
      || repairInput.runId !== row.run_id
      || repairInput.kind !== AgentTurnInputKind.PROTOCOL_REPAIR
      || repairInput.targetActor !== rejection.actor
      || repairInput.targetActor !== rejection.repair.targetActor
      || repairInput.sourceMessageId !== rejection.repair.sourceMessageId
      || sha256CanonicalJson(repairInput) !== rejection.repair.inputHash
      || repairInput.payload?.rejectedDeliveryId !== rejection.deliveryId
      || !repairDelivery
      || repairDelivery.run_id !== row.run_id
      || repairDelivery.input_id !== repairInput.inputId
      || sha256Text(repairDelivery.idempotency_key)
        !== rejection.repair.idempotencyKeyHash
    ) {
      integrity(errors, context, "protocol repair input/delivery link is inconsistent");
    }
  }

  return Object.freeze({ rejection, inputId: delivery.input_id });
}

function readVerifiedRejections(database, runId, errors) {
  const seenDeliveries = new Set();
  const seenTurns = new Set();
  const verified = [];
  for (const row of rejectionRows(database, runId)) {
    const rejection = decodeRejectionRow(row, errors);
    if (seenDeliveries.has(rejection.deliveryId)) {
      integrity(
        errors,
        `agent packet rejection event ${row.run_id}/${row.sequence}`,
        `duplicates delivery ${rejection.deliveryId}`,
      );
    }
    seenDeliveries.add(rejection.deliveryId);

    const turnKey = canonicalJson([
      rejection.runId,
      rejection.sessionId,
      rejection.turnId,
    ]);
    if (seenTurns.has(turnKey)) {
      integrity(
        errors,
        `agent packet rejection event ${row.run_id}/${row.sequence}`,
        `duplicates attributed turn ${rejection.sessionId}/${rejection.turnId}`,
      );
    }
    seenTurns.add(turnKey);
    verified.push(verifyRejectionLinks(database, row, rejection, errors));
  }
  return verified;
}

/**
 * Returns the one canonical rejection for a delivery, or null when none was
 * recorded. Any malformed, cross-run, duplicate, or valid-message-conflicting
 * rejection fails closed instead of being treated as a settled response.
 */
export function getAgentPacketRejectionByDeliveryEntity(database, deliveryId, errors) {
  requireDeliveryId(deliveryId);
  const delivery = database.prepare(`
    SELECT run_id FROM delivery_attempts WHERE delivery_id = ?
  `).get(deliveryId);
  if (!delivery) return null;
  const matches = readVerifiedRejections(database, delivery.run_id, errors)
    .filter((entry) => entry.rejection.deliveryId === deliveryId);
  return matches.length === 0 ? null : matches[0].rejection;
}

/** Verifies every persisted rejection and its durable attribution graph. */
export function verifyAgentPacketRejectionsEntity(database, errors) {
  const verified = readVerifiedRejections(database, null, errors);
  const expectedRepairInputs = new Set(
    verified.flatMap(({ rejection }) => (
      rejection.repair === null ? [] : [rejection.repair.inputId]
    )),
  );
  const actualRepairInputs = database.prepare(`
    SELECT input_id FROM agent_turn_inputs WHERE kind = ?
  `).all(AgentTurnInputKind.PROTOCOL_REPAIR);
  if (
    actualRepairInputs.length !== expectedRepairInputs.size
    || actualRepairInputs.some(({ input_id: inputId }) => !expectedRepairInputs.has(inputId))
  ) {
    integrity(errors, "agent packet rejection graph", "has an unbound protocol repair input");
  }
  return Object.freeze({ valid: true, rejections: verified.length });
}
