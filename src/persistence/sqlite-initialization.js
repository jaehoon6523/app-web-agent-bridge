import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";

export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS = 25;

export function setSqliteBusyTimeout(database, milliseconds = DEFAULT_SQLITE_BUSY_TIMEOUT_MS) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 2147483647) {
    throw new RangeError("SQLite busy timeout must be a non-negative 32-bit integer.");
  }
  database.exec(`PRAGMA busy_timeout=${milliseconds}`);
}

/**
 * Retry only unpublished database initialization. Each failed attempt must close
 * every handle it opened. Never use this to replay a runtime or user command.
 * @template T
 * @param {() => T} initializer
 * @param {{signal?: AbortSignal, onBusy?: (error: any) => void}} [options]
 * @returns {Promise<T>}
 */
export async function initializeSqlite(initializer, {signal, onBusy} = {}) {
  const deadline = performance.now() + DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  let lastBusy;
  for (;;) {
    signal?.throwIfAborted();
    if (lastBusy && performance.now() >= deadline) throw lastBusy;
    try { return initializer(); }
    catch (error) {
      if (error?.code !== "ERR_SQLITE_ERROR" || !Number.isInteger(error.errcode)
        || (error.errcode & 255) !== 5 || performance.now() >= deadline) throw error;
      lastBusy = error;
      try { onBusy?.(error); } catch { /* Diagnostics cannot change initialization. */ }
      try { await wait(Math.min(RETRY_INTERVAL_MS, Math.max(1, deadline-performance.now())), undefined, {signal}); }
      catch (error) { signal?.throwIfAborted(); throw error; }
    }
  }
}
