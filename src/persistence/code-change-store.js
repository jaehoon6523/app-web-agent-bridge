import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256CanonicalJson } from "../domain/canonical-json.js";

export class CodeChangeStore {
  constructor(filename) {
    this.database = new DatabaseSync(filename);
    this.database.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS code_change_runs (
        run_id TEXT PRIMARY KEY, version INTEGER NOT NULL,
        record_json TEXT NOT NULL, record_hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS code_change_history (
        run_id TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL, record_hash TEXT NOT NULL,
        PRIMARY KEY (run_id, version)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_command_receipts (
        request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT
      ) STRICT;`);
  }
  list() {
    return this.database.prepare("SELECT * FROM code_change_runs ORDER BY rowid").all().map((row) => {
      const value = JSON.parse(String(row.record_json));
      if (sha256CanonicalJson(value) !== row.record_hash || value.version !== Number(row.version)
        || value.runId !== row.run_id) throw new Error("Code change record integrity check failed.");
      return value;
    });
  }
  get(runId) { return this.list().find((run) => run.runId === runId) ?? null; }
  save(value, expectedVersion = 0) {
    const record = { ...value, version: expectedVersion + 1, updatedAt: new Date().toISOString() };
    const json = canonicalJson(record), hash = sha256CanonicalJson(record);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = expectedVersion === 0
      ? this.database.prepare("INSERT INTO code_change_runs VALUES (?, ?, ?, ?)").run(record.runId, record.version, json, hash)
      : this.database.prepare("UPDATE code_change_runs SET version=?,record_json=?,record_hash=? WHERE run_id=? AND version=?")
        .run(record.version, json, hash, record.runId, expectedVersion);
      if (Number(result.changes) !== 1) throw Object.assign(new Error("Run changed; refresh before acting."), { code: "RUN_VERSION_CONFLICT" });
      this.database.prepare("INSERT INTO code_change_history VALUES (?, ?, ?, ?)").run(record.runId, record.version, json, hash);
      this.database.exec("COMMIT");
      return record;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  receipt(requestId) { return this.database.prepare("SELECT * FROM audit_command_receipts WHERE request_id=?").get(requestId); }
  beginCommand(requestId, hash) {
    this.database.prepare("INSERT INTO audit_command_receipts VALUES (?, ?, 'INTENT', NULL)").run(requestId, hash);
  }
  finishCommand(requestId, result) {
    this.database.prepare("UPDATE audit_command_receipts SET status='COMPLETED', result_json=? WHERE request_id=? AND status='INTENT'").run(canonicalJson(result), requestId);
  }
  close() { this.database.close(); }
}
