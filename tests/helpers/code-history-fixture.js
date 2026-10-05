import { DatabaseSync } from "node:sqlite";
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
