import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { executeVerification } from "../src/evidence/candidate-evidence.js";
import { ArtifactStore } from "../src/evidence/artifact-store.js";
import { setupAudit } from "./helpers/audit-fixtures.js";
import { observeChildClose, waitChildClose } from '../src/runtime/child-close.js';
import { inheritedPipeScript, waitForPipeHolder, assertPipeHolderAlive, stopPipeHolder, removeOwnedPipeFixture } from './helpers/inherited-pipes-fixture.js';

function inheritedVerification(t, startupDelayMs = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-verification-close-"));
  const pidFile = path.join(root, "descendant.pid");
  const markerFile=path.join(root,'heartbeat');
  const source = `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${startupDelayMs});\n`
    + inheritedPipeScript({pidFile,markerFile,stdinProtocol:true});
  const args = ['-e',source], spawn = childProcess.spawn;
  let child, observation, startedCwd, dispatched = false;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await stopPipeHolder(pidFile);
    if (observation) await waitChildClose(child,observation,{timeoutMs:5000});
    await removeOwnedPipeFixture(root);
  });
  return {root,args,markerFile,get child() {return child;},
    async start(cwd) {
      startedCwd=cwd;
      child=spawn(process.execPath,args,{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
      observation=observeChildClose(child);
      await waitForPipeHolder({pidFile,markerFile});
      assert.equal(child.exitCode,null,'fixture parent must wait for stdin EOF');
      assert.equal(observation.result,undefined);
      assert.equal(child.stdout.closed,false); assert.equal(child.stderr.closed,false);
    },
    async run(action) {
      // Only process startup is controlled; the child, pipes and verification deadline are real.
      const replacement=t.mock.method(childProcess,'spawn',(executable,actualArgs,options) => {
        if (executable !== process.execPath || actualArgs?.[1] !== source) return spawn(executable,actualArgs,options);
        assert.ok(child && observation,'prepare the owned child before verification dispatch');
        assert.equal(dispatched,false,'verification must dispatch exactly once');
        assert.deepEqual(actualArgs,args);
        assert.equal(options.cwd,startedCwd,'the child must run in the actual candidate cwd');
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

test("verification timeout remains bounded after slow startup when an exited parent leaves inherited descendant pipes", {timeout:10000}, async t => {
  const fixture=inheritedVerification(t,1700);
  await fixture.start(fixture.root);
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
      parentExitCode:fixture.child.exitCode,startupDelayMs:1700,heartbeat}));
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
