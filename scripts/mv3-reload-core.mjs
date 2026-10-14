// Pure classification and child-process supervision for the independent MV3 experiment.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);
export const MATRIX_CASES = Object.freeze([
  { id: 'A', precondition: 'fresh', unsafeDebugging: false },
  { id: 'B', precondition: 'fresh', unsafeDebugging: true },
  { id: 'C', precondition: 'stop-start-navigation', unsafeDebugging: false },
  { id: 'D', precondition: 'stop-start-navigation', unsafeDebugging: true },
]);

export function assessReload(observation, windowCompleted) {
  const popup = observation.popupAfter ?? {};
  const recovered = popup.popupAccessible === true && popup.sentinelPreserved === true &&
    popup.backgroundResponded === true;
  const functionalRecovery = recovered ? 'PASS' : windowCompleted ? 'FAIL' : 'UNVERIFIED';
  const events = observation.workerEventsAfterReload ?? [];
  const registrations = observation.registrationEventsAfterReload ?? [];
  const boundaries = [
    ...events.filter(e => e.runningStatus === 'stopped'),
    ...registrations.filter(e => e.isDeleted === true),
  ];
  const runningAfter = boundaries.some(b => events.some(e => e.sequence > b.sequence && e.runningStatus === 'running'));
  const changed = observation.beforeReloadWorkerInstance != null && popup.instanceId != null &&
    observation.beforeReloadWorkerInstance !== popup.instanceId;
  const reloadBoundaryEvidence = changed && runningAfter ? 'CONFIRMED' :
    (boundaries.length || changed) ? 'PARTIAL' : 'NOT_OBSERVED';
  const reloadResult = functionalRecovery === 'FAIL' ? 'FAIL' :
    functionalRecovery === 'PASS' && reloadBoundaryEvidence === 'CONFIRMED' ? 'PASS' : 'UNVERIFIED';
  return { functionalRecovery, reloadBoundaryEvidence, reloadResult,
    boundaryObserved: boundaries.length > 0, runningAfterBoundary: runningAfter, workerInstanceChanged: changed };
}

export function recordCleanup(trial, cleanup) {
  // Cleanup never mutates actual experiment observations, classification, or execution.
  return { ...trial, cleanup: { ...cleanup } };
}
export function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}
export function readSnapshot(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
// Unlike Promise.race with an independent sleep(), this never leaves a deadline timer
// keeping a successfully completed supervisor alive for the full trial budget.
export function wait(promise, ms, fallback) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

async function profilePids(profile) {
  // Query actual browser processes by the unique per-case --user-data-dir, not just node parent PID.
  if (process.platform === 'win32') {
    const escaped = profile.replaceAll("'", "''");
    const command = `$needle='${escaped}'; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($needle) } | Select-Object -ExpandProperty ProcessId) -join ','`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: 4000, windowsHide: true, maxBuffer: 64 * 1024 });
    return stdout.trim().split(',').filter(Boolean).map(Number).filter(Number.isInteger);
  }
  if (process.platform === 'linux') {
    const pids = [];
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const argv = fs.readFileSync(`/proc/${entry}/cmdline`).toString('utf8');
        if (argv.includes(`--user-data-dir=${profile}`)) pids.push(Number(entry));
      } catch { /* process exited */ }
    }
    return pids;
  }
  return null; // Other OS: refuse to claim confirmed cleanup.
}

async function treeKill(pid) {
  if (!Number.isInteger(pid) || pid < 1) return { attempted: false, error: 'INVALID_PID' };
  try {
    if (process.platform === 'win32') {
      // /T includes descendants, /F is required for hung chromium processes.
      const { stdout, stderr } = await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'],
        { timeout: 5000, windowsHide: true });
      return { attempted: true, output: `${stdout}\n${stderr}`.slice(-1000) };
    }
    process.kill(-pid, 'SIGKILL'); // Child was started as a dedicated process group.
    return { attempted: true };
  } catch (error) { return { attempted: true, error: error.message }; }
}

async function killPid(pid) {
  try {
    if (process.platform === 'win32') await execFileAsync('taskkill.exe', ['/PID', String(pid), '/F'],
      { timeout: 3500, windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch { /* Verify actual survivors after attempt. */ }
}

export async function superviseTrial({ command, args, env = process.env, cwd = process.cwd(),
  snapshotFile, profile, scratch, limitMs = 35_000, stdoutLimit = 3000 }) {
  const start = Date.now();
  const child = spawn(command, args, { cwd, env, detached: true, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', spawnError = null;
  const append = chunk => { output = (output + chunk.toString('utf8')).slice(-stdoutLimit); };
  child.stdout?.on('data', append); child.stderr?.on('data', append);
  child.on('error', error => { spawnError = error.message; });
  const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let outcome = await wait(exited, limitMs, null);
  const timedOut = outcome === null;
  let terminate = null;
  if (timedOut) {
    terminate = await treeKill(child.pid);
    outcome = await wait(exited, 5000, null);
  }
  let survivors = null, profileQueryError = null;
  try { survivors = await profilePids(profile); }
  catch (error) { profileQueryError = error.message; }
  if (Array.isArray(survivors) && survivors.length) {
    for (const pid of survivors) await killPid(pid);
    try { survivors = await profilePids(profile); }
    catch (error) { profileQueryError = error.message; survivors = null; }
  }
  const childTerminationConfirmed = outcome !== null;
  const browserTerminationConfirmed = Array.isArray(survivors) && survivors.length === 0;
  const snapshot = readSnapshot(snapshotFile); // Capture the child's durable observations BEFORE deleting the scratch directory.
  const cleanupStatus = childTerminationConfirmed && browserTerminationConfirmed ? 'PASS' : 'UNCONFIRMED';
  let scratchRemoval = 'SKIPPED';
  let scratchError = null;
  if (cleanupStatus === 'PASS') {
    try { fs.rmSync(scratch, { recursive: true, force: true }); scratchRemoval = 'PASS'; }
    catch (error) { scratchRemoval = 'FAIL'; scratchError = error.message; }
  }
  const original = snapshot ?? {
    id: path.basename(scratch).slice(0, 1), stage: 'LAUNCH', execution: 'INCOMPLETE',
    functionalRecovery: 'UNVERIFIED', reloadBoundaryEvidence: 'NOT_OBSERVED', reloadResult: 'UNVERIFIED',
  };
  const observed = { ...original };
  if (timedOut) {
    if (observed.execution !== 'COMPLETE') observed.execution = 'INCOMPLETE'; // Completed observations survive a cleanup timeout.
    observed.watchdog = { timedOut: true, limitMs, elapsedMs: Date.now() - start };
  } else observed.watchdog = { timedOut: false, limitMs, elapsedMs: Date.now() - start };
  if (spawnError) observed.spawnError = spawnError;
  observed.childExit = outcome;
  observed.childExecution = {
    status: outcome === null ? 'UNCONFIRMED' :
      timedOut || spawnError || outcome.code !== 0 || outcome.signal !== null ? 'FAIL' : 'PASS',
    reason: outcome === null ? 'NO_CLOSE_OBSERVED' :
      timedOut ? 'WATCHDOG_TIMEOUT' :
      spawnError ? 'SPAWN_ERROR' :
      outcome.code !== 0 ? `EXIT_CODE_${outcome.code}` :
      outcome.signal !== null ? `SIGNAL_${outcome.signal}` : null,
  };
  observed.tail = output;
  const cleanup = { status: scratchRemoval === 'FAIL' || observed.childCleanup?.status === 'FAIL' ? 'FAIL' :
    cleanupStatus === 'PASS' && timedOut ? 'FORCED_TERMINATED' : cleanupStatus, childTerminationConfirmed,
    browserTerminationConfirmed, survivorPids: survivors, profileQueryError, terminate, scratchRemoval, scratchError,
    childReported: observed.childCleanup ?? null,
    profileRetained: scratchRemoval !== 'PASS' ? scratch : null };
  return recordCleanup(observed, cleanup);
}

// Parent-level receipt verdict is independent from functional recovery and cleanup.
// In particular, childExit=7 is an execution failure even when the last durable
// observation was COMPLETE + reloadResult PASS and cleanup later succeeded.
export function assessMatrix(cases, expected = MATRIX_CASES.length) {
  const execution = cases.length === expected && cases.every(x => x.execution === 'COMPLETE')
    ? 'COMPLETE' : 'INCOMPLETE';
  const cleanupStatus = cases.every(x => x.cleanup?.status === 'PASS') ? 'PASS' :
    cases.some(x => x.cleanup?.status === 'FAIL') ? 'FAIL' :
      cases.some(x => x.cleanup?.status === 'UNCONFIRMED') ? 'UNCONFIRMED' : 'FORCED_TERMINATED';
  const childExecutionStatus = cases.length === expected && cases.every(x => x.childExecution?.status === 'PASS')
    ? 'PASS' : cases.some(x => x.childExecution?.status === 'FAIL') ? 'FAIL' : 'UNCONFIRMED';
  const exitCode = cleanupStatus !== 'PASS' ? 3 : childExecutionStatus === 'FAIL' ? 4 :
    execution !== 'COMPLETE' || childExecutionStatus !== 'PASS' ? 2 : 0;
  return { execution, cleanupStatus, childExecutionStatus, exitCode };
}
