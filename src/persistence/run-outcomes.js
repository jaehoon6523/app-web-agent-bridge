import { canonicalJson, sha256CanonicalJson } from "../domain/canonical-json.js";
import { validateAgentRun } from "../domain/contracts.js";
import { validateRunOutcome } from "../domain/run-state-machine.js";
import { RunOutcomeType, RunPhase } from "../domain/vocabulary.js";

const OUTCOME_TYPES_BY_PHASE = Object.freeze({
  [RunPhase.COMPLETE]: new Set([
    RunOutcomeType.CONSENSUS,
    RunOutcomeType.INCONCLUSIVE,
  ]),
  [RunPhase.FAILED]: new Set([RunOutcomeType.FAILED]),
  [RunPhase.CANCELLED]: new Set([RunOutcomeType.CANCELLED]),
});
const RUN_COMPLETED_EVENT_TYPE = "RUN_COMPLETED";
const COMPLETION_PAYLOAD_KEYS = Object.freeze(["run", "details"]);
const COMPLETION_DETAIL_KEYS = Object.freeze(["outcome", "outcomeHash"]);

function requirePlainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value;
}

function requireExactKeys(value, keys, name) {
  requirePlainObject(value, name);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new TypeError(`${name} contains unsupported property ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${name} requires ${key}`);
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function decodeCanonical(text, context, validator, errors) {
  let value;
  try {
    value = JSON.parse(text);
    if (canonicalJson(value) !== text) throw new Error("value is not canonical JSON");
    validator(value);
  } catch (cause) {
    throw new errors.EventChainIntegrityError(`${context} is invalid`, { cause });
  }
  return value;
}

function readRun(database, runId, errors) {
  const row = database.prepare(`
    SELECT run_id, run_json, version FROM runs WHERE run_id = ?
  `).get(runId);
  if (!row) {
    throw new errors.PersistenceError(`run ${runId} does not exist`, "RUN_NOT_FOUND");
  }
  const run = decodeCanonical(row.run_json, `run ${runId}`, validateAgentRun, errors);
  if (
    run.runId !== row.run_id
    || run.runId !== runId
    || run.version !== Number(row.version)
  ) {
    throw new errors.EventChainIntegrityError(
      `run ${runId} metadata does not match its canonical state`,
    );
  }
  return run;
}

function phaseCompatibilityError(run, outcome, errors, integrity) {
  const allowed = OUTCOME_TYPES_BY_PHASE[run.phase];
  let message;
  let code;
  if (!allowed) {
    message = `nonterminal run ${run.runId} cannot have a final RunOutcome`;
    code = "RUN_OUTCOME_NONTERMINAL_PHASE";
  } else {
    message = `run ${run.runId} phase ${run.phase} is incompatible with outcome ${outcome.type}`;
    code = "RUN_OUTCOME_PHASE_MISMATCH";
  }
  if (integrity) throw new errors.EventChainIntegrityError(message);
  throw new errors.PersistenceError(message, code);
}

function assertPhaseCompatibility(run, outcome, errors, integrity) {
  const allowed = OUTCOME_TYPES_BY_PHASE[run.phase];
  if (!allowed || !allowed.has(outcome.type)) {
    phaseCompatibilityError(run, outcome, errors, integrity);
  }
}

function completionEventRows(database, runId) {
  return database.prepare(`
    SELECT run_id, sequence, event_type, payload_json, created_at
    FROM domain_events
    WHERE run_id = ? AND event_type = ?
    ORDER BY sequence
  `).all(runId, RUN_COMPLETED_EVENT_TYPE);
}

function completionLinkError(errors, message, integrity) {
  if (integrity) throw new errors.EventChainIntegrityError(message);
  throw new errors.PersistenceError(message, "RUN_OUTCOME_EVENT_MISMATCH");
}

function decodeCompletionEvent(row, errors) {
  const context = `run completion event ${row.run_id}/${row.sequence}`;
  const payload = decodeCanonical(
    row.payload_json,
    context,
    (value) => {
      requireExactKeys(value, COMPLETION_PAYLOAD_KEYS, "completion payload");
      validateAgentRun(value.run);
      requireExactKeys(value.details, COMPLETION_DETAIL_KEYS, "completion details");
      validateRunOutcome(value.details.outcome);
      requireNonEmptyString(value.details.outcomeHash, "completion outcomeHash");
      if (runOutcomeHash(value.details.outcome) !== value.details.outcomeHash) {
        throw new TypeError("completion outcome hash does not match its outcome");
      }
    },
    errors,
  );
  if (payload.run.runId !== row.run_id || row.event_type !== RUN_COMPLETED_EVENT_TYPE) {
    throw new errors.EventChainIntegrityError(`${context} metadata is inconsistent`);
  }
  return payload;
}

function assertCompletionLink(database, run, outcome, outcomeHash, createdAt, errors, integrity) {
  const rows = completionEventRows(database, run.runId);
  if (rows.length !== 1) {
    completionLinkError(
      errors,
      `terminal run ${run.runId} must have exactly one RUN_COMPLETED event`,
      integrity,
    );
  }
  const payload = decodeCompletionEvent(rows[0], errors);
  if (
    canonicalJson(payload.run) !== canonicalJson(run)
    || canonicalJson(payload.details.outcome) !== canonicalJson(outcome)
    || payload.details.outcomeHash !== outcomeHash
    || rows[0].created_at !== createdAt
  ) {
    completionLinkError(
      errors,
      `run outcome ${run.runId} does not match its RUN_COMPLETED event`,
      integrity,
    );
  }
}

function decodeOutcomeRow(database, row, errors) {
  const outcome = decodeCanonical(
    row.outcome_json,
    `run outcome ${row.run_id}`,
    validateRunOutcome,
    errors,
  );
  const calculatedHash = runOutcomeHash(outcome);
  if (
    outcome.type !== row.outcome_type
    || calculatedHash !== row.outcome_hash
  ) {
    throw new errors.EventChainIntegrityError(
      `run outcome ${row.run_id} metadata does not match its canonical value`,
    );
  }
  if (typeof row.created_at !== "string" || row.created_at.length === 0) {
    throw new errors.EventChainIntegrityError(
      `run outcome ${row.run_id} has invalid created_at metadata`,
    );
  }
  const run = readRun(database, row.run_id, errors);
  assertPhaseCompatibility(run, outcome, errors, true);
  assertCompletionLink(
    database,
    run,
    outcome,
    row.outcome_hash,
    row.created_at,
    errors,
    true,
  );
  return Object.freeze({
    runId: row.run_id,
    outcomeType: row.outcome_type,
    outcomeHash: row.outcome_hash,
    outcome,
    createdAt: row.created_at,
  });
}

export function runOutcomeHash(outcome) {
  validateRunOutcome(outcome);
  return sha256CanonicalJson(outcome);
}

export function saveRunOutcomeEntity(database, input, errors) {
  requireExactKeys(input, ["runId", "outcome", "createdAt"], "run outcome input");
  requireNonEmptyString(input.runId, "runId");
  requireNonEmptyString(input.createdAt, "createdAt");
  validateRunOutcome(input.outcome);

  const run = readRun(database, input.runId, errors);
  assertPhaseCompatibility(run, input.outcome, errors, false);
  const existing = database.prepare(`
    SELECT 1 AS present FROM run_outcomes WHERE run_id = ?
  `).get(input.runId);
  if (existing) {
    throw new errors.PersistenceError(
      `run ${input.runId} already has a final RunOutcome`,
      "RUN_OUTCOME_ALREADY_EXISTS",
    );
  }

  const hash = runOutcomeHash(input.outcome);
  assertCompletionLink(
    database,
    run,
    input.outcome,
    hash,
    input.createdAt,
    errors,
    false,
  );
  database.prepare(`
    INSERT INTO run_outcomes (
      run_id, outcome_type, outcome_hash, outcome_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    input.runId,
    input.outcome.type,
    hash,
    canonicalJson(input.outcome),
    input.createdAt,
  );
  return getRunOutcomeEntity(database, input.runId, errors);
}

export function getRunOutcomeEntity(database, runId, errors) {
  requireNonEmptyString(runId, "runId");
  const row = database.prepare("SELECT * FROM run_outcomes WHERE run_id = ?").get(runId);
  return row ? decodeOutcomeRow(database, row, errors) : null;
}

export function verifyRunOutcomesEntity(database, errors) {
  const completionRunIds = new Set();
  for (const row of database.prepare(`
    SELECT run_id, sequence, event_type, payload_json, created_at
    FROM domain_events
    WHERE event_type = ?
    ORDER BY run_id, sequence
  `).all(RUN_COMPLETED_EVENT_TYPE)) {
    const payload = decodeCompletionEvent(row, errors);
    if (!Object.hasOwn(OUTCOME_TYPES_BY_PHASE, payload.run.phase)) {
      throw new errors.EventChainIntegrityError(
        `RUN_COMPLETED event for ${row.run_id} does not contain a terminal run`,
      );
    }
    if (completionRunIds.has(row.run_id)) {
      throw new errors.EventChainIntegrityError(
        `run ${row.run_id} has duplicate RUN_COMPLETED events`,
      );
    }
    completionRunIds.add(row.run_id);
  }

  const rows = database.prepare("SELECT * FROM run_outcomes ORDER BY run_id").all();
  const outcomeRunIds = new Set();
  for (const row of rows) {
    decodeOutcomeRow(database, row, errors);
    outcomeRunIds.add(row.run_id);
  }

  let terminalRuns = 0;
  for (const row of database.prepare("SELECT run_id, run_json, version FROM runs").all()) {
    const run = decodeCanonical(row.run_json, `run ${row.run_id}`, validateAgentRun, errors);
    if (run.runId !== row.run_id || run.version !== Number(row.version)) {
      throw new errors.EventChainIntegrityError(
        `run ${row.run_id} metadata does not match its canonical state`,
      );
    }
    if (Object.hasOwn(OUTCOME_TYPES_BY_PHASE, run.phase)) {
      terminalRuns += 1;
      if (!outcomeRunIds.has(run.runId)) {
        throw new errors.EventChainIntegrityError(
          `terminal run ${run.runId} has no durable RunOutcome`,
        );
      }
    }
  }

  if (
    completionRunIds.size !== outcomeRunIds.size
    || [...completionRunIds].some((runId) => !outcomeRunIds.has(runId))
  ) {
    throw new errors.EventChainIntegrityError(
      "RUN_COMPLETED events and durable RunOutcomes are not one-to-one",
    );
  }

  return Object.freeze({ valid: true, outcomes: rows.length, terminalRuns });
}
