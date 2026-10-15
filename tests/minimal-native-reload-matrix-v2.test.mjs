import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assessReload, assessMatrix, recordCleanup, superviseTrial } from '../scripts/mv3-reload-core.mjs';

test('watchdog kills a real hung child after the deadline and verifies its exit', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3-watchdog-test-'));
  const start = Date.now();
  const trial = await superviseTrial({
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
    snapshotFile: path.join(scratch, 'nonexistent.json'), profile: path.join(scratch, 'profile'),
    scratch, limitMs: 180,
  });
  assert.equal(trial.watchdog.timedOut, true);
  assert.equal(trial.execution, 'INCOMPLETE');
  assert.equal(trial.cleanup.childTerminationConfirmed, true);
  if (process.platform === 'win32' || process.platform === 'linux') {
    assert.equal(trial.cleanup.browserTerminationConfirmed, true);
    assert.equal(trial.cleanup.status, 'FORCED_TERMINATED');
  }
  assert.ok(Date.now() - start < 15_000, 'Parent watchdog did not return within cleanup budget');
});

test('functional recovery PASS without CDP reload boundary is not a reload FAIL', () => {
  const observed = assessReload({
    popupAfter: { popupAccessible: true, sentinelPreserved: true, backgroundResponded: true, instanceId: 'new' },
    beforeReloadWorkerInstance: 'old', workerEventsAfterReload: [], registrationEventsAfterReload: [],
  }, true);
  assert.equal(observed.functionalRecovery, 'PASS');
  assert.equal(observed.reloadBoundaryEvidence, 'PARTIAL');
  assert.equal(observed.reloadResult, 'UNVERIFIED');
});

test('a complete observation of failed popup recovery is a functional FAIL', () => {
  const observed = assessReload({ popupAfter: { popupAccessible: false }, beforeReloadWorkerInstance: 'old' }, true);
  assert.equal(observed.functionalRecovery, 'FAIL');
  assert.equal(observed.reloadResult, 'FAIL');
  const incomplete = assessReload({ popupAfter: { popupAccessible: false } }, false);
  assert.equal(incomplete.functionalRecovery, 'UNVERIFIED');
});

test('CDP stop then running plus new instance and recovered popup confirms reload', () => {
  const observed = assessReload({
    popupAfter: { popupAccessible: true, sentinelPreserved: true, backgroundResponded: true, instanceId: 'new' },
    beforeReloadWorkerInstance: 'old',
    workerEventsAfterReload: [{ sequence: 1, runningStatus: 'stopped' }, { sequence: 3, runningStatus: 'running' }],
    registrationEventsAfterReload: [{ sequence: 2, isDeleted: true }],
  }, true);
  assert.equal(observed.functionalRecovery, 'PASS');
  assert.equal(observed.reloadBoundaryEvidence, 'CONFIRMED');
  assert.equal(observed.reloadResult, 'PASS');
});

test('cleanup failure never overwrites a previously proven successful reload', () => {
  const before = { execution: 'COMPLETE', functionalRecovery: 'PASS',
    reloadBoundaryEvidence: 'CONFIRMED', reloadResult: 'PASS' };
  const after = recordCleanup(before, { status: 'FAIL', reason: 'rm denied' });
  assert.equal(after.execution, 'COMPLETE');
  assert.equal(after.functionalRecovery, 'PASS');
  assert.equal(after.reloadBoundaryEvidence, 'CONFIRMED');
  assert.equal(after.reloadResult, 'PASS');
  assert.equal(after.cleanup.status, 'FAIL');
});

test('a child hung during cleanup retains COMPLETE and reload PASS in durable snapshot', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3-cleanup-watchdog-'));
  const snapshotFile = path.join(scratch, 'observation.json');
  // The subprocess first durably records a completed experiment, then hangs during cleanup.
  const program = `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({id:'A',stage:'DONE',execution:'COMPLETE',functionalRecovery:'PASS',reloadBoundaryEvidence:'CONFIRMED',reloadResult:'PASS'}));setInterval(()=>{},1000)`;
  const trial = await superviseTrial({ command: process.execPath,
    args: ['-e', program, snapshotFile], snapshotFile, profile: path.join(scratch, 'profile'),
    // This oracle concerns durable DONE surviving cleanup, not Node startup
    // completing within 250 ms. Keep the real child/write/watchdog assertions;
    // allow a bounded startup budget. The 180 ms deadline oracle is separate.
    scratch, limitMs: 2000 });
  assert.equal(trial.watchdog.timedOut, true);
  assert.equal(trial.execution, 'COMPLETE');
  assert.equal(trial.functionalRecovery, 'PASS');
  assert.equal(trial.reloadResult, 'PASS');
  assert.equal(trial.cleanup.status, 'FORCED_TERMINATED');
});

test('watchdog terminates a running descendant verified by PID and advancing heartbeat', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3-tree-watchdog-'));
  const signals = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3-tree-heartbeat-'));
  const marker = path.join(signals, 'heartbeat.json');
  const parentMarker = path.join(signals, 'parent.json');
  const profile = path.join(scratch, 'profile');
  // Two real Node launches must become observable before the lifecycle oracle
  // can begin. Keep startup readiness separate from the 3.5 s watchdog phase;
  // never treat a child that failed to start as a demonstrated descendant kill.
  const readinessBudgetMs = 10_000;
  const descendantCode = `const fs=require('node:fs');const marker=${JSON.stringify(marker)};let tick=0;function beat(){fs.writeFileSync(marker,JSON.stringify({pid:process.pid,ppid:process.ppid,tick:++tick,argv:process.argv}));}beat();setInterval(beat,60);`;
  // -- is required; without it Node interprets --user-data-dir as a Node CLI option and exits 9.
  const parentCode = `const fs=require('node:fs');const cp=require('node:child_process');fs.writeFileSync(${JSON.stringify(parentMarker)},JSON.stringify({pid:process.pid}));cp.spawn(process.execPath,['-e',${JSON.stringify(descendantCode)},'--',${JSON.stringify(`--user-data-dir=${profile}`)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const ongoing = superviseTrial({ command: process.execPath, args: ['-e', parentCode],
    profile, snapshotFile: path.join(scratch, 'observation.json'), scratch, limitMs: readinessBudgetMs + 3500 });
  let result;
  try {
    const until = Date.now() + readinessBudgetMs;
    let first;
    while (Date.now() < until) {
      try { first = JSON.parse(fs.readFileSync(marker, 'utf8')); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 40)); }
    }
    if (!first) {
      const failedObservation = await ongoing;
      assert.fail('Real descendant PID was not observed: ' + JSON.stringify(failedObservation));
    }
    assert.ok(first.pid > 0 && first.ppid > 0, 'Real descendant PID must be observed before timeout');
    const launchedParent = JSON.parse(fs.readFileSync(parentMarker, 'utf8'));
    assert.equal(first.ppid, launchedParent.pid, 'The running process must descend from the monitored child');
    assert.ok(first.argv.includes(`--user-data-dir=${profile}`), 'Profile marker must be in the live descendant argv');
    await new Promise(resolve => setTimeout(resolve, 200));
    const second = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(second.pid, first.pid);
    assert.ok(second.tick > first.tick, 'Descendant must actually be running before termination');
    result = await ongoing;
    assert.equal(result.watchdog.timedOut, true);
    assert.equal(result.cleanup.childTerminationConfirmed, true);
    if (process.platform === 'win32' || process.platform === 'linux') {
      assert.deepEqual(result.cleanup.survivorPids, []);
      assert.equal(result.cleanup.browserTerminationConfirmed, true);
      assert.equal(result.cleanup.status, 'FORCED_TERMINATED');
    }
    // Check that the observed descendant stopped doing work, not just that a search found no processes.
    const stoppedTick = JSON.parse(fs.readFileSync(marker, 'utf8')).tick;
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).tick, stoppedTick,
      'The originally observed descendant is still producing heartbeats');
  } finally {
    await ongoing;
    fs.rmSync(signals, { recursive: true, force: true });
  }
});

test('nonzero child exit retains PASS observation but parent reports execution failure', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mv3-nonzero-exit-'));
  const snapshotFile = path.join(scratch, 'observation.json');
  const program = `require('node:fs').writeFileSync(process.argv[1],JSON.stringify({id:'A',execution:'COMPLETE',functionalRecovery:'PASS',reloadBoundaryEvidence:'CONFIRMED',reloadResult:'PASS'}));process.exit(7);`;
  const trial = await superviseTrial({ command: process.execPath,
    args: ['-e', program, snapshotFile], snapshotFile, profile: path.join(scratch, 'profile'),
    scratch, limitMs: 3000 });
  assert.equal(trial.execution, 'COMPLETE');
  assert.equal(trial.reloadResult, 'PASS');
  assert.equal(trial.cleanup.status, 'PASS');
  assert.equal(trial.childExit.code, 7);
  assert.equal(trial.childExecution.status, 'FAIL');
  assert.equal(trial.childExecution.reason, 'EXIT_CODE_7');
  const valid = { execution: 'COMPLETE', cleanup: { status: 'PASS' },
    childExecution: { status: 'PASS' }, reloadResult: 'PASS' };
  const receipt = assessMatrix([trial, valid, valid, valid]);
  assert.equal(receipt.execution, 'COMPLETE');
  assert.equal(receipt.cleanupStatus, 'PASS');
  assert.equal(receipt.childExecutionStatus, 'FAIL');
  assert.equal(receipt.exitCode, 4);
  assert.equal(assessMatrix([valid, valid, valid, valid]).exitCode, 0);
});

test('completed child cancels long watchdog timer and lets parent Node exit promptly', () => {
  const importUrl = pathToFileURL(path.resolve('scripts/mv3-reload-core.mjs')).href;
  const code = `import{superviseTrial}from ${JSON.stringify(importUrl)};import fs from'node:fs';import os from'node:os';import path from'node:path';const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'mv3-timer-test-'));const trial=await superviseTrial({command:process.execPath,args:['-e','process.exit(0)'],snapshotFile:path.join(scratch,'missing.json'),profile:path.join(scratch,'profile'),scratch,limitMs:35000});if(trial.childExecution.status!=='PASS'||trial.cleanup.status!=='PASS')throw Error('Unexpected child result');console.log('FINISHED');`;
  const began = Date.now();
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.error, undefined, `A completed supervisor left an active timer: ${run.error?.message}`);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /FINISHED/);
  assert.ok(Date.now() - began < 5000, 'Returned supervisor should not keep Node alive for 35 seconds');
});
