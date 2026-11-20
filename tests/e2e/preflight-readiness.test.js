import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForPreflight } from '../../scripts/e2e/preflight-readiness.mjs';

const response = status => ({ status, async json() { return { checks:{ extensionConfigured:false }, secret:'must-not-be-logged' }; } });
test('startup driver never accepts a JSON 503 as readiness and reports the last HTTP status safely', async () => {
  await assert.rejects(waitForPreflight('unused', { timeoutMs:30, fetchResponse:async () => response(503) }), error => {
    assert.equal(error.lastObservation.status, 503);
    assert.equal(error.lastObservation.kind, 'HTTP_RESPONSE');
    assert.doesNotMatch(error.message, /must-not-be-logged/u);
    return true;
  });
});
test('startup driver confirms readiness only after a later successful 200', async () => {
  let calls = 0;
  const result = await waitForPreflight('unused', { timeoutMs:500, fetchResponse:async () => response(++calls === 1 ? 503 : 200) });
  assert.equal(calls, 2);
  assert.equal(result.lastObservation.status, 200);
  assert.equal(result.preflight.checks.extensionConfigured, false);
});
test('startup driver rejects malformed 200 instead of confirming readiness', async () => {
  await assert.rejects(waitForPreflight('unused', { timeoutMs:30,
    fetchResponse:async () => ({ status:200, async json() { return {}; } }) }), error => error.lastObservation.checksPresent === false);
});
test('startup driver identifies response read failure without storing an arbitrary error message', async () => {
  await assert.rejects(waitForPreflight('unused', { timeoutMs:30, fetchResponse:async () => { throw new TypeError('private secret'); } }), error => {
    assert.equal(error.lastObservation.errorName, 'TypeError');
    assert.doesNotMatch(error.message, /private secret/u);
    return true;
  });
});
