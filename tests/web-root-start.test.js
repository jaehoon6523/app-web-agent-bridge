import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverBootstrapAfterNavigation } from '../extension/runtime/bootstrap-recovery.js';
import { createExtensionStateStore } from '../extension/runtime/storage.js';

// Whole content/background scripts and their Web adapter connection are tested
// by npm run test:browser. These are focused recovery policy boundary checks.
function fixture({ current = {}, page = {}, tabUrls = ['https://chatgpt.com/uc/created'] } = {}) {
  const reservedState = { lastBoundSessionId: 's1', lastBoundRunId: 'r1', currentDeliveryId: 'd1',
    tabId: 7, windowId: 3, documentId: 'old-document', frameId: 0,
    conversationUrl: 'https://chatgpt.com/', conversationId: null, bindingStatus: 'ROOT_READY' };
  let saved = { ...reservedState, ...current };
  const sent = [];
  const store = createExtensionStateStore({ get: async () => structuredClone(saved), set: async value => { saved = structuredClone(value); } });
  const observed = { ok: true, url: 'https://chatgpt.com/uc/created', conversationId: 'created',
    documentId: 'new-document', frameId: 0, ...page };
  let tabRead = 0;
  const args = { store, reservedState, tab: { id: 7 }, turnIdentity: { requestId: 'd1', controllerMessageId: 'd1', runId: 'r1' },
    payload: {}, waitForContentScript: async () => observed, sleep: async () => {},
    tabs: { get: async () => ({ id: 7, windowId: 3, url: tabUrls[Math.min(tabRead++, tabUrls.length - 1)] }),
      sendMessage: async (tabId, message) => { sent.push({ tabId, ...message }); return { ok: true }; } } };
  return { args, sent, store };
}

test('bootstrap recovery persists the observed document and requests observation only', async () => {
  const f = fixture();
  const result = await recoverBootstrapAfterNavigation(f.args);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, 'agent.observeSubmittedPrompt');
  assert.equal(f.sent[0].payload.expectedDocumentId, 'new-document');
  assert.equal(f.sent[0].payload.controllerMessageId, 'd1');
  assert.equal(result.frozenTurn.documentId, 'new-document');
  assert.equal((await f.store.read()).currentDeliveryId, 'd1');
});

test('bootstrap recovery waits for a temporary WEB ID to settle', async () => {
  const f = fixture({ tabUrls: [
    'https://chatgpt.com/c/WEB:temporary',
    'https://chatgpt.com/c/created',
  ], page: { url: 'https://chatgpt.com/c/created', conversationId: 'created' } });
  const result = await recoverBootstrapAfterNavigation(f.args);
  assert.equal(result.frozenTurn.conversationId, 'created');
  assert.equal((await f.store.read()).conversationUrl, 'https://chatgpt.com/c/created');
  assert.equal(f.sent.length, 1);
});

for (const current of [{ currentDeliveryId: 'other' }, { lastBoundSessionId: 'other' }, { lastBoundRunId: 'other' }, { tabId: 8 }]) {
  test(`bootstrap rejects a changed ${Object.keys(current)[0]} before observing or promoting`, async () => {
    const f = fixture({ current });
    const before = await f.store.read();
    await assert.rejects(recoverBootstrapAfterNavigation(f.args), { code: 'TURN_BINDING_CHANGED' });
    assert.deepEqual(await f.store.read(), before);
    assert.equal(f.sent.length, 0);
  });
}

for (const page of [{ url: 'https://chatgpt.com/c/other' }, { conversationId: 'other' }, { documentId: null }, { frameId: 1 }]) {
  test(`bootstrap rejects invalid observed ${Object.keys(page)[0]} and keeps the unresolved delivery`, async () => {
    const f = fixture({ page });
    const before = await f.store.read();
    await assert.rejects(recoverBootstrapAfterNavigation(f.args), { code: 'WEB_DOCUMENT_CHANGED' });
    assert.deepEqual(await f.store.read(), before);
    assert.equal(f.sent.length, 0);
  });
}
