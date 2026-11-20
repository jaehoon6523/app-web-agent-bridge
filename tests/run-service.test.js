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
import {
  RunPhase,
} from "../src/domain/vocabulary.js";
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

  const paused = service.pause({
    runId: created.runId,
    expectedVersion: created.version,
  });
  assert.equal(paused.version, 2);
  assert.equal(store.getRunProjection(created.runId).run.paused, true);
  assert.equal(store.listDomainEvents(created.runId).length, 2);

  assert.throws(
    () => service.resume({
      runId: created.runId,
      expectedVersion: 1,
    }),
    (error) => error instanceof RunServiceError && error.code === "RUN_VERSION_CONFLICT",
  );
  store.close();
});

test("pause and resume persist without changing the Controller-owned phase", () => {
  const { store, service } = fixture();
  const run = service.createRun({
    runId: "run-service-pause",
    objective: "pause semantics",
    policy: createDiscussionRunPolicy({ maxTurns: 4 }),
  });
  const paused = service.pause({ runId: run.runId, expectedVersion: run.version });
  assert.equal(paused.paused, true);
  assert.equal(paused.phase, RunPhase.CREATED);
  const resumed = service.resume({ runId: run.runId, expectedVersion: paused.version });
  assert.equal(resumed.paused, false);
  assert.equal(resumed.phase, RunPhase.CREATED);
  store.close();
});

test("RunService exposes no evidence-free phase, blocker, or completion mutation", () => {
  const { store, service } = fixture();
  service.createRun({
    runId: "run-completion-guard",
    objective: "Reach evidence-backed consensus",
    policy: createDiscussionRunPolicy({ maxTurns: 4 }),
  });
  assert.equal(service.transition, undefined);
  assert.equal(service.setBlocker, undefined);
  assert.equal(service.enforceMaxTurns, undefined);
  assert.equal(service.startProtocolRepair, undefined);
  assert.equal(service.adoptRecoveredResponse, undefined);
  store.close();
});

test("runtime approval blocker and its pending record are created atomically", () => {
  const { store, service } = fixture();
  const created = service.createRun({
    runId: "run-backed-approval",
    objective: "Preserve an exact runtime approval gate",
    policy: createDiscussionRunPolicy(),
  });
  const requested = service.requestRuntimeApproval({
    runId: created.runId,
    expectedVersion: created.version,
    approvalId: "approval-backed",
    scope: { operationId: "operation-backed" },
  });

  assert.deepEqual(requested.run.blocker, {
    type: "RUNTIME_APPROVAL",
    approvalId: "approval-backed",
  });
  assert.equal(requested.approval.status, "PENDING");
  assert.equal(store.getApproval("approval-backed").approvalId, "approval-backed");
  assert.equal(store.listDomainEvents(created.runId).at(-1).eventType, "RUNTIME_APPROVAL_REQUESTED");
  assert.throws(() => service.requestRuntimeApproval({
    runId: created.runId,
    expectedVersion: requested.run.version,
    approvalId: "approval-replacement",
    scope: { operationId: "operation-replacement" },
  }), (error) => error.code === "RUN_BLOCKER_ALREADY_PRESENT");
  assert.equal(store.getApproval("approval-replacement"), null);
  store.close();
});

test("runtime approval request rolls back its side record when the blocker event fails", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "run-service-approval-atomic-"));
  const filename = path.join(directory, "controller.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStore(filename);
  const service = new RunService({
    store,
    clock: () => "2026-09-04T00:20:00.000Z",
    idFactory: () => "approval-atomic-event",
  });
  const created = service.createRun({
    runId: "run-approval-rollback",
    objective: "Keep the blocker and approval atomic",
    policy: createDiscussionRunPolicy(),
  });
  const eventsBefore = store.listDomainEvents(created.runId);
  const database = new DatabaseSync(filename);
  database.exec(`
    CREATE TRIGGER reject_runtime_approval_event
    BEFORE INSERT ON domain_events
    WHEN NEW.event_type = 'RUNTIME_APPROVAL_REQUESTED'
    BEGIN
      SELECT RAISE(ABORT, 'injected runtime approval event failure');
    END;
  `);
  database.close();

  assert.throws(() => service.requestRuntimeApproval({
    runId: created.runId,
    expectedVersion: created.version,
    approvalId: "approval-rollback",
    scope: { operationId: "operation-rollback" },
  }), /injected runtime approval event failure/u);
  assert.deepEqual(store.getRun(created.runId), created);
  assert.deepEqual(store.listDomainEvents(created.runId), eventsBefore);
  assert.equal(store.getApproval("approval-rollback"), null);
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
