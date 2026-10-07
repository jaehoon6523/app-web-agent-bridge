import assert from 'node:assert/strict';

export function assertNativeDatabaseClosed(database) {
  // isOpen was added in Node 22.15. Exercise the actual connection on older runtimes too.
  assert.throws(() => database.exec('SELECT 1'), {code:'ERR_INVALID_STATE'});
}
