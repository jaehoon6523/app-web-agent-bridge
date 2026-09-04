import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Text } from "../src/domain/canonical-json.js";
import { createAgentRun } from "../src/domain/contracts.js";
import { AgentActor, RunMode, RunPhase } from "../src/domain/vocabulary.js";
import {
  EventChainIntegrityError,
  SqliteStore,
} from "../src/persistence/sqlite-store.js";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-04T00:01:00.000Z";

function makeRun(runId = "run-rebuild") {
  return createAgentRun({
    runId,
    mode: RunMode.DISCUSSION,
    objective: "Rebuild deterministic projection",
    policyHash: sha256Text("policy-v1"),
    phase: RunPhase.CREATED,
    activeActor: null,
    maxTurns: 8,
    currentTurn: 0,
    paused: false,
    blocker: null,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });
}

function runLimitsFor(run) {
  return {
    maxTurns: run.maxTurns,
    maxProtocolRepairs: 2,
    maxDeliveryAttempts: 3,
    maxConsecutiveActorFailures: 2,
  };
}

function nextRun(run) {
  return createAgentRun({
    ...run,
    phase: RunPhase.STARTING_SESSIONS,
    activeActor: null,
    version: 2,
    updatedAt: T1,
  });
}

function tempFilename(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-projection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "controller.sqlite");
}

function prepareRebuildableStore(filename) {
  const store = new SqliteStore(filename);
  const original = makeRun();
  const current = nextRun(original);
  store.createRun(original, { runLimits: runLimitsFor(original) });
  store.appendEventAndUpdateProjection({
    runId: original.runId,
    expectedVersion: 1,
    eventId: "event-start-sessions",
    eventType: "SESSIONS_START_REQUESTED",
    payload: { run: current, actors: [AgentActor.CODEX_AGENT] },
    createdAt: T1,
    nextRun: current,
  });
  return { store, original, current };
}

function mutate(filename, statement, ...parameters) {
  const database = new DatabaseSync(filename);
  try {
    database.prepare(statement).run(...parameters);
  } finally {
    database.close();
  }
}

test("a deleted projection rebuilds identically from verified domain events", (t) => {
  const filename = tempFilename(t);
  const { store, original, current } = prepareRebuildableStore(filename);
  const before = store.getRunProjection(original.runId);
  store.close();

  mutate(filename, "DELETE FROM run_projections WHERE run_id = ?", original.runId);
  const recoveryStore = new SqliteStore({ filename, verifyOnOpen: false });
  const result = recoveryStore.rebuildRunProjection(original.runId);
  assert.deepEqual(result.run, current);
  assert.equal(result.replaced, false);
  assert.deepEqual(recoveryStore.getRunProjection(original.runId), before);
  assert.deepEqual(recoveryStore.verifyEventChains(), {
    valid: true,
    runCount: 1,
    eventCount: 2,
  });
  recoveryStore.close();
});

test("compare mode detects a divergent projection and non-compare rebuild repairs it", (t) => {
  const filename = tempFilename(t);
  const { store, original, current } = prepareRebuildableStore(filename);
  store.close();

  const corrupted = createAgentRun({ ...current, paused: true });
  mutate(
    filename,
    "UPDATE run_projections SET projection_json = ? WHERE run_id = ?",
    canonicalJson(corrupted),
    original.runId,
  );

  const recoveryStore = new SqliteStore({ filename, verifyOnOpen: false });
  assert.throws(
    () => recoveryStore.rebuildRunProjection(original.runId, { compare: true }),
    (error) => error.code === "PROJECTION_DIVERGENCE",
  );
  assert.equal(recoveryStore.getRunProjection(original.runId).run.paused, true);

  const repaired = recoveryStore.rebuildRunProjection(original.runId);
  assert.equal(repaired.replaced, true);
  assert.deepEqual(recoveryStore.getRunProjection(original.runId).run, current);
  recoveryStore.verifyEventChains();
  recoveryStore.close();
});

test("normal startup fails closed on a missing or divergent projection without repairing it", (t) => {
  const divergentFilename = tempFilename(t);
  const divergent = prepareRebuildableStore(divergentFilename);
  const corrupted = createAgentRun({ ...divergent.current, paused: true });
  divergent.store.close();
  mutate(
    divergentFilename,
    "UPDATE run_projections SET projection_json = ? WHERE run_id = ?",
    canonicalJson(corrupted),
    divergent.original.runId,
  );
  assert.throws(
    () => new SqliteStore(divergentFilename),
    (error) => error.code === "EVENT_CHAIN_INTEGRITY_FAILURE"
      || error.code === "PROJECTION_DIVERGENCE",
  );

  const missingFilename = tempFilename(t);
  const missing = prepareRebuildableStore(missingFilename);
  missing.store.close();
  mutate(missingFilename, "DELETE FROM run_projections WHERE run_id = ?", missing.original.runId);
  assert.throws(
    () => new SqliteStore(missingFilename),
    (error) => error.code === "EVENT_CHAIN_INTEGRITY_FAILURE"
      || error.code === "PROJECTION_DIVERGENCE",
  );
});

test("all-run rebuild is atomic and restores every missing projection", (t) => {
  const filename = tempFilename(t);
  const first = prepareRebuildableStore(filename);
  const other = makeRun("run-other");
  first.store.createRun(other, { runLimits: runLimitsFor(other) });
  first.store.close();
  mutate(filename, "DELETE FROM run_projections");

  const recoveryStore = new SqliteStore({ filename, verifyOnOpen: false });
  const rebuilt = recoveryStore.rebuildRunProjections();
  assert.deepEqual(rebuilt.map((item) => item.runId), ["run-other", "run-rebuild"]);
  assert.deepEqual(recoveryStore.verifyEventChains(), {
    valid: true,
    runCount: 2,
    eventCount: 3,
  });
  recoveryStore.close();
});

test("rebuild fails closed when an event chain was changed", (t) => {
  const filename = tempFilename(t);
  const { store, original } = prepareRebuildableStore(filename);
  store.close();
  mutate(
    filename,
    "UPDATE domain_events SET payload_json = ? WHERE run_id = ? AND sequence = 2",
    '{"run":null}',
    original.runId,
  );

  const recoveryStore = new SqliteStore({ filename, verifyOnOpen: false });
  assert.throws(
    () => recoveryStore.rebuildRunProjection(original.runId),
    EventChainIntegrityError,
  );
  recoveryStore.close();
});

test("append rejects event payloads that cannot reconstruct the current run", (t) => {
  const filename = tempFilename(t);
  const store = new SqliteStore(filename);
  const original = makeRun();
  const current = nextRun(original);
  store.createRun(original, { runLimits: runLimitsFor(original) });
  assert.throws(
    () => store.appendEventAndUpdateProjection({
      runId: original.runId,
      expectedVersion: 1,
      eventId: "event-without-run",
      eventType: "SESSIONS_START_REQUESTED",
      payload: { actors: [AgentActor.CODEX_AGENT] },
      createdAt: T1,
      nextRun: current,
    }),
    (error) => error.code === "PROJECTION_PAYLOAD_MISMATCH",
  );
  assert.deepEqual(store.getRun(original.runId), original);
  store.close();
});
