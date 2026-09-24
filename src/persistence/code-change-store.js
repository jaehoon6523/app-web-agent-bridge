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
        request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT,
        run_id TEXT
      ) STRICT;`);
    if (!this.database.prepare("PRAGMA table_info(audit_command_receipts)").all().some((column) => column.name === "run_id")) {
      this.database.exec("ALTER TABLE audit_command_receipts ADD COLUMN run_id TEXT");
    }
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
  history(runId) {
    return this.database.prepare("SELECT version, record_json, record_hash FROM code_change_history WHERE run_id=?").all(runId)
      .map((row) => {
        const record = JSON.parse(String(row.record_json));
        if (record.runId !== runId || record.version !== Number(row.version)
          || sha256CanonicalJson(record) !== row.record_hash) throw new Error("Code change history integrity check failed.");
        return record;
      });
  }
  deleteFinished(runId, expectedVersion) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT version, record_json FROM code_change_runs WHERE run_id=?").get(runId);
      if (!row || Number(row.version) !== expectedVersion) {
        throw Object.assign(new Error("Run changed; refresh."), { code:"RUN_VERSION_CONFLICT" });
      }
      const stage = JSON.parse(String(row.record_json)).stage;
      if (!["APPLIED", "CANCELLED", "INCONCLUSIVE", "FAILED"].includes(stage)) {
        throw Object.assign(new Error("Only finished runs can be deleted."), { code:"RUN_NOT_TERMINAL" });
      }
      this.database.prepare("DELETE FROM code_change_history WHERE run_id=?").run(runId);
      this.database.prepare("DELETE FROM code_change_runs WHERE run_id=? AND version=?").run(runId, expectedVersion);
      this.database.prepare("DELETE FROM audit_command_receipts WHERE run_id=? AND status='COMPLETED'").run(runId);
      for (const receipt of this.database.prepare("SELECT request_id, result_json FROM audit_command_receipts WHERE run_id IS NULL AND status='COMPLETED' AND result_json IS NOT NULL").all()) {
        try {
          if (JSON.parse(String(receipt.result_json))?.payload?.runId === runId) {
            this.database.prepare("DELETE FROM audit_command_receipts WHERE request_id=?").run(receipt.request_id);
          }
        } catch { /* Older malformed receipts are unrelated to this run. */ }
      }
      this.database.exec("COMMIT");
      return true;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
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
  beginCommand(requestId, hash, runId = null) {
    this.database.prepare("INSERT INTO audit_command_receipts (request_id, request_hash, status, result_json, run_id) VALUES (?, ?, 'INTENT', NULL, ?)").run(requestId, hash, runId);
  }
  finishCommand(requestId, result) {
    this.database.prepare("UPDATE audit_command_receipts SET status='COMPLETED', result_json=? WHERE request_id=? AND status='INTENT'").run(canonicalJson(result), requestId);
  }
  close() { this.database.close(); }
}
