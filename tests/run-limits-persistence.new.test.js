import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Text } from "../src/domain/canonical-json.js";
import { createAgentRun } from "../src/domain/contracts.js";
import { RunMode, RunPhase } from "../src/domain/vocabulary.js";
import {
  nextConsecutiveActorFailureCount,
  nextDeliveryAttemptCount,
  nextProtocolRepairCount,
  nextTurnNumber,
} from "../src/orchestration/run-limits.js";
import { OptimisticConcurrencyError } from "../src/persistence/errors.js";
import {
  RunLimitExceededError,
  createRunLimitsEntity,
  getRunLimitsEntity,
  recordConsecutiveActorFailureEntity,
  recordProtocolRepairEntity,
  resetConsecutiveActorFailuresEntity,
} from "../src/persistence/run-limits.js";
import { initializeSqliteSchema } from "../src/persistence/schema.js";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-04T00:01:00.000Z";
const T2 = "2026-09-04T00:02:00.000Z";
const POLICY_HASH = sha256Text("policy-v1");

function limits(overrides = {}) {
  return {
    maxTurns: 5,
    maxProtocolRepairs: 2,
    maxDeliveryAttempts: 3,
    maxConsecutiveActorFailures: 2,
    ...overrides,
  };
}

function run(runId = "run-limits") {
  return createAgentRun({
    runId,
    mode: RunMode.DISCUSSION,
    objective: "Reach a bounded consensus",
    policyHash: POLICY_HASH,
    phase: RunPhase.CREATED,
    activeActor: null,
    maxTurns: 5,
    currentTurn: 0,
    paused: false,
    blocker: null,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });
}

function openDatabase(t, { transitionBeforeFreeze = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-run-limits-"));
  const path = join(directory, "controller.sqlite");

  const initial = run();
  const storedRun = transitionBeforeFreeze
    ? createAgentRun({
      ...initial,
      phase: RunPhase.STARTING_SESSIONS,
      version: 2,
      updatedAt: T1,
    })
    : initial;

  const database = new DatabaseSync(path);
  initializeSqliteSchema(database);
  // Seed the owner row directly because the public SqliteStore API now requires
  // RunLimits atomically. These tests exercise the lower-level freeze primitive.
  database.prepare(`
    INSERT INTO runs (
      run_id, run_json, version, event_count, last_event_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    storedRun.runId,
    canonicalJson(storedRun),
    storedRun.version,
    transitionBeforeFreeze ? 2 : 1,
    "fixture-event-hash",
    storedRun.createdAt,
    storedRun.updatedAt,
  );
  t.after(() => {
    try {
      database.close();
    } catch {
      // A test may close this handle early to exercise reopen behavior.
    }
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { database, initial, path };
}

test("caller-supplied RunLimits are frozen exactly and survive reopen", (t) => {
  const { database, initial, path } = openDatabase(t);
  const supplied = limits();
  const frozen = createRunLimitsEntity(database, {
    runId: initial.runId,
    policyHash: POLICY_HASH,
    limits: supplied,
    createdAt: T0,
  });

  assert.deepEqual(frozen.limits, supplied);
  assert.equal(frozen.policyHash, POLICY_HASH);
  assert.equal(frozen.protocolRepairsUsed, 0);
  assert.equal(frozen.consecutiveActorFailures, 0);
  assert.equal(frozen.counterVersion, 1);
  assert(Object.isFrozen(frozen.limits));

  database.close();
  const reopened = new DatabaseSync(path);
  initializeSqliteSchema(reopened);
  assert.deepEqual(getRunLimitsEntity(reopened, initial.runId), frozen);
  reopened.close();
});

test("RunLimits have no implicit defaults and are bound to run policy/maxTurns", (t) => {
  const { database, initial } = openDatabase(t);
  assert.throws(() => createRunLimitsEntity(database, {
    runId: initial.runId,
    policyHash: POLICY_HASH,
    limits: {
      maxTurns: 5,
      maxProtocolRepairs: 2,
      maxDeliveryAttempts: 3,
    },
    createdAt: T0,
  }), /maxConsecutiveActorFailures/i);

  assert.throws(() => createRunLimitsEntity(database, {
    runId: initial.runId,
    policyHash: sha256Text("different-policy"),
    limits: limits(),
    createdAt: T0,
  }), (error) => error.code === "RUN_LIMITS_POLICY_MISMATCH");

  assert.throws(() => createRunLimitsEntity(database, {
    runId: initial.runId,
    policyHash: POLICY_HASH,
    limits: limits({ maxTurns: 6 }),
    createdAt: T0,
  }), (error) => error.code === "RUN_LIMITS_RUN_MISMATCH");
});

test("frozen limit configuration cannot be replaced, updated, or deleted", (t) => {
  const { database, initial } = openDatabase(t);
  createRunLimitsEntity(database, {
    runId: initial.runId,
    policyHash: POLICY_HASH,
    limits: limits(),
    createdAt: T0,
  });

  assert.throws(() => createRunLimitsEntity(database, {
    runId: initial.runId,
    policyHash: POLICY_HASH,
    limits: limits(),
    createdAt: T0,
  }), (error) => error.code === "RUN_LIMITS_ALREADY_FROZEN");
  assert.throws(
    () => database.prepare("UPDATE run_limits SET max_turns = 99 WHERE run_id = ?").run(initial.runId),
    /immutable/i,
  );
  assert.throws(
    () => database.prepare("DELETE FROM run_limits WHERE run_id = ?").run(initial.runId),
    /immutable/i,
  );
});

test("RunLimits cannot be attached after the run has transitioned", (t) => {
  const { database, initial } = openDatabase(t, { transitionBeforeFreeze: true });
  assert.throws(() => createRunLimitsEntity(database, {
    runId: initial.runId,
    policyHash: POLICY_HASH,
    limits: limits(),
    createdAt: T1,
  }), (error) => error.code === "RUN_LIMITS_FREEZE_WINDOW_CLOSED");
});

test("protocol repair usage is durable, CAS-protected, and stops at the frozen limit", (t) => {
  const { database, initial } = openDatabase(t);
  createRunLimitsEntity(database, {
    runId: initial.runId,
    policyHash: POLICY_HASH,
    limits: limits(),
    createdAt: T0,
  });

  const first = recordProtocolRepairEntity(database, {
    runId: initial.runId,
    expectedCounterVersion: 1,
    updatedAt: T1,
  });
  assert.equal(first.protocolRepairsUsed, 1);
  assert.equal(first.counterVersion, 2);

  assert.throws(() => recordProtocolRepairEntity(database, {
    runId: initial.runId,
    expectedCounterVersion: 1,
    updatedAt: T1,
  }), OptimisticConcurrencyError);

  const second = recordProtocolRepairEntity(database, {
    runId: initial.runId,
    expectedCounterVersion: 2,
    updatedAt: T2,
  });
  assert.equal(second.protocolRepairsUsed, 2);
  assert.equal(second.counterVersion, 3);
  assert.throws(() => recordProtocolRepairEntity(database, {
    runId: initial.runId,
    expectedCounterVersion: 3,
    updatedAt: T2,
  }), RunLimitExceededError);
});

test("consecutive actor failure usage increments and resets with CAS", (t) => {
  const { database, initial } = openDatabase(t);
  createRunLimitsEntity(database, {
    runId: initial.runId,
    policyHash: POLICY_HASH,
    limits: limits(),
    createdAt: T0,
  });

  const first = recordConsecutiveActorFailureEntity(database, {
    runId: initial.runId,
    expectedCounterVersion: 1,
    updatedAt: T1,
  });
  const second = recordConsecutiveActorFailureEntity(database, {
    runId: initial.runId,
    expectedCounterVersion: first.counterVersion,
    updatedAt: T2,
  });
  assert.equal(second.consecutiveActorFailures, 2);
  assert.throws(() => recordConsecutiveActorFailureEntity(database, {
    runId: initial.runId,
    expectedCounterVersion: second.counterVersion,
    updatedAt: T2,
  }), RunLimitExceededError);

  const reset = resetConsecutiveActorFailuresEntity(database, {
    runId: initial.runId,
    expectedCounterVersion: second.counterVersion,
    updatedAt: T2,
  });
  assert.equal(reset.consecutiveActorFailures, 0);
  assert.equal(reset.counterVersion, 4);
});

test("pure guards cover all four limits without supplying policy defaults", () => {
  const supplied = limits({ maxProtocolRepairs: 0 });
  assert.equal(nextTurnNumber(supplied, 4), 5);
  assert.equal(nextDeliveryAttemptCount(supplied, 2), 3);
  assert.equal(nextConsecutiveActorFailureCount(supplied, 1), 2);

  assert.throws(() => nextTurnNumber(supplied, 5), RunLimitExceededError);
  assert.throws(() => nextProtocolRepairCount(supplied, 0), RunLimitExceededError);
  assert.throws(() => nextDeliveryAttemptCount(supplied, 3), RunLimitExceededError);
  assert.throws(() => nextConsecutiveActorFailureCount(supplied, 2), RunLimitExceededError);
});
