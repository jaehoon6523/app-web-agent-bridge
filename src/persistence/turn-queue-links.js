import {
  SHA256_DIGEST_PATTERN,
  validateAgentTurnInput,
} from "../domain/agent-messages.js";
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
import {
  getAgentMessageByInputEntity,
  getAgentTurnInputEntity,
} from "./agent-communications.js";
import { getAgentPacketRejectionByDeliveryEntity } from "./agent-packet-rejections.js";
import { DeliveryState } from "./schema.js";
import { verifyTurnSubmissionLinksEntity } from "./turn-submission-links.js";

const QUEUE_EVENT_TYPE = "AGENT_TURN_QUEUED";
const PAYLOAD_KEYS = Object.freeze(["run", "details"]);
const DETAIL_KEYS = Object.freeze([
  "inputId",
  "inputHash",
  "deliveryId",
  "idempotencyKeyHash",
  "targetActor",
  "sourceMessageId",
]);
const TERMINAL_PHASES = new Set([
  RunPhase.COMPLETE,
  RunPhase.FAILED,
  RunPhase.CANCELLED,
]);
const SETTLED_DELIVERY_STATES = new Set([
  DeliveryState.RESPONSE_COMPLETED,
  DeliveryState.RELAYED,
]);
const PENDING_ACTOR_BY_PHASE = Object.freeze({
  [RunPhase.CODEX_TURN_PENDING]: AgentActor.CODEX_AGENT,
  [RunPhase.CODEX_TO_WEB_PENDING]: AgentActor.CHATGPT_WEB_AGENT,
  [RunPhase.WEB_TO_CODEX_PENDING]: AgentActor.CODEX_AGENT,
});

function integrity(errors, context, message, options = undefined) {
  throw new errors.EventChainIntegrityError(`${context} ${message}`, options);
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

function requireString(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return value;
}

function requireHash(value, context) {
  if (typeof value !== "string" || !SHA256_DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${context} must be a sha256 digest`);
  }
  return value;
}

function decodeCanonical(text, context, validator, errors) {
  try {
    const value = JSON.parse(text);
    if (canonicalJson(value) !== text) throw new TypeError("value must be canonical JSON");
    validator(value);
    return value;
  } catch (cause) {
    integrity(errors, context, "has invalid canonical JSON", { cause });
  }
}

function decodeQueueEvent(row, errors) {
  const context = `turn queue event ${row.run_id}/${row.sequence}`;
  const payload = decodeCanonical(
    row.payload_json,
    context,
    (value) => requireExactObject(value, PAYLOAD_KEYS, "payload"),
    errors,
  );
  try {
    validateAgentRun(payload.run);
    if (payload.run.runId !== row.run_id) {
      throw new TypeError("payload run does not match event ownership");
    }
    const details = requireExactObject(payload.details, DETAIL_KEYS, "details");
    requireString(details.inputId, "details.inputId");
    requireHash(details.inputHash, "details.inputHash");
    requireString(details.deliveryId, "details.deliveryId");
    requireHash(details.idempotencyKeyHash, "details.idempotencyKeyHash");
    if (!Object.values(AgentActor).includes(details.targetActor)) {
      throw new TypeError("details.targetActor must be an AgentActor");
    }
    if (details.sourceMessageId !== null) {
      requireString(details.sourceMessageId, "details.sourceMessageId");
    }
    return { run: payload.run, details };
  } catch (cause) {
    integrity(errors, context, "has invalid queue evidence", { cause });
  }
}

function expectedQueuePhase(input) {
  if (input.kind === AgentTurnInputKind.INITIAL_OBJECTIVE) {
    if (
      input.targetActor !== AgentActor.CODEX_AGENT
      || input.sourceMessageId !== null
    ) return null;
    return RunPhase.CODEX_TURN_PENDING;
  }
  if (input.kind !== AgentTurnInputKind.PEER_RELAY || input.sourceMessageId === null) {
    return null;
  }
  return input.targetActor === AgentActor.CHATGPT_WEB_AGENT
    ? RunPhase.CODEX_TO_WEB_PENDING
    : RunPhase.WEB_TO_CODEX_PENDING;
}

function verifyQueueLink(database, row, decoded, errors) {
  const context = `turn queue event ${row.run_id}/${row.sequence}`;
  const { run, details } = decoded;
  const input = getAgentTurnInputEntity(database, details.inputId, errors);
  const delivery = database.prepare(`
    SELECT run_id, input_id, idempotency_key, created_at
    FROM delivery_attempts
    WHERE delivery_id = ?
  `).get(details.deliveryId);
  if (
    !input
    || input.runId !== row.run_id
    || sha256CanonicalJson(input) !== details.inputHash
    || input.targetActor !== details.targetActor
    || input.sourceMessageId !== details.sourceMessageId
    || !delivery
    || delivery.run_id !== row.run_id
    || delivery.input_id !== input.inputId
    || sha256Text(delivery.idempotency_key) !== details.idempotencyKeyHash
    || input.createdAt !== row.created_at
    || delivery.created_at !== row.created_at
  ) {
    integrity(errors, context, "input/delivery evidence is inconsistent");
  }
  const expectedPhase = expectedQueuePhase(input);
  if (expectedPhase === null || run.phase !== expectedPhase) {
    integrity(errors, context, "does not describe an authorized queued discussion turn");
  }
  validateAgentTurnInput(input);
  return { input, delivery };
}

function currentRun(database, runId, errors) {
  const row = database.prepare("SELECT run_json FROM runs WHERE run_id = ?").get(runId);
  if (!row) integrity(errors, `run ${runId}`, "does not exist");
  return decodeCanonical(row.run_json, `run ${runId}`, validateAgentRun, errors);
}

function verifyRunCoverage(database, runId, queuedInputIds, errors) {
  const inputs = database.prepare(`
    SELECT input_id, kind FROM agent_turn_inputs WHERE run_id = ?
  `).all(runId);
  const nonRepairInputs = inputs.filter(({ kind }) => kind !== AgentTurnInputKind.PROTOCOL_REPAIR);
  if (
    nonRepairInputs.length !== queuedInputIds.size
    || nonRepairInputs.some(({ input_id: inputId }) => !queuedInputIds.has(inputId))
  ) {
    integrity(errors, `run ${runId}`, "has a non-repair turn input without exact queue evidence");
  }

  const run = currentRun(database, runId, errors);
  const deliveries = database.prepare(`
    SELECT delivery_id, input_id, state
    FROM delivery_attempts
    WHERE run_id = ?
  `).all(runId);
  const expectedPendingActor = PENDING_ACTOR_BY_PHASE[run.phase] ?? null;
  if (expectedPendingActor !== null) {
    const unsettled = deliveries.filter(({ state }) => !SETTLED_DELIVERY_STATES.has(state));
    if (unsettled.length !== 1) {
      integrity(errors, `run ${runId}`, "pending phase must have exactly one unsettled delivery");
    }
    const input = getAgentTurnInputEntity(database, unsettled[0].input_id, errors);
    if (!input || input.targetActor !== expectedPendingActor) {
      integrity(errors, `run ${runId}`, "pending delivery actor does not match the run phase");
    }
  }

  if (!TERMINAL_PHASES.has(run.phase)) return;
  for (const delivery of deliveries) {
    if (!SETTLED_DELIVERY_STATES.has(delivery.state)) {
      integrity(errors, `terminal run ${runId}`, `retains unsettled delivery ${delivery.delivery_id}`);
    }
    const message = getAgentMessageByInputEntity(database, delivery.input_id, errors);
    const rejection = getAgentPacketRejectionByDeliveryEntity(
      database,
      delivery.delivery_id,
      errors,
    );
    if ((message === null) === (rejection === null)) {
      integrity(
        errors,
        `terminal run ${runId}`,
        `delivery ${delivery.delivery_id} must have exactly one canonical response`,
      );
    }
  }
}

/** Verifies durable queue provenance and fail-closed terminal delivery closure. */
export function verifyTurnQueueLinksEntity(database, errors) {
  const rows = database.prepare(`
    SELECT run_id, sequence, payload_json, created_at
    FROM domain_events
    WHERE event_type = ?
    ORDER BY run_id, sequence
  `).all(QUEUE_EVENT_TYPE);
  const queuedByRun = new Map();

  for (const row of rows) {
    const decoded = decodeQueueEvent(row, errors);
    const { input } = verifyQueueLink(database, row, decoded, errors);
    const queued = queuedByRun.get(row.run_id) ?? new Set();
    if (queued.has(input.inputId)) {
      integrity(errors, `run ${row.run_id}`, `duplicates queue evidence for ${input.inputId}`);
    }
    queued.add(input.inputId);
    queuedByRun.set(row.run_id, queued);
  }

  const inputRunIds = database.prepare(`
    SELECT DISTINCT run_id FROM agent_turn_inputs ORDER BY run_id
  `).all().map(({ run_id: runId }) => runId);
  for (const runId of new Set([...queuedByRun.keys(), ...inputRunIds])) {
    verifyRunCoverage(database, runId, queuedByRun.get(runId) ?? new Set(), errors);
  }
  const submissionResult = verifyTurnSubmissionLinksEntity(database, errors);
  return Object.freeze({
    valid: true,
    queuedTurns: rows.length,
    submittedTurns: submissionResult.submittedTurns,
  });
}
