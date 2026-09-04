import { agentPacketHash, validateAgentPacket } from "../domain/agent-packets.js";
import { canonicalJson, sha256CanonicalJson } from "../domain/canonical-json.js";
import { validateAgentSessionRecord } from "../domain/contracts.js";

/*
 * These are persistence envelopes, not product-domain contracts. Their closed
 * shapes keep SQLite metadata and opaque JSON values deterministic without
 * assigning product meaning to approval/recovery status strings.
 *
 * ApprovalRecord:
 *   { approvalId, runId, status, scope, scopeHash, resolution,
 *     version, createdAt, updatedAt }
 * RecoveryOperationRecord:
 *   { operationId, runId, status, details, detailsHash, resolution,
 *     version, createdAt, updatedAt }
 * AgentPacketRecord:
 *   { packetId, runId, messageId, packetHash, packet, createdAt }
 */

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function requireObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value;
}

function requireKeys(value, required, optional, name) {
  requireObject(value, name);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${name} contains unsupported property ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${name} is missing ${key}`);
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireVersion(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a safe integer >= 1`);
  }
  return value;
}

function requireHash(value, name) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a sha256 digest`);
  }
  return value;
}

function encode(value) {
  return canonicalJson(value);
}

function decode(text, context, errors) {
  try {
    const value = JSON.parse(text);
    if (canonicalJson(value) !== text) throw new Error("value is not canonical JSON");
    return value;
  } catch (cause) {
    throw new errors.EventChainIntegrityError(`${context} is not valid canonical JSON`, { cause });
  }
}

function cloneJson(value, name) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (cause) {
    throw new TypeError(`${name} must be canonical JSON data`, { cause });
  }
}

function opaqueValue(value, name) {
  return value === undefined || value === null ? null : cloneJson(value, name);
}

function opaqueHash(value) {
  return value === null ? null : sha256CanonicalJson(value);
}

function rowChanges(result) {
  return Number(result.changes);
}

function requireRun(database, runId, errors) {
  const row = database.prepare("SELECT 1 AS present FROM runs WHERE run_id = ?").get(runId);
  if (!row) throw new errors.PersistenceError(`run ${runId} does not exist`, "RUN_NOT_FOUND");
}

function ownershipError(kind, id, expectedRunId, actualRunId, errors) {
  return new errors.PersistenceError(
    `${kind} ${id} belongs to run ${actualRunId}, not ${expectedRunId}`,
    "RUN_OWNERSHIP_MISMATCH",
  );
}

function decodeSession(row, errors) {
  const session = decode(row.session_json, `agent session ${row.session_id}`, errors);
  try {
    validateAgentSessionRecord(session);
  } catch (cause) {
    throw new errors.EventChainIntegrityError(
      `agent session ${row.session_id} violates its domain contract`,
      { cause },
    );
  }
  if (
    session.sessionId !== row.session_id
    || session.runId !== row.run_id
    || session.actor !== row.actor
    || session.version !== Number(row.version)
  ) {
    throw new errors.EventChainIntegrityError(
      `agent session ${row.session_id} metadata does not match its JSON`,
    );
  }
  return session;
}

export function createAgentSessionEntity(database, input, errors) {
  requireKeys(input, ["session", "createdAt", "updatedAt"], [], "session create input");
  return upsertAgentSessionEntity(database, {
    ...input,
    expectedVersion: null,
  }, errors);
}

export function upsertAgentSessionEntity(database, input, errors) {
  requireKeys(
    input,
    ["session", "expectedVersion", "updatedAt"],
    ["createdAt"],
    "session upsert input",
  );
  validateAgentSessionRecord(input.session);
  requireString(input.updatedAt, "updatedAt");
  if (input.createdAt !== undefined) requireString(input.createdAt, "createdAt");
  if (input.expectedVersion !== null) requireVersion(input.expectedVersion, "expectedVersion");

  requireRun(database, input.session.runId, errors);
  const existing = database.prepare(
    "SELECT * FROM agent_sessions WHERE session_id = ?",
  ).get(input.session.sessionId);

  if (!existing) {
    if (input.expectedVersion !== null) {
      throw new errors.OptimisticConcurrencyError(
        `agent session ${input.session.sessionId} does not exist at expected version ${input.expectedVersion}`,
      );
    }
    if (input.session.version !== 1) {
      throw new errors.OptimisticConcurrencyError("new agent session version must be 1");
    }
    requireString(input.createdAt, "createdAt");
    database.prepare(`
      INSERT INTO agent_sessions (
        session_id, run_id, actor, session_json, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(
      input.session.sessionId,
      input.session.runId,
      input.session.actor,
      encode(input.session),
      input.createdAt,
      input.updatedAt,
    );
    return structuredClone(input.session);
  }

  if (existing.run_id !== input.session.runId) {
    throw ownershipError(
      "agent session",
      input.session.sessionId,
      input.session.runId,
      existing.run_id,
      errors,
    );
  }
  if (existing.actor !== input.session.actor) {
    throw new errors.PersistenceError(
      `agent session ${input.session.sessionId} actor is immutable`,
      "IMMUTABLE_METADATA",
    );
  }
  if (input.expectedVersion === null || Number(existing.version) !== input.expectedVersion) {
    throw new errors.OptimisticConcurrencyError(
      `agent session ${input.session.sessionId} version conflict`,
    );
  }
  if (input.session.version !== input.expectedVersion + 1) {
    throw new errors.OptimisticConcurrencyError(
      "updated agent session version must equal expectedVersion + 1",
    );
  }
  if (input.createdAt !== undefined && input.createdAt !== existing.created_at) {
    throw new errors.PersistenceError(
      `agent session ${input.session.sessionId} createdAt is immutable`,
      "IMMUTABLE_METADATA",
    );
  }

  const update = database.prepare(`
    UPDATE agent_sessions
    SET session_json = ?, version = ?, updated_at = ?
    WHERE session_id = ? AND run_id = ? AND version = ?
  `).run(
    encode(input.session),
    input.session.version,
    input.updatedAt,
    input.session.sessionId,
    input.session.runId,
    input.expectedVersion,
  );
  if (rowChanges(update) !== 1) {
    throw new errors.OptimisticConcurrencyError(
      `agent session ${input.session.sessionId} changed concurrently`,
    );
  }
  return structuredClone(input.session);
}

export function getAgentSessionEntity(database, sessionId, errors) {
  requireString(sessionId, "sessionId");
  const row = database.prepare("SELECT * FROM agent_sessions WHERE session_id = ?").get(sessionId);
  return row ? decodeSession(row, errors) : null;
}

export function listAgentSessionsEntity(database, runId, errors) {
  requireString(runId, "runId");
  requireRun(database, runId, errors);
  return database.prepare(`
    SELECT * FROM agent_sessions WHERE run_id = ? ORDER BY actor, session_id
  `).all(runId).map((row) => decodeSession(row, errors));
}

function decodePacket(row, errors) {
  const packet = decode(row.packet_json, `agent packet ${row.packet_id}`, errors);
  try {
    validateAgentPacket(packet);
  } catch (cause) {
    throw new errors.EventChainIntegrityError(
      `agent packet ${row.packet_id} violates its domain contract`,
      { cause },
    );
  }
  const calculatedHash = agentPacketHash(packet);
  if (row.packet_hash !== calculatedHash) {
    throw new errors.EventChainIntegrityError(`agent packet ${row.packet_id} hash is inconsistent`);
  }
  return {
    packetId: row.packet_id,
    runId: row.run_id,
    messageId: row.message_id,
    packetHash: row.packet_hash,
    packet,
    createdAt: row.created_at,
  };
}

export function saveAgentPacketEntity(database, input, errors) {
  requireKeys(
    input,
    ["packetId", "runId", "messageId", "packet", "createdAt"],
    ["packetHash"],
    "agent packet save input",
  );
  requireString(input.packetId, "packetId");
  requireString(input.runId, "runId");
  requireString(input.messageId, "messageId");
  requireString(input.createdAt, "createdAt");
  validateAgentPacket(input.packet);
  const packetHash = agentPacketHash(input.packet);
  if (input.packetHash !== undefined) {
    requireHash(input.packetHash, "packetHash");
    if (input.packetHash !== packetHash) {
      throw new errors.PersistenceError("packetHash does not match packet", "HASH_MISMATCH");
    }
  }

  requireRun(database, input.runId, errors);
  const message = database.prepare(
    "SELECT run_id, message_json FROM agent_messages WHERE message_id = ?",
  ).get(input.messageId);
  if (!message) {
    throw new errors.PersistenceError(
      `agent message ${input.messageId} does not exist`,
      "AGENT_MESSAGE_NOT_FOUND",
    );
  }
  if (message.run_id !== input.runId) {
    throw ownershipError("agent message", input.messageId, input.runId, message.run_id, errors);
  }
  const agentMessage = decode(message.message_json, `agent message ${input.messageId}`, errors);
  if (encode(agentMessage.normalizedPacket) !== encode(input.packet)) {
    throw new errors.PersistenceError(
      `agent packet does not match agent message ${input.messageId}`,
      "AGENT_MESSAGE_PACKET_MISMATCH",
    );
  }
  database.prepare(`
    INSERT INTO agent_packets (
      packet_id, run_id, message_id, packet_hash, packet_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.packetId,
    input.runId,
    input.messageId,
    packetHash,
    encode(input.packet),
    input.createdAt,
  );
  return getAgentPacketEntity(database, input.packetId, errors);
}

export function getAgentPacketEntity(database, packetId, errors) {
  requireString(packetId, "packetId");
  const row = database.prepare("SELECT * FROM agent_packets WHERE packet_id = ?").get(packetId);
  return row ? decodePacket(row, errors) : null;
}

export function listAgentPacketsEntity(database, runId, errors) {
  requireString(runId, "runId");
  requireRun(database, runId, errors);
  return database.prepare(`
    SELECT * FROM agent_packets WHERE run_id = ? ORDER BY created_at, packet_id
  `).all(runId).map((row) => decodePacket(row, errors));
}

function decodeOpaqueRecord(row, kind, errors) {
  const idColumn = kind === "approval" ? "approval_id" : "operation_id";
  const jsonColumn = kind === "approval" ? "approval_json" : "operation_json";
  const idName = kind === "approval" ? "approvalId" : "operationId";
  const value = decode(row[jsonColumn], `${kind} ${row[idColumn]}`, errors);
  const expectedKeys = kind === "approval"
    ? ["approvalId", "runId", "status", "scope", "scopeHash", "resolution", "version", "createdAt", "updatedAt"]
    : ["operationId", "runId", "status", "details", "detailsHash", "resolution", "version", "createdAt", "updatedAt"];
  try {
    requireKeys(value, expectedKeys, [], `${kind} record`);
    requireString(value[idName], `${kind}.${idName}`);
    requireString(value.runId, `${kind}.runId`);
    requireString(value.status, `${kind}.status`);
    requireVersion(value.version, `${kind}.version`);
    requireString(value.createdAt, `${kind}.createdAt`);
    requireString(value.updatedAt, `${kind}.updatedAt`);
  } catch (cause) {
    throw new errors.EventChainIntegrityError(`${kind} ${row[idColumn]} has invalid metadata`, {
      cause,
    });
  }
  if (
    value[idName] !== row[idColumn]
    || value.runId !== row.run_id
    || value.status !== row.status
    || value.version !== Number(row.version)
    || value.createdAt !== row.created_at
    || value.updatedAt !== row.updated_at
  ) {
    throw new errors.EventChainIntegrityError(`${kind} ${row[idColumn]} metadata is inconsistent`);
  }
  const opaque = kind === "approval" ? value.scope : value.details;
  const hash = kind === "approval" ? value.scopeHash : value.detailsHash;
  if (opaque === null ? hash !== null : hash !== sha256CanonicalJson(opaque)) {
    throw new errors.EventChainIntegrityError(`${kind} ${row[idColumn]} opaque data hash is inconsistent`);
  }
  return value;
}

function createOpaqueRecord(database, input, kind, errors) {
  const idName = kind === "approval" ? "approvalId" : "operationId";
  const opaqueName = kind === "approval" ? "scope" : "details";
  requireKeys(
    input,
    [idName, "runId", "status", "createdAt", "updatedAt"],
    [opaqueName],
    `${kind} create input`,
  );
  requireString(input[idName], idName);
  requireString(input.runId, "runId");
  requireString(input.status, "status");
  requireString(input.createdAt, "createdAt");
  requireString(input.updatedAt, "updatedAt");
  const opaque = opaqueValue(input[opaqueName], opaqueName);
  const hashName = kind === "approval" ? "scopeHash" : "detailsHash";
  const record = {
    [idName]: input[idName],
    runId: input.runId,
    status: input.status,
    [opaqueName]: opaque,
    [hashName]: opaqueHash(opaque),
    resolution: null,
    version: 1,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
  const table = kind === "approval" ? "approvals" : "recovery_operations";
  const idColumn = kind === "approval" ? "approval_id" : "operation_id";
  const jsonColumn = kind === "approval" ? "approval_json" : "operation_json";

  requireRun(database, input.runId, errors);
  database.prepare(`
    INSERT INTO ${table} (
      ${idColumn}, run_id, status, ${jsonColumn}, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(
    input[idName],
    input.runId,
    input.status,
    encode(record),
    input.createdAt,
    input.updatedAt,
  );
  return structuredClone(record);
}

function resolveOpaqueRecord(database, input, kind, errors) {
  const idName = kind === "approval" ? "approvalId" : "operationId";
  const opaqueName = kind === "approval" ? "scope" : "details";
  const hashName = kind === "approval" ? "scopeHash" : "detailsHash";
  const expectedHashName = kind === "approval" ? "expectedScopeHash" : "expectedDetailsHash";
  requireKeys(
    input,
    [idName, "runId", "expectedStatus", "expectedVersion", "nextStatus", "updatedAt"],
    ["resolution", expectedHashName],
    `${kind} resolve input`,
  );
  requireString(input[idName], idName);
  requireString(input.runId, "runId");
  requireString(input.expectedStatus, "expectedStatus");
  requireVersion(input.expectedVersion, "expectedVersion");
  requireString(input.nextStatus, "nextStatus");
  requireString(input.updatedAt, "updatedAt");
  if (input[expectedHashName] !== undefined && input[expectedHashName] !== null) {
    requireHash(input[expectedHashName], expectedHashName);
  }
  const table = kind === "approval" ? "approvals" : "recovery_operations";
  const idColumn = kind === "approval" ? "approval_id" : "operation_id";
  const jsonColumn = kind === "approval" ? "approval_json" : "operation_json";

  const row = database.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = ?`).get(input[idName]);
  if (!row) {
    throw new errors.PersistenceError(
      `${kind} ${input[idName]} does not exist`,
      `${kind.toUpperCase()}_NOT_FOUND`,
    );
  }
  if (row.run_id !== input.runId) {
    throw ownershipError(kind, input[idName], input.runId, row.run_id, errors);
  }
  const current = decodeOpaqueRecord(row, kind, errors);
  if (current.status !== input.expectedStatus) {
    throw new errors.PersistenceError(
      `${kind} ${input[idName]} status conflict`,
      `${kind.toUpperCase()}_STATUS_CONFLICT`,
    );
  }
  if (current.version !== input.expectedVersion) {
    throw new errors.OptimisticConcurrencyError(`${kind} ${input[idName]} version conflict`);
  }
  if (
    input[expectedHashName] !== undefined
    && input[expectedHashName] !== current[hashName]
  ) {
    throw new errors.PersistenceError(
      `${kind} ${input[idName]} ${opaqueName} hash conflict`,
      "OPAQUE_SCOPE_HASH_CONFLICT",
    );
  }
  const next = {
    ...current,
    status: input.nextStatus,
    resolution: opaqueValue(input.resolution, "resolution"),
    version: current.version + 1,
    updatedAt: input.updatedAt,
  };
  const update = database.prepare(`
    UPDATE ${table}
    SET status = ?, ${jsonColumn} = ?, version = ?, updated_at = ?
    WHERE ${idColumn} = ? AND run_id = ? AND status = ? AND version = ?
  `).run(
    next.status,
    encode(next),
    next.version,
    next.updatedAt,
    input[idName],
    input.runId,
    input.expectedStatus,
    input.expectedVersion,
  );
  if (rowChanges(update) !== 1) {
    throw new errors.OptimisticConcurrencyError(`${kind} ${input[idName]} changed concurrently`);
  }
  return structuredClone(next);
}

function getOpaqueRecord(database, id, kind, errors) {
  requireString(id, kind === "approval" ? "approvalId" : "operationId");
  const table = kind === "approval" ? "approvals" : "recovery_operations";
  const idColumn = kind === "approval" ? "approval_id" : "operation_id";
  const row = database.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = ?`).get(id);
  return row ? decodeOpaqueRecord(row, kind, errors) : null;
}

function listOpaqueRecords(database, input, kind, errors) {
  const name = `${kind} list input`;
  requireKeys(input, ["runId"], ["status"], name);
  requireString(input.runId, "runId");
  if (input.status !== undefined) requireString(input.status, "status");
  requireRun(database, input.runId, errors);
  const table = kind === "approval" ? "approvals" : "recovery_operations";
  const idColumn = kind === "approval" ? "approval_id" : "operation_id";
  const rows = input.status === undefined
    ? database.prepare(`SELECT * FROM ${table} WHERE run_id = ? ORDER BY created_at, ${idColumn}`).all(input.runId)
    : database.prepare(`SELECT * FROM ${table} WHERE run_id = ? AND status = ? ORDER BY created_at, ${idColumn}`).all(input.runId, input.status);
  return rows.map((row) => decodeOpaqueRecord(row, kind, errors));
}

export function createApprovalEntity(database, input, errors) {
  return createOpaqueRecord(database, input, "approval", errors);
}

export function resolveApprovalEntity(database, input, errors) {
  return resolveOpaqueRecord(database, input, "approval", errors);
}

export function getApprovalEntity(database, approvalId, errors) {
  return getOpaqueRecord(database, approvalId, "approval", errors);
}

export function listApprovalsEntity(database, input, errors) {
  return listOpaqueRecords(database, input, "approval", errors);
}

export function createRecoveryOperationEntity(database, input, errors) {
  return createOpaqueRecord(database, input, "recovery", errors);
}

export function resolveRecoveryOperationEntity(database, input, errors) {
  return resolveOpaqueRecord(database, input, "recovery", errors);
}

export function getRecoveryOperationEntity(database, operationId, errors) {
  return getOpaqueRecord(database, operationId, "recovery", errors);
}

export function listRecoveryOperationsEntity(database, input, errors) {
  return listOpaqueRecords(database, input, "recovery", errors);
}
