import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256CanonicalJson } from "../domain/canonical-json.js";

function historyHash(runId, version, recordHash, previousHash) {
  return sha256CanonicalJson({ kind:"CODE_CHANGE_HISTORY", runId, version, recordHash, previousHash });
}

function verifyRows(runId, rows, current) {
  if (!rows.length || rows.length !== Number(current.version)) throw new Error("Code change history has missing versions.");
  let previousHash = null;
  for (const [index, row] of rows.entries()) {
    const record = JSON.parse(String(row.record_json));
    if (row.run_id !== runId || Number(row.version) !== index + 1 || record.runId !== runId
      || record.version !== index + 1 || sha256CanonicalJson(record) !== row.record_hash
      || row.previous_hash !== previousHash
      || row.entry_hash !== historyHash(runId, index + 1, row.record_hash, previousHash)) {
      throw new Error("Code change history integrity check failed.");
    }
    previousHash = row.entry_hash;
  }
  const latest = rows.at(-1);
  if (latest.record_hash !== current.record_hash || latest.record_json !== current.record_json
    || Number(latest.version) !== Number(current.version)) throw new Error("Code change current record differs from history.");
}

function checkedRecord(database, row) {
  const value = JSON.parse(String(row.record_json));
  if (sha256CanonicalJson(value) !== row.record_hash || value.version !== Number(row.version)
    || value.runId !== row.run_id) throw new Error("Code change record integrity check failed.");
  verifyRows(row.run_id,
    database.prepare("SELECT * FROM code_change_history WHERE run_id=? ORDER BY version").all(row.run_id), row);
  return value;
}

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
        previous_hash TEXT, entry_hash TEXT,
        PRIMARY KEY (run_id, version)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_command_receipts (
        request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT,
        run_id TEXT
      ) STRICT;`);
    if (!this.database.prepare("PRAGMA table_info(audit_command_receipts)").all().some((column) => column.name === "run_id")) {
      this.database.exec("ALTER TABLE audit_command_receipts ADD COLUMN run_id TEXT");
    }
    const historyColumns = this.database.prepare("PRAGMA table_info(code_change_history)").all();
    if (!historyColumns.some((column) => column.name === "previous_hash")) this.database.exec("ALTER TABLE code_change_history ADD COLUMN previous_hash TEXT");
    if (!historyColumns.some((column) => column.name === "entry_hash")) this.database.exec("ALTER TABLE code_change_history ADD COLUMN entry_hash TEXT");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const current of this.database.prepare("SELECT * FROM code_change_runs").all()) {
        const rows = this.database.prepare("SELECT * FROM code_change_history WHERE run_id=? ORDER BY version").all(current.run_id);
        const unchained = rows.every((row) => row.entry_hash === null && row.previous_hash === null);
        if (unchained) {
          if (rows.length !== Number(current.version)) throw new Error("Legacy code change history has missing versions.");
          let previousHash = null;
          for (const [index, row] of rows.entries()) {
            const record = JSON.parse(String(row.record_json));
            if (Number(row.version) !== index + 1 || record.runId !== current.run_id
              || record.version !== index + 1 || sha256CanonicalJson(record) !== row.record_hash) {
              throw new Error("Legacy code change history integrity check failed.");
            }
            const entryHash = historyHash(current.run_id, index + 1, row.record_hash, previousHash);
            this.database.prepare("UPDATE code_change_history SET previous_hash=?, entry_hash=? WHERE run_id=? AND version=?")
              .run(previousHash, entryHash, current.run_id, index + 1);
            previousHash = entryHash;
          }
        }
        verifyRows(current.run_id,
          this.database.prepare("SELECT * FROM code_change_history WHERE run_id=? ORDER BY version").all(current.run_id), current);
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  list() {
    return this.database.prepare("SELECT * FROM code_change_runs ORDER BY rowid").all()
      .map((row) => checkedRecord(this.database, row));
  }
  get(runId) {
    if (typeof runId !== "string" || !runId) return null;
    const row = this.database.prepare("SELECT * FROM code_change_runs WHERE run_id=?").get(runId);
    return row ? checkedRecord(this.database, row) : null;
  }
  history(runId) {
    const current = this.database.prepare("SELECT * FROM code_change_runs WHERE run_id=?").get(runId);
    if (!current) return [];
    const rows = this.database.prepare("SELECT * FROM code_change_history WHERE run_id=? ORDER BY version").all(runId);
    verifyRows(runId, rows, current);
    return rows
      .map((row) => {
        const record = JSON.parse(String(row.record_json));
        if (record.runId !== runId || record.version !== Number(row.version)
          || sha256CanonicalJson(record) !== row.record_hash) throw new Error("Code change history integrity check failed.");
        return record;
      });
  }
  historyProof(runId) {
    const current = this.database.prepare("SELECT * FROM code_change_runs WHERE run_id=?").get(runId);
    if (!current) return null;
    const rows = this.database.prepare("SELECT * FROM code_change_history WHERE run_id=? ORDER BY version").all(runId);
    verifyRows(runId, rows, current);
    return { kind:"LOCAL_UNKEYED_HASH_CHAIN", runId, version:Number(current.version),
      entries:rows.map((row) => ({ version:Number(row.version), recordHash:row.record_hash,
        previousHash:row.previous_hash, entryHash:row.entry_hash })) };
  }
  deleteFinished(runId, expectedVersion) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT * FROM code_change_runs WHERE run_id=?").get(runId);
      if (!row || Number(row.version) !== expectedVersion) {
        throw Object.assign(new Error("Run changed; refresh."), { code:"RUN_VERSION_CONFLICT" });
      }
      const stage = JSON.parse(String(row.record_json)).stage;
      verifyRows(runId,
        this.database.prepare("SELECT * FROM code_change_history WHERE run_id=? ORDER BY version").all(runId), row);
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
      let previousHash = null;
      if (expectedVersion > 0) {
        const current = this.database.prepare("SELECT * FROM code_change_runs WHERE run_id=?").get(record.runId);
        if (!current || Number(current.version) !== expectedVersion) throw Object.assign(new Error("Run changed; refresh before acting."), { code:"RUN_VERSION_CONFLICT" });
        const rows = this.database.prepare("SELECT * FROM code_change_history WHERE run_id=? ORDER BY version").all(record.runId);
        verifyRows(record.runId, rows, current);
        previousHash = rows.at(-1).entry_hash;
      }
      const result = expectedVersion === 0
      ? this.database.prepare("INSERT INTO code_change_runs VALUES (?, ?, ?, ?)").run(record.runId, record.version, json, hash)
      : this.database.prepare("UPDATE code_change_runs SET version=?,record_json=?,record_hash=? WHERE run_id=? AND version=?")
        .run(record.version, json, hash, record.runId, expectedVersion);
      if (Number(result.changes) !== 1) throw Object.assign(new Error("Run changed; refresh before acting."), { code: "RUN_VERSION_CONFLICT" });
      this.database.prepare("INSERT INTO code_change_history (run_id, version, record_json, record_hash, previous_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?)")
        .run(record.runId, record.version, json, hash, previousHash, historyHash(record.runId, record.version, hash, previousHash));
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
