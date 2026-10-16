import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { ArtifactStore } from '../src/evidence/artifact-store.js';
import { CodeChangeService } from '../src/orchestration/code-change-service.js';
import { setupAudit, assertionsFor } from './helpers/audit-fixtures.js';
import { parseFinalControllerPacketJsonEnvelope } from '../src/domain/controller-packet-envelope.js';
import { redactControllerResponseText } from '../src/orchestration/web-delivery-receipts.js';
import { DashboardController } from '../src/orchestration/dashboard-controller.js';

function fixture(t, hooks = {}) {
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
async function reopen(f) {
  f.options.artifactStore = new ArtifactStore(path.join(f.directory, 'artifacts'));
  await f.reopen();
}
function stopAfterAck(f, turn = 1) {
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
function assertRecovered(f, run, receipt) {
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

async function killAtBoundary(t, args = []) {
  const child = fork(new URL('./helpers/audit-ack-crash-child.mjs', import.meta.url), args, {
    execArgv:[], stdio:['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let metadata, boundary, stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(() => { child.kill('SIGKILL'); });
  const exit = once(child, 'exit');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Crash boundary timeout: ${stderr}`)); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('message', message => {
      if (message.type === 'ready') {
        metadata = message;
      }
      if (message.type === 'boundary') { boundary = message; clearTimeout(timer); child.kill('SIGKILL'); resolve(); }
    });
    child.on('exit', () => { if (!boundary) { clearTimeout(timer); reject(new Error(`Child exited before boundary: ${stderr}`)); } });
  });
  const [code, signal] = await exit;
  assert.ok(code !== 0 || signal);
  return { metadata, boundary };
}

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

for (const boundary of ['acknowledged', 'received', 'processed']) {
  test(`redacted response survives ${boundary} interruption without retransmission or an invented PASS`, async t => {
    const f = fixture(t, {
      reviewBody:() => 'Review credential password=example-body',
      review:data => {
        const packet = assertionsFor(data.context, 'UNDETERMINED');
        packet.assessments = packet.assessments.map(item => ({...item,
          missingInformation:'Check api_key=example-key and password=example-value'}));
        return packet;
      },
    });
    const update = f.service.update.bind(f.service);
    let interrupted = false;
    f.service.update = (runId, changes) => {
      const saved = update(runId, changes);
      if (!interrupted && ((boundary === 'acknowledged' && changes.webDeliveryReceipts?.at(-1)?.state === 'ACKNOWLEDGED')
        || (boundary === 'received' && changes.reviewArtifacts?.length)
        || (boundary === 'processed' && changes.requests?.some(item => item.status === 'PROCESSED')))) {
        interrupted = true; throw new Error(`Stop after ${boundary}`);
      }
      return saved;
    };
    const initial = await f.run(), receipt = initial.webDeliveryReceipts[0];
    assert.ok(interrupted); assert.equal(receipt.state, 'ACKNOWLEDGED');
    await reopen(f);
    const recovered = f.service.get(initial.runId);
    assert.equal(recovered.reviewRecovery.status, 'READY', JSON.stringify(recovered.reviewRecovery.failures));
    assertRecovered(f, recovered, receipt);
    const request = recovered.requests[0], artifact = recovered.reviewArtifacts[0];
    const stored = [receipt.responseRef, receipt.packetRef, artifact.contentRef, request.reportRef]
      .map(ref => f.options.artifactStore.read(ref.sha256).toString('utf8')).join('\n');
    assert.doesNotMatch(stored + JSON.stringify(recovered.messages), /example-body|example-key|example-value/u);
    assert.equal(JSON.parse(f.options.artifactStore.read(request.reportRef.sha256)).assessments[0].verdict, 'UNDETERMINED');
    await reopen(f);
    const again = f.service.get(initial.runId);
    assert.deepEqual(again.reviewArtifacts, recovered.reviewArtifacts);
    assert.deepEqual(again.requests[0].reportRef, request.reportRef);
    assert.deepEqual(again.messages, recovered.messages);
    assert.equal(f.reviewPrompts.length, 1); assert.equal(f.acknowledgements.length, 1);
    await f.service.command('code.review.retry', {runId:again.runId,expectedVersion:again.version});
    await f.service.jobs.get(again.runId);
    const resumed = f.service.get(again.runId);
    assert.equal(resumed.stage, 'HOLD', resumed.error);
    assert.equal(resumed.auditResult, 'HOLD');
    assert.equal(f.reviewPrompts.length, 4);
    const logicalTurns = f.reviewPrompts.map(item => [item.context.runId, item.context.candidateId,
      item.context.auditManifestHash, item.role, item.phase].join(':'));
    assert.equal(new Set(logicalTurns).size, logicalTurns.length);
    assert.equal(new Set(f.reviewPrompts.map(item => item.context.requestId)).size, f.reviewPrompts.length);
    assert.equal(f.reviewPrompts.filter(item => item.context.requestId === receipt.deliveryId).length, 1);
    assert.equal(f.acknowledgements.filter(id => id === receipt.deliveryId).length, 1);
    assert.ok(resumed.application == null);
  });
}

test('response masking preserves JSON punctuation, nested keys and packet framing', () => {
  const packet = {type:'EXAMPLE',missingInformation:'password=example-value',
    nested:{api_key:'nested-example'},items:['secret=example-array'],unchanged:'quote " slash \\ and newline\n'};
  for (const [open, close] of [['<controller_packet>','</controller_packet>'],['CONTROLLER_PACKET_BEGIN','CONTROLLER_PACKET_END']]) {
    const raw = `Review api_key=example-body\n${open}\n${JSON.stringify(packet,null,2)}\n${close}`;
    const masked = redactControllerResponseText(raw), parsed = parseFinalControllerPacketJsonEnvelope(masked);
    assert.equal(parsed.body, 'Review api_key=[REDACTED]');
    assert.deepEqual(parsed.parsed, {type:'EXAMPLE',missingInformation:'password=[REDACTED]',
      nested:{api_key:'[REDACTED]'},items:['secret=[REDACTED]'],unchanged:packet.unchanged});
    assert.doesNotMatch(masked, /example-value|nested-example|example-array|example-body/u);
    assert.equal(redactControllerResponseText(masked), masked);
  }
});

test('unchanged and already redacted legacy response bytes keep their exact hashes', () => {
  for (const packet of [{type:'EXAMPLE',value:'unchanged'},
    {type:'EXAMPLE',missingInformation:'password=[REDACTED]',password:'[REDACTED]'}]) {
    const raw = `Legacy reasoning\n<controller_packet>\n${JSON.stringify(packet,null,2)}\n</controller_packet>\n  `;
    assert.equal(redactControllerResponseText(raw), raw);
  }
});

const duplicatePackets = [
  ['shadowed assignment', '{"missingInformation":"password=duplicate-example","missingInformation":"Need evidence"}'],
  ['shadowed sensitive key', '{"password":"duplicate-example","password":"[REDACTED]"}'],
  ['nested member', '{"nested":{"api_key":"duplicate-example","api_key":"[REDACTED]"}}'],
  ['array member', '{"items":[{"secret":"duplicate-example","secret":"[REDACTED]"}]}'],
  ['escaped equivalent key', '{"pass\\u0077ord":"duplicate-example","password":"[REDACTED]"}'],
  ['escaped quote in key', '{"a\\\"b":"duplicate-example","a\\\"b":"safe"}'],
  ['repaired Windows member', String.raw`{"C:\Users\work":"duplicate-example","C:\Users\work":"safe"}`],
  ['equal values', '{"verdict":"SATISFIED","verdict":"SATISFIED"}'],
];
for (const [name, packetText] of duplicatePackets) {
  test(`duplicate JSON ${name} is refused before evidence serialization`, () => {
    for (const [open, close] of [['<controller_packet>','</controller_packet>'], ['CONTROLLER_PACKET_BEGIN','CONTROLLER_PACKET_END']]) {
      const raw = `Review\n${open}\n${packetText}\n${close}`;
      assert.doesNotThrow(() => parseFinalControllerPacketJsonEnvelope(raw));
      assert.throws(() => redactControllerResponseText(raw), error => {
        assert.equal(error.code, 'DUPLICATE_CONTROLLER_PACKET_KEY');
        assert.doesNotMatch(error.message, /duplicate-example/u);
        return true;
      });
    }
  });
}

test('duplicate-key detection keeps object scopes, quoted punctuation and legacy escapes separate', () => {
  const packetTexts = [
    '{"items":[{"value":"one"},{"value":"two"}],"value":"three"}',
    '{"value":"{ \\\"value\\\": \\\"inside a string\\\" }","nested":{"value":"one"}}',
    '{"path":"C:\\Users\\work","other":{"path":"C:/Users/work"}}',
    '{"quoted\\\"key":"safe","escaped\\u006bey":"safe"}',
    String.raw`{"C:\Users\work":"safe","other":{"C:\Users\work":"safe"}}`,
  ];
  for (const packetText of packetTexts) {
    const raw = `Legacy reasoning\n<controller_packet>\n${packetText}\n</controller_packet>\n  `;
    assert.doesNotThrow(() => parseFinalControllerPacketJsonEnvelope(raw));
    assert.equal(redactControllerResponseText(raw), raw);
  }
});

test('a duplicate-key review cannot be stored, acknowledged or lose its owner', async t => {
  const f = fixture(t, {review:data => assertionsFor(data.context, 'UNDETERMINED')});
  const submit = f.options.webSession.submitTurn, stored = [];
  f.options.webSession.submitTurn = async function(input) {
    return submit.call(this, {...input, parseResponse:raw => {
      const changed = raw.replace('"missingInformation":"Need actual evidence"',
        '"missingInformation":"password=duplicate-example","missingInformation":"Need actual evidence"');
      assert.notEqual(changed, raw);
      return input.parseResponse(changed);
    }});
  };
  const put = f.options.artifactStore.put.bind(f.options.artifactStore);
  f.options.artifactStore.put = (content, options) => {stored.push(String(content)); return put(content, options);};
  const initial = await f.run();
  assert.equal(initial.stage, 'RECOVERY_REQUIRED');
  assert.match(initial.error, /duplicate/u);
  assert.equal(initial.webDeliveryReceipts?.length ?? 0, 0);
  assert.equal(f.acknowledgements.length, 0);
  assert.equal(initial.reviewArtifacts?.length ?? 0, 0);
  assert.doesNotMatch(stored.join('\n') + JSON.stringify(initial), /duplicate-example/u);
  const requestId = initial.requests[0].requestId;
  assert.equal(initial.conversationBindings.find(item => item.role === initial.requests[0].role).activeDeliveryId, requestId);
  await reopen(f);
  const recovered = f.service.get(initial.runId);
  assert.notEqual(recovered.reviewRecovery?.status, 'READY');
  assert.equal(recovered.conversationBindings.find(item => item.role === initial.requests[0].role).activeDeliveryId, requestId);
  assert.equal(f.reviewPrompts.length, 1);
  assert.equal(f.acknowledgements.length, 0);
  assert.equal(recovered.reviews.length, 0);
  assert.ok(recovered.application == null);
});

test('an already acknowledged legacy duplicate-key receipt is refused without rewriting its evidence', async t => {
  const f = fixture(t, {review:data => assertionsFor(data.context, 'UNDETERMINED')});
  const put = f.options.artifactStore.put.bind(f.options.artifactStore);
  let injected = false;
  // Reproduce bytes persisted by the older writer, not a post-commit history mutation.
  f.options.artifactStore.put = (content, options) => {
    if (!injected && options?.mimeType === 'text/plain' && String(content).includes('<controller_packet>')
      && String(content).includes('"missingInformation":"Need actual evidence"')) {
      const changed = String(content).replace('"missingInformation":"Need actual evidence"',
        '"missingInformation":"password=duplicate-example","missingInformation":"Need actual evidence"');
      assert.notEqual(changed, content);
      injected = true;
      return put(changed, options);
    }
    return put(content, options);
  };
  const saveLegacy = f.service.update.bind(f.service);
  f.service.update = (runId, changes) => saveLegacy(runId, changes.webDeliveryReceipts
    ? {...changes,webDeliveryReceipts:changes.webDeliveryReceipts.map(({privateResponseRef, ...receipt}) => receipt)} : changes);
  stopAfterAck(f);
  const initial = await f.run();
  assert.ok(initial.webDeliveryReceipts?.length, initial.error);
  const receipt = initial.webDeliveryReceipts[0];
  assert.ok(injected);
  assert.equal(receipt.state, 'ACKNOWLEDGED');
  const originalBytes = f.options.artifactStore.read(receipt.responseRef.sha256).toString('utf8');
  assert.match(originalBytes, /duplicate-example/u);
  await reopen(f);
  const recovered = f.service.get(initial.runId);
  assert.equal(recovered.reviewRecovery.status, 'REFUSED');
  assert.equal(recovered.reviewRecovery.failures[0].code, 'DUPLICATE_CONTROLLER_PACKET_KEY');
  assert.deepEqual(recovered.webDeliveryReceipts[0], receipt);
  assert.equal(f.options.artifactStore.read(receipt.responseRef.sha256).toString('utf8'), originalBytes);
  assert.equal(recovered.reviewArtifacts.length, 0);
  assert.equal(recovered.reviews.length, 0);
  assert.equal(f.reviewPrompts.length, 1);
  assert.equal(f.acknowledgements.length, 1);
  assert.ok(recovered.application == null);
});

test('an invalid wire packet is omitted from public evidence without becoming a valid packet', () => {
  const raw = 'Review\nCONTROLLER_PACKET_BEGIN\n{"missingInformation":"password=example-value"\nCONTROLLER_PACKET_END';
  const masked = redactControllerResponseText(raw);
  assert.doesNotMatch(masked, /example-value/u);
  assert.throws(() => parseFinalControllerPacketJsonEnvelope(masked));
});

for (const mismatch of [false, true]) {
  test(`a legacy message ${mismatch ? 'with different reasoning is refused' : 'is redacted without changing receipt evidence'}`, async t => {
    const f = fixture(t, {reviewBody:() => 'Review password=legacy-example'});
    const update = f.service.update.bind(f.service);
    let interrupted = false;
    f.service.update = (runId, changes) => {
      const saved = update(runId, changes);
      if (!interrupted && changes.reviewArtifacts?.length) {interrupted = true;throw new Error('Stop after received');}
      return saved;
    };
    const initial = await f.run(), receipt = initial.webDeliveryReceipts[0];
    const legacyContent = mismatch ? 'Unrelated reasoning' : 'Review password=legacy-example';
    // Write an actual unredacted historical presentation value with a valid hash chain.
    f.service.store.save({...initial, messages:initial.messages.map(item => item.messageId === receipt.deliveryId
      ? {...item,content:legacyContent} : item)}, initial.version);
    assert.equal(f.service.get(initial.runId).messages.find(item => item.messageId === receipt.deliveryId).content, legacyContent);
    const prototypeUpdate = CodeChangeService.prototype.update;
    let messageRepairs = 0;
    t.mock.method(CodeChangeService.prototype, 'update', function(runId, changes) {
      if (changes.messages?.some(item => item.messageId === receipt.deliveryId
        && item.content === 'Review password=[REDACTED]')) messageRepairs++;
      return prototypeUpdate.call(this, runId, changes);
    });
    await reopen(f);
    const run = f.service.get(initial.runId);
    assert.equal(run.reviewRecovery.status, mismatch ? 'REFUSED' : 'READY');
    assert.equal(messageRepairs, mismatch ? 0 : 1);
    if (!mismatch) {
      assertRecovered(f, run, receipt);
      assert.equal(run.messages.find(item => item.messageId === receipt.deliveryId).content, 'Review password=[REDACTED]');
      assert.equal(run.reviewArtifacts[0].responseRef.sha256, receipt.responseRef.sha256);
      assert.deepEqual(run.webDeliveryReceipts, initial.webDeliveryReceipts);
      await reopen(f);
      assert.deepEqual(f.service.get(initial.runId).messages, run.messages);
      assert.equal(messageRepairs, 1);
    }
    assert.equal(f.reviewPrompts.length, 1);assert.equal(f.acknowledgements.length, 1);
  });
}

test('redaction keeps the raw-response versus packet disagreement check', async t => {
  const f = fixture(t, {review:data => {
    const packet = assertionsFor(data.context, 'UNDETERMINED');
    packet.assessments[0].missingInformation = 'password=example-value';
    return packet;
  }});
  const submit = f.options.webSession.submitTurn;
  f.options.webSession.submitTurn = async function(input) {
    const handle = await submit.call(this,input);
    return {...handle,completion:handle.completion.then(response => ({...response,packet:{...response.packet,
      assessments:response.packet.assessments.map(item => ({...item,verdict:'SATISFIED'}))}}))};
  };
  stopAfterAck(f);
  const initial = await f.run();
  await reopen(f);
  const run = f.service.get(initial.runId);
  assert.equal(run.reviewRecovery.status, 'REFUSED');
  assert.match(run.reviewRecovery.failures[0].reason, /Response text and packet evidence differ/u);
  assert.equal(run.reviews.length, 0);assert.equal(f.reviewPrompts.length, 1);
});

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

for (const newline of ['\n','\r\n']) {
  for (const fence of ['```','~~~']) {
    for (const boundary of ['acknowledged','received','processed']) {
      test(`private wire with ${JSON.stringify(newline)} ${fence} survives ${boundary} and explicit continuation`, async t => {
        const body = [`${fence}text`, 'password=', fence, 'Review password=', 'multiline-example',
          '"password":"quoted-example"'].join(newline);
        const f = fixture(t, {reviewBody:() => body, review:data => assertionsFor(data.context, 'UNDETERMINED')});
        const update = f.service.update.bind(f.service);
        let interrupted = false;
        f.service.update = (runId, changes) => {
          const saved = update(runId, changes);
          if (!interrupted && ((boundary === 'acknowledged' && changes.webDeliveryReceipts?.at(-1)?.state === 'ACKNOWLEDGED')
            || (boundary === 'received' && changes.reviewArtifacts?.length)
            || (boundary === 'processed' && changes.requests?.some(item => item.status === 'PROCESSED')))) {
            interrupted = true; throw new Error(`Stop at ${boundary}`);
          }
          return saved;
        };
        const initial = await f.run(), receipt = initial.webDeliveryReceipts[0];
        assert.ok(interrupted);
        assert.equal(receipt.state, 'ACKNOWLEDGED');
        const original = f.options.artifactStore.readPrivateResponse(receipt.privateResponseRef);
        assert.equal(original.body, body);
        assert.equal(original.rawText, `${body}\n<controller_packet>\n${original.packetText}\n</controller_packet>`);
        const publicWire = f.options.artifactStore.read(receipt.responseRef.sha256).toString('utf8');
        assert.doesNotMatch(publicWire, /multiline-example|quoted-example/u);
        assert.equal(parseFinalControllerPacketJsonEnvelope(publicWire).body.split(fence).length, 3);
        await reopen(f);
        const recovered = f.service.get(initial.runId);
        assert.equal(recovered.reviewRecovery.status, 'READY', JSON.stringify(recovered.reviewRecovery.failures));
        assertRecovered(f, recovered, receipt);
        assert.deepEqual(f.options.artifactStore.readPrivateResponse(receipt.privateResponseRef), original);
        await reopen(f);
        const again = f.service.get(initial.runId);
        assert.deepEqual(again.reviewArtifacts, recovered.reviewArtifacts);
        assert.deepEqual(again.messages, recovered.messages);
        await f.service.command('code.review.retry', {runId:again.runId, expectedVersion:again.version});
        await f.service.jobs.get(again.runId);
        const resumed = f.service.get(again.runId);
        assert.equal(resumed.stage, 'HOLD', resumed.error);
        const keys = f.reviewPrompts.map(item => JSON.stringify([item.context.runId, item.context.candidateId,
          item.context.auditManifestHash, item.role, item.phase]));
        assert.equal(new Set(keys).size, keys.length);
        assert.equal(f.reviewPrompts.filter(item => item.context.requestId === receipt.deliveryId).length, 1);
        assert.equal(f.acknowledgements.filter(id => id === receipt.deliveryId).length, 1);
        assert.ok(resumed.application == null);
      });
    }
  }
}

for (const terminated of [true, false]) {
  test(`invalid JSON with ${terminated ? 'closed' : 'unterminated'} secret stays private and unapproved`, async t => {
    const wire = `Review\nCONTROLLER_PACKET_BEGIN\n{"password":"malformed-example${terminated ? '"' : ''}\nCONTROLLER_PACKET_END`;
    const f = fixture(t), submit = f.options.webSession.submitTurn;
    f.options.webSession.submitTurn = async function(input) {
      const handle = await submit.call(this, {...input,parseResponse:() => input.parseResponse(wire)});
      return {...handle,completion:handle.completion.then(response => ({...response,rawText:wire}))};
    };
    stopAfterAck(f);
    const initial = await f.run(), receipt = initial.webDeliveryReceipts[0];
    assert.equal(receipt.state, 'ACKNOWLEDGED');
    assert.equal(receipt.validation, 'REJECTED_FORMAT');
    assert.equal(f.options.artifactStore.readPrivateResponse(receipt.privateResponseRef).rawText, wire);
    const visible = [receipt.responseRef,receipt.packetRef]
      .map(ref => f.options.artifactStore.read(ref.sha256).toString('utf8')).join('\n');
    assert.doesNotMatch(visible, /malformed-example/u);
    await reopen(f);
    const run = f.service.get(initial.runId);
    assert.equal(run.reviewRecovery.status, 'REFUSED');
    assert.equal(run.reviews.length, 0);
    assert.equal(f.reviewPrompts.length, 1);
    assert.equal(f.acknowledgements.length, 1);
    const snapshot = f.service.snapshot(run.runId, {});
    const command = {type:'evidence.export',requestId:`private-export-${terminated}`,
      payload:{runId:run.runId,expectedVersion:run.version}};
    const exported = await f.dashboard.executeDurable(command);
    assert.deepEqual(await f.dashboard.executeDurable(command), exported);
    const publicData = JSON.stringify([snapshot,exported,f.service.store.receipt(command.requestId)]);
    assert.doesNotMatch(publicData, /malformed-example|privateResponseRef/u);
    assert.equal(publicData.includes(receipt.privateResponseRef.sha256), false);
  });
}

test('private storage failure prevents ACK and preserves the exact delivery owner', async t => {
  const f = fixture(t);
  f.options.artifactStore.putPrivateResponse = () => {throw new Error('Private storage unavailable');};
  const run = await f.run(), request = run.requests[0];
  assert.equal(run.stage, 'RECOVERY_REQUIRED');
  assert.equal(f.acknowledgements.length, 0);
  assert.equal(run.webDeliveryReceipts?.length ?? 0, 0);
  assert.equal(run.conversationBindings.find(item => item.role === request.role).activeDeliveryId, request.requestId);
  await reopen(f);
  assert.equal(f.service.get(run.runId).conversationBindings.find(item => item.role === request.role).activeDeliveryId, request.requestId);
  assert.equal(f.reviewPrompts.length, 1);
});

for (const missing of [false, true]) {
  test(`a ${missing ? 'missing' : 'corrupted'} private original is refused without falling back to its public copy`, async t => {
    const f = fixture(t);
    stopAfterAck(f);
    const initial = await f.run(), receipt = initial.webDeliveryReceipts[0];
    const file = path.join(f.options.artifactStore.rootDirectory,'private-web-responses',receipt.privateResponseRef.sha256.slice(7));
    if (missing) fs.unlinkSync(file); else fs.writeFileSync(file, 'changed');
    await reopen(f);
    const run = f.service.get(initial.runId);
    assert.equal(run.reviewRecovery.status, 'REFUSED');
    assert.equal(run.reviewArtifacts.length, 0);
    assert.equal(f.reviewPrompts.length, 1);
    assert.equal(f.acknowledgements.length, 1);
    assert.equal(run.reviews.length, 0);
  });
}

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

test('explicit run deletion removes its unreferenced private originals', async t => {
  const f = fixture(t);
  stopAfterAck(f);
  const initial = await f.run(), ref = initial.webDeliveryReceipts[0].privateResponseRef;
  const run = f.service.update(initial.runId, {stage:'CANCELLED'});
  const controller = new DashboardController({getRuntime:async () => ({codeChanges:f.service,
    artifactStore:f.options.artifactStore,store:{listArtifactHashes:() => new Set()}}),preflight:() => ({})});
  await controller.execute({type:'run.delete',payload:{runId:run.runId,expectedVersion:run.version}});
  assert.throws(() => f.options.artifactStore.readPrivateResponse(ref), {code:'ENOENT'});
});
