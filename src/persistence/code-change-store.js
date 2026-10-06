import path from "node:path";
import { observeSynchronousStage } from "../diagnostics/synchronous-stage.js";
import { DatabaseSync } from "./sqlite-database.js";
import { setSqliteBusyTimeout } from "./sqlite-initialization.js";
import { canonicalJson, sha256CanonicalJson } from "../domain/canonical-json.js";
import { historyHash, verifyHistory, verifyHistories } from "./code-change-history.js";
import { CodeChangeHistoryJob, HISTORY_VERIFICATION_DEADLINE_MS } from "./code-change-history-job.js";
import { setTimeout as wait } from "node:timers/promises";

const changed = () => Object.assign(new Error("Code change history must be verified before use."), {code:"CODE_CHANGE_HISTORY_UNVERIFIED"});
const same = (left, right) => left !== null && left.data === right.data && left.changes === right.changes && left.schema === right.schema;

export class CodeChangeStore {
  #verified = new Map();
  #stamp = null;
  #complete = false;
  #job = null;
  #preparing = null;
  #closed = false;
  #closing = null;
  #closureFailure = null;
  constructor(filename, {busyTimeoutMs = 5000, onDiagnostic = null, verification = "synchronous"} = {}) {
    if (!["synchronous", "background"].includes(verification) || (verification === "background" && filename === ":memory:")) {
      throw new TypeError("History verification requires a supported mode and a shared database file.");
    }
    this.filename = filename === ":memory:" ? filename : path.resolve(filename);
    this.verification = verification;
    this.onDiagnostic = onDiagnostic;
    this.database = this.#observe("open", () => new DatabaseSync(this.filename));
    try { this.#observe("initialize", () => this.#initialize(busyTimeoutMs)); }
    catch (error) {
      try { this.database.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Code change initialization and close failed.", {cause:error}); }
      throw error;
    }
  }
  #observe(stage, operation) {
    return observeSynchronousStage(this.onDiagnostic, `persistence.code-store.${stage}`, operation);
  }
  #initialize(busyTimeoutMs) {
    setSqliteBusyTimeout(this.database, busyTimeoutMs);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS main.code_change_runs (
        run_id TEXT PRIMARY KEY, version INTEGER NOT NULL,
        record_json TEXT NOT NULL, record_hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS main.code_change_history (
        run_id TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL, record_hash TEXT NOT NULL,
        previous_hash TEXT, entry_hash TEXT,
        PRIMARY KEY (run_id, version)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS main.audit_command_receipts (
        request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT,
        run_id TEXT
      ) STRICT;`);
    if (!this.database.prepare("PRAGMA main.table_info(audit_command_receipts)").all().some((column) => column.name === "run_id")) {
      this.database.exec("ALTER TABLE main.audit_command_receipts ADD COLUMN run_id TEXT");
    }
    const historyColumns = this.database.prepare("PRAGMA main.table_info(code_change_history)").all();
    if (!historyColumns.some((column) => column.name === "previous_hash")) this.database.exec("ALTER TABLE main.code_change_history ADD COLUMN previous_hash TEXT");
    if (!historyColumns.some((column) => column.name === "entry_hash")) this.database.exec("ALTER TABLE main.code_change_history ADD COLUMN entry_hash TEXT");
    if (this.verification === "synchronous") this.#observe("history-verify-migrate", () => this.#initializeHistory());
    else {
      // Preserve atomic, no-wait writer acquisition during unpublished setup;
      // expensive verification never holds this main-thread writer transaction.
      this.database.exec("BEGIN IMMEDIATE; COMMIT");
    }
  }
  #generation() {
    if (this.#closed) throw Object.assign(new Error("Code change store is closed."), {code:"CODE_CHANGE_STORE_CLOSED"});
    return {
      data:this.database.prepare("PRAGMA main.data_version").get().data_version,
      changes:this.database.prepare("SELECT total_changes() AS count").get().count,
      // Reading the schema also detects same-connection DDL (including triggers).
      schema:JSON.stringify(this.database.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name").all()),
    };
  }
  #invalidate() { this.#verified.clear(); this.#stamp = null; this.#complete = false; }
  #assertCommittedView() {
    if (this.#closed) throw Object.assign(new Error("Code change store is closed."), {code:"CODE_CHANGE_STORE_CLOSED"});
    // A verifier on another connection cannot see this handle's provisional
    // writes. Reject caller-owned transactions without rolling them back. The
    // deferred BEGIN/ROLLBACK probe works on the declared Node 22.5 minimum and
    // acquires no writer lock; do not depend on newer DatabaseSync properties.
    try { this.database.exec("BEGIN"); }
    catch (error) {
      if (error?.code !== "ERR_SQLITE_ERROR" || !/within a transaction/u.test(error.message)) throw error;
      this.#invalidate();
      throw Object.assign(new Error("Finish the open SQLite transaction before using verified code change records."), {
        code:"CODE_CHANGE_TRANSACTION_ACTIVE",
      });
    }
    this.database.exec("ROLLBACK");
  }
  #fresh(stamp = this.#generation()) {
    if (!same(this.#stamp, stamp)) this.#invalidate();
    return this.#stamp !== null;
  }
  #initializeHistory() {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const before = this.#generation();
      let verified = verifyHistories(this.database, {migrate:true});
      // Migration writes can fire triggers. Verify the committed representation,
      // rather than trusting the rows read before those writes.
      if (this.#generation().changes !== before.changes) verified = verifyHistories(this.database);
      this.database.exec("COMMIT");
      const after = this.#generation();
      if (after.data === before.data && after.schema === before.schema) {
        this.#verified = new Map(verified.map(entry => [entry.runId, entry]));
        this.#stamp = after; this.#complete = true;
      }
    } catch (error) { this.#rollback(error); }
  }
  #rollback(error) {
    this.#invalidate();
    try { this.database.exec("ROLLBACK"); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Code change operation and rollback failed.", {cause:error}); }
    throw error;
  }
  #read(operation) {
    this.#assertCommittedView();
    const before = this.#generation();
    this.#fresh(before);
    const result = operation();
    this.#assertCommittedView();
    const after = this.#generation();
    if (!same(before, after)) { this.#invalidate(); throw changed(); }
    this.#stamp = after;
    return result;
  }
  #checked(row) {
    let entry = this.#verified.get(row.run_id);
    if (!entry || entry.version !== Number(row.version) || entry.recordHash !== row.record_hash) {
      if (this.verification === "background") throw changed();
      entry = this.#observe("history-verify", () => verifyHistory(this.database, row));
      this.#verified.set(row.run_id, entry);
    }
    // Fresh JSON on every read; callers never own cached verification authority.
    return JSON.parse(String(row.record_json));
  }
  #finishWrite(before, expectedChanges) {
    const after = this.#generation();
    if (!same(this.#stamp, before) || after.data !== before.data || after.schema !== before.schema
      || Number(after.changes)-Number(before.changes) !== expectedChanges) {
      this.#invalidate(); return false;
    }
    this.#stamp = after; return true;
  }
  #mutationStamp() {
    const stamp = this.#generation();
    this.#fresh(stamp);
    if (this.verification === "background" && !this.#complete) throw changed();
    return stamp;
  }
  #emit(type, detail = {}) {
    try { this.onDiagnostic?.({type:`persistence.code-store.${type}`, ...detail}); }
    catch { /* Diagnostics cannot change verification or canonical state. */ }
  }
  #startJob(options) {
    const job = new CodeChangeHistoryJob(this.filename, options);
    job.closed.catch(error => { this.#closureFailure = error; });
    return job;
  }
  /** @param {{signal?: AbortSignal}} [options] */
  prepareForRead({signal} = {}) {
    signal?.throwIfAborted();
    this.#assertCommittedView();
    if (this.#fresh() && this.#complete) return Promise.resolve();
    if (!this.#preparing) {
      this.#preparing = this.#prepare(signal).finally(() => { this.#preparing = null; });
    }
    return this.#preparing;
  }
  async #prepare(signal) {
    const started = performance.now(), deadline = started + HISTORY_VERIFICATION_DEADLINE_MS;
    this.#emit("history-background.started");
    let migrate = false;
    try {
      for (;;) {
        signal?.throwIfAborted();
        this.#assertCommittedView();
        const before = this.#generation();
        if (performance.now() >= deadline) throw Object.assign(new Error("History verification deadline exceeded."), {code:"CODE_CHANGE_HISTORY_DEADLINE"});
        let verified;
        try {
          this.#job = this.#startJob({migrate, signal, timeoutMs:Math.max(1, deadline-performance.now()),
            onProgress:verifiedVersions => this.#emit("history-background.progress", {verifiedVersions})});
          verified = await this.#job.result;
          if (migrate) { migrate = false; continue; }
        } catch (error) {
          if (error?.code === "CODE_CHANGE_HISTORY_MIGRATION_REQUIRED") {
            // Migration uses the same retry/deadline/closed gate as reads.
            // Its committed write is followed by a fresh read snapshot.
            migrate = true;
            continue;
          }
          if (error?.code !== "ERR_SQLITE_ERROR" || (error.errcode & 255) !== 5) throw error;
          this.#emit("history-background.busy-retry");
          await wait(25, undefined, {signal});
          continue;
        } finally { this.#job = null; }
        this.#assertCommittedView();
        const after = this.#generation();
        if (!same(before, after)) {
          this.#invalidate(); this.#emit("history-background.invalidated"); continue;
        }
        this.#verified = new Map(verified.map(entry => [entry.runId, entry]));
        this.#stamp = after; this.#complete = true;
        this.#emit("history-background.completed", {elapsedMs:performance.now()-started, runCount:verified.length});
        return;
      }
    } catch (error) {
      this.#invalidate(); this.#emit("history-background.failed", {elapsedMs:performance.now()-started, errorCode:error?.code || "HISTORY_INTEGRITY_ERROR"});
      throw error;
    }
  }
  list() {
    return this.#read(() => {
      if (this.verification === "background" && !this.#complete) throw changed();
      const rows = this.#observe("list-read", () => this.database.prepare("SELECT * FROM main.code_change_runs ORDER BY rowid").all());
      const result = rows.map(row => this.#checked(row));
      this.#complete = true;
      return result;
    });
  }
  setBusyTimeout(milliseconds) { setSqliteBusyTimeout(this.database, milliseconds); }
  get(runId) {
    if (typeof runId !== "string" || !runId) return null;
    return this.#read(() => {
      if (this.verification === "background" && !this.#complete) throw changed();
      const row = this.database.prepare("SELECT * FROM main.code_change_runs WHERE run_id=?").get(runId);
      return row ? this.#checked(row) : null;
    });
  }
  history(runId) {
    return this.#read(() => {
      const current = this.database.prepare("SELECT * FROM main.code_change_runs WHERE run_id=?").get(runId);
      if (!current) {
        if (this.verification === "background" && !this.#complete) throw changed();
        return [];
      }
      this.#checked(current);
      return this.database.prepare("SELECT record_json FROM main.code_change_history WHERE run_id=? ORDER BY version").all(runId)
        .map(row => JSON.parse(String(row.record_json)));
    });
  }
  historyProof(runId) {
    return this.#read(() => {
      const current = this.database.prepare("SELECT * FROM main.code_change_runs WHERE run_id=?").get(runId);
      if (!current) {
        if (this.verification === "background" && !this.#complete) throw changed();
        return null;
      }
      this.#checked(current);
      const rows = this.database.prepare("SELECT version,record_hash,previous_hash,entry_hash FROM main.code_change_history WHERE run_id=? ORDER BY version").all(runId);
      return {kind:"LOCAL_UNKEYED_HASH_CHAIN", runId, version:Number(current.version),
        entries:rows.map(row => ({version:Number(row.version), recordHash:row.record_hash,
          previousHash:row.previous_hash, entryHash:row.entry_hash}))};
    });
  }
  deleteFinished(runId, expectedVersion) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT * FROM main.code_change_runs WHERE run_id=?").get(runId);
      if (!row || Number(row.version) !== expectedVersion) {
        throw Object.assign(new Error("Run changed; refresh."), { code:"RUN_VERSION_CONFLICT" });
      }
      const before = this.#mutationStamp();
      const stage = this.#checked(row).stage;
      if (!["APPLIED", "CANCELLED", "INCONCLUSIVE", "FAILED"].includes(stage)) {
        throw Object.assign(new Error("Only finished runs can be deleted."), { code:"RUN_NOT_TERMINAL" });
      }
      let changes = Number(this.database.prepare("DELETE FROM main.code_change_history WHERE run_id=?").run(runId).changes);
      changes += Number(this.database.prepare("DELETE FROM main.code_change_runs WHERE run_id=? AND version=?").run(runId, expectedVersion).changes);
      changes += Number(this.database.prepare("DELETE FROM main.audit_command_receipts WHERE run_id=? AND status='COMPLETED'").run(runId).changes);
      for (const receipt of this.database.prepare("SELECT request_id, result_json FROM main.audit_command_receipts WHERE run_id IS NULL AND status='COMPLETED' AND result_json IS NOT NULL").all()) {
        try {
          if (JSON.parse(String(receipt.result_json))?.payload?.runId === runId) {
            changes += Number(this.database.prepare("DELETE FROM main.audit_command_receipts WHERE request_id=?").run(receipt.request_id).changes);
          }
        } catch { /* Older malformed receipts are unrelated to this run. */ }
      }
      this.database.exec("COMMIT");
      if (this.#finishWrite(before, changes)) this.#verified.delete(runId);
      return true;
    } catch (error) { this.#rollback(error); }
  }
  save(value, expectedVersion = 0) {
    const record = { ...value, version: expectedVersion + 1, updatedAt: new Date().toISOString() };
    const json = canonicalJson(record), hash = sha256CanonicalJson(record);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const before = this.#mutationStamp();
      let previousHash = null;
      if (expectedVersion > 0) {
        const current = this.database.prepare("SELECT * FROM main.code_change_runs WHERE run_id=?").get(record.runId);
        if (!current || Number(current.version) !== expectedVersion) throw Object.assign(new Error("Run changed; refresh before acting."), { code:"RUN_VERSION_CONFLICT" });
        this.#checked(current);
        previousHash = this.#verified.get(record.runId).headHash;
      }
      const result = expectedVersion === 0
      ? this.database.prepare("INSERT INTO main.code_change_runs VALUES (?, ?, ?, ?)").run(record.runId, record.version, json, hash)
      : this.database.prepare("UPDATE main.code_change_runs SET version=?,record_json=?,record_hash=? WHERE run_id=? AND version=?")
        .run(record.version, json, hash, record.runId, expectedVersion);
      if (Number(result.changes) !== 1) throw Object.assign(new Error("Run changed; refresh before acting."), { code: "RUN_VERSION_CONFLICT" });
      const headHash = historyHash(record.runId, record.version, hash, previousHash);
      this.database.prepare("INSERT INTO main.code_change_history (run_id, version, record_json, record_hash, previous_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?)")
        .run(record.runId, record.version, json, hash, previousHash, headHash);
      this.database.exec("COMMIT");
      if (this.#finishWrite(before, 2)) this.#verified.set(record.runId, {runId:record.runId, version:record.version, recordHash:hash, headHash});
      return record;
    } catch (error) { this.#rollback(error); }
  }
  receipt(requestId) { return this.database.prepare("SELECT * FROM main.audit_command_receipts WHERE request_id=?").get(requestId); }
  beginCommand(requestId, hash, runId = null) {
    const before = this.#generation(); this.#fresh(before);
    this.database.prepare("INSERT INTO main.audit_command_receipts (request_id, request_hash, status, result_json, run_id) VALUES (?, ?, 'INTENT', NULL, ?)").run(requestId, hash, runId);
    this.#finishWrite(before, 1);
  }
  finishCommand(requestId, result) {
    const before = this.#generation(); this.#fresh(before);
    const resultRow = this.database.prepare("UPDATE main.audit_command_receipts SET status='COMPLETED', result_json=? WHERE request_id=? AND status='INTENT'").run(canonicalJson(result), requestId);
    this.#finishWrite(before, Number(resultRow.changes));
  }
  close() {
    if (this.#closed) return this.#closing;
    this.#closed = true; this.#invalidate();
    const job = this.#job, preparing = this.#preparing;
    job?.cancel();
    let databaseFailure;
    try { this.database.close(); } catch (error) { databaseFailure = error; }
    if (job || preparing) {
      this.#closing = (async () => {
        const errors = [];
        try { await job?.closed; } catch (error) { errors.push(error); }
        // A failed operation is not itself failed closure. A retry waiter must
        // nevertheless settle before the owner reports that closure is done.
        await preparing?.catch(() => {});
        if (this.#closureFailure && !errors.includes(this.#closureFailure)) errors.push(this.#closureFailure);
        if (databaseFailure) errors.push(databaseFailure);
        if (job) this.#emit("history-background.closed", {forced:Boolean(job.forced)});
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, "Code change store closure failed.", {cause:errors[0]});
      })();
    } else if (databaseFailure || this.#closureFailure) {
      this.#closing = Promise.reject(databaseFailure || this.#closureFailure);
    }
    // Preserve rejection for callers while avoiding an unobserved rejection
    // when a synchronous owner initiates cleanup before awaiting its result.
    this.#closing?.catch(() => {});
    return this.#closing;
  }
}
