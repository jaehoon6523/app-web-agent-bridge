import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Text } from "../src/domain/canonical-json.js";
import { createAgentRun } from "../src/domain/contracts.js";
import { createRunOutcome } from "../src/domain/run-state-machine.js";
import { RunMode, RunOutcomeType, RunPhase } from "../src/domain/vocabulary.js";
import { runOutcomeHash } from "../src/persistence/run-outcomes.js";
import {
  EventChainIntegrityError,
  SqliteStore,
} from "../src/persistence/sqlite-store.js";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-04T00:01:00.000Z";

function makeRun(runId) {
  return createAgentRun({
    runId,
    mode: RunMode.DISCUSSION,
    objective: `Reach a terminal result for ${runId}`,
    policyHash: sha256Text("run-policy-v1"),
    phase: RunPhase.CREATED,
    activeActor: null,
    maxTurns: 12,
    currentTurn: 0,
    paused: false,
    blocker: null,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });
}

function runLimits() {
  return {
    maxTurns: 12,
    maxProtocolRepairs: 1,
    maxDeliveryAttempts: 3,
    maxConsecutiveActorFailures: 2,
  };
}

function openFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-outcomes-"));
  const filename = join(directory, "controller.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { filename, store: new SqliteStore(filename) };
}

function createStoredRun(store, runId) {
  const run = makeRun(runId);
  store.createRun(run, { runLimits: runLimits() });
  return run;
}

function terminalize(store, run, phase, outcome) {
  const next = createAgentRun({
    ...run,
    phase,
    activeActor: null,
    paused: false,
    blocker: null,
    version: run.version + 1,
    updatedAt: T1,
  });
  store.appendEventAndUpdateProjection({
    runId: run.runId,
    expectedVersion: run.version,
    eventId: `${run.runId}:terminal`,
    eventType: "RUN_COMPLETED",
    payload: {
      run: next,
      details: { outcome, outcomeHash: runOutcomeHash(outcome) },
    },
    createdAt: T1,
    nextRun: next,
  });
  return next;
}

test("compatible terminal outcomes are hash-bound, queryable, and restart durable", (t) => {
  const { filename, store } = openFixture(t);
  const cases = [
    {
      runId: "run-consensus",
      phase: RunPhase.COMPLETE,
      outcome: createRunOutcome({
        type: RunOutcomeType.CONSENSUS,
        proposalHash: sha256Text("proposal-ref"),
      }),
    },
    {
      runId: "run-inconclusive",
      phase: RunPhase.COMPLETE,
      outcome: createRunOutcome({
        type: RunOutcomeType.INCONCLUSIVE,
        reason: "Turn budget exhausted",
        unresolvedFindings: ["One disagreement remains"],
      }),
    },
    {
      runId: "run-failed",
      phase: RunPhase.FAILED,
      outcome: createRunOutcome({
        type: RunOutcomeType.FAILED,
        errorCode: "AGENT_PROTOCOL_REPAIR_EXHAUSTED",
      }),
    },
    {
      runId: "run-cancelled",
      phase: RunPhase.CANCELLED,
      outcome: createRunOutcome({
        type: RunOutcomeType.CANCELLED,
        cancelledBy: "user",
      }),
    },
  ];

  for (const item of cases) {
    terminalize(store, createStoredRun(store, item.runId), item.phase, item.outcome);
    const record = store.saveRunOutcome({
      runId: item.runId,
      outcome: item.outcome,
      createdAt: T1,
    });
    assert.deepEqual(record, {
      runId: item.runId,
      outcomeType: item.outcome.type,
      outcomeHash: runOutcomeHash(item.outcome),
      outcome: item.outcome,
      createdAt: T1,
    });
    assert.deepEqual(store.getRunOutcome(item.runId), record);
  }
  assert.deepEqual(
    store.verifyRunOutcomes(),
    { valid: true, outcomes: cases.length, terminalRuns: cases.length },
  );
  store.close();

  const reopened = new SqliteStore(filename);
  for (const item of cases) {
    assert.equal(reopened.getRunOutcome(item.runId)?.outcomeType, item.outcome.type);
  }
  reopened.close();
});

test("nonterminal and phase-incompatible outcomes are rejected", (t) => {
  const { store } = openFixture(t);
  const nonterminal = createStoredRun(store, "run-nonterminal");
  const failure = createRunOutcome({
    type: RunOutcomeType.FAILED,
    errorCode: "FAILED_FOR_TEST",
  });
  assert.equal(store.getRunOutcome(nonterminal.runId), null);
  assert.throws(
    () => store.saveRunOutcome({ runId: nonterminal.runId, outcome: failure, createdAt: T1 }),
    (error) => error.code === "RUN_OUTCOME_NONTERMINAL_PHASE",
  );

  const cancelledOutcome = createRunOutcome({
    type: RunOutcomeType.CANCELLED,
    cancelledBy: "test",
  });
  const cancelled = terminalize(
    store,
    createStoredRun(store, "run-incompatible"),
    RunPhase.CANCELLED,
    cancelledOutcome,
  );
  assert.throws(
    () => store.saveRunOutcome({ runId: cancelled.runId, outcome: failure, createdAt: T1 }),
    (error) => error.code === "RUN_OUTCOME_PHASE_MISMATCH",
  );
  store.close();
});

test("a run can persist only one final outcome", (t) => {
  const { store } = openFixture(t);
  const consensus = createRunOutcome({
    type: RunOutcomeType.CONSENSUS,
    proposalHash: sha256Text("proposal-ref"),
  });
  const run = terminalize(
    store,
    createStoredRun(store, "run-one-outcome"),
    RunPhase.COMPLETE,
    consensus,
  );
  store.saveRunOutcome({ runId: run.runId, outcome: consensus, createdAt: T1 });
  assert.throws(
    () => store.saveRunOutcome({ runId: run.runId, outcome: consensus, createdAt: T1 }),
    (error) => error.code === "RUN_OUTCOME_ALREADY_EXISTS",
  );
  store.close();
});

test("startup integrity rejects a terminal run with no durable outcome", (t) => {
  const { filename, store } = openFixture(t);
  const outcome = createRunOutcome({
    type: RunOutcomeType.CANCELLED,
    cancelledBy: "test",
  });
  terminalize(
    store,
    createStoredRun(store, "run-missing-outcome"),
    RunPhase.CANCELLED,
    outcome,
  );
  store.close();
  assert.throws(() => new SqliteStore(filename), EventChainIntegrityError);
});

test("startup integrity rejects coherent outcome content and hash tampering", (t) => {
  const { filename, store } = openFixture(t);
  const outcome = createRunOutcome({
    type: RunOutcomeType.FAILED,
    errorCode: "EXPECTED_FAILURE",
  });
  const run = terminalize(
    store,
    createStoredRun(store, "run-tampered-outcome"),
    RunPhase.FAILED,
    outcome,
  );
  store.saveRunOutcome({ runId: run.runId, outcome, createdAt: T1 });
  store.close();

  const tampered = createRunOutcome({
    type: RunOutcomeType.FAILED,
    errorCode: "FORGED_FAILURE",
  });

  const database = new DatabaseSync(filename);
  database.prepare(`
    UPDATE run_outcomes
    SET outcome_type = ?, outcome_hash = ?, outcome_json = ?
    WHERE run_id = ?
  `).run(
    tampered.type,
    runOutcomeHash(tampered),
    canonicalJson(tampered),
    run.runId,
  );
  database.close();
  assert.throws(() => new SqliteStore(filename), EventChainIntegrityError);
});

test("startup integrity rejects a final outcome attached to a nonterminal run", (t) => {
  const { filename, store } = openFixture(t);
  const run = createStoredRun(store, "run-forged-outcome");
  store.close();
  const outcome = createRunOutcome({
    type: RunOutcomeType.CANCELLED,
    cancelledBy: "forged",
  });

  const database = new DatabaseSync(filename);
  database.prepare(`
    INSERT INTO run_outcomes (
      run_id, outcome_type, outcome_hash, outcome_json, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    run.runId,
    outcome.type,
    runOutcomeHash(outcome),
    canonicalJson(outcome),
    T1,
  );
  database.close();
  assert.throws(() => new SqliteStore(filename), EventChainIntegrityError);
});
