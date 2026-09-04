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
    CREATE TABLE runs (run_id TEXT PRIMARY KEY);
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

test("empty schema v2 migrates to AgentTurnInput-backed schema v3", (t) => {
  const database = legacyDatabase(t);
  assert.equal(initializeSqliteSchema(database), 3);
  assert.equal(readSqliteSchemaVersion(database), 3);
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
