import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createDeliveryRecoveryActions } from '../src/orchestration/delivery-recovery-actions.js';
import { CodeChangeStore } from '../src/persistence/code-change-store.js';
import { ArtifactStore } from '../src/evidence/artifact-store.js';
import { WebExtensionTransport, WebSessionAdapter, computeWebChallengeHmac } from '../src/runtime/web/index.js';
import { createExtensionStateStore } from '../extension/runtime/storage.js';
import { handleDeliveryAcknowledgement } from '../extension/runtime/delivery-ack.js';
import { createActiveTurnGate } from '../extension/runtime/turn-guard.js';

// Real SQLite, artifacts, authenticated WebSocket, adapters and extension ACK.
// The page/session-ready reply and Chrome storage API are controlled fixtures.
async function fixture(t, { provider = 'CHATGPT_WEB' } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ack-restart-'));
  const url = provider === 'CHATGPT_WEB' ? 'https://chatgpt.com/c/test' : 'https://claude.ai/chat/test';
  const owner = { currentDeliveryId:'d', sessionId:'s', runId:'r', conversationUrl:url };
  const binding = { sessionId:'s', runId:'r', conversationUrl:url, conversationId:'test',
    tabId:7, windowId:3, documentId:'doc', frameId:0, title:null, bindingStatus:'BOUND',
    lastObservedUserMessageId:'u', lastObservedAssistantMessageId:'a' };
  const filename = path.join(scratch, 'controller.sqlite');
  const artifacts = new ArtifactStore(path.join(scratch, 'artifacts'));
  let database = new CodeChangeStore(filename);
  database.save({ runId:'r', stage:'HOLD', conversationBindings:[{ ...binding, role:'JUDGE', provider,
    historyAnchor:{ lastObservedUserMessageId:'u', lastObservedAssistantMessageId:'a' }, activeDeliveryId:'d' }],
    webDeliveryReceipts:[{ deliveryId:'d', sessionId:'s', conversationUrl:url, role:'JUDGE', state:'ACK_PENDING',
      responseRef:artifacts.put('Fixture response'), packetRef:artifacts.put('{"type":"REVIEW_ASSERTIONS"}') }] });
  await database.close();
  database = new CodeChangeStore(filename);
  let saved = { ...binding, lastBoundSessionId:'s', lastBoundRunId:'r', currentDeliveryId:'d' };
  const storage = { get:async () => structuredClone(saved), set:async value => { saved = structuredClone(value); } };
  let store = createExtensionStateStore(storage);
  const gate = createActiveTurnGate(), commands = [];
  const secret = 'fixture-secret-0123456789abcdef0123456789';
  const transport = new WebExtensionTransport({ sharedSecret:secret, expectedExtensionIdentity:'ack-fixture' });
  const web = new WebSessionAdapter({ transport, provider });
  const channel = provider === 'CHATGPT_WEB' ? web : new WebSessionAdapter({ transport });
  const server = new WebSocketServer({ host:'127.0.0.1', port:0 });
  await once(server, 'listening');
  server.on('connection', socket => transport.attach(socket));
  let socket, dropAck = false, prepareError = null, returned = binding, otherScopes = [], otherContexts = [], onPrepare = () => {};
  async function connect() {
    const authenticated = once(transport, 'authenticated');
    socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    socket.on('message', raw => {
      const message = JSON.parse(String(raw)); commands.push(message.type);
      const reply = value => socket.send(JSON.stringify({ ...value, protocolVersion:2 }));
      if (message.type === 'controller.auth.challenge') {
        reply({ type:'extension.auth.response', challengeId:message.challengeId, extensionIdentity:'ack-fixture',
          hmacSha256:computeWebChallengeHmac(message.nonce, secret) });
      } else if (message.type === 'web.delivery.inspect') {
        void store.read().then(state => reply({ type:'web.delivery.inspected', requestId:message.requestId, payload:{
          ...owner, currentDeliveryId:state.currentDeliveryId, lastAcknowledgedDelivery:state.lastAcknowledgedDelivery,
          pageReachable:true, pageBusy:false, generating:false, extensionBusy:false, scopedDeliveries:otherScopes,
          hasCompletedDelivery:false } }));
      } else if (message.type === 'web.session.prepare') {
        assert.equal(message.payload.createNewConversation, undefined);
        assert.equal(message.payload.sessionId, owner.sessionId);
        assert.equal(message.payload.runId, owner.runId);
        assert.equal(message.payload.conversationUrl, owner.conversationUrl);
        assert.equal(message.payload.provider, provider);
        onPrepare();
        reply(prepareError ? { type:'web.session.error', requestId:message.requestId,
          payload:{ code:prepareError, message:'Fixture session unavailable' } }
          : { type:'web.session.ready', requestId:message.requestId, payload:{ session:returned } });
      } else if (message.type === 'web.delivery.ack') {
        assert.equal(database.get('r').webDeliveryReceipts[0].state, 'ACK_PENDING');
        assert.equal(database.get('r').conversationBindings[0].activeDeliveryId, 'd');
        void handleDeliveryAcknowledgement({ store, turnGate:gate, message, broadcastPopupState:() => {}, send:value => {
          if (dropAck) { dropAck = false; socket.close(); } else reply(value);
        } });
      }
    });
    await authenticated;
  }
  t.after(async () => {
    // Shutdown order matters on Windows: terminate WebSocket ownership,
    // close the *current* SQLite connection (including one from reopen()),
    // and only then unlink the fixture directory.
    const failures = [];
    try { await web.close(); } catch (error) { failures.push(error); }
    try {
      socket?.terminate();
      for (const peer of server.clients) peer.terminate();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } catch (error) { failures.push(error); }
    try { await database.close(); } catch (error) { failures.push(error); }
    try { fs.rmSync(scratch, { recursive:true, force:true }); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'ACK fixture resource cleanup failed');
  });
  await connect();
  const codeChanges = { jobs:new Map(), workers:new Map(), reviewerWebBusy:() => false, artifactStore:artifacts,
    reviewerWeb:(role, expectedProvider) => {
      assert.equal(role, 'JUDGE'); assert.equal(expectedProvider, provider); return web;
    }, get:id => database.get(id), update:(id, patch) => {
      const run = database.get(id); return database.save({ ...run, ...patch }, run.version);
    } };
  // The inspection channel may use a different provider adapter on the shared transport.
  const actions = createDeliveryRecoveryActions({ web:channel,
    getSources:async () => ({ contexts:otherContexts, runs:database.list() }), getServices:async () => ({ codeChanges }) });
  return { owner, binding, actions, web, transport, commands, codeChanges, artifacts,
    run:() => database.get('r'), read:() => store.read(), connect,
    drop:() => { dropAck = true; }, prepareError:value => { prepareError = value; }, returned:value => { returned = value; },
    onPrepare:callback => { onPrepare = callback; },
    otherScopes:value => { otherScopes = value; }, otherContexts:value => { otherContexts = value; },
    async reopen() { await database.close(); database = new CodeChangeStore(filename); store = createExtensionStateStore(storage); } };
}

for (const change of ['same-session-owner', 'other-server-owner']) {
  test(`ACK waits for restored binding and refuses ${change} appearing during restoration`, async t => {
    const f = await fixture(t);
    f.onPrepare(() => {
      if (change === 'same-session-owner') f.codeChanges.update('r', {
        conversationBindings:[{ ...f.run().conversationBindings[0], activeDeliveryId:'new' }] });
      else f.otherContexts([{ preparationId:'other', webSession:{ sessionId:'other', activeDeliveryId:'other' }, deliveries:[] }]);
    });
    await assert.rejects(f.actions.acknowledge(f.owner), { code:'WEB_SESSION_BUSY' });
    assert.equal(f.run().conversationBindings[0].activeDeliveryId, change === 'same-session-owner' ? 'new' : 'd');
    assert.equal(f.run().webDeliveryReceipts[0].state, 'ACK_PENDING');
    assert.equal((await f.read()).currentDeliveryId, 'd');
    assert.equal(f.commands.includes('web.delivery.ack'), false);
    assert.equal(f.commands.includes('web.prompt'), false);
  });
}

for (const provider of ['CHATGPT_WEB', 'CLAUDE_WEB']) {
  test(`${provider}: reopened ACK_PENDING restores its exact role binding and settles without a prompt`, async t => {
    const f = await fixture(t, { provider });
    assert.equal((await f.web.inspect()).binding, null);
    await f.actions.acknowledge(f.owner);
    await f.actions.acknowledge(f.owner);
    await f.reopen();
    await f.actions.acknowledge(f.owner);
    assert.equal(f.run().conversationBindings[0].activeDeliveryId, null);
    assert.equal(f.run().webDeliveryReceipts[0].state, 'ACKNOWLEDGED');
    assert.equal((await f.read()).currentDeliveryId, null);
    assert.equal(f.commands.filter(type => type === 'web.session.prepare').length, 1);
    assert.equal(f.commands.filter(type => type === 'web.delivery.ack').length, 1);
    assert.equal(f.commands.includes('web.prompt'), false);
  });
}

test('lost ACK reply retains the SQLite owner and retries the exact extension receipt after reconnect', async t => {
  const f = await fixture(t); f.drop();
  await assert.rejects(f.actions.acknowledge(f.owner), { code:'EXTENSION_DISCONNECTED' });
  assert.equal(f.run().conversationBindings[0].activeDeliveryId, 'd');
  assert.equal(f.run().webDeliveryReceipts[0].state, 'ACK_PENDING');
  assert.equal((await f.read()).currentDeliveryId, null);
  await f.connect(); await f.reopen();
  await f.actions.acknowledge(f.owner);
  assert.equal(f.run().conversationBindings[0].activeDeliveryId, null);
  assert.equal(f.commands.filter(type => type === 'web.delivery.ack').length, 2);
  assert.equal(f.commands.includes('web.prompt'), false);
});

for (const failure of ['page-missing', 'identity-changed', 'different-adapter', 'other-server', 'other-scope', 'missing-evidence']) {
  test(`ACK restoration preserves both owners on ${failure}`, async t => {
    const f = await fixture(t);
    let code;
    if (failure === 'page-missing') { f.prepareError('NEEDS_REBIND'); code = 'NEEDS_REBIND'; }
    if (failure === 'identity-changed') { f.returned({ ...f.binding, conversationUrl:'https://chatgpt.com/c/other', conversationId:'other' }); code = 'WEB_SESSION_BINDING_MISMATCH'; }
    if (failure === 'different-adapter') { f.transport.setBinding({ ...f.binding, sessionId:'other' }); code = 'DELIVERY_RECOVERY_MISMATCH'; }
    if (failure === 'other-server') { f.otherContexts([{ preparationId:'other', webSession:{ sessionId:'other', activeDeliveryId:'other' }, deliveries:[] }]); code = 'WEB_SESSION_BUSY'; }
    if (failure === 'other-scope') { f.otherScopes([{ sessionId:'other', deliveryId:'other' }]); code = 'WEB_SESSION_BUSY'; }
    if (failure === 'missing-evidence') { f.artifacts.removeIfUnreferenced(f.run().webDeliveryReceipts[0].responseRef.sha256); code = 'ARTIFACT_NOT_FOUND'; }
    await assert.rejects(f.actions.acknowledge(f.owner), { code });
    assert.equal(f.run().conversationBindings[0].activeDeliveryId, 'd');
    assert.equal(f.run().webDeliveryReceipts[0].state, 'ACK_PENDING');
    assert.equal((await f.read()).currentDeliveryId, 'd');
    assert.equal(f.commands.includes('web.delivery.ack'), false);
    assert.equal(f.commands.includes('web.prompt'), false);
    if (!['page-missing', 'identity-changed'].includes(failure)) assert.equal(f.commands.includes('web.session.prepare'), false);
  });
}
