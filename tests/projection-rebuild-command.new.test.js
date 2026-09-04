import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { sha256Text } from "../src/domain/canonical-json.js";
import { createAgentRun } from "../src/domain/contracts.js";
import { RunMode, RunPhase } from "../src/domain/vocabulary.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";
import {
  executeProjectionRebuild,
  parseProjectionRebuildArguments,
  ProjectionRebuildCommandError,
} from "../src/repository/projection-rebuild-command.js";

const NOW = "2026-09-04T00:00:00.000Z";

function tempDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-bridge-rebuild-command-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createRun(runId) {
  return createAgentRun({
    runId,
    mode: RunMode.DISCUSSION,
    objective: "Projection command test",
    policyHash: sha256Text("policy"),
    phase: RunPhase.CREATED,
    activeActor: null,
    maxTurns: 2,
    currentTurn: 0,
    paused: false,
    blocker: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
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

test("projection rebuild argument parser is strict", () => {
  assert.deepEqual(parseProjectionRebuildArguments([
    "--database", "controller.sqlite", "--run-id", "run-1", "--compare",
  ]), {
    databaseFilename: "controller.sqlite",
    runId: "run-1",
    compare: true,
    help: false,
  });
  assert.throws(
    () => parseProjectionRebuildArguments([]),
    (error) => error instanceof ProjectionRebuildCommandError && error.code === "CLI_USAGE_ERROR",
  );
  assert.throws(
    () => parseProjectionRebuildArguments(["--unknown"]),
    (error) => error.code === "CLI_USAGE_ERROR",
  );
});

test("projection rebuild command restores a missing projection and verifies its chain", async (t) => {
  const directory = tempDirectory(t);
  const filename = path.join(directory, "controller.sqlite");
  const store = new SqliteStore(filename);
  const run = createRun("run-command");
  store.createRun(run, { runLimits: runLimitsFor(run) });
  store.close();

  const database = new DatabaseSync(filename);
  database.prepare("DELETE FROM run_projections WHERE run_id = ?").run("run-command");
  database.close();

  const output = await executeProjectionRebuild({ databaseFilename: filename });
  assert.equal(output.ok, true);
  assert.equal(output.mode, "REBUILD");
  assert.deepEqual(output.runs.map((run) => run.runId), ["run-command"]);
  assert.equal(output.runs[0].replaced, false);
  assert.deepEqual(output.eventChain, { valid: true, runCount: 1, eventCount: 1 });

  const verifiedStore = new SqliteStore(filename);
  assert.equal(verifiedStore.getRunProjection("run-command")?.run.runId, "run-command");
  verifiedStore.close();
});

test("projection rebuild command refuses a missing database instead of creating an empty one", async (t) => {
  const filename = path.join(tempDirectory(t), "missing.sqlite");
  await assert.rejects(
    executeProjectionRebuild({ databaseFilename: filename }),
    (error) => error.code === "DATABASE_NOT_FOUND",
  );
});

test("projection rebuild command does not report zero discovered runs as success", async (t) => {
  const filename = path.join(tempDirectory(t), "empty.sqlite");
  const store = new SqliteStore(filename);
  store.close();
  await assert.rejects(
    executeProjectionRebuild({ databaseFilename: filename }),
    (error) => error.code === "NO_RUNS_DISCOVERED",
  );
});
