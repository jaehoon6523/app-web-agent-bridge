import assert from 'node:assert/strict';
import test from 'node:test';
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

test('C03/C06: message, code, arbitrary aggregate and a lookalike flag are not closure evidence', () => {
  for (const error of [new Error('resource cleanup failed'), new AggregateError([new Error('rollback')], 'cleanup failed'),
    Object.assign(new Error('operation'),{code:'LIVE_RUNTIME_CLEANUP_FAILED'}),
    {resourceClosureFailed:true, cleanupErrors:[new Error('untrusted shape')]}]) {
    assert.equal(isResourceClosureFailure(error),false);
  }
});
