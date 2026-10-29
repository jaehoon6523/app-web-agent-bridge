import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {killAtBoundary} from './helpers/audit-crash-checkpoint.js';
import {removeOwnedFixture} from '../scripts/e2e/helpers/owned-fixture.mjs';

function childFixture(t, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-crash-protocol-'));
  const childFile = path.join(directory, 'child.mjs');
  const helper = new URL('./helpers/audit-crash-checkpoint.js', import.meta.url).href;
  fs.writeFileSync(childFile, `import {publishCrashCheckpoint} from ${JSON.stringify(helper)};\n${source}`);
  t.after(() => removeOwnedFixture(directory));
  return {directory, childFile};
}

test('large synchronous checkpoints arrive while the child is frozen at the boundary', {timeout:10000}, async t => {
  const {childFile, directory} = childFixture(t, `
import fs from 'node:fs';
import path from 'node:path';
publishCrashCheckpoint('ready', {directory:${JSON.stringify(os.tmpdir())}});
publishCrashCheckpoint('boundary', {snapshot:'x'.repeat(8 * 1024 * 1024)});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
fs.writeFileSync(path.join(import.meta.dirname, 'continued'), 'not at the boundary');
`);
  const result = await killAtBoundary(t, [], {childFile, timeoutMs:5000});
  assert.equal(result.boundary.snapshot.length, 8 * 1024 * 1024);
  assert.equal(result.boundary.pid, result.metadata.pid);
  assert.equal(result.boundary.token, result.metadata.token);
  assert.ok(result.closure.signal || result.closure.code !== 0);
  assert.equal(fs.existsSync(path.join(directory, 'continued')), false);
});

test('missing checkpoints fail within a local deadline and still confirm child closure', {timeout:8000}, async t => {
  const {childFile} = childFixture(t, 'setInterval(() => {}, 1000);');
  const started = performance.now();
  await assert.rejects(killAtBoundary(t, [], {childFile, timeoutMs:250}), error => {
    assert.equal(error.code, 'AUDIT_CRASH_BOUNDARY_TIMEOUT', error.stack);
    assert.ok(error.closure);
    assert.ok(error.closure.signal || error.closure.code !== 0);
    assert.equal(error.checkpointDirectory, null);
    return true;
  });
  assert.ok(performance.now() - started < 7000, 'The fixture deadline must include child closure.');
});

test('successful child exit without a boundary never counts as a crash observation', {timeout:8000}, async t => {
  const {childFile} = childFixture(t, 'process.exitCode = 0;');
  await assert.rejects(killAtBoundary(t, [], {childFile}), error => {
    assert.equal(error.code, 'AUDIT_CRASH_EARLY_EXIT', error.stack);
    assert.deepEqual(error.closure, {code:0, signal:null});
    return true;
  });
});

test('a checkpoint from a different invocation is rejected before killing and draining its child', {timeout:8000}, async t => {
  const {childFile} = childFixture(t, `
process.env.BRIDGE_AUDIT_CRASH_TOKEN = 'another-invocation';
publishCrashCheckpoint('ready', {});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`);
  await assert.rejects(killAtBoundary(t, [], {childFile}), error => {
    assert.equal(error.code, 'AUDIT_CRASH_CHECKPOINT_MISMATCH', error.stack);
    assert.ok(error.closure);
    assert.equal(error.checkpointDirectory, null);
    return true;
  });
});

test('a checkpoint from a different child is rejected', {timeout:8000}, async t => {
  const {childFile} = childFixture(t, `
const stringify = JSON.stringify;
JSON.stringify = record => stringify({...record, pid:process.pid + 1});
publishCrashCheckpoint('ready', {});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`);
  await assert.rejects(killAtBoundary(t, [], {childFile}), error => {
    assert.equal(error.code, 'AUDIT_CRASH_CHECKPOINT_MISMATCH', error.stack);
    assert.ok(error.closure);
    assert.equal(error.checkpointDirectory, null);
    return true;
  });
});

for (const [label, contents] of [['empty', ''],
  ['partial', '{"token":"private-checkpoint-token","snapshot":"private-checkpoint-value']]) {
  test(`${label} checkpoint JSON fails with its parse cause and safe evidence`, {timeout:8000}, async t => {
    const {childFile} = childFixture(t, `
JSON.stringify = () => ${JSON.stringify(contents)};
publishCrashCheckpoint('ready', {});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`);
    const diagnostics = [];
    await assert.rejects(killAtBoundary({diagnostic:line => diagnostics.push(JSON.parse(line))}, [], {childFile}), error => {
      assert.equal(error.code, 'AUDIT_CRASH_CHECKPOINT_INVALID_JSON', error.stack);
      assert.ok(error.cause instanceof SyntaxError);
      assert.equal(error.checkpointKind, 'ready');
      assert.equal(error.checkpointBytes, Buffer.byteLength(contents, 'utf8'));
      assert.ok(error.closure);
      assert.equal(error.checkpointDirectory, null);
      assert.doesNotMatch(error.message, /private-checkpoint-(?:token|value)/u);
      return true;
    });
    assert.equal(diagnostics.at(-1).errorName, 'Error');
    assert.equal(diagnostics.at(-1).errorMessage, 'Crash checkpoint is not valid JSON.');
    assert.equal(diagnostics.at(-1).causeName, 'SyntaxError');
    assert.doesNotMatch(JSON.stringify(diagnostics), /private-checkpoint-(?:token|value)/u);
  });
}

test('unpublished temporary checkpoint JSON is never consumed', {timeout:10000}, async t => {
  const {childFile, directory} = childFixture(t, `
import fs from 'node:fs';
JSON.stringify = () => '{"kind":';
fs.renameSync = () => {
  fs.writeFileSync(new URL('./publishing', import.meta.url), 'temporary checkpoint ready');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
publishCrashCheckpoint('ready', {});
`);
  await assert.rejects(killAtBoundary(t, [], {childFile, timeoutMs:3000}), error => {
    assert.equal(error.code, 'AUDIT_CRASH_BOUNDARY_TIMEOUT', error.stack);
    assert.ok(error.closure);
    assert.equal(error.checkpointDirectory, null);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(directory, 'publishing'), 'utf8'), 'temporary checkpoint ready');
});

test('a checkpoint failure retains cleanup and diagnostic failures plus its directory', {timeout:8000}, async t => {
  const {childFile} = childFixture(t, `
process.env.BRIDGE_AUDIT_CRASH_TOKEN = 'another-invocation';
publishCrashCheckpoint('ready', {});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`);
  const cleanupFailure = Object.assign(new Error('Synthetic checkpoint cleanup failure.'), {code:'EIO'});
  const diagnosticFailure = new Error('Synthetic checkpoint diagnostic failure.');
  const originalRemove = fs.promises.rm;
  const remove = t.mock.method(fs.promises, 'rm', (directory, options) => {
    if (path.basename(directory).startsWith('bridge-audit-crash-')) throw cleanupFailure;
    return originalRemove(directory, options);
  });
  let retainedDirectory;
  try {
    await assert.rejects(killAtBoundary({diagnostic:() => {throw diagnosticFailure;}}, [], {childFile}), error => {
      retainedDirectory = error.checkpointDirectory;
      assert.equal(error.code, 'AUDIT_CRASH_CHECKPOINT_MISMATCH', error.stack);
      assert.equal(error.cleanupError, cleanupFailure);
      assert.deepEqual(error.cleanupErrors, [cleanupFailure]);
      assert.equal(error.diagnosticError, diagnosticFailure);
      assert.ok(error.closure);
      assert.ok(retainedDirectory);
      assert.equal(fs.existsSync(retainedDirectory), true);
      return true;
    });
  } finally {
    remove.mock.restore();
    if (retainedDirectory) await removeOwnedFixture(retainedDirectory);
  }
});

test('a boundary without setup metadata is refused with bounded cleanup', {timeout:8000}, async t => {
  const {childFile} = childFixture(t, `
publishCrashCheckpoint('boundary', {snapshot:{}});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`);
  await assert.rejects(killAtBoundary(t, [], {childFile}), error => {
    assert.equal(error.code, 'AUDIT_CRASH_MISSING_METADATA', error.stack);
    assert.ok(error.closure);
    return true;
  });
});
