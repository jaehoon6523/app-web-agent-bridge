import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {assertSourceCopies, sourceCopyKey} from '../helpers/source-copy-identity.js';
import {ResourceClosureError, isResourceClosureFailure} from '../../src/persistence/resource-closure.js';

test('C02/C03: explicit closure evidence preserves object identity and cause', () => {
  const operation = new Error('operation'), cleanup = new Error('close');
  const error = new ResourceClosureError({resourceOwner:'SqliteStore', failureStage:'constructor.close',
    operationError:operation, cleanupErrors:[cleanup]});
  assert.equal(isResourceClosureFailure(error),true);
  assert.equal(error.cause,operation);
  assert.equal(error.operationError,operation);
  assert.deepEqual(error.errors,[operation,cleanup]);
  assert.equal(error.cleanupErrors[0],cleanup);
  assert.equal(error.resourceFailures[0].error,cleanup);
});

test('source identity accepts only exact permitted paths on either OS', () => {
  const allowed = ['src/persistence/sqlite-database.js','src/persistence/code-change-history-job.js'];
  for (const filesystem of [path.posix,path.win32]) {
    const job = filesystem.join('src','persistence','code-change-history-job.js');
    const owner = filesystem.join('src','persistence','code-change-store.js');
    assert.equal(sourceCopyKey(job),allowed[1]);
    assert.doesNotThrow(() => assertSourceCopies({[job]:{production:'original',probe:'instrumented'},
      [owner]:{production:'same',probe:'same'}},allowed));
    assert.throws(() => assertSourceCopies({[owner]:{production:'original',probe:'unauthorized'}},allowed), {code:'ERR_ASSERTION'});
    assert.throws(() => assertSourceCopies({[job+'.extra']:{production:'original',probe:'unauthorized'}},allowed), {code:'ERR_ASSERTION'});
  }
});

test('C03/C06: message, code, arbitrary aggregate and a lookalike flag are not closure evidence', () => {
  for (const error of [new Error('resource cleanup failed'), new AggregateError([new Error('rollback')], 'cleanup failed'),
    Object.assign(new Error('operation'),{code:'LIVE_RUNTIME_CLEANUP_FAILED'}),
    {resourceClosureFailed:true, cleanupErrors:[new Error('untrusted shape')]}]) {
    assert.equal(isResourceClosureFailure(error),false);
  }
});
