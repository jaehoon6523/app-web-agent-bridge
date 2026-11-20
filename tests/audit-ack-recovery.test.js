import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ArtifactStore} from '../src/evidence/artifact-store.js';
import {CodeChangeService} from '../src/orchestration/code-change-service.js';
import {assertionsFor} from './helpers/audit-fixtures.js';
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

for (const boundary of ['ack-request', 'ack-lost', 'ack-unconfirmed', 'settlement-write']) {
  test(`T5: ${boundary} preserves ACK_PENDING and the exact owner across reopen`, async t => {
    const f = fixture(t), ack = f.options.webSession.acknowledgeDelivery, update = f.service.update.bind(f.service);
    f.options.webSession.acknowledgeDelivery = async function(input) {
      if (boundary === 'ack-request') throw new Error('ACK request failed before transmission');
      const value = await ack.call(this, input);
      if (boundary === 'ack-lost') throw new Error('ACK response was lost');
      return boundary === 'ack-unconfirmed' ? {...value, sessionId:'wrong-session'} : value;
    };
    if (boundary === 'settlement-write') f.service.update = (runId, changes) => {
      if (changes.webDeliveryReceipts?.at(-1)?.state === 'ACKNOWLEDGED') throw new Error('Settlement write failed');
      return update(runId, changes);
    };
    const initial = await f.run(), receipt = initial.webDeliveryReceipts.at(-1);
    assert.equal(receipt.state, 'ACK_PENDING');
    await reopen(f);
    const run = f.service.get(initial.runId);
    assert.equal(run.webDeliveryReceipts[0].state, 'ACK_PENDING');
    assert.equal(run.conversationBindings.find(item => item.role === receipt.role).activeDeliveryId, receipt.deliveryId);
    assert.equal(run.reviewArtifacts.length, 0);
    assert.equal(run.requests[0].status, 'INTENT');
    assert.equal(run.reviews.length, 0);
    assert.equal(run.reviewRecovery, undefined);
    assert.equal(f.reviewPrompts.length, 1);
  });
}

for (const type of ['malformed-report', 'evidence-request']) {
  test(`stored ${type} stays unapproved and never triggers repair or supplement during recovery`, async t => {
    const f = fixture(t, { review:data => type === 'malformed-report' ? {...assertionsFor(data.context), assessments:[]} : {
      type:'EVIDENCE_REQUEST', runId:data.context.runId, requestId:data.context.requestId,
      candidateId:data.context.candidateId, requirementsRef:data.context.requirementsRef,
      requests:[{requestItemId:'code', kind:'CODE', path:'file.txt', purpose:'Inspect code'}],
    } });
    stopAfterAck(f);
    const initial = await f.run(), evidence = initial.evidence;
    await reopen(f);
    const run = f.service.get(initial.runId);
    assert.equal(run.stage, 'RECOVERY_REQUIRED');
    assert.equal(run.reviewRecovery.status, 'REFUSED');
    assert.equal(run.requests[0].status, 'RECEIVED');
    assert.deepEqual(run.evidence, evidence);
    assert.equal(run.reviews.length, 0);
    assert.equal(run.agreedWorkOrders.length, 0);
    assert.equal(f.reviewPrompts.length, 1);
  });
}

test('T2/T3: a SQLite failure during recovery rolls back all review collections and remains retryable after reopen', async t => {
  const f = fixture(t);
  stopAfterAck(f);
  const initial = await f.run();
  f.service.store.database.exec(`CREATE TRIGGER reject_recovery_history BEFORE INSERT ON code_change_history
    WHEN json_extract(NEW.record_json, '$.requests[0].status') = 'RECEIVED'
    BEGIN SELECT RAISE(ABORT, 'Injected recovery transaction failure'); END;`);
  await reopen(f);
  const refused = f.service.get(initial.runId);
  assert.equal(refused.reviewRecovery.status, 'REFUSED');
  assert.equal(refused.requests[0].status, 'INTENT');
  assert.equal(refused.reviewArtifacts.length, 0);
  assert.equal(refused.messages.some(item => item.messageId === refused.reviewTurnId), false);
  f.service.store.database.exec('DROP TRIGGER reject_recovery_history');
  await reopen(f);
  assertRecovered(f, f.service.get(initial.runId), initial.webDeliveryReceipts[0]);
  assert.equal(f.reviewPrompts.length, 1);
});

for (const mode of ['raw-packet-disagreement', 'artifact-deleted', 'artifact-corrupted']) {
  test(`T4: ${mode} cannot be promoted to a review result`, async t => {
    const f = fixture(t);
    if (mode === 'raw-packet-disagreement') {
      const submit = f.options.webSession.submitTurn;
      f.options.webSession.submitTurn = async function(input) {
        const handle = await submit.call(this, input);
        return {...handle, completion:handle.completion.then(response => ({...response, packet:{...response.packet,
          assessments:response.packet.assessments.map(item => ({...item, verdict:'UNSATISFIED'})),
        }}))};
      };
    }
    stopAfterAck(f);
    const initial = await f.run(), receipt = initial.webDeliveryReceipts[0];
    const file = path.join(f.options.artifactStore.rootDirectory, receipt.packetRef.sha256.slice(7));
    if (mode === 'artifact-deleted') fs.unlinkSync(file);
    if (mode === 'artifact-corrupted') fs.writeFileSync(file, 'corrupt bytes');
    await reopen(f);
    const run = f.service.get(initial.runId);
    assert.equal(run.reviewRecovery.status, 'REFUSED');
    assert.equal(run.requests[0].status, 'INTENT');
    assert.equal(run.reviewArtifacts.length, 0);
    assert.equal(run.stage, 'RECOVERY_REQUIRED');
    assert.equal(f.reviewPrompts.length, 1);
  });
}

for (const turn of [3, 4]) {
  test(`ROUND1 ACK ${turn} reuses the original Round0 and cross-review without inventing PASS`, async t => {
    const f = fixture(t, {review:data => assertionsFor(data.context, 'UNDETERMINED')});
    stopAfterAck(f, turn);
    const initial = await f.run();
    assert.equal(f.reviewPrompts.length, turn);
    await reopen(f);
    const ready = f.service.get(initial.runId);
    assert.equal(ready.reviewRecovery.status, 'READY', JSON.stringify(ready.reviewRecovery.failures));
    assert.equal(ready.stage, 'RECOVERY_REQUIRED');
    const originalIds = ready.requests.map(item => item.requestId);
    await f.service.command('code.review.retry', {runId:ready.runId, expectedVersion:ready.version});
    await f.service.jobs.get(ready.runId);
    const resumed = f.service.get(ready.runId);
    assert.equal(resumed.stage, 'HOLD', resumed.error);
    assert.equal(resumed.auditResult, 'HOLD');
    assert.equal(f.reviewPrompts.length, 4);
    assert.equal(resumed.reviewArtifacts.length, 4);
    assert.equal(resumed.requests.length, 4);
    for (const requestId of originalIds) assert.equal(f.acknowledgements.filter(item => item === requestId).length, 1);
    assert.ok(resumed.application == null);
    assert.equal(resumed.agreedWorkOrders.length, 0);
  });
}

for (const mode of ['report-replaced', 'completed-role-omitted']) {
  test(`T4: ${mode} after startup cannot turn explicit continuation into retransmission`, async t => {
    const f = fixture(t);
    stopAfterAck(f, 2);
    const initial = await f.run();
    await reopen(f);
    const ready = f.service.get(initial.runId);
    if (mode === 'report-replaced') f.service.update(ready.runId, {
      requests:ready.requests.map((item, index) => index === 0
        ? {...item, reportRef:f.options.artifactStore.put('{}')} : item),
    });
    else f.service.update(ready.runId, {reviewRecovery:{...ready.reviewRecovery,
      requestIds:ready.reviewRecovery.requestIds.filter(id => id === ready.reviewTurnId),
    }});
    const changed = f.service.get(ready.runId);
    await f.service.command('code.review.retry', {runId:changed.runId, expectedVersion:changed.version});
    await f.service.jobs.get(changed.runId);
    const run = f.service.get(changed.runId);
    assert.equal(run.stage, 'RECOVERY_REQUIRED');
    assert.equal(f.reviewPrompts.length, 2);
    assert.equal(f.acknowledgements.length, 2);
    assert.equal(run.reviews.length, 0);
  });
}
