import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceOwner } from '../../scripts/e2e/helpers/resources.mjs';
import { addArtifactWrites } from '../../scripts/e2e/helpers/artifacts.mjs';
import { closeSteps } from '../../src/diagnostics/shutdown.js';
import { createBridgeServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('multiple close failures and an artifact write failure preserve every cause and later evidence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-artifact-contract-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  // A directory at the file path causes a real write failure on both OSes.
  fs.mkdirSync(path.join(root, 'server.stdout.log'));
  const owner = createResourceOwner();
  const browserError = new Error('controlled browser close rejection');
  const serverError = new Error('controlled server close rejection');
  owner.add('browser', () => { throw browserError; }, 20);
  owner.add('server', () => { throw serverError; }, 30);
  addArtifactWrites(owner, root, [
    ['server.stdout.log', () => 'stdout'],
    ['server.stderr.log', () => 'stderr survives'],
    ['boundary.json', () => JSON.stringify({ observed:true })],
  ]);
  addArtifactWrites(owner, root, [
    ['result.json', errors => JSON.stringify({ outcome:errors.length ? 'FAIL' : 'PASS', cleanupFailures:errors.map(error => error.message) })],
  ], 100);
  await assert.rejects(owner.close(), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 3);
    assert.equal(error.errors[0].cause, browserError);
    assert.equal(error.errors[1].cause, serverError);
    assert.match(error.errors[2].message, /artifact server\.stdout\.log/u);
    assert.ok(error.errors[2].cause instanceof Error);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(root, 'server.stderr.log'), 'utf8'), 'stderr survives');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'boundary.json'), 'utf8')), { observed:true });
  const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
  assert.equal(result.outcome, 'FAIL');
  assert.equal(result.cleanupFailures.length, 3);
});

test('cleanup rejection and deadline preserve FAIL and cannot skip later resources or final evidence', async () => {
  const owner = createResourceOwner(), calls = [];
  let outcome;
  owner.add('rejected close', () => { calls.push('reject'); throw new Error('controlled close failure'); }, 10);
  owner.add('stuck close', () => new Promise(() => {}), 20, 30);
  owner.add('later close', () => calls.push('later'), 30);
  owner.add('result', errors => { outcome = errors.length ? 'FAIL' : 'PASS'; calls.push('result'); }, 100);
  await assert.rejects(owner.close(), error => error instanceof AggregateError && error.errors.length === 2);
  assert.deepEqual(calls, ['reject','later','result']);
  assert.equal(outcome, 'FAIL');
  await assert.rejects(owner.close());
  assert.deepEqual(calls, ['reject','later','result'], 'disposal is idempotent after failure');
});

test('shutdown diagnoses the failed stage, closes later resources and isolates throwing sinks', async () => {
  const cause = Object.assign(new Error('private provider payload'), { code:'CONTROLLED_CLOSE_FAILURE' });
  const events = [], calls = [];
  await assert.rejects(closeSteps([
    ['first', () => { calls.push('first'); throw cause; }],
    ['last', () => calls.push('last')],
  ], (type, detail) => { events.push({type,...detail}); throw new Error('sink failure'); }),
  error => error.errors[0].cause === cause);
  assert.deepEqual(calls, ['first','last']);
  assert.deepEqual(events.map(event => [event.type,event.stage]), [
    ['shutdown.stage.start','first'], ['shutdown.stage.error','first'],
    ['shutdown.stage.start','last'], ['shutdown.stage.done','last'],
  ]);
  assert.equal(events[1].errorCode, 'CONTROLLED_CLOSE_FAILURE');
  assert.doesNotMatch(JSON.stringify(events), /private provider payload/u);
});

test('a real bridge closes HTTP after runtime close rejects and retains the shutdown error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-platform-close-'));
  const events = [];
  const runtimeConfig = {...loadConfig({cwd:root, env:{WORKSPACE:root,DEMO_MODE:'false',
    WEB_EXTENSION_SHARED_SECRET:'contract-only-secret-0123456789abcdef',WEB_EXTENSION_EXPECTED_IDENTITY:'contract-extension'}}),port:0};
  const bridge = createBridgeServer({runtimeConfig, onDiagnostic:event => events.push(event),
    createLiveRuntime:async () => ({close:async () => {throw new Error('controlled runtime close rejection');}})});
  try {
    await bridge.listen();
    await bridge.getLiveRuntime();
    await assert.rejects(bridge.close(), /Shutdown failed at runtime.close/u);
    assert.equal(bridge.server.listening, false);
    assert.ok(events.some(event => event.type === 'shutdown.stage.error' && event.stage === 'runtime.close'));
    assert.ok(events.some(event => event.type === 'shutdown.stage.done' && event.stage === 'HTTP server close'));
    await assert.rejects(bridge.close(), /runtime.close/u);
  } finally {
    if (bridge.server.listening) await new Promise(resolve => bridge.server.close(resolve));
    fs.rmSync(root, {recursive:true,force:true});
  }
});
