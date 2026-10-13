import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setupAudit } from './helpers/audit-fixtures.js';
import { WebSessionAdapter, WebExtensionTransport, computeWebChallengeHmac } from '../src/runtime/web/index.js';

// Exercise the production adapter with a controlled authenticated socket.
function adapterFixture(t, failure) {
  const secret = 'fixture-secret-0123456789abcdef0123456789', commands = [];
  class Peer extends EventEmitter {
    readyState = 1;
    challenge = null;
    send(raw) {
      const message = JSON.parse(raw); commands.push(message.type);
      if (message.type === 'controller.auth.challenge') this.challenge = message;
      if (message.type === 'web.session.prepare') {
        const p = message.payload;
        queueMicrotask(() => this.emit('message', JSON.stringify({ type:'web.session.ready', protocolVersion:2,
          requestId:message.requestId, payload:{ session:{ sessionId:p.sessionId, runId:p.runId,
            conversationUrl:p.conversationUrl, conversationId:p.conversationId, tabId:7, windowId:1,
            documentId:'doc', frameId:0, title:null, lastObservedUserMessageId:null,
            lastObservedAssistantMessageId:null, bindingStatus:'BOUND' } } })));
      }
      if (message.type === 'web.prompt') {
        if (failure === 'transport-send') throw new Error('Injected transport send failure');
        queueMicrotask(() => this.emit('message', JSON.stringify({ type:'web.prompt.error', protocolVersion:2,
          requestId:message.requestId, payload:{ code:'WEB_TURN_AMBIGUOUS', message:'Submitted outcome is unknown',
            details:{ browserDispatchStarted:true } } })));
      }
    }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const transport = new WebExtensionTransport({ sharedSecret:secret, expectedExtensionIdentity:'predispatch-fixture' });
  const socket = new Peer(); transport.attach(socket);
  socket.emit('message', JSON.stringify({ type:'extension.auth.response', protocolVersion:2,
    challengeId:socket.challenge.challengeId, extensionIdentity:'predispatch-fixture',
    hmacSha256:computeWebChallengeHmac(socket.challenge.nonce, secret) }));
  const web = new WebSessionAdapter({ transport });
  t.after(() => web.close());
  if (failure === 'before-dispatch') {
    const original = web.resume.bind(web);
    web.resume = async input => { const binding = await original(input); socket.close(); return binding; };
  }
  return { web, commands };
}

test('local validation reports no dispatch without changing the authenticated transport', async t => {
  const wire = adapterFixture(t, 'after-dispatch');
  await assert.rejects(wire.web.submitTurn({ turnId:'local-reject', controllerMessageId:'local-message',
    runId:'local-run', text:'Review' }), error => {
    assert.equal(error.code, 'WEB_SESSION_NOT_READY');
    assert.equal(error.details.browserDispatchStarted, false); return true;
  });
  await wire.web.resume({ binding:{ sessionId:'local-session', runId:'local-run', tabId:7, windowId:1,
    documentId:'doc', frameId:0, conversationUrl:'https://chatgpt.com/c/test', conversationId:'test', title:null,
    lastObservedUserMessageId:null, lastObservedAssistantMessageId:null, bindingStatus:'BOUND' } });
  for (const [input, code] of [
    [{ runId:'other-run' }, 'DELIVERY_BINDING_MISMATCH'], [{ turnId:'' }, 'INVALID_WEB_TURN'],
    [{ controllerMessageId:null }, 'INVALID_WEB_TURN'], [{ text:' ' }, 'INVALID_WEB_TURN'],
  ]) {
    const before = wire.commands.length;
    await assert.rejects(wire.web.submitTurn({ turnId:'local-reject', controllerMessageId:'local-message',
      runId:'local-run', text:'Review', ...input }), error => {
      assert.equal(error.code, code);
      assert.equal(error.details.browserDispatchStarted, false); return true;
    });
    assert.equal(wire.commands.length, before);
  }
  assert.equal(wire.commands.includes('web.prompt'), false);
  assert.equal((await wire.web.inspect()).authenticated, true);
});

for (const flow of ['audit', 'discussion']) {
  for (const failure of ['before-dispatch', 'transport-send', 'after-dispatch']) {
    test(`${flow}: ${failure} releases only a provably unsent reservation`, async t => {
      const wire = adapterFixture(t, failure);
      let f, initial;
      if (flow === 'audit') f = setupAudit(t, { webSession:wire.web });
      else {
        f = setupAudit(t, { reviewVerdicts:['SATISFIED'] });
        initial = await f.run(); assert.equal(initial.stage, 'AWAITING_APPLY', initial.error);
        f.service.reviewerWeb = () => wire.web;
        f.service.reviewerWebAdapters = () => [wire.web];
      }
      let run;
      if (flow === 'audit') run = await f.run();
      else {
        await assert.rejects(f.dashboard.executeDurable({ type:'code.review.discuss', requestId:`predispatch-${failure}`,
          payload:{ runId:initial.runId, expectedVersion:initial.version, role:'JUDGE', text:'Explain this frozen review.' } }),
        { code:failure === 'before-dispatch' ? 'WEB_SESSION_NOT_READY' : 'REVIEW_DISCUSSION_UNCONFIRMED' });
        run = f.service.get(initial.runId);
        assert.equal(run.reviewDiscussions.at(-1).status, failure === 'before-dispatch' ? 'FAILED' : 'UNCONFIRMED');
      }
      const owner = run.conversationBindings.find(item => item.role === 'JUDGE');
      const prompts = wire.commands.filter(type => type === 'web.prompt');
      assert.equal(prompts.length, failure === 'before-dispatch' ? 0 : 1);
      if (failure === 'before-dispatch') assert.equal(owner.activeDeliveryId, null);
      else assert.equal(typeof owner.activeDeliveryId, 'string');
      assert.equal(wire.commands.includes('web.delivery.ack'), false);
      assert.equal(wire.commands.includes('web.delivery.discard'), false);
      await f.reopen();
      assert.equal(f.service.get(run.runId).conversationBindings.find(item => item.role === 'JUDGE').activeDeliveryId,
        owner.activeDeliveryId);
    });
  }
}
