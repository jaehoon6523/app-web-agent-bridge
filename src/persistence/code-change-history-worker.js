import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "./sqlite-database.js";
import { verifyHistories } from "./code-change-history.js";

const cancellation = new Int32Array(workerData.cancellation);
let database, transaction = false, verifiedVersions = 0;
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
  const verified = verifyHistories(database, {migrate, checkCancelled});
  if (migrate) verifyHistories(database, {checkCancelled});
  checkCancelled();
  database.exec("COMMIT"); transaction = false;
  parentPort.postMessage({ok:true, verified:migrate ? null : verified});
} catch (error) {
  // Only fixed integrity messages cross the boundary; no record JSON or path.
  const message = error.message.startsWith("Code change ") ? error.message : "Code change history verification failed.";
  parentPort.postMessage({ok:false, error:{message, code:error.code, errcode:error.errcode}});
} finally {
  try { if (transaction) database.exec("ROLLBACK"); }
  finally { database?.close(); parentPort.close(); }
}
