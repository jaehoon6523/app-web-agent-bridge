import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBridgeServer } from '../src/server.js';
import { computeWebChallengeHmac } from '../src/runtime/web/auth.js';

const secret = 'test-only-delivery-secret-0123456789abcdef';
const token = 'test-only-delivery-token-0123456789abcdef';
test('HTTP preparation carries provider diagnostics through inspect, stop, recover and resubmit', async (t) => {
  const config = { host: '127.0.0.1', port: 0, baseUrl: 'http://127.0.0.1:0', workspace: process.cwd(),
    dashboard: { token }, webExtension: { sharedSecret: secret, expectedExtensionIdentity: 'test-extension' }, relay: { webResponseTimeoutMs: 500 } };
  const live = { store: { listRuns: () => [] }, codeChanges: { busy: () => false }, close: async () => {} };
  const bridge = createBridgeServer({ runtimeConfig: config, createLiveRuntime: async () => live });
  t.after(() => bridge.close());
  const address = await bridge.listen(), base = `http://127.0.0.1:${address.port}`;
  const calls = []; let binding, recovered = false;
  let details = { currentDeliveryId: 'old-delivery', runId: 'old-run', sessionId: 'old-session',
    conversationUrl: 'https://chatgpt.com/c/old', pageReachable: true, pageBusy: true, generating: true,
    extensionBusy: true, activeRequestId: 'old-delivery', observedConversationUrl: 'https://chatgpt.com/c/old', pageStatus: 'READY' };
  class Socket extends EventEmitter {
    readyState = 1;
    close() { this.readyState = 3; this.emit('close'); }
    send(raw) {
      const m = JSON.parse(raw); calls.push(m.type);
      queueMicrotask(() => {
        const reply = (type, payload) => this.emit('message', JSON.stringify({ type, protocolVersion: 2, requestId: m.requestId, payload }));
        if (m.type === 'controller.auth.challenge') this.emit('message', JSON.stringify({ type: 'extension.auth.response', protocolVersion: 2,
          challengeId: m.challengeId, extensionIdentity: 'test-extension', hmacSha256: computeWebChallengeHmac(m.nonce, secret) }));
        if (m.type === 'web.session.prepare') {
          if (!recovered) reply('web.session.error', { code: 'REBIND_DURING_ACTIVE_DELIVERY', message: 'blocked', details });
          else { binding = { ...m.payload, tabId: 7, windowId: 1, title: 'test', bindingStatus: 'BOUND', lastObservedUserMessageId: null, lastObservedAssistantMessageId: null }; delete binding.focus; reply('web.session.ready', { session: binding }); }
        }
        if (m.type === 'web.delivery.inspect') reply('web.delivery.inspected', details);
        if (m.type === 'web.delivery.focus') reply('web.delivery.focused', {});
        if (m.type === 'web.delivery.stop') { details = { ...details, pageBusy: false, generating: false, extensionBusy: false }; reply('web.delivery.stopped', details); }
        if (m.type === 'web.delivery.recover') { recovered = true; reply('web.delivery.recovered', details); }
        if (m.type === 'web.prompt') reply('web.prompt.result', { text: '<controller_packet>\n{"type":"REQUIREMENTS_PROPOSAL","summary":"plan","questions":[],"items":[{"statement":"feature","acceptanceCriteria":"visible"}]}\n</controller_packet>', confidence: 'CONFIRMED_BY_UI_STATE', session: binding });
      });
    }
  }
  bridge.extensionTransport.attach(new Socket()); await new Promise(setImmediate);
  const headers = { authorization: `Bearer ${token}`, origin: config.baseUrl, 'content-type': 'application/json' };
  const post = (url, body, h = headers) => fetch(base + url, { method: 'POST', headers: h, body: JSON.stringify(body) });
  assert.equal((await post('/api/project/proposal/session', {}, { 'content-type': 'application/json', origin: config.baseUrl })).status, 401);
  const input = { objective: 'test request', conversationUrl: 'https://chatgpt.com/c/new' };
  let draft = await (await post('/api/project/proposal', input)).json();
  const read = async () => (await fetch(base + '/api/project/proposal', { headers })).json();
  for (let i = 0; i < 20 && draft.status === 'PENDING'; i++) { await new Promise(setImmediate); draft = await read(); }
  assert.equal(draft.status, 'FAILED'); assert.equal(draft.errorDetails.currentDeliveryId, 'old-delivery');
  assert.equal(calls.includes('web.prompt'), false);
  assert.equal((await post('/api/project/proposal/session', { draftId: 'stale', action: 'stop' })).status, 409);
  for (const action of ['inspect', 'focus', 'stop', 'recover']) {
    const response = await post('/api/project/proposal/session', { draftId: draft.draftId, action });
    assert.equal(response.status, 200, await response.clone().text()); draft = await response.json();
  }
  assert.equal(draft.errorDetails.currentDeliveryId, null);
  draft = await (await post('/api/project/proposal', input)).json();
  for (let i = 0; i < 20 && draft.status === 'PENDING'; i++) { await new Promise(setImmediate); draft = await read(); }
  assert.equal(draft.status, 'READY', JSON.stringify(draft));
  assert.equal(calls.filter(type => type === 'web.prompt').length, 1);
});
