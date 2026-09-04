import { SHA256_DIGEST_PATTERN } from "../domain/agent-messages.js";
import { deriveAgentBlockedDecisionIds } from "../domain/agent-blocked.js";
import { canonicalJson } from "../domain/canonical-json.js";
import { evaluateConsensus } from "../domain/consensus.js";
import { validateAgentRun } from "../domain/contracts.js";
import {
  AgentMessageKind,
  AgentPacketType,
  RunBlockerType,
  RunPhase,
} from "../domain/vocabulary.js";
import {
  getAgentMessageEntity,
  listAgentMessagesEntity,
} from "./agent-communications.js";
import { listProposalArtifactsEntity } from "./proposal-artifacts.js";
import { getApprovalEntity } from "./sqlite-entities.js";

const RUNTIME_APPROVAL_EVENT = "RUNTIME_APPROVAL_REQUESTED";
const STORED_RESPONSE_EVENT = "AGENT_RESPONSE_STORED";
const BLOCKED_RESPONSE_EVENT = "AGENT_RESPONSE_BLOCKED";
const HELD_RESPONSE_EVENT = "AGENT_RESPONSE_HELD_FOR_BLOCKER";
const PAYLOAD_KEYS = Object.freeze(["run", "details"]);
const RUNTIME_APPROVAL_DETAIL_KEYS = Object.freeze(["approvalId", "scopeHash"]);
const STORED_RESPONSE_DETAIL_KEYS = Object.freeze([
  "deliveryId",
  "inputId",
  "messageId",
  "messageHash",
  "messageContentHash",
  "packetId",
  "packetHash",
  "proposal",
  "next",
  "outcome",
  "disposition",
]);
const BLOCKED_DETAIL_KEYS = Object.freeze([
  "messageId",
  "reasonCode",
  "blocker",
  "sideRecord",
]);
const HELD_DETAIL_KEYS = Object.freeze([
  "messageId",
  "plannedDisposition",
  "blocker",
]);
const FINAL_RESPONSE_DISPOSITIONS = new Set(["BLOCKED", "HELD"]);
const HELD_PLANNED_DISPOSITIONS = new Set(["BLOCKED", "COMPLETE"]);

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

function requireNullableHash(value, context) {
  if (value !== null && (typeof value !== "string" || !SHA256_DIGEST_PATTERN.test(value))) {
    throw new TypeError(`${context} must be null or a sha256 digest`);
  }
  return value;
}

function decodeEvent(row, errors) {
  const context = `control side-record event ${row.run_id}/${row.sequence}`;
  try {
    const payload = JSON.parse(row.payload_json);
    if (canonicalJson(payload) !== row.payload_json) {
      throw new TypeError("payload must be canonical JSON");
    }
    requireExactObject(payload, PAYLOAD_KEYS, "payload");
    validateAgentRun(payload.run);
    if (payload.run.runId !== row.run_id) {
      throw new TypeError("payload run does not match event ownership");
    }
    return payload;
  } catch (cause) {
    integrity(errors, context, "has invalid canonical payload", { cause });
  }
}

function sideRecordKey(kind, runId, id) {
  return canonicalJson([kind, runId, id]);
}

function registerReference(seen, kind, runId, id, context, errors) {
  const key = sideRecordKey(kind, runId, id);
  if (seen.has(key)) integrity(errors, context, `duplicates creation evidence for ${key}`);
  seen.add(key);
}

function verifyApprovalRecord(database, row, id, hash, seen, errors) {
  const context = `control side-record event ${row.run_id}/${row.sequence}`;
  const record = getApprovalEntity(database, id, errors);
  if (
    !record
    || record.runId !== row.run_id
    || record.scopeHash !== hash
    || record.createdAt !== row.created_at
  ) {
    integrity(errors, context, `approval ${id} does not match its creation evidence`);
  }
  registerReference(seen, "APPROVAL", row.run_id, id, context, errors);
}

function verifyRuntimeApproval(database, row, payload, seen, errors) {
  const context = `control side-record event ${row.run_id}/${row.sequence}`;
  const details = requireExactObject(
    payload.details,
    RUNTIME_APPROVAL_DETAIL_KEYS,
    "runtime approval details",
  );
  requireString(details.approvalId, "runtime approval details.approvalId");
  requireNullableHash(details.scopeHash, "runtime approval details.scopeHash");
  if (
    payload.run.blocker?.type !== RunBlockerType.RUNTIME_APPROVAL
    || payload.run.blocker.approvalId !== details.approvalId
  ) {
    integrity(errors, context, "blocker does not match the requested approval");
  }
  verifyApprovalRecord(
    database,
    row,
    details.approvalId,
    details.scopeHash,
    seen,
    errors,
  );
}

function verifyBlockedMessage(database, row, details, errors) {
  const context = `control side-record event ${row.run_id}/${row.sequence}`;
  const message = getAgentMessageEntity(database, details.messageId, errors);
  if (
    !message
    || message.runId !== row.run_id
    || message.kind !== AgentMessageKind.BLOCKER
    || message.normalizedPacket.type !== AgentPacketType.BLOCKED
    || message.normalizedPacket.reason_code !== details.reasonCode
  ) {
    integrity(errors, context, "blocked AgentMessage evidence is inconsistent");
  }
  return message;
}

function verifyBlockedResponse(database, row, payload, errors) {
  const context = `control side-record event ${row.run_id}/${row.sequence}`;
  const details = requireExactObject(
    payload.details,
    BLOCKED_DETAIL_KEYS,
    "blocked response details",
  );
  requireString(details.messageId, "blocked response details.messageId");
  requireString(details.reasonCode, "blocked response details.reasonCode");
  if (canonicalJson(details.blocker) !== canonicalJson(payload.run.blocker)) {
    integrity(errors, context, "blocker does not match the event run state");
  }
  const message = verifyBlockedMessage(database, row, details, errors);
  if (payload.run.phase !== RunPhase.HUMAN_GATE) {
    integrity(errors, context, "Agent BLOCKED must finish in the human-gate phase");
  }
  if (payload.run.blocker?.type !== RunBlockerType.USER_DECISION) {
    integrity(errors, context, "Agent BLOCKED must create only a user-decision blocker");
  }
  if (
    canonicalJson(payload.run.blocker.decisionIds)
    !== canonicalJson(deriveAgentBlockedDecisionIds(message))
  ) {
    integrity(errors, context, "Agent BLOCKED decision ids do not match their message evidence");
  }
  if (details.sideRecord !== null) {
    integrity(errors, context, "Agent BLOCKED must not declare an operational side record");
  }
}

function responseFinalizationKey(runId, messageId) {
  return canonicalJson([runId, messageId]);
}

function precedingRunState(database, row, errors) {
  const preceding = database.prepare(`
    SELECT run_id, sequence, event_type, payload_json, created_at
    FROM domain_events
    WHERE run_id = ? AND sequence < ?
    ORDER BY sequence DESC LIMIT 1
  `).get(row.run_id, row.sequence);
  if (!preceding) {
    integrity(
      errors,
      `control side-record event ${row.run_id}/${row.sequence}`,
      "has no preceding run state",
    );
  }
  return decodeEvent(preceding, errors).run;
}

function collectExpectedResponseFinalizations(database, errors) {
  const expected = new Map();
  const rows = database.prepare(`
    SELECT run_id, sequence, event_type, payload_json, created_at
    FROM domain_events
    WHERE event_type = ?
    ORDER BY run_id, sequence
  `).all(STORED_RESPONSE_EVENT);

  for (const row of rows) {
    let payload;
    try {
      payload = decodeEvent(row, errors);
      const details = requireExactObject(
        payload.details,
        STORED_RESPONSE_DETAIL_KEYS,
        "stored response details",
      );
      requireString(details.messageId, "stored response details.messageId");
      requireString(details.disposition, "stored response details.disposition");
      if (!FINAL_RESPONSE_DISPOSITIONS.has(details.disposition)) continue;
      const priorRun = precedingRunState(database, row, errors);
      if (canonicalJson(payload.run.blocker) !== canonicalJson(priorRun.blocker)) {
        throw new TypeError("stored response changed the pre-existing Controller blocker");
      }
      if (details.disposition === "BLOCKED" && payload.run.blocker !== null) {
        throw new TypeError("a BLOCKED response must not inherit an existing blocker");
      }
      if (details.disposition === "HELD" && payload.run.blocker === null) {
        throw new TypeError("a HELD response must retain an existing blocker");
      }
      const key = responseFinalizationKey(row.run_id, details.messageId);
      if (expected.has(key)) {
        throw new TypeError("response has duplicate stored finalization intent");
      }
      expected.set(key, Object.freeze({
        eventType: details.disposition === "BLOCKED"
          ? BLOCKED_RESPONSE_EVENT
          : HELD_RESPONSE_EVENT,
        messageId: details.messageId,
        sequence: Number(row.sequence),
        blocker: payload.run.blocker,
      }));
    } catch (cause) {
      if (cause instanceof errors.EventChainIntegrityError) throw cause;
      integrity(
        errors,
        `control side-record event ${row.run_id}/${row.sequence}`,
        "has invalid response finalization intent",
        { cause },
      );
    }
  }
  return expected;
}

function plannedDispositionFromEvidence(database, row, payload, message, errors) {
  if (
    message.kind === AgentMessageKind.BLOCKER
    && message.normalizedPacket.type === AgentPacketType.BLOCKED
  ) {
    return "BLOCKED";
  }
  const messages = listAgentMessagesEntity(database, row.run_id, errors)
    .filter((candidate) => candidate.sequence <= message.sequence);
  const sourceMessageIds = new Set(messages.map((candidate) => candidate.messageId));
  const proposals = listProposalArtifactsEntity(database, row.run_id, errors)
    .filter((artifact) => sourceMessageIds.has(artifact.sourceMessageId));
  const consensus = evaluateConsensus({
    runId: row.run_id,
    messages,
    proposals,
    objectiveHash: payload.run.objectiveHash,
    policyHash: payload.run.policyHash,
    policyViolation: false,
  });
  if (consensus !== null || payload.run.currentTurn >= payload.run.maxTurns) {
    return "COMPLETE";
  }
  return "RELAY";
}

function verifyHeldResponse(database, row, payload, seen, errors) {
  const context = `control side-record event ${row.run_id}/${row.sequence}`;
  const details = requireExactObject(
    payload.details,
    HELD_DETAIL_KEYS,
    "held response details",
  );
  requireString(details.messageId, "held response details.messageId");
  requireString(details.plannedDisposition, "held response details.plannedDisposition");
  if (!HELD_PLANNED_DISPOSITIONS.has(details.plannedDisposition)) {
    integrity(errors, context, "held response has an unsupported planned disposition");
  }
  if (
    payload.run.blocker === null
    || canonicalJson(details.blocker) !== canonicalJson(payload.run.blocker)
  ) {
    integrity(errors, context, "held blocker does not match the event run state");
  }
  const expectedPhase = payload.run.blocker.type === RunBlockerType.RECOVERY_CONFIRMATION
    ? RunPhase.RECOVERY_REQUIRED
    : RunPhase.HUMAN_GATE;
  if (payload.run.phase !== expectedPhase) {
    integrity(errors, context, "held response finished in the wrong blocker phase");
  }
  const message = getAgentMessageEntity(database, details.messageId, errors);
  if (!message || message.runId !== row.run_id) {
    integrity(errors, context, "held AgentMessage evidence is inconsistent");
  }
  if (
    details.plannedDisposition
    !== plannedDispositionFromEvidence(database, row, payload, message, errors)
  ) {
    integrity(errors, context, "held planned disposition does not match its AgentMessage");
  }
  const provenanceKey = payload.run.blocker.type === RunBlockerType.RUNTIME_APPROVAL
    ? sideRecordKey("APPROVAL", row.run_id, payload.run.blocker.approvalId)
    : payload.run.blocker.type === RunBlockerType.RECOVERY_CONFIRMATION
      ? sideRecordKey("RECOVERY", row.run_id, payload.run.blocker.operationId)
      : null;
  if (provenanceKey === null || !seen.has(provenanceKey)) {
    integrity(errors, context, "held blocker has no Controller-owned creation evidence");
  }
}

function registerResponseFinalization(
  expected,
  finalized,
  row,
  payload,
  errors,
) {
  const context = `control side-record event ${row.run_id}/${row.sequence}`;
  const key = responseFinalizationKey(row.run_id, payload.details.messageId);
  const intent = expected.get(key);
  if (
    !intent
    || intent.eventType !== row.event_type
    || Number(row.sequence) <= intent.sequence
  ) {
    integrity(errors, context, "does not match its stored response disposition");
  }
  if (
    row.event_type === HELD_RESPONSE_EVENT
    && canonicalJson(payload.run.blocker) !== canonicalJson(intent.blocker)
  ) {
    integrity(errors, context, "held response changed its pre-existing blocker");
  }
  if (finalized.has(key)) {
    integrity(errors, context, "duplicates response finalization evidence");
  }
  finalized.add(key);
}

function verifyResponseFinalizationCoverage(expected, finalized, errors) {
  for (const [key, intent] of expected) {
    if (!finalized.has(key)) {
      integrity(
        errors,
        `AgentMessage ${intent.messageId}`,
        `has no exact ${intent.eventType} finalization evidence`,
      );
    }
  }
}

function verifyExactCoverage(database, seen, errors) {
  for (const row of database.prepare("SELECT run_id, approval_id FROM approvals").all()) {
    if (!seen.has(sideRecordKey("APPROVAL", row.run_id, row.approval_id))) {
      integrity(errors, "control side-record graph", `has unbound approval ${row.approval_id}`);
    }
  }
  for (const row of database.prepare(
    "SELECT run_id, operation_id FROM recovery_operations",
  ).all()) {
    if (!seen.has(sideRecordKey("RECOVERY", row.run_id, row.operation_id))) {
      integrity(
        errors,
        "control side-record graph",
        `has unbound recovery operation ${row.operation_id}`,
      );
    }
  }
}

function groupPendingIds(rows, idColumn) {
  const grouped = new Map();
  for (const row of rows) {
    const ids = grouped.get(row.run_id) ?? [];
    ids.push(row[idColumn]);
    grouped.set(row.run_id, ids);
  }
  return grouped;
}

function decodeCurrentRun(row, errors) {
  const context = `run ${row.run_id}`;
  try {
    const run = JSON.parse(row.run_json);
    if (canonicalJson(run) !== row.run_json) {
      throw new TypeError("run must be canonical JSON");
    }
    validateAgentRun(run);
    if (run.runId !== row.run_id) throw new TypeError("run ownership does not match");
    return run;
  } catch (cause) {
    integrity(errors, context, "has invalid current blocker state", { cause });
  }
}

function requireExactPending(ids, expectedId, context, kind, errors) {
  if (ids.length !== 1 || ids[0] !== expectedId) {
    integrity(errors, context, `active ${kind} blocker has no exact pending side record`);
  }
}

function verifyCurrentBlockerCoverage(database, seen, errors) {
  const pendingApprovals = groupPendingIds(database.prepare(`
    SELECT run_id, approval_id FROM approvals
    WHERE status = 'PENDING' ORDER BY run_id, approval_id
  `).all(), "approval_id");
  const pendingRecoveries = groupPendingIds(database.prepare(`
    SELECT run_id, operation_id FROM recovery_operations
    WHERE status = 'PENDING' ORDER BY run_id, operation_id
  `).all(), "operation_id");
  const runs = database.prepare(`
    SELECT run_id, run_json FROM runs ORDER BY run_id
  `).all();

  for (const row of runs) {
    const run = decodeCurrentRun(row, errors);
    const approvals = pendingApprovals.get(run.runId) ?? [];
    const recoveries = pendingRecoveries.get(run.runId) ?? [];
    const context = `run ${run.runId}`;
    if (run.blocker?.type === RunBlockerType.RUNTIME_APPROVAL) {
      requireExactPending(
        approvals,
        run.blocker.approvalId,
        context,
        "runtime approval",
        errors,
      );
      if (recoveries.length !== 0) {
        integrity(errors, context, "has pending recovery outside its active blocker");
      }
      if (!seen.has(sideRecordKey("APPROVAL", run.runId, run.blocker.approvalId))) {
        integrity(errors, context, "runtime approval blocker has no creation evidence");
      }
      continue;
    }
    if (run.blocker?.type === RunBlockerType.RECOVERY_CONFIRMATION) {
      requireExactPending(
        recoveries,
        run.blocker.operationId,
        context,
        "recovery confirmation",
        errors,
      );
      if (approvals.length !== 0) {
        integrity(errors, context, "has pending approval outside its active blocker");
      }
      if (!seen.has(sideRecordKey("RECOVERY", run.runId, run.blocker.operationId))) {
        integrity(errors, context, "recovery confirmation blocker has no creation evidence");
      }
      continue;
    }
    if (approvals.length !== 0 || recoveries.length !== 0) {
      integrity(errors, context, "has a pending side record without its active blocker");
    }
  }
}

/** Verifies Controller side records and blocker finalization provenance. */
export function verifyControlSideRecordLinksEntity(database, errors) {
  const expectedFinalizations = collectExpectedResponseFinalizations(database, errors);
  const rows = database.prepare(`
    SELECT run_id, sequence, event_type, payload_json, created_at
    FROM domain_events
    WHERE event_type IN (?, ?, ?)
    ORDER BY run_id, sequence
  `).all(RUNTIME_APPROVAL_EVENT, BLOCKED_RESPONSE_EVENT, HELD_RESPONSE_EVENT);
  const seen = new Set();
  const finalized = new Set();
  for (const row of rows) {
    try {
      const payload = decodeEvent(row, errors);
      if (row.event_type === RUNTIME_APPROVAL_EVENT) {
        verifyRuntimeApproval(database, row, payload, seen, errors);
      } else if (row.event_type === BLOCKED_RESPONSE_EVENT) {
        verifyBlockedResponse(database, row, payload, errors);
        registerResponseFinalization(
          expectedFinalizations,
          finalized,
          row,
          payload,
          errors,
        );
      } else {
        registerResponseFinalization(
          expectedFinalizations,
          finalized,
          row,
          payload,
          errors,
        );
        verifyHeldResponse(database, row, payload, seen, errors);
      }
    } catch (cause) {
      if (cause instanceof errors.EventChainIntegrityError) throw cause;
      integrity(
        errors,
        `control side-record event ${row.run_id}/${row.sequence}`,
        "has invalid creation evidence",
        { cause },
      );
    }
  }
  verifyResponseFinalizationCoverage(expectedFinalizations, finalized, errors);
  verifyExactCoverage(database, seen, errors);
  verifyCurrentBlockerCoverage(database, seen, errors);
  return Object.freeze({ valid: true, sideRecords: seen.size });
}
