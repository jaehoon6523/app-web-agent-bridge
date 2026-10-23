import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {assertionsFor} from './helpers/audit-fixtures.js';
import {reopen, stopAfterAck, assertRecovered} from './helpers/audit-recovery-fixtures.js';

import {fixture} from './helpers/ack-recovery-traced-fixture.js';

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
