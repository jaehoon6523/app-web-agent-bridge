import { SHA256_DIGEST_PATTERN } from "../domain/agent-messages.js";
import { canonicalJson } from "../domain/canonical-json.js";
import { validateAgentRun } from "../domain/contracts.js";
import {
  AgentMessageKind,
  AgentPacketType,
  RunBlockerType,
} from "../domain/vocabulary.js";
import { getAgentMessageEntity } from "./agent-communications.js";
import {
  getApprovalEntity,
  getRecoveryOperationEntity,
} from "./sqlite-entities.js";

const RUNTIME_APPROVAL_EVENT = "RUNTIME_APPROVAL_REQUESTED";
const BLOCKED_RESPONSE_EVENT = "AGENT_RESPONSE_BLOCKED";
const PAYLOAD_KEYS = Object.freeze(["run", "details"]);
const RUNTIME_APPROVAL_DETAIL_KEYS = Object.freeze(["approvalId", "scopeHash"]);
const BLOCKED_DETAIL_KEYS = Object.freeze([
  "messageId",
  "reasonCode",
  "blocker",
  "sideRecord",
]);
const SIDE_RECORD_KEYS = Object.freeze(["type", "id", "hash"]);

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

function registerReference(seen, kind, id, context, errors) {
  const key = `${kind}:${id}`;
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
  registerReference(seen, "APPROVAL", id, context, errors);
}

function verifyRecoveryRecord(database, row, id, hash, seen, errors) {
  const context = `control side-record event ${row.run_id}/${row.sequence}`;
  const record = getRecoveryOperationEntity(database, id, errors);
  if (
    !record
    || record.runId !== row.run_id
    || record.detailsHash !== hash
    || record.createdAt !== row.created_at
  ) {
    integrity(errors, context, `recovery operation ${id} does not match its creation evidence`);
  }
  registerReference(seen, "RECOVERY", id, context, errors);
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
}

function verifyBlockedResponse(database, row, payload, seen, errors) {
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
  verifyBlockedMessage(database, row, details, errors);

  const blocker = payload.run.blocker;
  if (blocker?.type === RunBlockerType.RUNTIME_APPROVAL) {
    const side = requireExactObject(details.sideRecord, SIDE_RECORD_KEYS, "sideRecord");
    if (side.type !== "APPROVAL" || side.id !== blocker.approvalId) {
      integrity(errors, context, "approval side record does not match the blocker");
    }
    requireNullableHash(side.hash, "sideRecord.hash");
    verifyApprovalRecord(database, row, side.id, side.hash, seen, errors);
    return;
  }
  if (blocker?.type === RunBlockerType.RECOVERY_CONFIRMATION) {
    const side = requireExactObject(details.sideRecord, SIDE_RECORD_KEYS, "sideRecord");
    if (side.type !== "RECOVERY" || side.id !== blocker.operationId) {
      integrity(errors, context, "recovery side record does not match the blocker");
    }
    requireNullableHash(side.hash, "sideRecord.hash");
    verifyRecoveryRecord(database, row, side.id, side.hash, seen, errors);
    return;
  }
  if (details.sideRecord !== null) {
    integrity(errors, context, "non-side-record blocker must declare sideRecord null");
  }
}

function verifyExactCoverage(database, seen, errors) {
  for (const row of database.prepare("SELECT approval_id FROM approvals").all()) {
    if (!seen.has(`APPROVAL:${row.approval_id}`)) {
      integrity(errors, "control side-record graph", `has unbound approval ${row.approval_id}`);
    }
  }
  for (const row of database.prepare("SELECT operation_id FROM recovery_operations").all()) {
    if (!seen.has(`RECOVERY:${row.operation_id}`)) {
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
      if (!seen.has(`APPROVAL:${run.blocker.approvalId}`)) {
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
      if (!seen.has(`RECOVERY:${run.blocker.operationId}`)) {
        integrity(errors, context, "recovery confirmation blocker has no creation evidence");
      }
      continue;
    }
    if (approvals.length !== 0 || recoveries.length !== 0) {
      integrity(errors, context, "has a pending side record without its active blocker");
    }
  }
}

/** Verifies each approval/recovery row against exactly one hash-chained creation event. */
export function verifyControlSideRecordLinksEntity(database, errors) {
  const rows = database.prepare(`
    SELECT run_id, sequence, event_type, payload_json, created_at
    FROM domain_events
    WHERE event_type IN (?, ?)
    ORDER BY run_id, sequence
  `).all(RUNTIME_APPROVAL_EVENT, BLOCKED_RESPONSE_EVENT);
  const seen = new Set();
  for (const row of rows) {
    try {
      const payload = decodeEvent(row, errors);
      if (row.event_type === RUNTIME_APPROVAL_EVENT) {
        verifyRuntimeApproval(database, row, payload, seen, errors);
      } else {
        verifyBlockedResponse(database, row, payload, seen, errors);
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
  verifyExactCoverage(database, seen, errors);
  verifyCurrentBlockerCoverage(database, seen, errors);
  return Object.freeze({ valid: true, sideRecords: seen.size });
}
