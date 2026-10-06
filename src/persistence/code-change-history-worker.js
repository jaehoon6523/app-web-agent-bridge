import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "./sqlite-database.js";
import { verifyHistories } from "./code-change-history.js";

const cancellation = new Int32Array(workerData.cancellation);
let database, transaction = false, verifiedVersions = 0;
let verified, failure;
const cleanup = [];
const fixedErrorMessages = new Set([
  "Code change history has missing versions.",
  "Code change history requires verified migration.",
  "Code change history integrity check failed.",
  "Code change current record differs from history.",
  "Code change history verification cancelled.",
]);
function safeError(error) {
  // No arbitrary exception text, record JSON or filename crosses the boundary.
  const message = fixedErrorMessages.has(error.message)
    ? error.message : "Code change history verification failed.";
  return {message, code:error.code, errcode:error.errcode};
}
function checkCancelled() {
  if (Atomics.load(cancellation, 0)) {
    throw Object.assign(new Error("Code change history verification cancelled."), {code:"CODE_CHANGE_HISTORY_CANCELLED"});
  }
  if (++verifiedVersions % 128 === 0) parentPort.postMessage({progress:verifiedVersions});
}
try {
  checkCancelled();
  const migrate = workerData.migrate === true;
  database = new DatabaseSync(workerData.filename, {readOnly:!migrate});
  database.exec("PRAGMA busy_timeout=0");
  if (!migrate) database.exec("PRAGMA query_only=1");
  database.exec(migrate ? "BEGIN IMMEDIATE" : "BEGIN");
  transaction = true;
  verified = verifyHistories(database, {migrate, checkCancelled});
  if (migrate) verifyHistories(database, {checkCancelled});
  checkCancelled();
  database.exec("COMMIT"); transaction = false;
  if (migrate) verified = null;
} catch (error) {
  failure = error;
} finally {
  try { if (transaction) database.exec("ROLLBACK"); } catch (error) { cleanup.push(error); }
  try { database?.close(); } catch (error) { cleanup.push(error); }
  const errors = [failure, ...cleanup].filter(error => error !== undefined);
  const error = cleanup.length ? {message:"Code change history operation and cleanup failed.",
    code:"CODE_CHANGE_HISTORY_CLEANUP_FAILED", errors:errors.map(safeError)} : failure && safeError(failure);
  parentPort.postMessage(error ? {ok:false, error, cleanupFailed:cleanup.length > 0} : {ok:true, verified});
  parentPort.close();
}
