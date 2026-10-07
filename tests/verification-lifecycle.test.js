import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeVerification } from "../src/evidence/candidate-evidence.js";
import { ArtifactStore } from "../src/evidence/artifact-store.js";
import { setupAudit } from "./helpers/audit-fixtures.js";
import { inheritedPipeScript, waitForPipeHolder, assertPipeHolderAlive, stopPipeHolder } from './helpers/inherited-pipes-fixture.js';

test("verification timeout remains bounded when an exited parent leaves inherited descendant pipes", {timeout:10000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-verification-close-"));
  const pidFile = path.join(root, "descendant.pid");
  const markerFile=path.join(root,'heartbeat');
  t.after(async () => {
    await stopPipeHolder(pidFile);
    fs.rmSync(root, {recursive:true, force:true});
  });
  const script = inheritedPipeScript({pidFile,markerFile});
  const started = performance.now();
  const pending = executeVerification({
    // Candidate identity is held constant here. This is the actual process/pipe
    // boundary, not evidence that the Git capture path or live provider ran.
    workspace:{root, assertCandidate() {}}, capture:{}, candidateId:"candidate",
    artifactStore:new ArtifactStore(path.join(root, "artifacts")),
    verification:{verificationId:"inherited-pipes",executable:process.execPath,args:["-e",script],
      cwd:".",timeoutMs:1500,environmentId:"controlled-node",resultFiles:[]},
  });
  // A bounded observation controls the test's own descendant cleanup even on
  // the old implementation, whose executeVerification promise stays pending.
  let deadline;
  const outcome = await Promise.race([pending.then(result => ({result})),
    new Promise(resolve => {deadline=setTimeout(() => resolve({pending:true}), 4000);})]);
  clearTimeout(deadline);
  try {
    await waitForPipeHolder({pidFile,markerFile});
    assert.equal(outcome.result?.record.exitCode,0,'direct parent must have exited normally');
    const heartbeat=await assertPipeHolderAlive(markerFile);
    t.diagnostic(JSON.stringify({node:process.version,platform:process.platform,heartbeat}));
    assert.equal(outcome.pending, undefined, "configured timeout must not wait indefinitely for descendant stdio");
    assert.equal(outcome.result.record.terminationConfirmed, false);
    assert.match(outcome.result.record.error, /closure deadline/);
    assert.ok(performance.now() - started < 4000);
  } finally {
    await stopPipeHolder(pidFile);
    await pending;
  }
});

test("unconfirmed verification closure persists recovery and never dispatches an audit or application", {timeout:10000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-verification-recovery-"));
  const pidFile = path.join(root, "descendant.pid");
  const markerFile=path.join(root,'heartbeat');
  t.after(async () => {
    await stopPipeHolder(pidFile);
    fs.rmSync(root, {recursive:true, force:true});
  });
  const script = inheritedPipeScript({pidFile,markerFile});
  const f = setupAudit(t, {configure(project) {
    project.verifications = [{verificationId:"pipes",executable:process.execPath,args:["-e",script],
      cwd:".",timeoutMs:1500,purpose:"lifetime",environmentId:"controlled-node",resultFiles:[]}];
  }, review() {throw new Error("uncertain verification must not reach reviewer");}});
  const run = await f.run();
  assert.equal(run.stage, "RECOVERY_REQUIRED");
  assert.equal(f.reviews(), 0);
  assert.equal(run.application, null);
  const execution = run.evidence.find(item => item.kind === "EXECUTION");
  assert.equal(execution.result.exitCode,0);
  await waitForPipeHolder({pidFile,markerFile});
  const heartbeat=await assertPipeHolderAlive(markerFile);
  t.diagnostic(JSON.stringify({node:process.version,platform:process.platform,heartbeat}));
  assert.equal(execution.result.terminationConfirmed, false);
  assert.equal(execution.result.timedOut, true);
  await f.reopen();
  assert.equal(f.service.get(run.runId).stage, "RECOVERY_REQUIRED");
  assert.equal(f.reviews(), 0);
});
