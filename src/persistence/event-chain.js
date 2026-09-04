import { canonicalJson, sha256Text } from "../domain/canonical-json.js";
import { validateAgentRun } from "../domain/contracts.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function requireRunId(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("runId must be a non-empty string");
  }
  return value;
}

function decode(text, context, errors) {
  if (typeof text !== "string") {
    throw new errors.EventChainIntegrityError(`${context} is not stored as JSON text`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new errors.EventChainIntegrityError(`${context} contains invalid JSON`, { cause });
  }
  try {
    if (canonicalJson(value) !== text) {
      throw new Error("value is not canonical JSON");
    }
  } catch (cause) {
    throw new errors.EventChainIntegrityError(`${context} is not canonical JSON data`, { cause });
  }
  return value;
}

function eventDigestInput({ sequence, eventId, runId, eventType, payload, createdAt }) {
  return { sequence, eventId, runId, eventType, payload, createdAt };
}

export function calculateDomainEventHash(previousHash, event) {
  if (previousHash !== null && !SHA256_PATTERN.test(previousHash)) {
    throw new TypeError("previousHash must be null or a sha256 digest");
  }
  return sha256Text(`${previousHash ?? ""}${canonicalJson(eventDigestInput(event))}`);
}

export function domainEventDigestInput(event) {
  return structuredClone(eventDigestInput(event));
}

export function listDomainEventsEntity(database, runId, errors) {
  requireRunId(runId);
  return database.prepare(`
    SELECT sequence, event_id, event_type, payload_json,
           previous_hash, event_hash, created_at
    FROM domain_events WHERE run_id = ? ORDER BY sequence
  `).all(runId).map((row) => ({
    sequence: Number(row.sequence),
    eventId: row.event_id,
    runId,
    eventType: row.event_type,
    payload: decode(row.payload_json, `event ${runId}/${row.sequence} payload`, errors),
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    createdAt: row.created_at,
  }));
}

function verifyOneRunChain(database, runRow, errors) {
  const runId = runRow.run_id;
  const run = decode(runRow.run_json, `run ${runId}`, errors);
  try {
    validateAgentRun(run);
  } catch (cause) {
    throw new errors.EventChainIntegrityError(`run ${runId} violates its domain contract`, { cause });
  }
  if (run.version !== Number(runRow.version)) {
    throw new errors.EventChainIntegrityError(`run ${runId} version metadata is inconsistent`);
  }

  const projectionRow = database.prepare(`
    SELECT projection_json, version, last_event_sequence, last_event_hash
    FROM run_projections WHERE run_id = ?
  `).get(runId);
  if (!projectionRow) {
    throw new errors.EventChainIntegrityError(`run ${runId} has no projection`);
  }
  const projection = decode(projectionRow.projection_json, `run projection ${runId}`, errors);
  try {
    validateAgentRun(projection);
  } catch (cause) {
    throw new errors.EventChainIntegrityError(
      `run projection ${runId} violates its domain contract`,
      { cause },
    );
  }
  if (canonicalJson(run) !== canonicalJson(projection)) {
    throw new errors.EventChainIntegrityError(`run ${runId} and its projection disagree`);
  }
  if (
    Number(projectionRow.version) !== Number(runRow.version)
    || projection.version !== Number(runRow.version)
  ) {
    throw new errors.EventChainIntegrityError(`run projection ${runId} version is inconsistent`);
  }

  const rows = database.prepare(`
    SELECT sequence, event_id, event_type, payload_json,
           previous_hash, event_hash, created_at
    FROM domain_events WHERE run_id = ? ORDER BY sequence
  `).all(runId);
  if (rows.length !== Number(runRow.event_count)) {
    throw new errors.EventChainIntegrityError(
      `run ${runId} event count is ${rows.length}; expected ${runRow.event_count}`,
    );
  }

  let expectedPreviousHash = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expectedSequence = index + 1;
    if (Number(row.sequence) !== expectedSequence) {
      throw new errors.EventChainIntegrityError(
        `run ${runId} event sequence ${row.sequence} should be ${expectedSequence}`,
      );
    }
    if (row.previous_hash !== expectedPreviousHash) {
      throw new errors.EventChainIntegrityError(
        `run ${runId} event ${row.sequence} previous hash is inconsistent`,
      );
    }
    const event = {
      sequence: Number(row.sequence),
      eventId: row.event_id,
      runId,
      eventType: row.event_type,
      payload: decode(row.payload_json, `event ${runId}/${row.sequence} payload`, errors),
      createdAt: row.created_at,
    };
    const calculated = calculateDomainEventHash(expectedPreviousHash, event);
    if (row.event_hash !== calculated) {
      throw new errors.EventChainIntegrityError(
        `run ${runId} event ${row.sequence} hash does not match its contents`,
      );
    }
    expectedPreviousHash = calculated;
  }

  if (runRow.last_event_hash !== expectedPreviousHash) {
    throw new errors.EventChainIntegrityError(`run ${runId} chain head does not match its events`);
  }
  if (Number(projectionRow.last_event_sequence) !== rows.length) {
    throw new errors.EventChainIntegrityError(
      `run projection ${runId} event sequence is inconsistent`,
    );
  }
  if (projectionRow.last_event_hash !== expectedPreviousHash) {
    throw new errors.EventChainIntegrityError(`run projection ${runId} chain head is inconsistent`);
  }
}

export function verifyEventChainsEntity(database, runId, errors) {
  if (runId !== null) requireRunId(runId);
  const runs = runId === null
    ? database.prepare(`
        SELECT run_id, run_json, version, event_count, last_event_hash
        FROM runs ORDER BY run_id
      `).all()
    : database.prepare(`
        SELECT run_id, run_json, version, event_count, last_event_hash
        FROM runs WHERE run_id = ?
      `).all(runId);
  if (runId !== null && runs.length === 0) {
    throw new errors.PersistenceError(`run ${runId} does not exist`, "RUN_NOT_FOUND");
  }

  const orphanCount = Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM domain_events event
    LEFT JOIN runs run ON run.run_id = event.run_id
    WHERE run.run_id IS NULL
  `).get().count);
  if (orphanCount !== 0) {
    throw new errors.EventChainIntegrityError(`${orphanCount} domain event(s) have no owning run`);
  }

  let totalEvents = 0;
  for (const runRow of runs) {
    verifyOneRunChain(database, runRow, errors);
    totalEvents += Number(runRow.event_count);
  }
  return { valid: true, runCount: runs.length, eventCount: totalEvents };
}
