import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
import { executeVerification } from "../src/evidence/candidate-evidence.js";
import { ArtifactStore } from "../src/evidence/artifact-store.js";
import { setupAudit } from "./helpers/audit-fixtures.js";
import { observeChildClose, waitChildClose } from '../src/runtime/child-close.js';
import { inheritedPipeScript, waitForPipeHolder, assertPipeHolderAlive, stopPipeHolder, removeOwnedPipeFixture } from './helpers/inherited-pipes-fixture.js';

test('verification cwd uses filesystem identity when a legacy root spelling is retained', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-alias-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const root = path.join(directory, 'candidate'), alias = path.join(directory, 'candidate alias');
  const cwd = path.join(root, 'source'); fs.mkdirSync(cwd, {recursive:true});
  fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const realpath = fs.realpathSync;
  const retained = t.mock.method(fs, 'realpathSync', (selected, options) =>
    selected === alias ? alias : realpath(selected, options));
  retained.native = realpath.native;
  const result = await executeVerification({workspace:{root:alias, assertCandidate() {}}, capture:{},
    candidateId:'alias-candidate', artifactStore:new ArtifactStore(path.join(directory, 'artifacts')),
    verification:{verificationId:'cwd', executable:process.execPath, args:['-e','process.stdout.write(process.cwd())'],
      cwd:'source', timeoutMs:3000, purpose:'directory boundary', environmentId:'controlled-node', resultFiles:[]}});
  assert.equal(result.record.error, null);
  assert.equal(result.record.exitCode, 0);
  assert.equal(result.record.terminationConfirmed, true);
  assert.equal(fs.realpathSync.native(result.record.stdout), fs.realpathSync.native(cwd));
});

test('verification refuses an aliased cwd outside the candidate before dispatch', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-outside-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const root = path.join(directory, 'candidate'), outside = path.join(directory, 'other');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  const marker = path.join(directory, 'must-not-run');
  const result = await executeVerification({workspace:{root, assertCandidate() {}}, capture:{},
    candidateId:'outside-candidate', artifactStore:new ArtifactStore(path.join(directory, 'artifacts')),
    verification:{verificationId:'cwd', executable:process.execPath,
      args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`], cwd:'outside', timeoutMs:3000,
      purpose:'directory boundary', environmentId:'controlled-node', resultFiles:[]}});
  assert.match(result.record.error, /escapes candidate/u);
  assert.equal(result.record.exitCode, null);
  assert.equal(fs.existsSync(marker), false);
});

function inheritedVerification(t, startupDelayMs = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-verification-close-"));
  const pidFile = path.join(root, "descendant.pid");
  const markerFile=path.join(root,'heartbeat');
  const source = inheritedPipeScript({pidFile,markerFile,stdinProtocol:true});
  const args = ['-e',source], spawn = childProcess.spawn;
  let child, observation, startedCwd, startupElapsedMs, dispatched = false;
  t.after(async () => {
    const deadline = performance.now()+5000;
    const remaining = () => {
      const ms = Math.ceil(deadline-performance.now());
      if (ms <= 0) throw Object.assign(new Error('Inherited fixture cleanup deadline exceeded'), {code:'FIXTURE_CLEANUP_DEADLINE'});
      return ms;
    };
    try {
      if (child) {
        const running = child.exitCode === null && child.signalCode === null;
        const exited = running ? once(child,'exit',{signal:AbortSignal.timeout(remaining())}) : Promise.resolve();
        exited.catch(() => {});
        if (running) child.kill('SIGKILL');
        // A kill request cannot prove the parent has stopped publishing descendant ownership.
        await exited;
        await stopPipeHolder(pidFile,{timeoutMs:remaining()});
        await waitChildClose(child,observation,{timeoutMs:remaining()});
      }
      await removeOwnedPipeFixture(root,{timeoutMs:remaining()});
    } catch (error) {
      // Contain failed fixture observation without converting uncertain closure into PASS.
      child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
      throw error;
    }
  });
  return {root,args,markerFile,get child() {return child;},get startupElapsedMs() {return startupElapsedMs;},
    async start(cwd) {
      const started = performance.now();
      startedCwd=cwd;
      child=spawn(process.execPath,args,{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
      observation=observeChildClose(child);
      await waitForPipeHolder({pidFile,markerFile});
      assert.equal(child.exitCode,null,'fixture parent must wait for stdin EOF');
      assert.equal(observation.result,undefined);
      assert.equal(child.stdout.closed,false); assert.equal(child.stderr.closed,false);
      // Keep controlled setup cost outside the real descendant's readiness budget.
      if (startupDelayMs) await wait(startupDelayMs);
      startupElapsedMs = performance.now()-started;
    },
    async run(action) {
      // Only process startup is controlled; the child, pipes and verification deadline are real.
      const replacement=t.mock.method(childProcess,'spawn',(executable,actualArgs,options) => {
        if (executable !== process.execPath || actualArgs?.[1] !== source) return spawn(executable,actualArgs,options);
        assert.ok(child && observation,'prepare the owned child before verification dispatch');
        assert.equal(dispatched,false,'verification must dispatch exactly once');
        assert.deepEqual(actualArgs,args);
        assert.equal(fs.realpathSync.native(options.cwd),fs.realpathSync.native(startedCwd),
          'the child must run in the actual candidate cwd');
        dispatched=true;
        queueMicrotask(() => child.stdin.end());
        return child;
      });
      syncBuiltinESMExports();
      try {
        const result=await action();
        assert.equal(dispatched,true,'the production verification path must consume the child');
        return result;
      } finally {replacement.mock.restore(); syncBuiltinESMExports();}
    },
  };
}

test('failed fixture readiness still closes its owned parent, descendant and observation pipes', {timeout:10000}, async t => {
  let fixture, descendantPid;
  const failure=Object.assign(new Error('controlled readiness stat failure'),{code:'EIO'});
  await t.test('readiness rejection preserves the failure and runs fixture cleanup', async nested => {
    fixture=inheritedVerification(nested);
    const stat=fs.statSync;
    const injected=nested.mock.method(fs,'statSync',(filename,...args) => {
      const result=stat(filename,...args);
      if (filename === fixture.markerFile && result.size >= 2) {
        descendantPid=Number(fs.readFileSync(path.join(fixture.root,'descendant.pid'),'utf8'));
        throw failure;
      }
      return result;
    });
    try { await assert.rejects(() => fixture.start(fixture.root), error => error === failure); }
    finally { injected.mock.restore(); }
  });
  assert.ok(Number.isInteger(descendantPid) && descendantPid>0);
  assert.equal(fs.existsSync(fixture.root),false);
  assert.ok(fixture.child.exitCode !== null || fixture.child.signalCode !== null);
  assert.equal(fixture.child.stdin.closed,true);
  assert.equal(fixture.child.stdout.closed,true);
  assert.equal(fixture.child.stderr.closed,true);
});

test("verification timeout remains bounded after slow startup when an exited parent leaves inherited descendant pipes", {timeout:10000}, async t => {
  const fixture=inheritedVerification(t,1700);
  await fixture.start(fixture.root);
  assert.ok(fixture.startupElapsedMs >= 1700,'controlled setup delay must remain before verification dispatch');
  const started = performance.now();
  const pending = fixture.run(() => executeVerification({
    // Candidate identity is held constant here. This is the actual process/pipe
    // boundary, not evidence that the Git capture path or live provider ran.
    workspace:{root:fixture.root, assertCandidate() {}}, capture:{}, candidateId:"candidate",
    artifactStore:new ArtifactStore(path.join(fixture.root, "artifacts")),
    verification:{verificationId:"inherited-pipes",executable:process.execPath,args:fixture.args,
      cwd:".",timeoutMs:1500,environmentId:"controlled-node",resultFiles:[]},
  }));
  // A bounded observation controls the test's own descendant cleanup even on
  // the old implementation, whose executeVerification promise stays pending.
  let deadline;
  const outcome = await Promise.race([pending.then(result => ({result})),
    new Promise(resolve => {deadline=setTimeout(() => resolve({pending:true}), 4000);})]);
  clearTimeout(deadline);
  try {
    assert.equal(outcome.result?.record.exitCode,0,'direct parent must have exited normally');
    assert.equal(fixture.child.exitCode,0);
    const heartbeat=await assertPipeHolderAlive(fixture.markerFile);
    t.diagnostic(JSON.stringify({node:process.version,platform:process.platform,parentPid:fixture.child.pid,
      parentExitCode:fixture.child.exitCode,startupDelayMs:1700,startupElapsedMs:fixture.startupElapsedMs,heartbeat}));
    assert.equal(outcome.pending, undefined, "configured timeout must not wait indefinitely for descendant stdio");
    assert.equal(outcome.result.record.terminationConfirmed, false);
    assert.match(outcome.result.record.error, /closure deadline/);
    assert.ok(performance.now() - started < 4000);
  } finally {
    if (fixture.child.exitCode === null) fixture.child.kill('SIGKILL');
    await stopPipeHolder(path.join(fixture.root,'descendant.pid'));
    await pending;
  }
});

test("unconfirmed verification closure persists recovery and never dispatches an audit or application", {timeout:10000}, async t => {
  const fixture=inheritedVerification(t);
  const f = setupAudit(t, {configure(project) {
    project.verifications = [{verificationId:"pipes",executable:process.execPath,args:fixture.args,
      cwd:".",timeoutMs:1500,purpose:"lifetime",environmentId:"controlled-node",resultFiles:[]}];
  }, async worker({workspace}) {
    fs.writeFileSync(path.join(workspace.root,'file.txt'),'revision 1\n');
    await fixture.start(workspace.root);
  }, review() {throw new Error("uncertain verification must not reach reviewer");}});
  const run = await fixture.run(() => f.run());
  assert.equal(run.stage, "RECOVERY_REQUIRED");
  assert.equal(f.reviews(), 0);
  assert.equal(run.application, null);
  const execution = run.evidence.find(item => item.kind === "EXECUTION");
  assert.equal(execution.result.exitCode,0);
  assert.equal(fixture.child.exitCode,0);
  const heartbeat=await assertPipeHolderAlive(fixture.markerFile);
  t.diagnostic(JSON.stringify({node:process.version,platform:process.platform,parentPid:fixture.child.pid,
    parentExitCode:fixture.child.exitCode,heartbeat}));
  assert.equal(execution.result.terminationConfirmed, false);
  assert.equal(execution.result.timedOut, true);
  await f.reopen();
  assert.equal(f.service.get(run.runId).stage, "RECOVERY_REQUIRED");
  assert.equal(f.reviews(), 0);
});
