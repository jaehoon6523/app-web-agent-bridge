import { stat } from "node:fs/promises";
import path from "node:path";
import { SqliteStore } from "../persistence/sqlite-store.js";

export class ProjectionRebuildCommandError extends Error {
  constructor(message, code = "PROJECTION_REBUILD_COMMAND_ERROR", options = undefined) {
    super(message, options);
    this.name = "ProjectionRebuildCommandError";
    this.code = code;
  }
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    throw new ProjectionRebuildCommandError(`${option} requires a value`, "CLI_USAGE_ERROR");
  }
  return value;
}

export function parseProjectionRebuildArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new TypeError("argv must be an array of strings");
  }
  let databaseFilename = null;
  let runId = null;
  let compare = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--database") {
      if (databaseFilename !== null) {
        throw new ProjectionRebuildCommandError("--database may appear only once", "CLI_USAGE_ERROR");
      }
      databaseFilename = requireValue(argv, index, option);
      index += 1;
    } else if (option === "--run-id") {
      if (runId !== null) {
        throw new ProjectionRebuildCommandError("--run-id may appear only once", "CLI_USAGE_ERROR");
      }
      runId = requireValue(argv, index, option);
      index += 1;
    } else if (option === "--compare") {
      compare = true;
    } else if (option === "--help" || option === "-h") {
      help = true;
    } else {
      throw new ProjectionRebuildCommandError(`Unknown option: ${option}`, "CLI_USAGE_ERROR");
    }
  }

  if (!help && databaseFilename === null) {
    throw new ProjectionRebuildCommandError("--database is required", "CLI_USAGE_ERROR");
  }
  return Object.freeze({ databaseFilename, runId, compare, help });
}

export const PROJECTION_REBUILD_USAGE = [
  "Usage: npm run projection:rebuild -- --database <sqlite-file> [--run-id <run-id>] [--compare]",
  "",
  "Without --run-id, every persisted run is rebuilt atomically.",
  "--compare verifies projections without replacing them.",
].join("\n");

async function requireExistingDatabase(filename) {
  const absolute = path.resolve(filename);
  let databaseStat;
  try {
    databaseStat = await stat(absolute);
  } catch (cause) {
    throw new ProjectionRebuildCommandError(
      "Configured SQLite database does not exist",
      "DATABASE_NOT_FOUND",
      { cause },
    );
  }
  if (!databaseStat.isFile()) {
    throw new ProjectionRebuildCommandError(
      "Configured SQLite database is not a regular file",
      "DATABASE_NOT_FILE",
    );
  }
  return absolute;
}

function summarize(result) {
  return Object.freeze({
    runId: result.runId ?? result.run.runId,
    runVersion: result.run.version,
    lastEventSequence: result.lastEventSequence,
    lastEventHash: result.lastEventHash,
    replaced: result.replaced,
  });
}

/**
 * @param {{
 *   databaseFilename?: string,
 *   runId?: string | null,
 *   compare?: boolean,
 *   openStore?: (filename: string) => any
 * }} [options]
 */
export async function executeProjectionRebuild({
  databaseFilename,
  runId = null,
  compare = false,
  openStore = (filename) => new SqliteStore({ filename, verifyOnOpen: false }),
} = {}) {
  if (typeof databaseFilename !== "string" || databaseFilename.length === 0) {
    throw new TypeError("databaseFilename must be a non-empty path");
  }
  if (runId !== null && (typeof runId !== "string" || runId.length === 0)) {
    throw new TypeError("runId must be null or a non-empty string");
  }
  if (typeof compare !== "boolean") throw new TypeError("compare must be a boolean");
  if (typeof openStore !== "function") throw new TypeError("openStore must be a function");

  const filename = await requireExistingDatabase(databaseFilename);
  const store = await openStore(filename);
  try {
    if (store === null || typeof store !== "object" || typeof store.close !== "function") {
      throw new TypeError("openStore must return a closable store");
    }
    const rebuilt = runId === null
      ? store.rebuildRunProjections({ compare })
      : [store.rebuildRunProjection(runId, { compare })];
    if (!Array.isArray(rebuilt) || rebuilt.length === 0) {
      throw new ProjectionRebuildCommandError(
        "No persisted runs were discovered; no projection was rebuilt",
        "NO_RUNS_DISCOVERED",
      );
    }
    const verification = store.verifyEventChains(runId);
    return Object.freeze({
      ok: true,
      mode: compare ? "COMPARE" : "REBUILD",
      runs: Object.freeze(rebuilt.map(summarize)),
      eventChain: Object.freeze({ ...verification }),
    });
  } finally {
    if (store && typeof store.close === "function") await store.close();
  }
}
