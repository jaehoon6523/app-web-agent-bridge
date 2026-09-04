import assert from "node:assert/strict";
import test from "node:test";
import { sha256Text } from "../src/domain/canonical-json.js";
import {
  AgentBlockedReason,
  AgentActor,
  AgentTurnInputKind,
  OperationalBlockerReason,
  RunBlockerType,
  RunMode,
  RunOutcomeType,
  RunPhase,
} from "../src/domain/vocabulary.js";
import {
  adoptRecoveredCompletedResponse,
  assertRunState,
  createRunLimits,
  createRunOutcome,
  createInitialRunState,
  enforceTurnLimit,
  requestPause,
  resumeRun,
  setRunBlocker,
  startProtocolRepairTurn,
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
  for (const gateReason of Object.values(AgentBlockedReason)) {
    assert.equal(createRunOutcome({ type: RunOutcomeType.BLOCKED, gateReason }).gateReason, gateReason);
  }
  for (const gateReason of [...Object.values(OperationalBlockerReason), "POLICY_VIOLATION"]) {
    assert.throws(
      () => createRunOutcome({ type: RunOutcomeType.BLOCKED, gateReason }),
      /AgentBlockedReason/u,
    );
  }
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

test("pause stores an active response and queues, but does not start, the next delivery", () => {
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
  const deliveryPending = transitionRunState(checking, {
    to: RunPhase.CODEX_TO_WEB_PENDING,
    sourceActor: AgentActor.CODEX_AGENT,
    expectedVersion: checking.version,
    updatedAt: TIMES.next,
  });
  assert.equal(deliveryPending.paused, true);
  assert.equal(deliveryPending.phase, RunPhase.CODEX_TO_WEB_PENDING);

  const resumed = resumeRun(deliveryPending, {
    expectedVersion: deliveryPending.version,
    updatedAt: TIMES.resumed,
  });
  assert.equal(resumed.paused, false);
  assert.equal(resumed.phase, RunPhase.CODEX_TO_WEB_PENDING);
  assert.equal(resumed.activeActor, null);
});

test("an unresolved blocker allows a queued delivery but prevents its turn from starting", () => {
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
  const queued = transitionRunState(checking, {
    to: RunPhase.CODEX_TO_WEB_PENDING,
    sourceActor: AgentActor.CODEX_AGENT,
    expectedVersion: checking.version,
    updatedAt: TIMES.next,
  });
  assert.equal(queued.blocker.type, RunBlockerType.RUNTIME_APPROVAL);
  assert.throws(() => transitionRunState(queued, {
    to: RunPhase.WEB_TURN_RUNNING,
    expectedVersion: queued.version,
    updatedAt: TIMES.next,
  }), /blocker/i);

  const unblocked = setRunBlocker(queued, {
    blocker: null,
    expectedVersion: queued.version,
    updatedAt: TIMES.resumed,
  });
  assert.equal(unblocked.blocker, null);
  assert.equal(
    transitionRunState(unblocked, {
      to: RunPhase.WEB_TURN_RUNNING,
      expectedVersion: unblocked.version,
      updatedAt: TIMES.next,
    }).phase,
    RunPhase.WEB_TURN_RUNNING,
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
      sourceActor: AgentActor.CODEX_AGENT,
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
      sourceActor: AgentActor.CODEX_AGENT,
      expectedVersion: checking.version,
      updatedAt: TIMES.next,
    }),
    /maxTurns|turn limit/i,
  );
});

test("consensus checking requires the explicit response source for peer alternation", () => {
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
    to: RunPhase.CODEX_TO_WEB_PENDING,
    expectedVersion: checking.version,
    updatedAt: TIMES.next,
  }), /sourceActor/i);
  assert.throws(() => transitionRunState(checking, {
    to: RunPhase.WEB_TO_CODEX_PENDING,
    sourceActor: AgentActor.CODEX_AGENT,
    expectedVersion: checking.version,
    updatedAt: TIMES.next,
  }), (error) => error.code === "RUN_ACTOR_ALTERNATION_VIOLATION");
  assert.equal(transitionRunState(checking, {
    to: RunPhase.CODEX_TO_WEB_PENDING,
    sourceActor: AgentActor.CODEX_AGENT,
    expectedVersion: checking.version,
    updatedAt: TIMES.next,
  }).phase, RunPhase.CODEX_TO_WEB_PENDING);
});

test("a same-actor protocol repair is explicit and every terminal response counts as a turn", () => {
  const running = codexRunning();
  const invalidResponseStored = transitionRunState(running, {
    to: RunPhase.CODEX_RESPONSE_STORED,
    expectedVersion: running.version,
    updatedAt: TIMES.stored,
  });
  assert.equal(invalidResponseStored.currentTurn, 1);

  assert.throws(() => transitionRunState(invalidResponseStored, {
    to: RunPhase.CODEX_TURN_RUNNING,
    expectedVersion: invalidResponseStored.version,
    updatedAt: TIMES.next,
  }), /transition/i, "the generic transition cannot silently become a repair");
  assert.throws(() => startProtocolRepairTurn(invalidResponseStored, {
    actor: AgentActor.CODEX_AGENT,
    kind: AgentTurnInputKind.PEER_RELAY,
    expectedVersion: invalidResponseStored.version,
    updatedAt: TIMES.next,
  }), (error) => error.code === "PROTOCOL_REPAIR_INTENT_REQUIRED");
  assert.throws(() => startProtocolRepairTurn(invalidResponseStored, {
    actor: AgentActor.CHATGPT_WEB_AGENT,
    kind: AgentTurnInputKind.PROTOCOL_REPAIR,
    expectedVersion: invalidResponseStored.version,
    updatedAt: TIMES.next,
  }), (error) => error.code === "PROTOCOL_REPAIR_ACTOR_MISMATCH");

  const repairRunning = startProtocolRepairTurn(invalidResponseStored, {
    actor: AgentActor.CODEX_AGENT,
    kind: AgentTurnInputKind.PROTOCOL_REPAIR,
    expectedVersion: invalidResponseStored.version,
    updatedAt: TIMES.next,
  });
  assert.equal(repairRunning.phase, RunPhase.CODEX_TURN_RUNNING);
  assert.equal(repairRunning.activeActor, AgentActor.CODEX_AGENT);
  assert.equal(repairRunning.currentTurn, 1, "starting a repair does not count a response");

  const repairResponseStored = transitionRunState(repairRunning, {
    to: RunPhase.CODEX_RESPONSE_STORED,
    expectedVersion: repairRunning.version,
    updatedAt: TIMES.completed,
  });
  assert.equal(repairResponseStored.currentTurn, 2);

  const checking = transitionRunState(invalidResponseStored, {
    to: RunPhase.CONSENSUS_CHECK,
    expectedVersion: invalidResponseStored.version,
    updatedAt: TIMES.consensus,
  });
  const webPending = transitionRunState(checking, {
    to: RunPhase.CODEX_TO_WEB_PENDING,
    sourceActor: AgentActor.CODEX_AGENT,
    expectedVersion: checking.version,
    updatedAt: TIMES.next,
  });
  const webRunning = transitionRunState(webPending, {
    to: RunPhase.WEB_TURN_RUNNING,
    expectedVersion: webPending.version,
    updatedAt: TIMES.running,
  });
  const invalidWebResponseStored = transitionRunState(webRunning, {
    to: RunPhase.WEB_RESPONSE_STORED,
    expectedVersion: webRunning.version,
    updatedAt: TIMES.stored,
  });
  assert.equal(invalidWebResponseStored.currentTurn, 2);
  const webRepairRunning = startProtocolRepairTurn(invalidWebResponseStored, {
    actor: AgentActor.CHATGPT_WEB_AGENT,
    kind: AgentTurnInputKind.PROTOCOL_REPAIR,
    expectedVersion: invalidWebResponseStored.version,
    updatedAt: TIMES.next,
  });
  assert.equal(webRepairRunning.phase, RunPhase.WEB_TURN_RUNNING);
  assert.equal(webRepairRunning.currentTurn, 2);
  const webRepairResponseStored = transitionRunState(webRepairRunning, {
    to: RunPhase.WEB_RESPONSE_STORED,
    expectedVersion: webRepairRunning.version,
    updatedAt: TIMES.completed,
  });
  assert.equal(webRepairResponseStored.currentTurn, 3);
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
    sourceActor: AgentActor.CODEX_AGENT,
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
    sourceActor: AgentActor.CODEX_AGENT,
    expectedVersion: recovery.version,
    updatedAt: "2026-09-04T00:00:10.000Z",
  }), (error) => error.code === "RUN_BLOCKER_NOT_RESOLVED");
});

test("recovery adopts an explicitly attributed completed response without turn parity", () => {
  const running = codexRunning();
  const invalidResponseStored = transitionRunState(running, {
    to: RunPhase.CODEX_RESPONSE_STORED,
    expectedVersion: running.version,
    updatedAt: TIMES.stored,
  });
  const repairRunning = startProtocolRepairTurn(invalidResponseStored, {
    actor: AgentActor.CODEX_AGENT,
    kind: AgentTurnInputKind.PROTOCOL_REPAIR,
    expectedVersion: invalidResponseStored.version,
    updatedAt: TIMES.next,
  });
  assert.equal(repairRunning.currentTurn, 1);

  const recovery = transitionRunState(repairRunning, {
    to: RunPhase.RECOVERY_REQUIRED,
    blocker: {
      type: RunBlockerType.RECOVERY_CONFIRMATION,
      operationId: "recover-completed-codex-turn",
    },
    expectedVersion: repairRunning.version,
    updatedAt: TIMES.completed,
  });
  assert.throws(() => transitionRunState(recovery, {
    to: RunPhase.CODEX_RESPONSE_STORED,
    expectedVersion: recovery.version,
    updatedAt: TIMES.resumed,
  }), /transition/i, "generic recovery does not infer response ownership from parity");
  assert.throws(() => adoptRecoveredCompletedResponse(recovery, {
    actor: AgentActor.CODEX_AGENT,
    operationId: "different-operation",
    expectedVersion: recovery.version,
    updatedAt: TIMES.resumed,
  }), (error) => error.code === "RECOVERY_OPERATION_MISMATCH");

  const adopted = adoptRecoveredCompletedResponse(recovery, {
    actor: AgentActor.CODEX_AGENT,
    operationId: "recover-completed-codex-turn",
    expectedVersion: recovery.version,
    updatedAt: TIMES.resumed,
  });
  assert.equal(adopted.phase, RunPhase.CODEX_RESPONSE_STORED);
  assert.equal(adopted.currentTurn, 2, "the recovered repair response is another terminal turn");
  assert.equal(adopted.blocker, null);
});
