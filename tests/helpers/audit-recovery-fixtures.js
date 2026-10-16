import assert from 'node:assert/strict';
import path from 'node:path';
import {ArtifactStore} from '../../src/evidence/artifact-store.js';
import {setupAudit} from './audit-fixtures.js';

export function fixture(t, hooks = {}) {
  const f = setupAudit(t, { reviewVerdicts:['SATISFIED'], reviewBody:() => 'Original review reasoning.', ...hooks });
  // Match the real adapter's rawText contract; the generic fixture omits it.
  const submit = f.options.webSession.submitTurn;
  f.options.webSession.submitTurn = async function(input) {
    const handle = await submit.call(this, input);
    return { ...handle, completion:handle.completion.then(response => ({ ...response,
      rawText:`${response.body}\n<controller_packet>\n${response.packetText}\n</controller_packet>` })) };
  };
  return f;
}
export async function reopen(f) {
  f.options.artifactStore = new ArtifactStore(path.join(f.directory, 'artifacts'));
  await f.reopen();
}
export function stopAfterAck(f, turn = 1) {
  const update = f.service.update.bind(f.service);
  let stopped;
  f.service.update = (runId, changes) => {
    const saved = update(runId, changes);
    if (!stopped && f.acknowledgements.length === turn && changes.webDeliveryReceipts?.at(-1)?.state === 'ACKNOWLEDGED') {
      stopped = saved;
      throw new Error('Injected stop after the settlement commit');
    }
    return saved;
  };
  return () => stopped;
}
export function assertRecovered(f, run, receipt) {
  const request = run.requests.find(item => item.requestId === receipt.deliveryId);
  const artifacts = run.reviewArtifacts.filter(item => item.requestId === receipt.deliveryId);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].packetRef.sha256, receipt.packetRef.sha256);
  assert.equal(artifacts[0].responseRef.sha256, receipt.responseRef.sha256);
  assert.equal(run.messages.filter(item => item.messageId === receipt.deliveryId).length, 1);
  assert.equal(request.status, 'PROCESSED');
  assert.ok(request.reportRef);
  for (const ref of [receipt.responseRef, receipt.packetRef, artifacts[0].contentRef, request.reportRef]) {
    f.options.artifactStore.verify(ref.sha256);
  }
  const packet = JSON.parse(f.options.artifactStore.read(receipt.packetRef.sha256));
  const report = JSON.parse(f.options.artifactStore.read(request.reportRef.sha256));
  for (const key of ['runId', 'requestId', 'candidateId']) assert.equal(report[key], packet[key]);
  assert.equal(run.conversationBindings.find(item => item.role === receipt.role).activeDeliveryId, null);
  assert.equal(run.reviews.length, 0, 'Local recovery cannot create aggregate review authority');
  assert.ok(run.application == null);
  assert.equal(run.stage, 'RECOVERY_REQUIRED');
}
