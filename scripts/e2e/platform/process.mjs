import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { observeChildClose } from '../../../src/runtime/child-close.js';

// Failure containment only. Callers must retain FAIL after forced cleanup.
export async function forceProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide:true, timeout:5000 });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export function ownedSpawn(args, { cwd, env = process.env, ipc = false } = {}) {
  return spawn(process.execPath, args, { cwd, env, windowsHide:true,
    // One process group per owner permits bounded descendant cleanup on POSIX.
    detached:process.platform !== 'win32',
    stdio:['ignore','pipe','pipe', ...(ipc ? ['ipc'] : [])] });
}

export async function runOwnedNode(args, { cwd, env, timeoutMs, isComplete = () => false,
  drainMs = 10000, onStdout = () => {}, onStderr = () => {}, onDeadline = () => {} } = {}) {
  const child = ownedSpawn(args, { cwd, env });
  const observation = observeChildClose(child);
  let timer, drainTimer;
  const deadline = new Promise((_, reject) => {
    const expire = reason => {
      try { onDeadline({ reason, pid:child.pid, activeResources:process.getActiveResourcesInfo() }); } catch {}
      reject(Object.assign(new Error(`E2E runner resource closure failed: ${reason}`), { code:'E2E_RUNNER_DEADLINE' }));
    };
    timer = setTimeout(() => expire('execution deadline'), timeoutMs);
    child.stdout.on('data', chunk => {
      onStdout(chunk);
      if (!drainTimer && isComplete()) drainTimer = setTimeout(() => expire('profiles completed but runner did not close'), drainMs);
    });
    child.stderr.on('data', onStderr);
    child.once('error', reject);
  });
  try {
    const result = await Promise.race([observation.promise, deadline]);
    return { ...result, forced:false };
  } catch (error) {
    try { await forceProcessTree(child); } catch (cleanupError) {
      error.cleanupError = cleanupError.message;
      try { child.kill('SIGKILL'); } catch {}
    }
    // Inherited pipes can outlive an exited parent, even after a failed tree kill.
    child.stdout.destroy(); child.stderr.destroy();
    child.unref();
    throw error;
  } finally { clearTimeout(timer); clearTimeout(drainTimer); }
}
