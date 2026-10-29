import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {ownedSpawn, forceProcessTree} from '../../scripts/e2e/platform/process.mjs';
import {removeOwnedFixture} from '../../scripts/e2e/helpers/owned-fixture.mjs';
import {observeChildClose, waitChildClose} from '../../src/runtime/child-close.js';

const directoryKey = 'BRIDGE_AUDIT_CRASH_DIRECTORY';
const tokenKey = 'BRIDGE_AUDIT_CRASH_TOKEN';
const defaultChild = fileURLToPath(new URL('./audit-ack-crash-child.mjs', import.meta.url));
const failure = (code, message) => Object.assign(new Error(message), {code});

// The tested persistence call remains synchronous. IPC cannot be flushed by a
// main thread parked in Atomics.wait, so publish to an atomic, parent-owned file.
export function publishCrashCheckpoint(kind, value) {
  if (!['ready', 'boundary'].includes(kind) || !process.env[directoryKey] || !process.env[tokenKey]) {
    throw failure('AUDIT_CRASH_CONFIGURATION', 'Missing isolated crash-checkpoint configuration.');
  }
  const filename = path.join(process.env[directoryKey], `${kind}.json`);
  const record = {...value, kind, token:process.env[tokenKey], pid:process.pid};
  const fd = fs.openSync(`${filename}.tmp`, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(`${filename}.tmp`, filename);
}

function readCheckpoint(directory, kind, token, pid) {
  let text;
  try { text = fs.readFileSync(path.join(directory, `${kind}.json`), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let record;
  try { record = JSON.parse(text); }
  catch (cause) {
    throw Object.assign(failure('AUDIT_CRASH_CHECKPOINT_INVALID_JSON', 'Crash checkpoint is not valid JSON.'),
      {cause, checkpointKind:kind, checkpointBytes:Buffer.byteLength(text, 'utf8')});
  }
  if (record?.kind !== kind || record?.token !== token || record?.pid !== pid) {
    throw failure('AUDIT_CRASH_CHECKPOINT_MISMATCH', 'Crash checkpoint belongs to another child or invocation.');
  }
  return record;
}

export async function killAtBoundary(t, args = [], {childFile = defaultChild,
  timeoutMs = 15000, closeMs = 5000} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-audit-crash-'));
  const token = crypto.randomUUID();
  const env = {...process.env, [directoryKey]:directory, [tokenKey]:token};
  delete env.NODE_TEST_CONTEXT;
  const child = ownedSpawn([childFile, ...args], {env});
  const observation = observeChildClose(child);
  let spawnError, stderr = '', metadata, boundary, error, closure;
  child.on('error', cause => { spawnError = cause; });
  child.stdout.resume();
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
  try {
    const deadline = performance.now() + timeoutMs;
    while (!boundary) {
      if (spawnError) throw spawnError;
      metadata ??= readCheckpoint(directory, 'ready', token, child.pid);
      boundary = readCheckpoint(directory, 'boundary', token, child.pid);
      if (boundary && !metadata) throw failure('AUDIT_CRASH_MISSING_METADATA', 'Boundary arrived without child metadata.');
      if (boundary) break;
      if (observation.result) throw failure('AUDIT_CRASH_EARLY_EXIT', 'Child closed before the persistence boundary.');
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw failure('AUDIT_CRASH_BOUNDARY_TIMEOUT', 'Child did not publish the persistence boundary.');
      await wait(Math.min(10, remaining));
    }
    // Do not permit a late checkpoint or a child that already exited to pass.
    if (performance.now() > deadline) throw failure('AUDIT_CRASH_BOUNDARY_TIMEOUT', 'Persistence boundary arrived after its deadline.');
    if (child.exitCode !== null || child.signalCode !== null) {
      throw failure('AUDIT_CRASH_EARLY_EXIT', 'Child exited before the parent requested abrupt termination.');
    }
    t.diagnostic?.(JSON.stringify({event:'AUDIT_CRASH_BOUNDARY', childPid:child.pid,
      mode:args[0] === 'recover' ? 'RECOVERY' : 'ACK', runId:boundary.runId}));
  } catch (cause) { error = cause; }
  // A boundary timeout still requires bounded process and pipe closure. Merely
  // issuing kill(), or receiving exit while stderr remains open, is insufficient.
  try {
    closure = await waitChildClose(child, observation, {timeoutMs:closeMs,
      request:() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            if (!child.kill('SIGKILL')) error ??= failure('AUDIT_CRASH_KILL_REJECTED', 'Child did not accept the abrupt-termination request.');
          } catch (cause) { error ??= cause; }
        }
      }, forceClose:() => forceProcessTree(child)});
  } catch (cause) {
    if (error) {
      (error.cleanupErrors ??= []).push(cause);
      error.cleanupError ??= cause;
    }
    else error = cause;
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
  }
  if (!error && closure.code === 0 && closure.signal === null) {
    error = failure('AUDIT_CRASH_NORMAL_EXIT', 'Expected an actual abrupt termination, received a successful exit.');
  }
  let checkpointDirectory = directory;
  if (observation.result) {
    try { await removeOwnedFixture(directory); checkpointDirectory = null; }
    catch (cause) {
      if (error) {
        (error.cleanupErrors ??= []).push(cause);
        error.cleanupError ??= cause;
      } else error = cause;
    }
  }
  try {
    t.diagnostic?.(JSON.stringify({event:'AUDIT_CRASH_CLOSE', childPid:child.pid,
      closed:Boolean(observation.result), code:closure?.code ?? null, signal:closure?.signal ?? null,
      errorCode:error?.code ?? null, errorName:error?.name ?? null, errorMessage:error?.message ?? null,
      causeName:error?.cause?.name ?? null,
      checkpointKind:error?.checkpointKind ?? null, checkpointBytes:error?.checkpointBytes ?? null,
      checkpointDirectory}));
  } catch (cause) {
    if (error) error.diagnosticError = cause;
    else error = cause;
  }
  if (error) {
    Object.assign(error, {childPid:child.pid, closure, stderr, checkpointDirectory});
    throw error;
  }
  return {metadata, boundary, closure};
}
