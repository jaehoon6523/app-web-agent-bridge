import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, reopen, stopAfterAck, assertRecovered} from './helpers/audit-recovery-fixtures.js';

for (const turn of [1, 2]) {
  test(`T1: ACK ${turn} is restored after SQLite/ArtifactStore reopen and explicitly resumed without retransmission`, async t => {
    const f = fixture(t), stopped = stopAfterAck(f, turn);
    const initial = await f.run(), snapshot = stopped(), receipt = snapshot.webDeliveryReceipts.at(-1);
    assert.equal(initial.stage, 'RECOVERY_REQUIRED');
    assert.equal(snapshot.reviewArtifacts.filter(item => item.requestId === receipt.deliveryId).length, 0);
    assert.equal(snapshot.requests.find(item => item.requestId === receipt.deliveryId).status, 'INTENT');
    assert.equal(f.acknowledgements.length, turn);
    await reopen(f);
    const run = f.service.get(initial.runId);
    assertRecovered(f, run, receipt);
    assert.equal(f.reviewPrompts.length, turn);
    assert.equal(run.reviewRecovery.status, 'READY');
    assert.ok(f.service.reconcile(run).allowedActions.includes('code.review.retry'));
    await f.dashboard.executeDurable({ type:'code.review.retry', requestId:`resume-ack-${turn}`,
      payload:{runId:run.runId, expectedVersion:run.version} });
    await f.service.jobs.get(run.runId);
    const resumed = f.service.get(run.runId);
    assert.equal(resumed.stage, 'AWAITING_APPLY', resumed.error);
    assert.equal(resumed.reviewRecovery.status, 'COMPLETED');
    assert.equal(f.reviewPrompts.length, 2, 'Only the missing Critic may receive a new prompt after explicit continuation');
    assert.equal(f.acknowledgements.filter(item => item === receipt.deliveryId).length, 1);
    assert.equal(resumed.requests.length, 2);
    assert.equal(resumed.reviewArtifacts.length, 2);
    assert.equal(new Set(resumed.messages.map(item => item.messageId)).size, resumed.messages.length);
    assert.equal(resumed.reviews.length, 1);
    assert.ok(resumed.application == null);
    await reopen(f);
    assert.equal(f.service.get(run.runId).stage, 'AWAITING_APPLY');
  });
}

for (const boundary of ['reasoning-artifact', 'packet-artifact', 'sqlite-rollback', 'received-commit', 'processed-commit']) {
  test(`T2: ${boundary} failure recovers original evidence exactly once`, async t => {
    const f = fixture(t), update = f.service.update.bind(f.service), put = f.options.artifactStore.put.bind(f.options.artifactStore);
    let injected = false, armed = false;
    f.options.artifactStore.put = (content, options) => {
      if (armed && !injected && ((boundary === 'reasoning-artifact' && content === 'Original review reasoning.')
        || (boundary === 'packet-artifact' && options.mimeType === 'application/json'))) {
        injected = true; throw new Error(`Injected ${boundary}`);
      }
      return put(content, options);
    };
    f.service.update = (runId, changes) => {
      if (!injected && boundary === 'sqlite-rollback' && changes.reviewArtifacts?.length) {
        // Fail after UPDATE code_change_runs inside the real save transaction.
        f.service.store.database.exec(`CREATE TEMP TRIGGER reject_review_history BEFORE INSERT ON main.code_change_history
          BEGIN SELECT RAISE(ABORT, 'Injected history insert failure'); END;`);
        try { return update(runId, changes); }
        catch (error) { injected = true; throw error; }
        finally { f.service.store.database.exec('DROP TRIGGER reject_review_history'); }
      }
      const saved = update(runId, changes);
      if (changes.webDeliveryReceipts?.at(-1)?.state === 'ACKNOWLEDGED') armed = true;
      if (!injected && ((boundary === 'received-commit' && changes.reviewArtifacts?.length)
        || (boundary === 'processed-commit' && changes.requests?.some(item => item.status === 'PROCESSED')))) {
        injected = true; throw new Error(`Injected ${boundary}`);
      }
      return saved;
    };
    const initial = await f.run();
    assert.ok(injected, boundary);
    assert.equal(initial.stage, 'RECOVERY_REQUIRED');
    const receipt = initial.webDeliveryReceipts.at(-1);
    if (boundary === 'sqlite-rollback') {
      assert.equal(initial.reviewArtifacts.length, 0);
      assert.equal(initial.requests.at(-1).status, 'INTENT');
      assert.equal(initial.messages.some(item => item.messageId === receipt.deliveryId), false);
    }
    await reopen(f);
    const recovered = f.service.get(initial.runId);
    assertRecovered(f, recovered, receipt);
    const artifact = recovered.reviewArtifacts[0], request = recovered.requests[0];
    await reopen(f);
    const again = f.service.get(initial.runId);
    assertRecovered(f, again, receipt);
    assert.deepEqual(again.reviewArtifacts[0], artifact);
    assert.deepEqual(again.requests[0].reportRef, request.reportRef);
    assert.equal(f.reviewPrompts.length, 1);
    assert.equal(f.acknowledgements.length, 1);
  });
}

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
