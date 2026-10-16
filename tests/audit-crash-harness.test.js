import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {killAtBoundary} from './helpers/audit-crash-checkpoint.js';

function childFixture(t, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-crash-protocol-'));
  const childFile = path.join(directory, 'child.mjs');
  const helper = new URL('./helpers/audit-crash-checkpoint.js', import.meta.url).href;
  fs.writeFileSync(childFile, `import {publishCrashCheckpoint} from ${JSON.stringify(helper)};\n${source}`);
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
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
    assert.equal(error.code, 'AUDIT_CRASH_BOUNDARY_TIMEOUT');
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
    assert.equal(error.code, 'AUDIT_CRASH_EARLY_EXIT');
    assert.deepEqual(error.closure, {code:0, signal:null});
    return true;
  });
});

test('a checkpoint from a different invocation is rejected before killing and draining its child', {timeout:8000}, async t => {
  const {childFile} = childFixture(t, `
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(process.env.BRIDGE_AUDIT_CRASH_DIRECTORY, 'ready.json'),
  JSON.stringify({kind:'ready', token:'another-invocation', pid:process.pid}));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`);
  await assert.rejects(killAtBoundary(t, [], {childFile}), error => {
    assert.equal(error.code, 'AUDIT_CRASH_CHECKPOINT_MISMATCH');
    assert.ok(error.closure);
    assert.equal(error.checkpointDirectory, null);
    return true;
  });
});

test('a boundary without setup metadata is refused with bounded cleanup', {timeout:8000}, async t => {
  const {childFile} = childFixture(t, `
publishCrashCheckpoint('boundary', {snapshot:{}});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`);
  await assert.rejects(killAtBoundary(t, [], {childFile}), error => {
    assert.equal(error.code, 'AUDIT_CRASH_MISSING_METADATA');
    assert.ok(error.closure);
    return true;
  });
});
