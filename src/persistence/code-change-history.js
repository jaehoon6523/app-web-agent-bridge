import { sha256CanonicalJson } from "../domain/canonical-json.js";

export function historyHash(runId, version, recordHash, previousHash) {
  return sha256CanonicalJson({kind:"CODE_CHANGE_HISTORY", runId, version, recordHash, previousHash});
}

// Iterate within one SQLite snapshot; do not load every cumulative JSON version
// into memory. Hash format and current/history equality remain durable contracts.
export function verifyHistory(database, current, {migrate = false, checkCancelled = () => {}} = {}) {
  const runId = current.run_id;
  const counts = database.prepare(`SELECT COUNT(*) AS count,
    SUM(entry_hash IS NULL AND previous_hash IS NULL) AS unchained
    FROM main.code_change_history WHERE run_id=?`).get(runId);
  if (!counts.count || Number(counts.count) !== Number(current.version)) {
    throw new Error("Code change history has missing versions.");
  }
  const legacy = Number(counts.unchained) === Number(counts.count);
  if (legacy && !migrate) {
    throw Object.assign(new Error("Code change history requires verified migration."), {code:"CODE_CHANGE_HISTORY_MIGRATION_REQUIRED"});
  }
  let previousHash = null, latest, version = 0;
  const update = legacy ? database.prepare("UPDATE main.code_change_history SET previous_hash=?,entry_hash=? WHERE run_id=? AND version=?") : null;
  // Keyset reads also work on the declared Node 22.5 minimum: SQLite's native
  // StatementSync.iterate() was added later. Each read uses the existing PK.
  const first = database.prepare("SELECT * FROM main.code_change_history WHERE run_id=? ORDER BY version LIMIT 1");
  const next = database.prepare("SELECT * FROM main.code_change_history WHERE run_id=? AND version>? ORDER BY version LIMIT 1");
  for (let row = first.get(runId); row; row = next.get(runId, row.version)) {
    checkCancelled();
    version++;
    const record = JSON.parse(String(row.record_json));
    const entryHash = historyHash(runId, version, row.record_hash, previousHash);
    if (row.run_id !== runId || Number(row.version) !== version || record.runId !== runId
      || record.version !== version || sha256CanonicalJson(record) !== row.record_hash
      || (!legacy && (row.previous_hash !== previousHash || row.entry_hash !== entryHash))) {
      throw new Error("Code change history integrity check failed.");
    }
    if (legacy) update.run(previousHash, entryHash, runId, version);
    previousHash = entryHash;
    latest = row;
  }
  if (latest.record_hash !== current.record_hash || latest.record_json !== current.record_json
    || version !== Number(current.version)) throw new Error("Code change current record differs from history.");
  return {runId, version, recordHash:current.record_hash, headHash:previousHash};
}

export function verifyHistories(database, options = {}) {
  const verified = [];
  for (const current of database.prepare("SELECT * FROM main.code_change_runs ORDER BY rowid").all()) {
    verified.push(verifyHistory(database, current, options));
  }
  return verified;
}
