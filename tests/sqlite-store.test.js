import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { sha256Text } from "../src/domain/canonical-json.js";
import { createAgentRun } from "../src/domain/contracts.js";
import { AgentActor, RunMode, RunPhase } from "../src/domain/vocabulary.js";
import {
  EventChainIntegrityError,
  OptimisticConcurrencyError,
  SqliteStore,
  calculateDomainEventHash,
  domainEventDigestInput,
} from "../src/persistence/sqlite-store.js";
import {
  REQUIRED_TABLES,
  SQLITE_SCHEMA_VERSION,
} from "../src/persistence/schema.js";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-04T00:01:00.000Z";

function makeRun(runId = "run-01") {
  return createAgentRun({
    runId,
    mode: RunMode.DISCUSSION,
    objective: "Compare two recovery proposals",
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
    version: run.version + 1,
    updatedAt: T1,
  });
}

function tempDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-sqlite-"));
  const filename = join(directory, "controller.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return filename;
}

function mutateDatabase(filename, sql, ...params) {
  const database = new DatabaseSync(filename);
  try {
    database.prepare(sql).run(...params);
  } finally {
    database.close();
  }
}

test("schema initialization creates every required table and records its version", (t) => {
  const filename = tempDatabase(t);
  const store = new SqliteStore(filename);
  assert.equal(store.schemaVersion, SQLITE_SCHEMA_VERSION);
  store.close();

  const database = new DatabaseSync(filename);
  try {
    const tables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.deepEqual(tables, [...REQUIRED_TABLES].sort());
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, SQLITE_SCHEMA_VERSION);
  } finally {
    database.close();
  }
});

test("run creation and event append atomically advance the projection and hash chain", (t) => {
  const filename = tempDatabase(t);
  const store = new SqliteStore(filename);
  const run = makeRun();
  const created = store.createRun(run, { runLimits: runLimitsFor(run) });

  assert.equal(created.sequence, 1);
  assert.equal(created.previousHash, null);
  assert.equal(created.eventHash, calculateDomainEventHash(null, created));
  assert.deepEqual(Object.keys(domainEventDigestInput(created)).sort(), [
    "createdAt",
    "eventId",
    "eventType",
    "payload",
    "runId",
    "sequence",
  ]);

  const updatedRun = nextRun(run);
  const appended = store.appendEventAndUpdateProjection({
    runId: run.runId,
    expectedVersion: 1,
    eventId: "event-session-start",
    eventType: "SESSIONS_START_REQUESTED",
    payload: {
      run: updatedRun,
      actors: [AgentActor.CODEX_AGENT, AgentActor.CHATGPT_WEB_AGENT],
    },
    createdAt: T1,
    nextRun: updatedRun,
  });

  assert.equal(appended.sequence, 2);
  assert.equal(appended.previousHash, created.eventHash);
  assert.deepEqual(store.getRun(run.runId), updatedRun);
  assert.deepEqual(store.getRunProjection(run.runId), {
    run: updatedRun,
    lastEventSequence: 2,
    lastEventHash: appended.eventHash,
  });
  assert.deepEqual(store.verifyEventChains(), { valid: true, runCount: 1, eventCount: 2 });

  assert.throws(
    () => store.appendEventAndUpdateProjection({
      runId: run.runId,
      expectedVersion: 1,
      eventId: "stale-event",
      eventType: "STALE",
      payload: { run: updatedRun },
      createdAt: T1,
      nextRun: updatedRun,
    }),
    OptimisticConcurrencyError,
  );
  assert.equal(store.listDomainEvents(run.runId).length, 2);
  store.close();

  const reopened = new SqliteStore(filename);
  assert.deepEqual(reopened.getRun(run.runId), updatedRun);
  assert.deepEqual(reopened.verifyEventChains(), { valid: true, runCount: 1, eventCount: 2 });
  reopened.close();
});

test("run creation without frozen limits creates neither a run nor an event", (t) => {
  const store = new SqliteStore(tempDatabase(t));
  const run = makeRun("run-without-limits");

  assert.throws(
    () => store.createRun(run),
    (error) => error.code === "RUN_LIMITS_REQUIRED",
  );
  assert.equal(store.getRun(run.runId), null);
  assert.equal(store.getRunLimits(run.runId), null);
  assert.deepEqual(store.listDomainEvents(run.runId), []);
  assert.deepEqual(store.verifyEventChains(), { valid: true, runCount: 0, eventCount: 0 });
  store.close();
});

test("run metadata cannot be rewritten through a later projection event", (t) => {
  const store = new SqliteStore(tempDatabase(t));
  const run = makeRun("run-immutable");
  store.createRun(run, { runLimits: runLimitsFor(run) });
  const rewritten = createAgentRun({
    ...nextRun(run),
    objective: "A silently replaced objective",
    objectiveHash: sha256Text("A silently replaced objective"),
  });
  assert.throws(() => store.appendEventAndUpdateProjection({
    runId: run.runId,
    expectedVersion: run.version,
    eventId: "event-rewrite-objective",
    eventType: "INVALID_REWRITE",
    payload: { run: rewritten },
    createdAt: T1,
    nextRun: rewritten,
  }), (error) => error.code === "IMMUTABLE_RUN_METADATA");
  assert.deepEqual(store.getRun(run.runId), run);
  assert.equal(store.listDomainEvents(run.runId).length, 1);
  store.close();
});

test("startup verification fails closed after an event payload is changed", (t) => {
  const filename = tempDatabase(t);
  const store = new SqliteStore(filename);
  const run = makeRun();
  store.createRun(run, { runLimits: runLimitsFor(run) });
  store.close();

  mutateDatabase(
    filename,
    "UPDATE domain_events SET payload_json = ? WHERE run_id = ? AND sequence = 1",
    '{"tampered":true}',
    "run-01",
  );

  assert.throws(() => new SqliteStore(filename), EventChainIntegrityError);
});

test("startup verification detects deletion including deletion of the chain tail", (t) => {
  const filename = tempDatabase(t);
  const store = new SqliteStore(filename);
  const run = makeRun();
  store.createRun(run, { runLimits: runLimitsFor(run) });
  store.close();

  mutateDatabase(filename, "DELETE FROM domain_events WHERE run_id = ?", "run-01");

  assert.throws(
    () => new SqliteStore(filename),
    (error) => error instanceof EventChainIntegrityError && /event count/.test(error.message),
  );
});

test("startup verification detects event sequence gaps and reorder attempts", (t) => {
  const filename = tempDatabase(t);
  const store = new SqliteStore(filename);
  const run = makeRun();
  store.createRun(run, { runLimits: runLimitsFor(run) });
  store.appendEventAndProject({
    runId: run.runId,
    expectedVersion: 1,
    eventId: "event-02",
    eventType: "SECOND_EVENT",
    payload: { run: nextRun(run), step: 2 },
    createdAt: T1,
    nextRun: nextRun(run),
  });
  store.close();

  mutateDatabase(
    filename,
    "UPDATE domain_events SET sequence = 3 WHERE run_id = ? AND sequence = 2",
    "run-01",
  );

  assert.throws(
    () => new SqliteStore(filename),
    (error) => error instanceof EventChainIntegrityError && /should be 2/.test(error.message),
  );
});
