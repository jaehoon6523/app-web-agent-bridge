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
    CREATE TABLE delivery_attempts (delivery_id TEXT PRIMARY KEY, run_id TEXT, input_id TEXT);
    CREATE TABLE agent_packets (packet_id TEXT PRIMARY KEY);
    CREATE TABLE domain_events (event_id TEXT PRIMARY KEY, run_id TEXT, event_type TEXT, payload_json TEXT);
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
    CREATE TABLE agent_messages (message_id TEXT PRIMARY KEY, input_id TEXT);
    CREATE TABLE delivery_attempts (delivery_id TEXT PRIMARY KEY, run_id TEXT, input_id TEXT);
    CREATE TABLE agent_packets (packet_id TEXT PRIMARY KEY);
    CREATE TABLE domain_events (event_id TEXT PRIMARY KEY, run_id TEXT, event_type TEXT, payload_json TEXT);
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
    CREATE TABLE agent_messages (message_id TEXT PRIMARY KEY, input_id TEXT);
    CREATE TABLE delivery_attempts (delivery_id TEXT PRIMARY KEY, run_id TEXT, input_id TEXT);
    CREATE TABLE agent_packets (packet_id TEXT PRIMARY KEY);
    CREATE TABLE proposal_artifacts (proposal_id TEXT PRIMARY KEY);
    CREATE TABLE domain_events (event_id TEXT PRIMARY KEY, run_id TEXT, event_type TEXT, payload_json TEXT);
    CREATE TABLE approvals (approval_id TEXT PRIMARY KEY);
    CREATE TABLE run_projections (run_id TEXT PRIMARY KEY);
    CREATE TABLE recovery_operations (operation_id TEXT PRIMARY KEY);
    PRAGMA user_version = 4;
  `);
  return database;
}

test("empty schema v2 migrates through AgentTurnInput, proposal, and outcome schema v6", (t) => {
  const database = legacyDatabase(t);
  assert.equal(initializeSqliteSchema(database), 6);
  assert.equal(readSqliteSchemaVersion(database), 6);
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
  assert.equal(initializeSqliteSchema(database), 6);
  assert.equal(readSqliteSchemaVersion(database), 6);

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

  assert.equal(initializeSqliteSchema(database), 6);
  database.close();
});

test("incomplete schema v3 migration rolls back without claiming v6", (t) => {
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

test("schema v4 adds the exact run_outcomes columns and advances to v6", (t) => {
  const database = version4Database(t);
  assert.equal(initializeSqliteSchema(database), 6);
  assert.equal(readSqliteSchemaVersion(database), 6);
  assert.deepEqual(
    database.prepare("PRAGMA table_info(run_outcomes)").all().map((row) => row.name),
    ["run_id", "outcome_type", "outcome_hash", "outcome_json", "created_at"],
  );
  assert.equal(initializeSqliteSchema(database), 6);
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

function terminalFixtureDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-bridge-terminal-"));
  t.after(() => rmSync(directory, { recursive:true, force:true }));
  const database = new DatabaseSync(join(directory, "controller.sqlite"));
  initializeSqliteSchema(database);
  // Direct SQL writes simulate an independent writer; trigger enforcement must
  // hold even when application checks and foreign keys are bypassed.
  database.exec("PRAGMA foreign_keys = OFF");
  database.prepare(`
    INSERT INTO delivery_attempts
      (delivery_id, run_id, input_id, idempotency_key, state, created_at, updated_at)
    VALUES ('delivery-1', 'run-1', 'input-1', 'idempotency-1', 'RESPONSE_COMPLETED', 't0', 't0')
  `).run();
  return database;
}

function insertTerminalMessage(database) {
  database.prepare(`
    INSERT INTO agent_messages
      (message_id, run_id, input_id, sequence, actor, session_id, turn_id,
       kind, content_hash, message_json, created_at)
    VALUES ('message-1', 'run-1', 'input-1', 1, 'CODEX_AGENT', 'session-1',
      'turn-1', 'PROPOSAL', 'hash-1', '{}', 't0')
  `).run();
}

function insertTerminalRejection(database) {
  database.prepare(`
    INSERT INTO domain_events
      (run_id, sequence, event_id, event_type, payload_json, event_hash, created_at)
    VALUES ('run-1', 1, 'event-1', 'AGENT_PACKET_REJECTED',
      '{"details":{"deliveryId":"delivery-1"}}', 'hash-1', 't0')
  `).run();
}

test("schema v6 rejects a message and a rejection for one delivery in either insert order", (t) => {
  const database = terminalFixtureDatabase(t);
  insertTerminalMessage(database);
  assert.throws(() => insertTerminalRejection(database), /terminal response already recorded/u);
  database.prepare("DELETE FROM agent_messages WHERE message_id = 'message-1'").run();
  insertTerminalRejection(database);
  assert.throws(() => insertTerminalMessage(database), /terminal response already rejected/u);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM agent_messages").get().n, 0);
  database.close();
});

test("schema v6 also rejects changing an existing record into a conflicting terminal outcome", (t) => {
  const database = terminalFixtureDatabase(t);
  insertTerminalMessage(database);
  database.prepare(`
    INSERT INTO domain_events
      (run_id, sequence, event_id, event_type, payload_json, event_hash, created_at)
    VALUES ('run-1', 1, 'event-1', 'AGENT_PACKET_REJECTED',
      '{"details":{"deliveryId":"delivery-other"}}', 'hash-1', 't0')
  `).run();
  assert.throws(() => database.prepare(`
    UPDATE domain_events SET payload_json = '{"details":{"deliveryId":"delivery-1"}}'
    WHERE event_id = 'event-1'
  `).run(), /terminal response already recorded/u);

  database.prepare("DELETE FROM agent_messages WHERE message_id = 'message-1'").run();
  database.prepare(`
    UPDATE domain_events SET payload_json = '{"details":{"deliveryId":"delivery-1"}}'
    WHERE event_id = 'event-1'
  `).run();
  database.prepare(`
    INSERT INTO agent_messages
      (message_id, run_id, input_id, sequence, actor, session_id, turn_id,
       kind, content_hash, message_json, created_at)
    VALUES ('message-2', 'run-1', 'input-other', 1, 'CODEX_AGENT', 'session-1',
      'turn-1', 'PROPOSAL', 'hash-1', '{}', 't0')
  `).run();
  assert.throws(() => database.prepare(`
    UPDATE agent_messages SET input_id = 'input-1' WHERE message_id = 'message-2'
  `).run(), /terminal response already rejected/u);
  database.close();
});

test("schema v5 with conflicting terminal records refuses migration without changing its version", (t) => {
  const database = terminalFixtureDatabase(t);
  database.exec(`
    DROP TRIGGER agent_messages_no_rejected_response;
    DROP TRIGGER agent_messages_no_rejected_response_update;
    DROP TRIGGER agent_packet_rejection_no_message;
    DROP TRIGGER agent_packet_rejection_no_message_update;
    PRAGMA user_version = 5;
  `);
  insertTerminalMessage(database);
  insertTerminalRejection(database);
  assert.throws(() => initializeSqliteSchema(database), /explicit recovery is required/u);
  assert.equal(readSqliteSchemaVersion(database), 5);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM agent_messages").get().n, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM domain_events").get().n, 1);
  database.close();
});

test("schema v5 with a single terminal outcome migrates and enforces exclusivity", (t) => {
  const database = terminalFixtureDatabase(t);
  database.exec(`
    DROP TRIGGER agent_messages_no_rejected_response;
    DROP TRIGGER agent_messages_no_rejected_response_update;
    DROP TRIGGER agent_packet_rejection_no_message;
    DROP TRIGGER agent_packet_rejection_no_message_update;
    PRAGMA user_version = 5;
  `);
  insertTerminalMessage(database);
  assert.equal(initializeSqliteSchema(database), 6);
  assert.throws(() => insertTerminalRejection(database), /terminal response already recorded/u);
  assert.equal(readSqliteSchemaVersion(database), 6);
  database.close();
});
