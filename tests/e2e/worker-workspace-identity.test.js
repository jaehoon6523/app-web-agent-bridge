import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assertWorkerWorkspace} from '../../scripts/e2e/helpers/worker.mjs';

test('the Worker E2E boundary accepts aliases of the expected worktree only', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-identity-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const target = path.join(directory, 'target'), worker = path.join(directory, 'worker'), other = path.join(directory, 'other');
  for (const item of [target, worker, other]) fs.mkdirSync(item);
  const alias = path.join(directory, 'worker alias');
  fs.symlinkSync(worker, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.doesNotThrow(() => assertWorkerWorkspace({workspaceRoot:fs.realpathSync.native(worker)}, alias, target));
  assert.doesNotThrow(() => assertWorkerWorkspace({workspaceRoot:alias}, worker, target));
  assert.throws(() => assertWorkerWorkspace({workspaceRoot:other}, worker, target), {code:'ERR_ASSERTION'});
});

test('a target alias cannot masquerade as an isolated Worker worktree', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-target-alias-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const target = path.join(directory, 'target'), alias = path.join(directory, 'target alias');
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertWorkerWorkspace({workspaceRoot:alias}, alias, target), {code:'ERR_ASSERTION'});
});
