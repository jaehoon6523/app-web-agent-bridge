import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ArtifactStore} from '../src/evidence/artifact-store.js';
import {CodeChangeService} from '../src/orchestration/code-change-service.js';
import {assertionsFor} from './helpers/audit-fixtures.js';
import {parseFinalControllerPacketJsonEnvelope} from '../src/domain/controller-packet-envelope.js';
import {redactControllerResponseText} from '../src/orchestration/web-delivery-receipts.js';
import {DashboardController} from '../src/orchestration/dashboard-controller.js';
import {fixture, reopen, stopAfterAck, assertRecovered} from './helpers/audit-recovery-fixtures.js';

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
