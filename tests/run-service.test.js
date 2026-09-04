import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  calculateRunPolicyHash,
  createDiscussionRunPolicy,
} from "../src/domain/run-policy.js";
import { RunPhase } from "../src/domain/vocabulary.js";
import { RunService, RunServiceError } from "../src/orchestration/run-service.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "run-service-"));
  const store = new SqliteStore(path.join(directory, "controller.sqlite"));
  let tick = 0;
  const service = new RunService({
    store,
    clock: () => `2026-09-04T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    idFactory: () => `id-${tick}`,
  });
  return { store, service };
}

test("RunService is the versioned single writer for state and event projection", () => {
  const { store, service } = fixture();
  const policy = createDiscussionRunPolicy({ maxTurns: 4 });
  const created = service.createRun({
    runId: "run-service-1",
    objective: "Have two agents review a design",
    policy,
  });
  assert.equal(created.phase, RunPhase.CREATED);
  assert.equal(store.getRunLimits(created.runId).limits.maxTurns, 4);
  assert.equal(created.policyHash, calculateRunPolicyHash(policy));

  const starting = service.transition({
    runId: created.runId,
    expectedVersion: created.version,
    to: RunPhase.STARTING_SESSIONS,
  });
  assert.equal(starting.version, 2);
  assert.equal(store.getRunProjection(created.runId).run.phase, RunPhase.STARTING_SESSIONS);
  assert.equal(store.listDomainEvents(created.runId).length, 2);

  assert.throws(
    () => service.transition({
      runId: created.runId,
      expectedVersion: 1,
      to: RunPhase.CODEX_TURN_PENDING,
    }),
    (error) => error instanceof RunServiceError && error.code === "RUN_VERSION_CONFLICT",
  );
  store.close();
});

test("pause is persisted without advancing a running turn", () => {
  const { store, service } = fixture();
  let run = service.createRun({
    runId: "run-service-pause",
    objective: "pause semantics",
    policy: createDiscussionRunPolicy({ maxTurns: 4 }),
  });
  for (const phase of [
    RunPhase.STARTING_SESSIONS,
    RunPhase.CODEX_TURN_PENDING,
    RunPhase.CODEX_TURN_RUNNING,
  ]) {
    run = service.transition({ runId: run.runId, expectedVersion: run.version, to: phase });
  }
  const paused = service.pause({ runId: run.runId, expectedVersion: run.version });
  assert.equal(paused.paused, true);
  assert.equal(paused.phase, RunPhase.CODEX_TURN_RUNNING);
  assert.equal(paused.activeActor, "CODEX_AGENT");

  const stored = service.transition({
    runId: run.runId,
    expectedVersion: paused.version,
    to: RunPhase.CODEX_RESPONSE_STORED,
  });
  assert.equal(stored.currentTurn, 1);
  const checking = service.transition({
    runId: run.runId,
    expectedVersion: stored.version,
    to: RunPhase.CONSENSUS_CHECK,
  });
  assert.throws(
    () => service.transition({
      runId: run.runId,
      expectedVersion: checking.version,
      to: RunPhase.CODEX_TO_WEB_PENDING,
    }),
    /paused/u,
  );
  store.close();
});

test("generic phase transition cannot bypass evidence-backed completion", () => {
  const { store, service } = fixture();
  let run = service.createRun({
    runId: "run-completion-guard",
    objective: "Reach evidence-backed consensus",
    policy: createDiscussionRunPolicy({ maxTurns: 4 }),
  });
  run = service.transition({
    runId: run.runId,
    expectedVersion: run.version,
    to: RunPhase.STARTING_SESSIONS,
  });
  run = service.transition({
    runId: run.runId,
    expectedVersion: run.version,
    to: RunPhase.CODEX_TURN_PENDING,
  });
  run = service.transition({
    runId: run.runId,
    expectedVersion: run.version,
    to: RunPhase.CODEX_TURN_RUNNING,
  });
  run = service.transition({
    runId: run.runId,
    expectedVersion: run.version,
    to: RunPhase.CODEX_RESPONSE_STORED,
  });
  run = service.transition({
    runId: run.runId,
    expectedVersion: run.version,
    to: RunPhase.CONSENSUS_CHECK,
  });

  assert.throws(
    () => service.transition({
      runId: run.runId,
      expectedVersion: run.version,
      to: RunPhase.COMPLETE,
    }),
    (error) => error?.code === "RUN_COMPLETION_EVIDENCE_REQUIRED",
  );
  assert.equal(service.getRun(run.runId).phase, RunPhase.CONSENSUS_CHECK);
  store.close();
});

test("run creation rolls back when the frozen RunLimits insert fails", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "run-service-atomic-"));
  const filename = path.join(directory, "controller.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStore(filename);
  const faultConnection = new DatabaseSync(filename);
  faultConnection.exec(`
    CREATE TRIGGER reject_run_limits_for_atomicity_test
    BEFORE INSERT ON run_limits
    BEGIN
      SELECT RAISE(ABORT, 'injected run_limits failure');
    END;
  `);
  faultConnection.close();

  const service = new RunService({
    store,
    clock: () => "2026-09-04T00:00:00.000Z",
    idFactory: () => "atomic-id",
  });
  assert.throws(() => service.createRun({
    runId: "run-atomic",
    objective: "freeze limits atomically",
    policy: createDiscussionRunPolicy({ maxTurns: 2 }),
  }), /injected run_limits failure/u);
  assert.equal(store.getRun("run-atomic"), null);
  assert.equal(store.getRunProjection("run-atomic"), null);
  store.close();
});

test("RunService rejects caller-owned policy hashes and freezes policy limits", () => {
  const { store, service } = fixture();
  const policy = structuredClone(createDiscussionRunPolicy({ maxTurns: 6 }));
  const created = service.createRun({
    runId: "run-policy-owner",
    objective: "Controller owns policy identity",
    policy,
  });
  policy.limits.maxTurns = 12;

  assert.equal(created.maxTurns, 6);
  assert.equal(store.getRunLimits(created.runId).limits.maxTurns, 6);
  assert.equal(created.policyHash, calculateRunPolicyHash(createDiscussionRunPolicy({ maxTurns: 6 })));
  assert.throws(() => service.createRun({
    runId: "run-legacy-policy-hash",
    objective: "Do not accept split policy identity",
    policy: createDiscussionRunPolicy(),
    policyHash: created.policyHash,
  }), /unsupported property "policyHash"/u);
  store.close();
});
