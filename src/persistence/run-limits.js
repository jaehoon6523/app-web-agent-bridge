import { canonicalJson } from "../domain/canonical-json.js";
import { validateAgentRun } from "../domain/contracts.js";
import { createRunLimits, validateRunLimits } from "../domain/run-state-machine.js";
import { RunPhase } from "../domain/vocabulary.js";
import { OptimisticConcurrencyError, PersistenceError } from "./errors.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class RunLimitsPersistenceError extends PersistenceError {
  constructor(message, code = "RUN_LIMITS_PERSISTENCE_ERROR", options = undefined) {
    super(message, code, options);
    this.name = "RunLimitsPersistenceError";
  }
}

export class RunLimitExceededError extends RunLimitsPersistenceError {
  constructor(limitName, maximum) {
    super(`${limitName} has reached its frozen maximum (${maximum})`, "RUN_LIMIT_EXCEEDED");
    this.name = "RunLimitExceededError";
    this.limitName = limitName;
    this.maximum = maximum;
  }
}

function requireDatabase(database) {
  if (database === null || typeof database !== "object" || typeof database.prepare !== "function") {
    throw new TypeError("database must be an open SQLite database");
  }
  return database;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requirePolicyHash(value, name = "policyHash") {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a sha256:<64 lowercase hex> digest`);
  }
  return value;
}

function requireCounter(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function requireCounterVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("expectedCounterVersion must be a positive safe integer");
  }
  return value;
}

function decodeCanonicalJson(text, context) {
  if (typeof text !== "string") {
    throw new RunLimitsPersistenceError(
      `${context} is not stored as JSON text`,
      "RUN_LIMITS_INTEGRITY_FAILURE",
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new RunLimitsPersistenceError(
      `${context} contains invalid JSON`,
      "RUN_LIMITS_INTEGRITY_FAILURE",
      { cause },
    );
  }
  if (canonicalJson(value) !== text) {
    throw new RunLimitsPersistenceError(
      `${context} is not canonical JSON`,
      "RUN_LIMITS_INTEGRITY_FAILURE",
    );
  }
  return value;
}

function readRunForFreeze(database, runId) {
  const row = database.prepare(`
    SELECT run_json, version, event_count
    FROM runs
    WHERE run_id = ?
  `).get(runId);
  if (!row) {
    throw new RunLimitsPersistenceError(`run ${runId} does not exist`, "RUN_NOT_FOUND");
  }

  const run = decodeCanonicalJson(row.run_json, `run ${runId}`);
  try {
    validateAgentRun(run);
  } catch (cause) {
    throw new RunLimitsPersistenceError(
      `run ${runId} violates its domain contract`,
      "RUN_LIMITS_INTEGRITY_FAILURE",
      { cause },
    );
  }
  if (run.version !== Number(row.version)) {
    throw new RunLimitsPersistenceError(
      `run ${runId} version metadata does not match its JSON`,
      "RUN_LIMITS_INTEGRITY_FAILURE",
    );
  }
  if (run.runId !== runId) {
    throw new RunLimitsPersistenceError(
      `run ${runId} identifier metadata does not match its JSON`,
      "RUN_LIMITS_INTEGRITY_FAILURE",
    );
  }
  return { run, eventCount: Number(row.event_count) };
}

function validateStoredRow(row) {
  const limits = decodeCanonicalJson(row.limits_json, `run limits for ${row.run_id}`);
  try {
    validateRunLimits(limits);
  } catch (cause) {
    throw new RunLimitsPersistenceError(
      `run limits for ${row.run_id} violate the RunLimits contract`,
      "RUN_LIMITS_INTEGRITY_FAILURE",
      { cause },
    );
  }

  const storedColumns = {
    maxTurns: Number(row.max_turns),
    maxProtocolRepairs: Number(row.max_protocol_repairs),
    maxDeliveryAttempts: Number(row.max_delivery_attempts),
    maxConsecutiveActorFailures: Number(row.max_consecutive_actor_failures),
  };
  if (canonicalJson(storedColumns) !== canonicalJson(limits)) {
    throw new RunLimitsPersistenceError(
      `run limits for ${row.run_id} do not match their indexed columns`,
      "RUN_LIMITS_INTEGRITY_FAILURE",
    );
  }
  requirePolicyHash(row.policy_hash, "stored policyHash");

  const ownerRun = decodeCanonicalJson(row.owner_run_json, `owner run ${row.run_id}`);
  try {
    validateAgentRun(ownerRun);
  } catch (cause) {
    throw new RunLimitsPersistenceError(
      `owner run ${row.run_id} violates its domain contract`,
      "RUN_LIMITS_INTEGRITY_FAILURE",
      { cause },
    );
  }
  if (
    ownerRun.runId !== row.run_id
    || ownerRun.policyHash !== row.policy_hash
    || ownerRun.maxTurns !== limits.maxTurns
  ) {
    throw new RunLimitsPersistenceError(
      `run limits for ${row.run_id} no longer match their owning run`,
      "RUN_LIMITS_INTEGRITY_FAILURE",
    );
  }

  const protocolRepairsUsed = requireCounter(
    Number(row.protocol_repairs_used),
    "stored protocolRepairsUsed",
  );
  const consecutiveActorFailures = requireCounter(
    Number(row.consecutive_actor_failures),
    "stored consecutiveActorFailures",
  );
  if (protocolRepairsUsed > limits.maxProtocolRepairs) {
    throw new RunLimitsPersistenceError(
      `run ${row.run_id} protocol repair counter exceeds its frozen maximum`,
      "RUN_LIMITS_INTEGRITY_FAILURE",
    );
  }
  if (consecutiveActorFailures > limits.maxConsecutiveActorFailures) {
    throw new RunLimitsPersistenceError(
      `run ${row.run_id} consecutive failure counter exceeds its frozen maximum`,
      "RUN_LIMITS_INTEGRITY_FAILURE",
    );
  }

  return Object.freeze({
    runId: row.run_id,
    policyHash: row.policy_hash,
    limits: createRunLimits(limits),
    protocolRepairsUsed,
    consecutiveActorFailures,
    counterVersion: requireCounterVersion(Number(row.counter_version)),
    createdAt: requireNonEmptyString(row.created_at, "stored createdAt"),
    updatedAt: requireNonEmptyString(row.updated_at, "stored updatedAt"),
  });
}

function selectRow(database, runId) {
  return database.prepare(`
    SELECT
      limits.run_id AS run_id,
      limits.policy_hash AS policy_hash,
      limits.limits_json AS limits_json,
      limits.max_turns AS max_turns,
      limits.max_protocol_repairs AS max_protocol_repairs,
      limits.max_delivery_attempts AS max_delivery_attempts,
      limits.max_consecutive_actor_failures AS max_consecutive_actor_failures,
      limits.protocol_repairs_used AS protocol_repairs_used,
      limits.consecutive_actor_failures AS consecutive_actor_failures,
      limits.counter_version AS counter_version,
      limits.created_at AS created_at,
      limits.updated_at AS updated_at,
      runs.run_json AS owner_run_json
    FROM run_limits AS limits
    INNER JOIN runs ON runs.run_id = limits.run_id
    WHERE limits.run_id = ?
  `).get(runId);
}

function requireStoredRecord(database, runId) {
  const row = selectRow(database, runId);
  if (!row) {
    throw new RunLimitsPersistenceError(
      `run ${runId} has no frozen RunLimits`,
      "RUN_LIMITS_NOT_FOUND",
    );
  }
  return validateStoredRow(row);
}

function classifyFailedCounterUpdate(database, runId, expectedCounterVersion, limitField) {
  const record = requireStoredRecord(database, runId);
  if (record.counterVersion !== expectedCounterVersion) {
    throw new OptimisticConcurrencyError(
      `run ${runId} counter version ${record.counterVersion} does not match expected version ${expectedCounterVersion}`,
    );
  }
  const counterName = limitField === "maxProtocolRepairs"
    ? "protocolRepairsUsed"
    : "consecutiveActorFailures";
  if (record[counterName] >= record.limits[limitField]) {
    throw new RunLimitExceededError(limitField, record.limits[limitField]);
  }
  throw new RunLimitsPersistenceError(
    `run ${runId} limit counter update did not complete`,
    "RUN_LIMIT_COUNTER_UPDATE_FAILED",
  );
}

export function createRunLimitsEntity(database, {
  runId,
  policyHash,
  limits,
  createdAt,
  updatedAt = createdAt,
}) {
  requireDatabase(database);
  requireNonEmptyString(runId, "runId");
  requirePolicyHash(policyHash);
  validateRunLimits(limits);
  requireNonEmptyString(createdAt, "createdAt");
  requireNonEmptyString(updatedAt, "updatedAt");

  const { run, eventCount } = readRunForFreeze(database, runId);
  if (run.phase !== RunPhase.CREATED || run.version !== 1 || eventCount !== 1) {
    throw new RunLimitsPersistenceError(
      `RunLimits for ${runId} must be frozen at run creation before any transition`,
      "RUN_LIMITS_FREEZE_WINDOW_CLOSED",
    );
  }
  if (run.policyHash !== policyHash) {
    throw new RunLimitsPersistenceError(
      `policyHash does not match run ${runId}`,
      "RUN_LIMITS_POLICY_MISMATCH",
    );
  }
  if (run.maxTurns !== limits.maxTurns) {
    throw new RunLimitsPersistenceError(
      `maxTurns does not match run ${runId}`,
      "RUN_LIMITS_RUN_MISMATCH",
    );
  }
  if (selectRow(database, runId)) {
    throw new RunLimitsPersistenceError(
      `RunLimits for ${runId} are already frozen`,
      "RUN_LIMITS_ALREADY_FROZEN",
    );
  }

  const frozen = createRunLimits(limits);
  try {
    database.prepare(`
      INSERT INTO run_limits (
        run_id,
        policy_hash,
        limits_json,
        max_turns,
        max_protocol_repairs,
        max_delivery_attempts,
        max_consecutive_actor_failures,
        protocol_repairs_used,
        consecutive_actor_failures,
        counter_version,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)
    `).run(
      runId,
      policyHash,
      canonicalJson(frozen),
      frozen.maxTurns,
      frozen.maxProtocolRepairs,
      frozen.maxDeliveryAttempts,
      frozen.maxConsecutiveActorFailures,
      createdAt,
      updatedAt,
    );
  } catch (cause) {
    if (selectRow(database, runId)) {
      throw new RunLimitsPersistenceError(
        `RunLimits for ${runId} are already frozen`,
        "RUN_LIMITS_ALREADY_FROZEN",
        { cause },
      );
    }
    throw cause;
  }
  return requireStoredRecord(database, runId);
}

export function getRunLimitsEntity(database, runId) {
  requireDatabase(database);
  requireNonEmptyString(runId, "runId");
  const row = selectRow(database, runId);
  return row ? validateStoredRow(row) : null;
}

export function recordProtocolRepairEntity(database, {
  runId,
  expectedCounterVersion,
  updatedAt,
}) {
  requireDatabase(database);
  requireNonEmptyString(runId, "runId");
  requireCounterVersion(expectedCounterVersion);
  requireNonEmptyString(updatedAt, "updatedAt");
  const row = database.prepare(`
    UPDATE run_limits
    SET
      protocol_repairs_used = protocol_repairs_used + 1,
      counter_version = counter_version + 1,
      updated_at = ?
    WHERE
      run_id = ?
      AND counter_version = ?
      AND protocol_repairs_used < max_protocol_repairs
    RETURNING *
  `).get(updatedAt, runId, expectedCounterVersion);
  if (!row) {
    classifyFailedCounterUpdate(
      database,
      runId,
      expectedCounterVersion,
      "maxProtocolRepairs",
    );
  }
  return requireStoredRecord(database, runId);
}

export function recordConsecutiveActorFailureEntity(database, {
  runId,
  expectedCounterVersion,
  updatedAt,
}) {
  requireDatabase(database);
  requireNonEmptyString(runId, "runId");
  requireCounterVersion(expectedCounterVersion);
  requireNonEmptyString(updatedAt, "updatedAt");
  const row = database.prepare(`
    UPDATE run_limits
    SET
      consecutive_actor_failures = consecutive_actor_failures + 1,
      counter_version = counter_version + 1,
      updated_at = ?
    WHERE
      run_id = ?
      AND counter_version = ?
      AND consecutive_actor_failures < max_consecutive_actor_failures
    RETURNING *
  `).get(updatedAt, runId, expectedCounterVersion);
  if (!row) {
    classifyFailedCounterUpdate(
      database,
      runId,
      expectedCounterVersion,
      "maxConsecutiveActorFailures",
    );
  }
  return requireStoredRecord(database, runId);
}

export function resetConsecutiveActorFailuresEntity(database, {
  runId,
  expectedCounterVersion,
  updatedAt,
}) {
  requireDatabase(database);
  requireNonEmptyString(runId, "runId");
  requireCounterVersion(expectedCounterVersion);
  requireNonEmptyString(updatedAt, "updatedAt");
  const row = database.prepare(`
    UPDATE run_limits
    SET
      consecutive_actor_failures = 0,
      counter_version = counter_version + 1,
      updated_at = ?
    WHERE run_id = ? AND counter_version = ?
    RETURNING *
  `).get(updatedAt, runId, expectedCounterVersion);
  if (!row) {
    const record = requireStoredRecord(database, runId);
    if (record.counterVersion !== expectedCounterVersion) {
      throw new OptimisticConcurrencyError(
        `run ${runId} counter version ${record.counterVersion} does not match expected version ${expectedCounterVersion}`,
      );
    }
    throw new RunLimitsPersistenceError(
      `run ${runId} consecutive failure reset did not complete`,
      "RUN_LIMIT_COUNTER_UPDATE_FAILED",
    );
  }
  return requireStoredRecord(database, runId);
}
