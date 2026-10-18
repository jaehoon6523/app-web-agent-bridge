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

// runtime.reload() treats a command-line extension as unpacked. Prepare only
// the disposable browser profile, and verify Chrome's effective setting.
export async function enableExtensionDeveloperMode(context) {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions/', { waitUntil: 'domcontentloaded', timeout: 3000 });
    const change = await page.evaluate(async () => {
      const observation = {};
      let timer;
      try {
        await Promise.race([
          (async () => {
            observation.before = await chrome.developerPrivate.getProfileConfiguration();
            if (observation.before.inDeveloperMode !== true) {
              if (observation.before.isDeveloperModeControlledByPolicy)
                throw new Error('Extension developer mode is disabled by policy');
              await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
            }
            observation.after = await chrome.developerPrivate.getProfileConfiguration();
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Extension developer mode configuration timed out')), 4000);
          }),
        ]);
      } catch (error) { observation.error = error.message; }
      finally { clearTimeout(timer); }
      return observation;
    });
    if (change.after?.inDeveloperMode !== true) {
      throw Object.assign(new Error(change.error ?? 'Extension developer mode ON was not confirmed'),
        { developerModeChange: change });
    }
    return change;
  } finally { await page.close(); }
}

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

async function profilePids(profile, ownershipRoots = []) {
  // Include descendants even if they omit --user-data-dir or their parent has
  // already exited. Roots come only from this launch and its durable snapshot.
  if (process.platform === 'win32') {
    const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: 4000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const data = JSON.parse(stdout.trim());
    const processes = Array.isArray(data) ? data : data ? [data] : [];
    const escaped = (`--user-data-dir=${profile}`).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const marker = new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, 'u');
    const owned = new Set(ownershipRoots);
    for (const item of processes) if (marker.test((item.CommandLine ?? '').replaceAll('"', ''))) owned.add(item.ProcessId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of processes) if (!owned.has(item.ProcessId) && owned.has(item.ParentProcessId)) {
        owned.add(item.ProcessId); changed = true;
      }
    }
    return processes.filter(item => owned.has(item.ProcessId)).map(item => item.ProcessId);
  }
  if (process.platform === 'linux') {
    const pids = [];
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const argv = fs.readFileSync(`/proc/${entry}/cmdline`).toString('utf8');
        if (fs.readlinkSync(`/proc/${entry}/ns/pid`) === fs.readlinkSync('/proc/self/ns/pid')) {
          const status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
          const ids = status.match(/^NSpid:\s+(.+)$/mu)?.[1].trim().split(/\s+/u);
          const groups = status.match(/^NSpgid:\s+(.+)$/mu)?.[1].trim().split(/\s+/u);
          const alive = !/^State:\s+Z\b/mu.test(status);
          if (alive && ids?.length && (argv.split('\0').includes(`--user-data-dir=${profile}`)
            || ownershipRoots.includes(Number(groups?.at(-1))))) pids.push(Number(ids.at(-1)));
        }
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
  snapshotFile, profile, scratch, limitMs = 35_000, stdoutLimit = 3000,
  stdoutFile, expectedRunId, expectedScope,
  removeScratch = directory => fs.rmSync(directory, { recursive: true, force: true }) }) {
  const start = Date.now();
  // Never let a diagnostic cleanup erase an unrelated directory/profile.
  const contained = file => { const relative = path.relative(path.resolve(scratch), path.resolve(file));
    return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
  if (!contained(profile) || !contained(snapshotFile)) throw Error('OWNED_SCRATCH_PATH_REQUIRED');
  if (stdoutFile) { fs.mkdirSync(path.dirname(stdoutFile), { recursive: true }); fs.writeFileSync(stdoutFile, ''); }
  const child = spawn(command, args, { cwd, env, detached: true, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', spawnError = null;
  const append = chunk => { output = (output + chunk.toString('utf8')).slice(-stdoutLimit);
    if (stdoutFile) fs.appendFileSync(stdoutFile, chunk); };
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
  const rawSnapshot = readSnapshot(snapshotFile); // Preserve before removing owned resources.
  const snapshotReceiptError = !rawSnapshot ? 'RESULT_NOT_CREATED' :
    expectedRunId && rawSnapshot.verificationRunId !== expectedRunId ? 'RESULT_RUN_MISMATCH' :
      expectedScope && rawSnapshot.scope !== expectedScope ? 'RESULT_SCOPE_MISMATCH' : null;
  const ownershipRoots = [child.pid, !snapshotReceiptError && expectedRunId ? rawSnapshot.browserProcessPid : null].filter(Number.isInteger);
  let survivors = null, profileQueryError = null;
  try { survivors = await profilePids(profile, ownershipRoots); }
  catch (error) { profileQueryError = error.message; }
  const browserForceRequired = Array.isArray(survivors) && survivors.length > 0;
  if (browserForceRequired) {
    const verificationDeadline = Date.now() + 2000;
    do {
      // A delivered kill signal is not an observed exit. Allow bounded time
      // for actual disappearance, and retain ancestry roots of orphaned peers.
      for (const pid of survivors) {
        if (!ownershipRoots.includes(pid)) ownershipRoots.push(pid);
        await killPid(pid);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      try { survivors = await profilePids(profile, ownershipRoots); }
      catch (error) { profileQueryError = error.message; survivors = null; }
    } while (Array.isArray(survivors) && survivors.length > 0 && Date.now() < verificationDeadline);
  }
  const childTerminationConfirmed = outcome !== null;
  const browserTerminationConfirmed = Array.isArray(survivors) && survivors.length === 0;
  const snapshot = snapshotReceiptError ? null : rawSnapshot;
  const cleanupStatus = childTerminationConfirmed && browserTerminationConfirmed ? 'PASS' : 'UNCONFIRMED';
  let scratchRemoval = 'SKIPPED';
  let scratchError = null;
  if (cleanupStatus === 'PASS') {
    try { removeScratch(scratch); scratchRemoval = 'PASS'; }
    catch (error) { scratchRemoval = 'FAIL'; scratchError = error.message; }
  }
  const original = snapshot ?? {
    id: path.basename(scratch).slice(0, 1), stage: 'LAUNCH', execution: 'INCOMPLETE',
    functionalRecovery: 'UNVERIFIED', reloadBoundaryEvidence: 'NOT_OBSERVED', reloadResult: 'UNVERIFIED',
  };
  const observed = { ...original };
  observed.snapshotReceiptError = snapshotReceiptError;
  if (snapshotReceiptError && rawSnapshot) observed.rejectedSnapshot = rawSnapshot;
  observed.supervision = { startedAt: new Date(start).toISOString(), finishedAt: new Date().toISOString(),
    pid: child.pid ?? null, command, args, stdoutFile: stdoutFile ?? null };
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
    cleanupStatus === 'PASS' && (timedOut || browserForceRequired) ? 'FORCED_TERMINATED' : cleanupStatus, childTerminationConfirmed,
    browserForceRequired, ownershipRoots,
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
