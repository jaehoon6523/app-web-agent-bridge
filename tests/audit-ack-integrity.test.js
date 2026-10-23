import test from 'node:test';
import assert from 'node:assert/strict';
import {assertionsFor} from './helpers/audit-fixtures.js';
import {reopen, stopAfterAck} from './helpers/audit-recovery-fixtures.js';

import {fixture} from './helpers/ack-recovery-traced-fixture.js';

const corruptions = {
  'receipt-response-hash':(run, store) => { run.webDeliveryReceipts[0].responseRef = store.put('Another response'); },
  'receipt-packet-hash':(run, store) => { run.webDeliveryReceipts[0].packetRef = store.put('{}'); },
  'duplicate-delivery':run => { run.webDeliveryReceipts.push({...run.webDeliveryReceipts[0], sessionId:'other-session'}); },
  'session':run => { run.conversationBindings[0].sessionId = 'other-session'; },
  'binding-run':run => { run.conversationBindings[0].runId = 'other-run'; },
  'receipt-role':run => { run.webDeliveryReceipts[0].role = 'CRITIC'; },
  'request-role':run => { run.requests[0].role = 'CRITIC'; },
  'candidate':run => { run.requests[0].candidateId = 'other-candidate'; },
  'manifest':run => { run.requests[0].auditManifestHash = 'other-manifest'; },
  'phase':run => { run.requests[0].phase = 'ROUND1'; },
  'conversation':run => { run.conversationBindings[0].conversationId = 'other-conversation'; },
  'duplicate-request':run => { run.requests.push({...run.requests[0]}); },
};
for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`T4: ${name} contamination is refused after reopen without a send or authority`, async t => {
    const f = fixture(t), stopped = stopAfterAck(f);
    const initial = await f.run(), changed = structuredClone(initial);
    corrupt(changed, f.options.artifactStore);
    f.service.store.save(changed, initial.version);
    await reopen(f);
    const run = f.service.get(initial.runId);
    assert.equal(run.stage, 'RECOVERY_REQUIRED');
    assert.equal(run.reviewRecovery?.status, 'REFUSED');
    assert.equal(run.reviewArtifacts.length, 0);
    assert.equal(run.reviews.length, 0);
    assert.equal(f.reviewPrompts.length, 1);
    assert.equal(f.acknowledgements.length, 1);
    assert.ok(stopped());
    await assert.rejects(f.service.command('code.review.retry', {runId:run.runId, expectedVersion:run.version}));
  });
}

for (const mismatch of ['runId', 'requestId', 'candidateId', 'auditManifestHash']) {
  test(`T4: a consistently stored packet with wrong ${mismatch} never becomes a processed report`, async t => {
    const f = fixture(t, { review:data => ({...assertionsFor(data.context), [mismatch]:'other-identity'}) });
    stopAfterAck(f);
    const initial = await f.run();
    await reopen(f);
    const run = f.service.get(initial.runId);
    assert.equal(run.reviewRecovery.status, 'REFUSED');
    assert.equal(run.requests[0].status, 'RECEIVED');
    assert.equal(run.reviews.length, 0);
    assert.equal(f.reviewPrompts.length, 1);
    assert.equal(run.stage, 'RECOVERY_REQUIRED');
  });
}
