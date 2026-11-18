import test from 'node:test';
import assert from 'node:assert/strict';
import { assertionsFor } from './helpers/audit-fixtures.js';
import { parseFinalControllerPacketJsonEnvelope } from '../src/domain/controller-packet-envelope.js';
import { fixture, reopen, assertRecovered } from './helpers/audit-recovery-fixtures.js';

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
