import { setTimeout as wait } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

// SQLite COMMIT can itself be BUSY while another connection holds a read lock
// in rollback-journal mode. The same external transaction remains open: retry
// only COMMIT, never replay the product mutation or release by swallowing errors.
export async function commitExternalLock(db, { timeout = 5000, onBusy = () => {} } = {}) {
  const deadline = performance.now() + timeout;
  for (;;) {
    try { db.exec('COMMIT'); return; }
    catch (error) {
      if (error.code !== 'ERR_SQLITE_ERROR' || ![5, 6].includes(error.errcode & 255) || performance.now() >= deadline) throw error;
      onBusy(error); await wait(25);
    }
  }
}
