import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  REQUIRED_TABLES,
  initializeSqliteSchema,
  readSqliteSchemaVersion,
} from "../src/persistence/schema.js";

function legacyDatabase(t, withRelayData = false) {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-schema-v2-"));
  const filename = join(directory, "controller.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(filename);
  database.exec(`
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, run_json TEXT);
    CREATE TABLE run_limits (run_id TEXT PRIMARY KEY);
    CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY);
    CREATE TABLE relay_messages (message_id TEXT PRIMARY KEY);
    CREATE TABLE delivery_attempts (delivery_id TEXT PRIMARY KEY);
    CREATE TABLE agent_packets (packet_id TEXT PRIMARY KEY);
    CREATE TABLE domain_events (event_id TEXT PRIMARY KEY);
    CREATE TABLE approvals (approval_id TEXT PRIMARY KEY);
    CREATE TABLE run_projections (run_id TEXT PRIMARY KEY);
    CREATE TABLE recovery_operations (operation_id TEXT PRIMARY KEY);
    PRAGMA user_version = 2;
  `);
  if (withRelayData) {
    database.prepare("INSERT INTO relay_messages (message_id) VALUES (?)").run("legacy-message");
  }
  return database;
}

function version3Database(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-schema-v3-"));
  const filename = join(directory, "controller.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(filename);
  database.exec(`
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, run_json TEXT);
    CREATE TABLE run_limits (run_id TEXT PRIMARY KEY);
    CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY);
    CREATE TABLE agent_turn_inputs (input_id TEXT PRIMARY KEY);
    CREATE TABLE agent_messages (message_id TEXT PRIMARY KEY);
    CREATE TABLE delivery_attempts (delivery_id TEXT PRIMARY KEY);
    CREATE TABLE agent_packets (packet_id TEXT PRIMARY KEY);
    CREATE TABLE domain_events (event_id TEXT PRIMARY KEY);
    CREATE TABLE approvals (approval_id TEXT PRIMARY KEY);
    CREATE TABLE run_projections (run_id TEXT PRIMARY KEY);
    CREATE TABLE recovery_operations (operation_id TEXT PRIMARY KEY);
    PRAGMA user_version = 3;
  `);
  return database;
}

function version4Database(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-schema-v4-"));
  const filename = join(directory, "controller.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(filename);
  database.exec(`
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, run_json TEXT);
    CREATE TABLE run_limits (run_id TEXT PRIMARY KEY);
    CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY);
    CREATE TABLE agent_turn_inputs (input_id TEXT PRIMARY KEY);
    CREATE TABLE agent_messages (message_id TEXT PRIMARY KEY);
    CREATE TABLE delivery_attempts (delivery_id TEXT PRIMARY KEY);
    CREATE TABLE agent_packets (packet_id TEXT PRIMARY KEY);
    CREATE TABLE proposal_artifacts (proposal_id TEXT PRIMARY KEY);
    CREATE TABLE domain_events (event_id TEXT PRIMARY KEY);
    CREATE TABLE approvals (approval_id TEXT PRIMARY KEY);
    CREATE TABLE run_projections (run_id TEXT PRIMARY KEY);
    CREATE TABLE recovery_operations (operation_id TEXT PRIMARY KEY);
    PRAGMA user_version = 4;
  `);
  return database;
}

test("empty schema v2 migrates through AgentTurnInput, proposal, and outcome schema v5", (t) => {
  const database = legacyDatabase(t);
  assert.equal(initializeSqliteSchema(database), 5);
  assert.equal(readSqliteSchemaVersion(database), 5);
  const tables = new Set(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table'
  `).all().map((row) => row.name));
  for (const table of REQUIRED_TABLES) assert.equal(tables.has(table), true, table);
  assert.equal(tables.has("relay_messages"), false);
  const deliveryColumns = database.prepare("PRAGMA table_info(delivery_attempts)")
    .all().map((row) => row.name);
  assert.equal(deliveryColumns.includes("input_id"), true);
  assert.equal(deliveryColumns.includes("message_id"), false);
  database.close();
});

test("schema v3 deterministically adds proposal_artifacts and run_outcomes", (t) => {
  const database = version3Database(t);
  assert.equal(initializeSqliteSchema(database), 5);
  assert.equal(readSqliteSchemaVersion(database), 5);

  const table = database.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'proposal_artifacts'
  `).get();
  assert.match(table.sql, /source_message_id TEXT NOT NULL UNIQUE/u);
  assert.match(table.sql, /UNIQUE \(run_id, proposal_ref_hash\)/u);
  const indexes = new Set(database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'index' AND tbl_name = 'proposal_artifacts'
  `).all().map((row) => row.name));
  assert.equal(indexes.has("proposal_artifacts_run_idx"), true);
  assert.equal(
    database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'run_outcomes'
    `).get().name,
    "run_outcomes",
  );

  assert.equal(initializeSqliteSchema(database), 5);
  database.close();
});

test("incomplete schema v3 migration rolls back without claiming v5", (t) => {
  const database = version3Database(t);
  database.exec("DROP TABLE recovery_operations");
  assert.throws(
    () => initializeSqliteSchema(database),
    /missing required table\(s\): recovery_operations/u,
  );
  assert.equal(readSqliteSchemaVersion(database), 3);
  const proposalTable = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name = 'proposal_artifacts'
  `).get();
  assert.equal(proposalTable, undefined);
  const outcomeTable = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name = 'run_outcomes'
  `).get();
  assert.equal(outcomeTable, undefined);
  database.close();
});

test("schema v4 adds the exact run_outcomes columns and advances to v5", (t) => {
  const database = version4Database(t);
  assert.equal(initializeSqliteSchema(database), 5);
  assert.equal(readSqliteSchemaVersion(database), 5);
  assert.deepEqual(
    database.prepare("PRAGMA table_info(run_outcomes)").all().map((row) => row.name),
    ["run_id", "outcome_type", "outcome_hash", "outcome_json", "created_at"],
  );
  assert.equal(initializeSqliteSchema(database), 5);
  database.close();
});

test("schema v4 terminal runs fail closed because an outcome cannot be inferred", (t) => {
  const database = version4Database(t);
  database.prepare("INSERT INTO runs (run_id, run_json) VALUES (?, ?)").run(
    "run-terminal",
    JSON.stringify({ phase: "COMPLETE" }),
  );
  assert.throws(
    () => initializeSqliteSchema(database),
    /terminal run run-terminal whose RunOutcome cannot be inferred/u,
  );
  assert.equal(readSqliteSchemaVersion(database), 4);
  assert.equal(
    database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'run_outcomes'
    `).get(),
    undefined,
  );
  database.close();
});

test("schema v2 relay data fails closed without changing its version or rows", (t) => {
  const database = legacyDatabase(t, true);
  assert.throws(
    () => initializeSqliteSchema(database),
    /AgentTurnInput provenance cannot be inferred/u,
  );
  assert.equal(readSqliteSchemaVersion(database), 2);
  assert.equal(
    database.prepare("SELECT message_id FROM relay_messages").get().message_id,
    "legacy-message",
  );
  const tables = new Set(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table'
  `).all().map((row) => row.name));
  assert.equal(tables.has("agent_turn_inputs"), false);
  database.close();
});
