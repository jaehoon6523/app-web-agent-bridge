import { SHA256_DIGEST_PATTERN } from "../domain/agent-messages.js";
import { canonicalJson, sha256CanonicalJson } from "../domain/canonical-json.js";
import { validateAgentRun } from "../domain/contracts.js";
import {
  AgentActor,
  AgentSessionStatus,
  AgentTurnInputKind,
  RunPhase,
} from "../domain/vocabulary.js";
import { getAgentTurnInputEntity } from "./agent-communications.js";
import { DeliveryState } from "./schema.js";
import { getAgentSessionEntity } from "./sqlite-entities.js";

const SUBMISSION_EVENT_TYPES = Object.freeze([
  "AGENT_TURN_SUBMITTED",
  "PROTOCOL_REPAIR_TURN_STARTED",
]);
const PAYLOAD_KEYS = Object.freeze(["run", "details"]);
const DETAIL_KEYS = Object.freeze([
  "deliveryId",
  "inputId",
  "targetActor",
  "sessionId",
  "turnId",
  "providerReceiptHash",
  "attemptCount",
]);
const RUNNING_PHASE_BY_ACTOR = Object.freeze({
  [AgentActor.CODEX_AGENT]: RunPhase.CODEX_TURN_RUNNING,
  [AgentActor.CHATGPT_WEB_AGENT]: RunPhase.WEB_TURN_RUNNING,
});
const RECEIPT_REQUIRED_STATES = new Set([
  DeliveryState.SUBMITTED,
  DeliveryState.RESPONSE_STARTED,
  DeliveryState.RESPONSE_COMPLETED,
  DeliveryState.RELAYED,
]);
const RECEIPT_FORBIDDEN_STATES = new Set([
  DeliveryState.PENDING,
  DeliveryState.DISPATCHING,
]);
const CURRENT_IN_FLIGHT_STATES = new Set([
  DeliveryState.SUBMITTED,
  DeliveryState.RESPONSE_STARTED,
]);

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

function decodeSubmissionEvent(row, errors) {
  const context = `turn submission event ${row.run_id}/${row.sequence}`;
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
    for (const key of ["deliveryId", "inputId", "sessionId", "turnId"]) {
      requireString(details[key], `details.${key}`);
    }
    requireHash(details.providerReceiptHash, "details.providerReceiptHash");
    if (!Number.isSafeInteger(details.attemptCount) || details.attemptCount < 1) {
      throw new TypeError("details.attemptCount must be a positive safe integer");
    }
    if (!Object.values(AgentActor).includes(details.targetActor)) {
      throw new TypeError("details.targetActor must be an AgentActor");
    }
    return { run: payload.run, details };
  } catch (cause) {
    integrity(errors, context, "has invalid submission evidence", { cause });
  }
}

function verifySubmissionRow(database, row, errors) {
  const context = `turn submission event ${row.run_id}/${row.sequence}`;
  const decoded = decodeSubmissionEvent(row, errors);
  const { run, details } = decoded;
  const input = getAgentTurnInputEntity(database, details.inputId, errors);
  const delivery = database.prepare(`
    SELECT delivery_id, run_id, input_id, attempt_count, provider_receipt_json
    FROM delivery_attempts
    WHERE delivery_id = ?
  `).get(details.deliveryId);
  const session = getAgentSessionEntity(database, details.sessionId, errors);
  const expectedEventType = input?.kind === AgentTurnInputKind.PROTOCOL_REPAIR
    ? "PROTOCOL_REPAIR_TURN_STARTED"
    : "AGENT_TURN_SUBMITTED";
  if (
    !input
    || input.runId !== row.run_id
    || input.targetActor !== details.targetActor
    || !delivery
    || delivery.run_id !== row.run_id
    || delivery.input_id !== input.inputId
    || Number(delivery.attempt_count) < details.attemptCount
    || !session
    || session.runId !== row.run_id
    || session.actor !== input.targetActor
    || row.event_type !== expectedEventType
    || run.phase !== RUNNING_PHASE_BY_ACTOR[input.targetActor]
    || run.activeActor !== input.targetActor
  ) {
    integrity(errors, context, "input/delivery/session attribution is inconsistent");
  }
  return Object.freeze({ row, run, details, delivery, session });
}

function submissionRows(database, runId = null) {
  return runId === null
    ? database.prepare(`
        SELECT run_id, sequence, event_type, payload_json
        FROM domain_events
        WHERE event_type IN (?, ?)
        ORDER BY run_id, sequence
      `).all(...SUBMISSION_EVENT_TYPES)
    : database.prepare(`
        SELECT run_id, sequence, event_type, payload_json
        FROM domain_events
        WHERE run_id = ? AND event_type IN (?, ?)
        ORDER BY sequence
      `).all(runId, ...SUBMISSION_EVENT_TYPES);
}

function decodeProviderReceipt(delivery, errors) {
  return decodeCanonical(
    delivery.provider_receipt_json,
    `delivery ${delivery.delivery_id} provider receipt`,
    (value) => {
      requireExactObject(value, Object.keys(value), "provider receipt");
      requireString(value.externalTurnId, "provider receipt.externalTurnId");
    },
    errors,
  );
}

function verifyCurrentReceipt(submission, errors) {
  const { delivery, details } = submission;
  const receipt = decodeProviderReceipt(delivery, errors);
  if (
    details.inputId !== delivery.input_id
    || details.attemptCount !== Number(delivery.attempt_count)
    || details.turnId !== receipt.externalTurnId
    || details.providerReceiptHash !== sha256CanonicalJson(receipt)
  ) {
    integrity(
      errors,
      `delivery ${delivery.delivery_id}`,
      "current provider receipt does not match its latest submission evidence",
    );
  }
}

function readCurrentRun(database, runId, errors) {
  const row = database.prepare("SELECT run_json FROM runs WHERE run_id = ?").get(runId);
  if (!row) integrity(errors, `run ${runId}`, "does not exist");
  return decodeCanonical(
    row.run_json,
    `run ${runId}`,
    (value) => {
      validateAgentRun(value);
      if (value.runId !== runId) throw new TypeError("run ownership does not match");
    },
    errors,
  );
}

function verifyCurrentInFlightSession(database, delivery, submission, errors) {
  if (
    !submission
    || submission.details.attemptCount !== Number(delivery.attempt_count)
    || !CURRENT_IN_FLIGHT_STATES.has(delivery.state)
  ) return;
  const { details, session } = submission;
  const run = readCurrentRun(database, delivery.run_id, errors);
  if (
    run.phase !== RUNNING_PHASE_BY_ACTOR[details.targetActor]
    || run.activeActor !== details.targetActor
  ) return;
  if (
    session.status !== AgentSessionStatus.RUNNING
    || session.activeTurnId !== details.turnId
  ) {
    integrity(
      errors,
      `delivery ${delivery.delivery_id}`,
      "current in-flight session does not match its submitted turn",
    );
  }
}

function readVerifiedSubmissions(database, runId, errors) {
  const verified = submissionRows(database, runId)
    .map((row) => verifySubmissionRow(database, row, errors));
  const seen = new Set();
  const latestAttemptByDelivery = new Map();
  for (const submission of verified) {
    const { details, row } = submission;
    const key = canonicalJson([
      details.deliveryId,
      details.turnId,
      details.providerReceiptHash,
    ]);
    if (seen.has(key)) {
      integrity(
        errors,
        `turn submission event ${row.run_id}/${row.sequence}`,
        "duplicates exact submission evidence",
      );
    }
    seen.add(key);
    const previousAttempt = latestAttemptByDelivery.get(details.deliveryId) ?? 0;
    if (details.attemptCount <= previousAttempt) {
      integrity(
        errors,
        `turn submission event ${row.run_id}/${row.sequence}`,
        "does not advance the delivery attempt count",
      );
    }
    latestAttemptByDelivery.set(details.deliveryId, details.attemptCount);
  }
  return verified;
}

export function getTurnSubmissionEvidenceByDeliveryEntity(database, deliveryId, errors) {
  requireString(deliveryId, "deliveryId");
  const delivery = database.prepare(`
    SELECT run_id FROM delivery_attempts WHERE delivery_id = ?
  `).get(deliveryId);
  if (!delivery) return null;
  const matches = readVerifiedSubmissions(database, delivery.run_id, errors)
    .filter(({ details }) => details.deliveryId === deliveryId);
  if (matches.length === 0) return null;
  const latest = matches.at(-1);
  verifyCurrentReceipt(latest, errors);
  return latest.details;
}

export function verifyTurnSubmissionLinksEntity(database, errors) {
  const verified = readVerifiedSubmissions(database, null, errors);
  const latestByDelivery = new Map();
  for (const submission of verified) {
    latestByDelivery.set(submission.details.deliveryId, submission);
  }
  const deliveries = database.prepare(`
    SELECT delivery_id, run_id, state, attempt_count, provider_receipt_json
    FROM delivery_attempts
    ORDER BY run_id, delivery_id
  `).all();
  for (const delivery of deliveries) {
    const submission = latestByDelivery.get(delivery.delivery_id);
    verifyCurrentInFlightSession(database, delivery, submission, errors);
    if (delivery.provider_receipt_json === null) {
      if (RECEIPT_REQUIRED_STATES.has(delivery.state)) {
        integrity(
          errors,
          `delivery ${delivery.delivery_id}`,
          `state ${delivery.state} requires a provider receipt and submission evidence`,
        );
      }
      const historical = latestByDelivery.get(delivery.delivery_id);
      if (
        historical
        && (delivery.state === DeliveryState.FAILED
          || delivery.state === DeliveryState.AMBIGUOUS)
        && historical.details.attemptCount === Number(delivery.attempt_count)
      ) {
        integrity(
          errors,
          `delivery ${delivery.delivery_id}`,
          `state ${delivery.state} lost its current-attempt provider receipt`,
        );
      }
      continue;
    }
    if (RECEIPT_FORBIDDEN_STATES.has(delivery.state)) {
      integrity(
        errors,
        `delivery ${delivery.delivery_id}`,
        `state ${delivery.state} must not retain a provider receipt`,
      );
    }
    if (!submission || submission.row.run_id !== delivery.run_id) {
      integrity(
        errors,
        `delivery ${delivery.delivery_id}`,
        "has a provider receipt without hash-chained submission evidence",
      );
    }
    verifyCurrentReceipt(submission, errors);
  }
  return Object.freeze({ valid: true, submittedTurns: verified.length });
}
