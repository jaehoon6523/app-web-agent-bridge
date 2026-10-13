import test from 'node:test';
import assert from 'node:assert/strict';
import { setupAudit } from './helpers/audit-fixtures.js';

// Inject committed SQLite owner changes at real service await boundaries.
for (const flow of ['audit', 'discussion']) {
  for (const boundary of ['response', 'ack']) {
    for (const changed of ['delivery', 'session']) {
      test(`${flow}: ${changed} ownership drift at ${boundary} never settles the old delivery`, async t => {
        const f = setupAudit(t, { reviewVerdicts:['SATISFIED'] });
        let settled;
        if (flow === 'discussion') {
          settled = await f.run();
          assert.equal(settled.stage, 'AWAITING_APPLY', settled.error);
        }
        const web = f.options.webSession, beforeAcks = f.acknowledgements.length;
        const method = boundary === 'response' ? 'submitTurn' : 'acknowledgeDelivery';
        const original = web[method];
        let injected = false, deliveryId, replacement;
        web[method] = async function(input) {
          const value = await original.call(this, input);
          if (!injected) {
            injected = true; deliveryId = input.turnId;
            const run = f.service.list()[0];
            const binding = run.conversationBindings.find(item => item.activeDeliveryId === deliveryId);
            assert.ok(binding);
            replacement = { ...binding, ...(changed === 'delivery'
              ? { activeDeliveryId:'replacement-delivery' } : { sessionId:'replacement-session' }) };
            f.service.update(run.runId, { conversationBindings:run.conversationBindings.map(item =>
              item.bindingId === binding.bindingId ? replacement : item) });
          }
          return value;
        };
        let run;
        if (flow === 'audit') run = await f.run();
        else {
          await assert.rejects(f.dashboard.executeDurable({ type:'code.review.discuss', requestId:'owner-drift-chat',
            payload:{ runId:settled.runId, expectedVersion:settled.version, role:'JUDGE', text:'Explain the frozen review.' } }),
          { code:'REVIEW_DISCUSSION_UNCONFIRMED' });
          run = f.service.get(settled.runId);
          assert.equal(run.reviewDiscussions.at(-1).status, 'UNCONFIRMED');
        }
        assert.ok(injected);
        const owner = run.conversationBindings.find(item => item.bindingId === replacement.bindingId);
        assert.deepEqual(owner, replacement);
        assert.equal(f.acknowledgements.length - beforeAcks, boundary === 'response' ? 0 : 1);
        const receipt = run.webDeliveryReceipts?.find(item => item.deliveryId === deliveryId);
        if (boundary === 'response') assert.equal(receipt, undefined);
        else assert.equal(receipt.state, 'ACK_PENDING');
        if (flow === 'audit') assert.equal(run.stage, 'RECOVERY_REQUIRED');
        await f.reopen();
        const reopened = f.service.get(run.runId).conversationBindings.find(item => item.bindingId === replacement.bindingId);
        assert.deepEqual(reopened, replacement);
      });
    }
  }
}

for (const boundary of ['receipt-write', 'ack-request', 'settlement-write']) {
  test(`audit: ${boundary} failure preserves the exact reserved delivery and never authorizes application`, async t => {
    const f = setupAudit(t, { reviewVerdicts:['SATISFIED'] });
    const web = f.options.webSession, originalAck = web.acknowledgeDelivery;
    const originalUpdate = f.service.update.bind(f.service);
    let deliveryId, injected = false;
    web.acknowledgeDelivery = async function(input) {
      deliveryId = input.turnId;
      if (boundary === 'ack-request' && !injected) {
        injected = true;
        throw Object.assign(new Error('Injected ACK failure'), { code:'EXTENSION_DISCONNECTED' });
      }
      return originalAck.call(this, input);
    };
    f.service.update = (runId, changes) => {
      if (!injected && (boundary === 'receipt-write' && changes.webDeliveryReceipts?.some(item => item.state === 'ACK_PENDING')
        || boundary === 'settlement-write' && changes.webDeliveryReceipts?.some(item => item.state === 'ACKNOWLEDGED'))) {
        injected = true;
        throw Object.assign(new Error('Injected SQLite write failure'), { code:'INJECTED_STORAGE_FAILURE' });
      }
      return originalUpdate(runId, changes);
    };
    const run = await f.run();
    assert.ok(injected); assert.equal(run.stage, 'RECOVERY_REQUIRED');
    const owner = run.conversationBindings.find(item => item.activeDeliveryId);
    assert.ok(owner);
    assert.equal(f.acknowledgements.length, boundary === 'settlement-write' ? 1 : 0);
    const receipt = run.webDeliveryReceipts?.find(item => item.deliveryId === owner.activeDeliveryId);
    if (boundary === 'receipt-write') assert.equal(receipt, undefined);
    else { assert.equal(owner.activeDeliveryId, deliveryId); assert.equal(receipt.state, 'ACK_PENDING'); }
    await f.reopen();
    assert.equal(f.service.get(run.runId).conversationBindings.find(item => item.role === owner.role).activeDeliveryId, owner.activeDeliveryId);
  });
}

for (const flow of ['audit', 'discussion']) {
  test(`${flow}: a provably unsent request cannot release a replaced session owner`, async t => {
    const f = setupAudit(t, { reviewVerdicts:['SATISFIED'] });
    const initial = flow === 'discussion' ? await f.run() : null;
    let replacement;
    f.options.webSession.submitTurn = async input => {
      const run = f.service.list()[0];
      const binding = run.conversationBindings.find(item => item.activeDeliveryId === input.turnId);
      replacement = { ...binding, sessionId:'replacement-session' };
      f.service.update(run.runId, { conversationBindings:run.conversationBindings.map(item =>
        item.bindingId === binding.bindingId ? replacement : item) });
      throw Object.assign(new Error('Local validation failed before dispatch'), {
        code:'WEB_SESSION_NOT_READY', details:{ browserDispatchStarted:false },
      });
    };
    const beforeAcks = f.acknowledgements.length;
    let run;
    if (flow === 'audit') run = await f.run();
    else {
      await assert.rejects(f.dashboard.executeDurable({ type:'code.review.discuss', requestId:'unsent-replaced-owner',
        payload:{ runId:initial.runId, expectedVersion:initial.version, role:'JUDGE', text:'Explain the review.' } }),
      { code:'WEB_SESSION_NOT_READY' });
      run = f.service.get(initial.runId);
    }
    assert.deepEqual(run.conversationBindings.find(item => item.bindingId === replacement.bindingId), replacement);
    assert.equal(f.acknowledgements.length, beforeAcks);
    await f.reopen();
    assert.deepEqual(f.service.get(run.runId).conversationBindings.find(item => item.bindingId === replacement.bindingId), replacement);
  });
}
