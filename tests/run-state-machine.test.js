import assert from "node:assert/strict";
import test from "node:test";
import { sha256Text } from "../src/domain/canonical-json.js";
import {
  AgentActor,
  RunBlockerType,
  RunMode,
  RunOutcomeType,
  RunPhase,
} from "../src/domain/vocabulary.js";
import {
  assertRunState,
  createRunLimits,
  createRunOutcome,
  createInitialRunState,
  enforceTurnLimit,
  requestPause,
  resumeRun,
  setRunBlocker,
  transitionRunState,
  validateRunLimits,
  validateRunOutcome,
} from "../src/domain/run-state-machine.js";

const TIMES = Object.freeze({
  created: "2026-09-04T00:00:00.000Z",
  started: "2026-09-04T00:00:01.000Z",
  pending: "2026-09-04T00:00:02.000Z",
  running: "2026-09-04T00:00:03.000Z",
  paused: "2026-09-04T00:00:04.000Z",
  stored: "2026-09-04T00:00:05.000Z",
  resumed: "2026-09-04T00:00:06.000Z",
  next: "2026-09-04T00:00:07.000Z",
  consensus: "2026-09-04T00:00:08.000Z",
  completed: "2026-09-04T00:00:09.000Z",
});

function newRun({ maxTurns = 4 } = {}) {
  return createInitialRunState({
    runId: "run-001",
    mode: RunMode.DISCUSSION,
    objective: "Produce one reviewable proposal",
    objectiveHash: sha256Text("Produce one reviewable proposal"),
    policyHash: sha256Text("policy-v1"),
    maxTurns,
    createdAt: TIMES.created,
  });
}

function codexRunning({ maxTurns = 4 } = {}) {
  const created = newRun({ maxTurns });
  const starting = transitionRunState(created, {
    to: RunPhase.STARTING_SESSIONS,
    expectedVersion: created.version,
    updatedAt: TIMES.started,
  });
  const pending = transitionRunState(starting, {
    to: RunPhase.CODEX_TURN_PENDING,
    expectedVersion: starting.version,
    updatedAt: TIMES.pending,
  });
  return transitionRunState(pending, {
    to: RunPhase.CODEX_TURN_RUNNING,
    expectedVersion: pending.version,
    updatedAt: TIMES.running,
  });
}

test("RunLimits and RunOutcome remain closed, immutable contract unions", () => {
  const limits = createRunLimits({
    maxTurns: 8,
    maxProtocolRepairs: 0,
    maxDeliveryAttempts: 3,
    maxConsecutiveActorFailures: 2,
  });
  assert.equal(validateRunLimits(limits), limits);
  assert.ok(Object.isFrozen(limits));
  assert.throws(
    () => createRunLimits({ ...limits, unownedRetryLimit: 1 }),
    /unsupported property/i,
  );
  assert.throws(
    () => createRunLimits({ ...limits, maxProtocolRepairs: -1 }),
    /maxProtocolRepairs/i,
  );

  const outcomes = [
    {
      type: RunOutcomeType.CONSENSUS,
      proposalHash: sha256Text("proposal"),
    },
    {
      type: RunOutcomeType.INCONCLUSIVE,
      reason: "MAX_TURNS_REACHED",
      unresolvedFindings: ["No shared proposal"],
    },
    {
      type: RunOutcomeType.BLOCKED,
      gateReason: "PRODUCT_DECISION_REQUIRED",
    },
    {
      type: RunOutcomeType.CANCELLED,
      cancelledBy: "USER",
    },
    {
      type: RunOutcomeType.FAILED,
      errorCode: "SESSION_START_FAILED",
    },
  ].map(createRunOutcome);

  outcomes.forEach((outcome) => {
    assert.equal(validateRunOutcome(outcome), outcome);
    assert.ok(Object.isFrozen(outcome));
  });
  assert.ok(Object.isFrozen(outcomes[1].unresolvedFindings));
  assert.throws(
    () => createRunOutcome({ ...outcomes[0], unownedStatus: "PASS" }),
    /unsupported property/i,
  );
});

test("initial state and transitions keep phase, actor, turn, and version consistent", () => {
  const created = newRun();
  assert.equal(created.phase, RunPhase.CREATED);
  assert.equal(created.activeActor, null);
  assert.equal(created.currentTurn, 0);
  assert.equal(created.version, 1);
  assert.ok(Object.isFrozen(created));

  const starting = transitionRunState(created, {
    to: RunPhase.STARTING_SESSIONS,
    expectedVersion: 1,
    updatedAt: TIMES.started,
  });
  const pending = transitionRunState(starting, {
    to: RunPhase.CODEX_TURN_PENDING,
    expectedVersion: 2,
    updatedAt: TIMES.pending,
  });
  const running = transitionRunState(pending, {
    to: RunPhase.CODEX_TURN_RUNNING,
    expectedVersion: 3,
    updatedAt: TIMES.running,
  });
  const stored = transitionRunState(running, {
    to: RunPhase.CODEX_RESPONSE_STORED,
    expectedVersion: 4,
    updatedAt: TIMES.stored,
  });

  assert.equal(running.activeActor, AgentActor.CODEX_AGENT);
  assert.equal(running.currentTurn, 0);
  assert.equal(stored.activeActor, null);
  assert.equal(stored.currentTurn, 1);
  assert.equal(stored.version, 5);
  assert.equal(created.phase, RunPhase.CREATED, "the input state was not mutated");
  assert.equal(assertRunState(stored), stored);
});

test("invalid edges, stale versions, and actor/phase mismatches fail closed", () => {
  const created = newRun();
  assert.throws(
    () => transitionRunState(created, {
      to: RunPhase.COMPLETE,
      expectedVersion: created.version,
      updatedAt: TIMES.completed,
    }),
    /transition/i,
  );
  assert.throws(
    () => transitionRunState(created, {
      to: RunPhase.STARTING_SESSIONS,
      expectedVersion: created.version + 1,
      updatedAt: TIMES.started,
    }),
    /version/i,
  );

  const malformed = {
    ...created,
    phase: RunPhase.WEB_TURN_RUNNING,
    activeActor: AgentActor.CODEX_AGENT,
  };
  assert.throws(() => assertRunState(malformed), /activeActor/i);
});

test("a run may be cancelled before session startup", () => {
  const created = newRun();
  const cancelled = transitionRunState(created, {
    to: RunPhase.CANCELLED,
    expectedVersion: created.version,
    updatedAt: TIMES.completed,
  });
  assert.equal(cancelled.phase, RunPhase.CANCELLED);
  assert.equal(cancelled.activeActor, null);
});

test("pause never interrupts an active turn and blocks the next delivery boundary", () => {
  const running = codexRunning();
  const paused = requestPause(running, {
    expectedVersion: running.version,
    updatedAt: TIMES.paused,
  });

  assert.equal(paused.paused, true);
  assert.equal(paused.phase, RunPhase.CODEX_TURN_RUNNING);
  assert.equal(paused.activeActor, AgentActor.CODEX_AGENT);

  const stored = transitionRunState(paused, {
    to: RunPhase.CODEX_RESPONSE_STORED,
    expectedVersion: paused.version,
    updatedAt: TIMES.stored,
  });
  assert.equal(stored.currentTurn, 1, "the in-flight response is stored normally");
  assert.equal(stored.paused, true);
  const checking = transitionRunState(stored, {
    to: RunPhase.CONSENSUS_CHECK,
    expectedVersion: stored.version,
    updatedAt: TIMES.consensus,
  });
  assert.throws(
    () => transitionRunState(checking, {
      to: RunPhase.CODEX_TO_WEB_PENDING,
      expectedVersion: checking.version,
      updatedAt: TIMES.next,
    }),
    /paused/i,
  );

  const resumed = resumeRun(checking, {
    expectedVersion: checking.version,
    updatedAt: TIMES.resumed,
  });
  assert.equal(resumed.paused, false);
  assert.equal(resumed.phase, RunPhase.CONSENSUS_CHECK);
  assert.equal(resumed.activeActor, null);

  const deliveryPending = transitionRunState(resumed, {
    to: RunPhase.CODEX_TO_WEB_PENDING,
    expectedVersion: resumed.version,
    updatedAt: TIMES.next,
  });
  assert.equal(deliveryPending.phase, RunPhase.CODEX_TO_WEB_PENDING);
});

test("an unresolved blocker prevents a new delivery or turn but not in-flight storage", () => {
  const running = codexRunning();
  const blocked = setRunBlocker(running, {
    blocker: {
      type: RunBlockerType.RUNTIME_APPROVAL,
      approvalId: "approval-001",
    },
    expectedVersion: running.version,
    updatedAt: TIMES.paused,
  });
  const stored = transitionRunState(blocked, {
    to: RunPhase.CODEX_RESPONSE_STORED,
    expectedVersion: blocked.version,
    updatedAt: TIMES.stored,
  });

  assert.equal(stored.blocker.type, RunBlockerType.RUNTIME_APPROVAL);
  const checking = transitionRunState(stored, {
    to: RunPhase.CONSENSUS_CHECK,
    expectedVersion: stored.version,
    updatedAt: TIMES.consensus,
  });
  assert.throws(
    () => transitionRunState(checking, {
      to: RunPhase.CODEX_TO_WEB_PENDING,
      expectedVersion: checking.version,
      updatedAt: TIMES.next,
    }),
    /blocker/i,
  );

  const unblocked = setRunBlocker(checking, {
    blocker: null,
    expectedVersion: checking.version,
    updatedAt: TIMES.resumed,
  });
  assert.equal(unblocked.blocker, null);
  assert.equal(
    transitionRunState(unblocked, {
      to: RunPhase.CODEX_TO_WEB_PENDING,
      expectedVersion: unblocked.version,
      updatedAt: TIMES.next,
    }).phase,
    RunPhase.CODEX_TO_WEB_PENDING,
  );
});

test("human and recovery phases enforce their minimum blocker invariants", () => {
  const running = codexRunning();
  assert.throws(
    () => transitionRunState(running, {
      to: RunPhase.RECOVERY_REQUIRED,
      expectedVersion: running.version,
      updatedAt: TIMES.stored,
    }),
    /RECOVERY_CONFIRMATION|blocker/i,
  );

  const recovery = transitionRunState(running, {
    to: RunPhase.RECOVERY_REQUIRED,
    blocker: {
      type: RunBlockerType.RECOVERY_CONFIRMATION,
      operationId: "recover-turn-001",
    },
    expectedVersion: running.version,
    updatedAt: TIMES.stored,
  });
  assert.equal(recovery.phase, RunPhase.RECOVERY_REQUIRED);
  assert.equal(recovery.activeActor, null);

  assert.throws(
    () => transitionRunState(recovery, {
      to: RunPhase.HUMAN_GATE,
      blocker: null,
      expectedVersion: recovery.version,
      updatedAt: TIMES.next,
    }),
    /blocker/i,
  );
});

test("reaching maxTurns completes with an INCONCLUSIVE outcome, not a human gate", () => {
  const running = codexRunning({ maxTurns: 1 });
  const stored = transitionRunState(running, {
    to: RunPhase.CODEX_RESPONSE_STORED,
    expectedVersion: running.version,
    updatedAt: TIMES.stored,
  });
  const checking = transitionRunState(stored, {
    to: RunPhase.CONSENSUS_CHECK,
    expectedVersion: stored.version,
    updatedAt: TIMES.consensus,
  });
  const unresolvedFindings = ["Reviewer did not get a turn"];
  const result = enforceTurnLimit(checking, {
    expectedVersion: checking.version,
    unresolvedFindings,
    updatedAt: TIMES.completed,
  });

  unresolvedFindings.push("mutated after completion");
  assert.equal(result.state.phase, RunPhase.COMPLETE);
  assert.equal(result.state.blocker, null);
  assert.deepEqual(result.outcome, {
    type: RunOutcomeType.INCONCLUSIVE,
    reason: "MAX_TURNS_REACHED",
    unresolvedFindings: ["Reviewer did not get a turn"],
  });
  assert.ok(Object.isFrozen(result.outcome.unresolvedFindings));
  assert.throws(
    () => transitionRunState(result.state, {
      to: RunPhase.CODEX_TO_WEB_PENDING,
      expectedVersion: result.state.version,
      updatedAt: "2026-09-04T00:00:10.000Z",
    }),
    /terminal|transition/i,
  );
});

test("maxTurns prevents dispatching one more turn before completion is recorded", () => {
  const running = codexRunning({ maxTurns: 1 });
  const stored = transitionRunState(running, {
    to: RunPhase.CODEX_RESPONSE_STORED,
    expectedVersion: running.version,
    updatedAt: TIMES.stored,
  });
  const checking = transitionRunState(stored, {
    to: RunPhase.CONSENSUS_CHECK,
    expectedVersion: stored.version,
    updatedAt: TIMES.consensus,
  });

  assert.throws(
    () => transitionRunState(checking, {
      to: RunPhase.CODEX_TO_WEB_PENDING,
      expectedVersion: checking.version,
      updatedAt: TIMES.next,
    }),
    /maxTurns|turn limit/i,
  );
});

test("consensus checking preserves strict actor alternation", () => {
  const running = codexRunning();
  const stored = transitionRunState(running, {
    to: RunPhase.CODEX_RESPONSE_STORED,
    expectedVersion: running.version,
    updatedAt: TIMES.stored,
  });
  const checking = transitionRunState(stored, {
    to: RunPhase.CONSENSUS_CHECK,
    expectedVersion: stored.version,
    updatedAt: TIMES.consensus,
  });
  assert.throws(() => transitionRunState(checking, {
    to: RunPhase.WEB_TO_CODEX_PENDING,
    expectedVersion: checking.version,
    updatedAt: TIMES.next,
  }), (error) => error.code === "RUN_ACTOR_ALTERNATION_VIOLATION");
  assert.equal(transitionRunState(checking, {
    to: RunPhase.CODEX_TO_WEB_PENDING,
    expectedVersion: checking.version,
    updatedAt: TIMES.next,
  }).phase, RunPhase.CODEX_TO_WEB_PENDING);
});

test("externally active pending phases can fail closed into recovery", () => {
  const running = codexRunning();
  const stored = transitionRunState(running, {
    to: RunPhase.CODEX_RESPONSE_STORED,
    expectedVersion: running.version,
    updatedAt: TIMES.stored,
  });
  const checking = transitionRunState(stored, {
    to: RunPhase.CONSENSUS_CHECK,
    expectedVersion: stored.version,
    updatedAt: TIMES.consensus,
  });
  const webPending = transitionRunState(checking, {
    to: RunPhase.CODEX_TO_WEB_PENDING,
    expectedVersion: checking.version,
    updatedAt: TIMES.next,
  });
  const recovery = transitionRunState(webPending, {
    to: RunPhase.RECOVERY_REQUIRED,
    blocker: {
      type: RunBlockerType.RECOVERY_CONFIRMATION,
      operationId: "recover-delivery-001",
    },
    expectedVersion: webPending.version,
    updatedAt: TIMES.completed,
  });
  assert.equal(recovery.phase, RunPhase.RECOVERY_REQUIRED);
  assert.throws(() => transitionRunState(recovery, {
    to: RunPhase.CODEX_TO_WEB_PENDING,
    expectedVersion: recovery.version,
    updatedAt: "2026-09-04T00:00:10.000Z",
  }), (error) => error.code === "RUN_BLOCKER_NOT_RESOLVED");
});

test("recovery may adopt a confirmed completed response exactly once", () => {
  const running = codexRunning();
  const recovery = transitionRunState(running, {
    to: RunPhase.RECOVERY_REQUIRED,
    blocker: {
      type: RunBlockerType.RECOVERY_CONFIRMATION,
      operationId: "recover-completed-codex-turn",
    },
    expectedVersion: running.version,
    updatedAt: TIMES.stored,
  });
  const adopted = transitionRunState(recovery, {
    to: RunPhase.CODEX_RESPONSE_STORED,
    blocker: null,
    expectedVersion: recovery.version,
    updatedAt: TIMES.resumed,
  });
  assert.equal(adopted.currentTurn, 1);
  assert.equal(adopted.blocker, null);
});
