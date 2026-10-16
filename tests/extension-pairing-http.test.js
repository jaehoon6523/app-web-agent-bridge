import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createBridgeServer } from '../src/server.js';
import { computeWebChallengeHmac } from '../src/runtime/web/auth.js';

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(message) { this.sent.push(JSON.parse(message)); }
  close() { this.readyState = 3; this.emit('close'); }
}

const secret = 'extension-pairing-http-fixture-secret-0123456789';
function present(transport, identity) {
  const socket = new Socket();
  transport.attach(socket);
  const challenge = socket.sent[0];
  socket.emit('message', JSON.stringify({ type: 'extension.auth.response', protocolVersion: 2,
    challengeId: challenge.challengeId, extensionIdentity: identity,
    hmacSha256: computeWebChallengeHmac(challenge.nonce, secret) }));
  return socket;
}

test('HTTP pairing requires explicit confirmation, refuses active ownership, and persists an approved identity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-pairing-http-'));
  const config = { host: '127.0.0.1', port: 0, baseUrl: 'http://127.0.0.1:0', workspace: root,
    demoMode: false, persistence: { databasePath: path.join(root, 'controller.sqlite') },
    dashboard: { token: 'extension-pairing-dashboard-token-0123456789' },
    webExtension: { enabled: true, sharedSecret: secret, expectedExtensionIdentity: 'old-identity' },
    relay: { webResponseTimeoutMs: 1000 } };
  let active = false;
  const createLiveRuntime = async () => ({ codeChanges: { list: () => [], jobs: new Map(), workers: new Map(),
    busy: () => active, reviewerWebBusy: () => false },
  store: { listRuns: () => [], getDelivery: () => null }, close: async () => {} });
  const bridge = createBridgeServer({ runtimeConfig: config, createLiveRuntime });
  let restarted;
  t.after(async () => {
    const errors = [];
    // Both servers own queued writes in this directory. Drain both before removal.
    for (const instance of [restarted,bridge]) {
      try { await instance?.close(); } catch (error) { errors.push(error); }
    }
    if (!errors.length) {
      try { assert.deepEqual(fs.readdirSync(path.join(root,'diagnostics')),['runtime-latest.json']); }
      catch (error) { errors.push(error); }
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors,'Pairing fixture cleanup failed.');
  });
  const old = present(bridge.extensionTransport, 'new-identity');
  assert.equal(old.sent.at(-1).code, 'AUTH_IDENTITY_MISMATCH');
  let address;
  try { address = await bridge.listen(); }
  catch (error) {
    if (error.code === 'EPERM') { t.skip('This sandbox disallows listening on loopback. Run on Windows for HTTP coverage.'); return; }
    throw error;
  }
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${config.dashboard.token}`, Origin: config.baseUrl,
    'Content-Type': 'application/json' };
  const body = { candidateIdentity: 'new-identity', expectedCurrentIdentity: 'old-identity',
    unresolvedStateConfirmed: true };
  const post = input => fetch(base + '/api/extension-pairing', { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal((await post({ ...body, unresolvedStateConfirmed: false })).status, 409);
  active = true;
  const blocked = await post(body);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, 'WEB_SESSION_BUSY');
  assert.equal(fs.existsSync(path.join(root, 'extension-pairing.json')), false);
  active = false;
  assert.equal((await post({ ...body, candidateIdentity: 'different' })).status, 409);
  const approved = await post(body);
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).status, 'APPROVED');
  assert.equal((await post(body)).status, 409);
  assert.equal((await (await fetch(base + '/api/extension-pairing', { headers })).json()).currentIdentity, 'new-identity');
  const connected = present(bridge.extensionTransport, 'new-identity');
  assert.equal(connected.sent.at(-1).type, 'controller.auth.accepted');
  assert.equal(bridge.extensionTransport.authenticated, true);
  restarted = createBridgeServer({ runtimeConfig: config, createLiveRuntime });
  assert.equal(restarted.extensionTransport.pendingPairing, null);
  const fromRestart = present(restarted.extensionTransport, 'new-identity');
  assert.equal(fromRestart.sent.at(-1).type, 'controller.auth.accepted');
  assert.deepEqual(fs.readFileSync(path.join(root, 'extension-pairing', 'events.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line).phase), ['STARTED', 'COMPLETED']);
});
