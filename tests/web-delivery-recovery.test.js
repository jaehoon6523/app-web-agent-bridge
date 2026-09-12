import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createActiveTurnGate } from '../extension/runtime/turn-guard.js';
import { matchExactConversationTabs } from '../extension/runtime/conversation.js';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf('async function deliveryDetails('), source.indexOf('async function handleFocus('));
function harness(overrides = {}, pageOverrides = {}, tabOverrides = {}) {
  const state = { currentDeliveryId: 'delivery-old', lastBoundSessionId: 'session-old', lastBoundRunId: 'run-old',
    conversationUrl: 'https://chatgpt.com/c/old', conversationId: 'old', tabId: 7, bindingStatus: 'BOUND', ...overrides };
  const page = { ok: true, pageStatus: 'READY', busy: false, generating: false, url: state.conversationUrl, ...pageOverrides };
  // handleDeliveryRecovery re-confirms the exact conversation tab via chrome.tabs.query + matchExactConversationTabs
  // before clearing a delivery (see extension/background.js:391). By default this mock returns the same tab
  // the state already believes is bound, so recovery proceeds exactly as it used to before that check existed.
  const tab = tabOverrides === null ? null : { id: state.tabId, windowId: 1, url: state.conversationUrl, ...tabOverrides };
  const cleared = [], sent = [], gate = createActiveTurnGate();
  const context = vm.createContext({ turnGate: gate, store: { read: async () => state, clearDelivery: async (id) => cleared.push(id),
      update: async (patch) => Object.assign(state, patch) },
    CHATGPT_URL_PATTERNS: ["https://chatgpt.com/*"], matchExactConversationTabs,
    chrome: { tabs: { sendMessage: async (_tab, message) => {
      if (message.type === 'agent.cancel') { page.busy = false; page.generating = false; return { ok: true, cancelled: true }; }
      return page;
    }, query: async () => (tab === null ? [] : [tab]) } }, send: (message) => sent.push(message), broadcastPopupState() {}, sleep: async () => {},
    ExtensionOperationError: class extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } },
    errorPayload: (e) => ({ code: e.code, details: e.details }),
  });
  vm.runInContext(handlers, context);
  const expected = { currentDeliveryId: state.currentDeliveryId, sessionId: state.lastBoundSessionId,
    runId: state.lastBoundRunId, conversationUrl: state.conversationUrl };
  return { state, cleared, sent, gate, stop: (patch = {}) => context.handleDeliveryStop({ requestId: 'stop', payload: { ...expected, ...patch } }),
    recover: (patch = {}) => context.handleDeliveryRecovery({ requestId: 'recovery', payload: {
    currentDeliveryId: state.currentDeliveryId, sessionId: state.lastBoundSessionId, runId: state.lastBoundRunId,
    conversationUrl: state.conversationUrl, ...patch,
  } }) };
}
test('recovery clears only the exact idle delivery and returns identifying evidence', async () => {
  const h = harness(); await h.recover();
  assert.deepEqual(h.cleared, ['delivery-old']);
  assert.equal(h.sent[0].type, 'web.delivery.recovered');
  assert.equal(h.sent[0].payload.runId, 'run-old');
  assert.equal(h.sent[0].payload.generating, false);
  assert.equal(h.gate.active, false);
});
for (const [label, page] of Object.entries({ generating: { generating: true }, active: { busy: true },
  legacy: { busy: undefined, generating: undefined }, unreachable: { ok: false }, wrongConversation: { url: 'https://chatgpt.com/c/other' } })) {
  test(`recovery preserves delivery when ${label}`, async () => {
    const h = harness({}, page); await h.recover();
    assert.equal(h.cleared.length, 0);
    assert.equal(h.sent[0].payload.code, 'DELIVERY_RECOVERY_UNCONFIRMED');
    assert.equal(h.sent[0].payload.details.currentDeliveryId, 'delivery-old');
    assert.equal(h.gate.active, false);
  });
}
test('recovery requires the exact conversation tab to be open (no tab, ambiguous tabs)', async () => {
  const noTab = harness({}, {}, null); await noTab.recover();
  assert.equal(noTab.cleared.length, 0);
  assert.equal(noTab.sent[0].payload.code, 'DELIVERY_RECOVERY_UNCONFIRMED');
  const h2 = harness();
  const ambiguousContext = vm.createContext({ turnGate: h2.gate, store: { read: async () => h2.state },
    CHATGPT_URL_PATTERNS: ["https://chatgpt.com/*"],
    matchExactConversationTabs: () => ({ status: 'AMBIGUOUS', tab: null }),
    chrome: { tabs: { query: async () => [] } }, send: (message) => h2.sent.push(message), broadcastPopupState() {}, sleep: async () => {},
    ExtensionOperationError: class extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } },
    errorPayload: (e) => ({ code: e.code, details: e.details }),
  });
  vm.runInContext(handlers, ambiguousContext);
  await ambiguousContext.handleDeliveryRecovery({ requestId: 'recovery', payload: {
    currentDeliveryId: h2.state.currentDeliveryId, sessionId: h2.state.lastBoundSessionId,
    runId: h2.state.lastBoundRunId, conversationUrl: h2.state.conversationUrl } });
  assert.equal(h2.sent.at(-1).payload.code, 'DELIVERY_RECOVERY_UNCONFIRMED');
});
test('recovery rejects changed delivery identity and concurrent work', async () => {
  const h = harness(); await h.recover({ currentDeliveryId: 'other' });
  assert.equal(h.sent[0].payload.code, 'DELIVERY_RECOVERY_MISMATCH');
  const held = h.gate.reserve('active'); await h.recover();
  assert.equal(h.sent[1].payload.code, 'WEB_SESSION_BUSY');
  assert.equal(h.cleared.length, 0); h.gate.release(held);
});

test('stop targets the exact tracked generation and confirms idle without clearing delivery', async () => {
  const h = harness({}, { busy: true, generating: true, activeRequestId: 'delivery-old' });
  await h.stop();
  assert.equal(h.sent[0].type, 'web.delivery.stopped');
  assert.equal(h.sent[0].payload.generating, false);
  assert.equal(h.cleared.length, 0);
});
test('stop cannot cancel an unrelated or untracked generation', async () => {
  const h = harness({}, { busy: true, generating: true, activeRequestId: 'other' });
  await h.stop();
  assert.equal(h.sent[0].payload.code, 'DELIVERY_STOP_UNAVAILABLE');
  assert.equal(h.cleared.length, 0);
});