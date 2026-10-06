import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';

// Preserve the former SQLite contention budget, but yield between no-wait attempts.
export const PREPARATION_WRITE_WAIT_MS = 5000;
const RETRY_INTERVAL_MS = 25;

/** Retry only a confirmed, rolled-back SQLite BUSY write; never replay a command. */
export async function persistPreparation(db, json, committed, closed) {
  const deadline = performance.now() + PREPARATION_WRITE_WAIT_MS;
  let lastBusy;
  for (;;) {
    if (lastBusy && performance.now() >= deadline) throw lastBusy;
    if (closed()) throw Object.assign(new Error('Preparation persistence is closed.'), {code:'PREPARATION_CLOSED'});
    let began = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      began = true;
      db.prepare('INSERT INTO preparation_state VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(json());
      db.exec('COMMIT');
      committed();
      return;
    } catch (error) {
      if (began) {
        try { db.exec('ROLLBACK'); }
        catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Preparation persistence and rollback failed.', {cause:error});
        } // Unknown transaction outcome cannot be retried.
      }
      if (error?.code !== 'ERR_SQLITE_ERROR' || error.errcode !== 5 || performance.now() >= deadline) throw error;
      lastBusy = error;
      await wait(Math.min(RETRY_INTERVAL_MS, Math.max(1, deadline-performance.now())));
    }
  }
}
