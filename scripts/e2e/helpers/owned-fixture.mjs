import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';

// Call only after all owned processes, sockets and storage have closed.
// Windows may release filesystem handles later.
// This bounds the retry decision, not the duration of a pending filesystem call.
// Exhaustion is a real fixture failure, not a passing cleanup exception.
export async function removeOwnedFixture(root, {timeoutMs = 2500, retryDelayMs = 75,
  remove = directory => fs.promises.rm(directory, {recursive:true, force:true, maxRetries:0})} = {}) {
  assert.ok(timeoutMs > 0 && retryDelayMs > 0, 'fixture cleanup needs a positive time budget');
  const deadline = performance.now() + timeoutMs;
  let retries = 0, lastLockError;
  const exhausted = (cause, completedAfterDeadline = false) => Object.assign(
    new Error(`Owned fixture cleanup retry budget ${timeoutMs}ms exceeded after ${retries} retries`, {cause}),
    {code:'OWNED_FIXTURE_CLEANUP_DEADLINE', retries, timeoutMs, completedAfterDeadline});
  for (;;) {
    // Do not begin another filesystem attempt after the retry budget expires.
    if (performance.now() >= deadline) throw exhausted(lastLockError);
    try {
      // Disable fs.rm's linear backoff; this loop owns the retry budget.
      await remove(root);
      assert.equal(fs.existsSync(root),false,'owned fixture directory must be removed');
      // An over-budget success is still a deadline failure; do not silently pass.
      // The in-flight filesystem call itself cannot be forcibly interrupted here.
      if (performance.now() >= deadline) throw exhausted(lastLockError, true);
      return;
    } catch (error) {
      if (error.code === 'OWNED_FIXTURE_CLEANUP_DEADLINE') throw error;
      if (!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(error.code)) throw error;
      lastLockError = error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw exhausted(error);
      await wait(Math.min(retryDelayMs,remaining));
      retries++;
    }
  }
}
