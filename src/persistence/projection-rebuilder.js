import { canonicalJson, sha256Text } from "../domain/canonical-json.js";
import { validateAgentRun } from "../domain/contracts.js";

function requireRunId(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("runId must be a non-empty string");
  }
  return value;
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

function eventDigestInput(event) {
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    runId: event.runId,
    eventType: event.eventType,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

function calculateHash(previousHash, event) {
  return sha256Text(`${previousHash ?? ""}${canonicalJson(eventDigestInput(event))}`);
}

function projectionError(errors, message, code = "PROJECTION_REBUILD_FAILURE", cause) {
  if (code === "EVENT_CHAIN_INTEGRITY_FAILURE") {
    return new errors.EventChainIntegrityError(message, cause ? { cause } : undefined);
  }
  return new errors.PersistenceError(message, code, cause ? { cause } : undefined);
}

function validateProjectedRun(value, runId, context, errors) {
  try {
    validateAgentRun(value);
  } catch (cause) {
    throw projectionError(
      errors,
      `${context} does not contain a valid full AgentRun`,
      "EVENT_CHAIN_INTEGRITY_FAILURE",
      cause,
    );
  }
  if (value.runId !== runId) {
    throw projectionError(
      errors,
      `${context} contains run ${value.runId}, expected ${runId}`,
      "EVENT_CHAIN_INTEGRITY_FAILURE",
    );
  }
  return value;
}

/*
 * Projection-bearing event payloads have one of two documented forms:
 *   RUN_CREATED: <full AgentRun>
 *   any later event: { run: <full AgentRun>, ... }
 * Payloads without the explicit run property do not advance projected state.
 */
function projectedRunFromEvent(event, errors) {
  if (event.eventType === "RUN_CREATED") {
    return validateProjectedRun(
      event.payload,
      event.runId,
      `RUN_CREATED event ${event.runId}/${event.sequence}`,
      errors,
    );
  }
  if (
    event.payload !== null
    && typeof event.payload === "object"
    && !Array.isArray(event.payload)
    && Object.hasOwn(event.payload, "run")
  ) {
    return validateProjectedRun(
      event.payload.run,
      event.runId,
      `event ${event.runId}/${event.sequence} payload.run`,
      errors,
    );
  }
  return null;
}

function deriveProjection(database, runId, errors) {
  const runRow = database.prepare(`
    SELECT run_json, version, event_count, last_event_hash
    FROM runs WHERE run_id = ?
  `).get(runId);
  if (!runRow) throw new errors.PersistenceError(`run ${runId} does not exist`, "RUN_NOT_FOUND");

  const storedRun = decode(runRow.run_json, `run ${runId}`, errors);
  validateProjectedRun(storedRun, runId, `run ${runId}`, errors);
  if (storedRun.version !== Number(runRow.version)) {
    throw new errors.EventChainIntegrityError(`run ${runId} version metadata is inconsistent`);
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
  if (rows.length === 0) {
    throw new errors.EventChainIntegrityError(`run ${runId} has no initial event`);
  }

  let previousHash = null;
  let projectedRun = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const sequence = index + 1;
    if (Number(row.sequence) !== sequence) {
      throw new errors.EventChainIntegrityError(
        `run ${runId} event sequence ${row.sequence} should be ${sequence}`,
      );
    }
    if (row.previous_hash !== previousHash) {
      throw new errors.EventChainIntegrityError(
        `run ${runId} event ${sequence} previous hash is inconsistent`,
      );
    }
    const event = {
      sequence,
      eventId: row.event_id,
      runId,
      eventType: row.event_type,
      payload: decode(row.payload_json, `event ${runId}/${sequence} payload`, errors),
      createdAt: row.created_at,
    };
    const eventHash = calculateHash(previousHash, event);
    if (eventHash !== row.event_hash) {
      throw new errors.EventChainIntegrityError(
        `run ${runId} event ${sequence} hash does not match its contents`,
      );
    }
    previousHash = eventHash;
    const next = projectedRunFromEvent(event, errors);
    if (sequence === 1 && next === null) {
      throw new errors.EventChainIntegrityError(
        `run ${runId} first event does not contain a valid initial AgentRun`,
      );
    }
    if (next !== null) projectedRun = next;
  }
  if (previousHash !== runRow.last_event_hash) {
    throw new errors.EventChainIntegrityError(`run ${runId} chain head is inconsistent`);
  }
  if (projectedRun === null) {
    throw new errors.EventChainIntegrityError(`run ${runId} has no reconstructable AgentRun`);
  }
  if (canonicalJson(projectedRun) !== canonicalJson(storedRun)) {
    throw projectionError(
      errors,
      `run ${runId} events do not reconstruct the current run state`,
      "PROJECTION_SOURCE_INCOMPLETE",
    );
  }
  return {
    run: structuredClone(projectedRun),
    lastEventSequence: rows.length,
    lastEventHash: previousHash,
  };
}

function projectionMatches(row, expected, errors) {
  if (!row) return false;
  const existing = decode(row.projection_json, "existing run projection", errors);
  return canonicalJson(existing) === canonicalJson(expected.run)
    && Number(row.version) === expected.run.version
    && Number(row.last_event_sequence) === expected.lastEventSequence
    && row.last_event_hash === expected.lastEventHash
    && row.updated_at === expected.run.updatedAt;
}

function writeProjection(database, runId, expected, compare, errors) {
  const existing = database.prepare(`
    SELECT projection_json, version, last_event_sequence, last_event_hash, updated_at
    FROM run_projections WHERE run_id = ?
  `).get(runId);
  if (compare) {
    if (!existing || !projectionMatches(existing, expected, errors)) {
      throw projectionError(
        errors,
        `run projection ${runId} diverges from its event reconstruction`,
        "PROJECTION_DIVERGENCE",
      );
    }
    return {
      ...expected,
      replaced: false,
    };
  }
  database.prepare(`
    INSERT INTO run_projections (
      run_id, projection_json, version, last_event_sequence, last_event_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      projection_json = excluded.projection_json,
      version = excluded.version,
      last_event_sequence = excluded.last_event_sequence,
      last_event_hash = excluded.last_event_hash,
      updated_at = excluded.updated_at
  `).run(
    runId,
    canonicalJson(expected.run),
    expected.run.version,
    expected.lastEventSequence,
    expected.lastEventHash,
    expected.run.updatedAt,
  );
  return {
    ...expected,
    replaced: Boolean(existing),
  };
}

function transact(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the first failure.
    }
    throw error;
  }
}

export function rebuildRunProjectionEntity(database, runId, options, errors) {
  requireRunId(runId);
  const compare = options?.compare === true;
  if (options !== undefined) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("projection rebuild options must be an object");
    }
    for (const key of Object.keys(options)) {
      if (key !== "compare") throw new TypeError(`unsupported projection rebuild option ${key}`);
    }
  }
  return transact(database, () => {
    const expected = deriveProjection(database, runId, errors);
    return writeProjection(database, runId, expected, compare, errors);
  });
}

export function rebuildRunProjectionsEntity(database, options, errors) {
  const compare = options?.compare === true;
  if (options !== undefined) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("projection rebuild options must be an object");
    }
    for (const key of Object.keys(options)) {
      if (key !== "compare") throw new TypeError(`unsupported projection rebuild option ${key}`);
    }
  }
  return transact(database, () => {
    const runIds = database.prepare("SELECT run_id FROM runs ORDER BY run_id").all();
    return runIds.map(({ run_id: runId }) => {
      const expected = deriveProjection(database, runId, errors);
      return { runId, ...writeProjection(database, runId, expected, compare, errors) };
    });
  });
}
