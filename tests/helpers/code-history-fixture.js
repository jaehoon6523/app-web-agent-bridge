import { DatabaseSync } from "node:sqlite";
import { Worker, isMainThread, workerData } from "node:worker_threads";
import { CodeChangeStore } from "../../src/persistence/code-change-store.js";
import { canonicalJson, sha256CanonicalJson } from "../../src/domain/canonical-json.js";

// Actual cumulative records and canonical hash chain, independently written in
// one transaction. No delayed response, fake verifier or mocked SQLite handle.
export function seedHistory(filename, {versions = 8, eventBytes = 32, legacy = false} = {}) {
  new CodeChangeStore(filename).close();
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE");
  let previousHash = null, record, json, hash;
  const events = [], runId = "accumulated-history";
  const insert = db.prepare("INSERT INTO code_change_history VALUES (?,?,?,?,?,?)");
  try {
    for (let version = 1; version <= versions; version++) {
      events.push({type:"STATE_CHANGED", detail:"x".repeat(eventBytes), version});
      record = {runId, version, schemaVersion:3, stage:"CANCELLED", events, objective:"history contract",
        createdAt:"2026-10-05T00:00:00.000Z", updatedAt:"2026-10-05T00:00:00.000Z"};
      json = canonicalJson(record); hash = sha256CanonicalJson(record);
      const headHash = sha256CanonicalJson({kind:"CODE_CHANGE_HISTORY",runId,version,recordHash:hash,previousHash});
      insert.run(runId, version, json, hash, legacy ? null : previousHash, legacy ? null : headHash);
      previousHash = headHash;
    }
    db.prepare("INSERT INTO code_change_runs VALUES (?,?,?,?)").run(runId, versions, json, hash);
    db.exec("COMMIT");
    return {record, headHash:previousHash};
  } finally { db.close(); }
}

// The HTTP test's supervisor also receives server heartbeats. Keep fixture
// hashing and synchronous SQLite commit off that event loop, just as production
// history verification is kept off the server event loop.
export function appendHistory(filename, record, {signal} = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const worker = new Worker(new URL(import.meta.url), {workerData:{appendHistory:{filename,record}}});
  return new Promise((resolve,reject) => {
    let failure;
    const cancel = () => { void worker.terminate().catch(error => {failure ??= error;}); };
    worker.once('error',error => {failure = error;});
    worker.once('exit',code => {
      signal?.removeEventListener('abort',cancel);
      if (failure) reject(failure);
      else if (signal?.aborted) reject(signal.reason);
      else if (code !== 0) reject(new Error('History fixture append worker exited with code '+code));
      else resolve();
    });
    signal?.addEventListener('abort',cancel,{once:true});
  });
}

if (!isMainThread && workerData?.appendHistory) {
  const {filename,record} = workerData.appendHistory;
  const writer = new DatabaseSync(filename);
  try {
    const json = canonicalJson(record), hash = sha256CanonicalJson(record);
    const previousHash = writer.prepare("SELECT entry_hash FROM code_change_history ORDER BY version DESC LIMIT 1").get().entry_hash;
    const headHash = sha256CanonicalJson({kind:"CODE_CHANGE_HISTORY",runId:record.runId,version:record.version,recordHash:hash,previousHash});
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("UPDATE code_change_runs SET version=?,record_json=?,record_hash=? WHERE run_id=?").run(record.version,json,hash,record.runId);
    writer.prepare("INSERT INTO code_change_history VALUES (?,?,?,?,?,?)").run(record.runId,record.version,json,hash,previousHash,headHash);
    writer.exec("COMMIT");
  } finally {writer.close();}
}
