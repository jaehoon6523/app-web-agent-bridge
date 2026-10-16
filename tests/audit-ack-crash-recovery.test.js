import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ArtifactStore} from '../src/evidence/artifact-store.js';
import {CodeChangeService} from '../src/orchestration/code-change-service.js';
import {assertRecovered} from './helpers/audit-recovery-fixtures.js';
import {killAtBoundary} from './helpers/audit-crash-checkpoint.js';

for (const recoveryCrash of [false, true]) {
  test(`T${recoveryCrash ? 3 : 1} crash: SIGKILL ${recoveryCrash ? 'again during local recovery' : 'immediately after ACK commit'}`, async t => {
    const {metadata, boundary} = await killAtBoundary(t);
    let service;
    t.after(async () => { await service?.close(); fs.rmSync(metadata.directory, {recursive:true, force:true}); });
    const receipt = boundary.snapshot.webDeliveryReceipts.at(-1);
    assert.equal(receipt.state, 'ACKNOWLEDGED');
    assert.equal(boundary.snapshot.reviewArtifacts.length, 0);
    assert.deepEqual(boundary.acknowledgements, [receipt.deliveryId]);
    let recoveredSnapshot;
    if (recoveryCrash) recoveredSnapshot = (await killAtBoundary(t, ['recover', JSON.stringify(metadata)])).boundary.snapshot;
    let sends = 0;
    const options = { filename:metadata.filename, project:metadata.project,
      artifactStore:new ArtifactStore(path.join(metadata.directory, 'artifacts')),
      webSession:{ submitTurn() { sends++; throw new Error('Recovery must not send'); } }, codex:{},
    };
    service = new CodeChangeService(options);
    const run = service.get(boundary.runId);
    assertRecovered({options}, run, receipt);
    assert.equal(run.reviewRecovery.status, 'READY');
    assert.equal(sends, 0);
    if (recoveredSnapshot) assert.deepEqual(run.reviewArtifacts, recoveredSnapshot.reviewArtifacts);
  });
}


test('a structurally redacted response survives real SIGKILL immediately after ACK', async t => {
  const {metadata, boundary} = await killAtBoundary(t, ['--sensitive-response']);
  let service;
  t.after(async () => {await service?.close();fs.rmSync(metadata.directory,{recursive:true,force:true});});
  let sends = 0;
  const options = {filename:metadata.filename,project:metadata.project,
    artifactStore:new ArtifactStore(path.join(metadata.directory,'artifacts')),
    webSession:{submitTurn(){sends++;throw new Error('Recovery must not send');}},codex:{}};
  const receipt = boundary.snapshot.webDeliveryReceipts[0];
  assert.equal(receipt.state, 'ACKNOWLEDGED');assert.equal(boundary.snapshot.reviewArtifacts.length, 0);
  service = new CodeChangeService(options);
  const recovered = service.get(boundary.runId);
  assert.equal(recovered.reviewRecovery.status, 'READY', JSON.stringify(recovered.reviewRecovery.failures));
  assertRecovered({options}, recovered, receipt);
  const report = JSON.parse(options.artifactStore.read(recovered.requests[0].reportRef.sha256));
  assert.equal(report.assessments[0].verdict, 'UNDETERMINED');
  assert.equal(report.assessments[0].missingInformation, 'password=[REDACTED]');
  assert.equal(sends, 0);assert.deepEqual(boundary.acknowledgements, [receipt.deliveryId]);
});

test('fenced private wire survives real SIGKILL immediately after ACK', async t => {
  const {metadata,boundary} = await killAtBoundary(t, ['--sensitive-response','--fenced-response']);
  let service;
  t.after(async () => {await service?.close();fs.rmSync(metadata.directory,{recursive:true,force:true});});
  const options = {filename:metadata.filename,project:metadata.project,
    artifactStore:new ArtifactStore(path.join(metadata.directory,'artifacts')),
    webSession:{submitTurn(){throw new Error('Recovery must not send');}},codex:{}};
  const receipt = boundary.snapshot.webDeliveryReceipts[0];
  const original = options.artifactStore.readPrivateResponse(receipt.privateResponseRef);
  assert.equal(original.body, '```text\npassword=\n```');
  service = new CodeChangeService(options);
  const run = service.get(boundary.runId);
  assert.equal(run.reviewRecovery.status, 'READY', JSON.stringify(run.reviewRecovery.failures));
  assertRecovered({options}, run, receipt);
  assert.deepEqual(options.artifactStore.readPrivateResponse(receipt.privateResponseRef), original);
  assert.deepEqual(boundary.acknowledgements, [receipt.deliveryId]);
});
