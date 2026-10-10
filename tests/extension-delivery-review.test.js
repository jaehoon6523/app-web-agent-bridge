import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createExtensionStateStore } from '../extension/runtime/storage.js';
import { createDeliveryReview, deliveryOwner, createServerDeliveryInspector } from '../extension/runtime/delivery-review.js';
import { discardExactDelivery } from '../extension/runtime/delivery-discard.js';
import { createActiveTurnGate } from '../extension/runtime/turn-guard.js';
import { handleDeliveryAcknowledgement } from '../extension/runtime/delivery-ack.js';
import { classifyDeliveryOwnership, inspectDeliveryOwnership, installDeliveryOwnershipInspection } from '../src/orchestration/delivery-ownership.js';
import { createDeliveryRecoveryActions } from '../src/orchestration/delivery-recovery-actions.js';
import { persistWebDeliveryReceipt } from '../src/orchestration/web-delivery-receipts.js';
import { setupAudit } from './helpers/audit-fixtures.js';
import { diagnosticError, diagnosticMetadata } from '../extension/runtime/document-binding.js';
import { createBridgeServer } from '../src/server.js';
import { reviewerRoleSummary } from '../public/run-context-view.js';
import os from 'node:os';
import path from 'node:path';

async function harness({ serverStatus = 'MISSING', serverRecords = [], page = {}, stored = {} } = {}) {
  let saved = { lastBoundSessionId: 's', lastBoundRunId: 'r', conversationUrl: 'https://chatgpt.com/c/test',
    conversationId: 'test', tabId: 7, windowId: 3, documentId: 'doc', frameId: 0,
    bindingStatus: 'AMBIGUOUS', currentDeliveryId: 'd', ...stored };
  const store = createExtensionStateStore({ get: async () => structuredClone(saved), set: async value => { saved = structuredClone(value); } });
  const turnGate = createActiveTurnGate(), opened = [];
  const tabs = { sendMessage: async () => ({ ok: true, busy: false, generating: false, documentId: 'doc', ...page }),
    get: async () => ({ id: 7, url: 'https://chatgpt.com/c/test' }), update: async (...value) => opened.push(value),
    create: async value => opened.push(value) };
  let inspected = 0;
  const review = createDeliveryReview({ store, turnGate, tabs, inspectServer: async () => {
    inspected++; return { status: serverStatus, records: serverRecords }; } });
  const owner = deliveryOwner(await store.read());
  return { store, turnGate, review, owner, opened, tabs, inspected: () => inspected,
    discard: (patch = {}) => review.discardOrphan({ ...owner, unresolvedResultConfirmed: true,
      noAutomaticResendConfirmed: true, serverMissingConfirmed: true, reason: 'Operator reviewed the original conversation', ...patch }) };
}

test('popup never presents AMBIGUOUS plus unresolved delivery plus ready root as success', () => {
  const ids = ['status','detail','controllerUrl','sharedSecret','save','reconnect','legacyRecovery','clearLegacy',
    'deliveryRecovery','recoveryDetail','inspectDelivery','openDelivery','openController','discardOrphan','discardReason',
    'unresolvedConfirmed','noResendConfirmed','serverMissingConfirmed','pageUnconfirmed'];
  const nodes = Object.fromEntries(ids.map(id => [id, { value: '', textContent: '', checked: false }]));
  const context = vm.createContext({ document: { querySelector: selector => nodes[selector.slice(1)] }, chrome: { runtime: {} } });
  const source = fs.readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('async function refresh(')), context);
  context.state = { connected: true, bindingStatus: 'AMBIGUOUS', currentDeliveryId: 'd', busy: false,
    startTab: { tabId: 8, ready: true }, bindingError: 'CONTENT_SCRIPT_INJECTION_FAILED: Original cause',
    bindingRecovery: { message: 'Inspect this delivery' }, deliveryPhase: 'UNRESOLVED' };
  vm.runInContext('render({ok:true,state})', context);
  assert.equal(nodes.status.className, 'badge bad'); assert.equal(nodes.status.textContent, '전송 확인 필요');
  assert.match(nodes.detail.textContent, /Original cause/u); assert.match(nodes.detail.textContent, /Inspect this delivery/u);
  assert.match(nodes.detail.textContent, /tab 8/u); assert.equal(nodes.deliveryRecovery.hidden, false);
});

for (const [label, stored, server, phase] of [
  ['unknown result', {}, [], 'UNRESOLVED'],
  ['local response awaiting server validation', { completedDelivery: { turnId: 'd', text: 'Must not leak' } }, [], 'RESPONSE_OBSERVED'],
  ['durable response awaiting ACK', { completedDelivery: { turnId: 'd' } }, [{ processingState: 'ACK_PENDING', responseStored: true }], 'ACK_PENDING'],
]) {
  test('inspection distinguishes ' + label + ' and excludes response bytes', async () => {
    const f = await harness({ stored, serverStatus: server.length ? 'MATCHED' : 'MISSING', serverRecords: server });
    const result = await f.review.inspect(); assert.equal(result.phase, phase);
    assert.doesNotMatch(JSON.stringify(result), /Must not leak/u);
    assert.equal((await f.store.read()).currentDeliveryId, 'd');
  });
}

test('orphan discard requires all explicit confirmations and an exact ownership snapshot', async () => {
  const f = await harness();
  await assert.rejects(f.discard({ unresolvedResultConfirmed: false }), { code: 'DISCARD_CONFIRMATION_REQUIRED' });
  await assert.rejects(f.discard({ serverMissingConfirmed: false }), { code: 'DISCARD_CONFIRMATION_REQUIRED' });
  await assert.rejects(f.discard({ documentId: 'different' }), { code: 'DELIVERY_RECOVERY_MISMATCH' });
  assert.equal((await f.store.read()).currentDeliveryId, 'd');
  assert.equal(f.turnGate.active, false);
  const result = await f.discard(); assert.equal(result.discarded, true);
  const after = await f.store.read(); assert.equal(after.currentDeliveryId, null);
  assert.equal(after.bindingStatus, 'NEEDS_REBIND'); assert.equal(after.lastDeliveryDiscard.runId, 'r');
});

for (const status of ['MATCHED', 'MISMATCH', 'UNAVAILABLE']) {
  test('a ' + status + ' server record blocks orphan discard without deleting anything', async () => {
    const f = await harness({ serverStatus: status });
    await assert.rejects(f.discard(), { code: 'SERVER_DELIVERY_NOT_MISSING' });
    assert.equal((await f.store.read()).currentDeliveryId, 'd');
  });
}

test('active generation and unreachable pages require distinct handling', async () => {
  const active = await harness({ page: { busy: true, generating: true } });
  await assert.rejects(active.discard(), { code: 'WEB_SESSION_BUSY' });
  const unknown = await harness({ page: { ok: false, busy: null, generating: null } });
  await assert.rejects(unknown.discard(), { code: 'PAGE_STATE_CONFIRMATION_REQUIRED' });
  await unknown.discard({ pageStateUnconfirmedConfirmed: true });
  assert.equal((await unknown.store.read()).currentDeliveryId, null);
});

test('ownership drift during server inspection cannot clear a different delivery', async () => {
  const f = await harness();
  const review = createDeliveryReview({ store: f.store, turnGate: f.turnGate, tabs: f.tabs,
    inspectServer: async () => { await f.store.update({ currentDeliveryId: 'new-owner' }); return { status: 'MISSING' }; } });
  await assert.rejects(review.discardOrphan({ ...f.owner, unresolvedResultConfirmed: true,
    noAutomaticResendConfirmed: true, serverMissingConfirmed: true, reason: 'Inspected' }), { code: 'DELIVERY_RECOVERY_MISMATCH' });
  assert.equal((await f.store.read()).currentDeliveryId, 'new-owner');
});

test('read-only conversation navigation does not clear or resend a delivery', async () => {
  const f = await harness(); await f.review.openConversation(f.owner);
  assert.deepEqual(f.opened, [[7, { active: true }]]);
  assert.equal((await f.store.read()).currentDeliveryId, 'd');
  await assert.rejects(f.review.openConversation({ ...f.owner, runId: 'other' }), { code: 'DELIVERY_RECOVERY_MISMATCH' });
});

test('a lost ACK reply can be retried idempotently but cannot clear another delivery', async () => {
  const f = await harness(); const messages = [];
  const ack = () => handleDeliveryAcknowledgement({ store: f.store, turnGate: f.turnGate,
    message: { requestId: 'd', payload: { sessionId: 's' } }, send: message => messages.push(message), broadcastPopupState() {} });
  await ack(); await ack();
  assert.deepEqual(messages.map(message => message.type), ['web.delivery.acknowledged', 'web.delivery.acknowledged']);
  await f.store.reserveDelivery('new'); await ack();
  assert.equal(messages[2].payload.code, 'DELIVERY_ACK_MISMATCH');
  assert.equal((await f.store.read()).currentDeliveryId, 'new'); assert.equal(f.turnGate.active, false);
});

test('server-initiated discard preserves an exact receipt and rejects a different owner', async () => {
  const f = await harness(), messages = [];
  const command = patch => discardExactDelivery({ store: f.store, turnGate: f.turnGate, send: message => messages.push(message),
    message: { requestId: 'discard-command', payload: { ...f.owner, unresolvedResultConfirmed: true, noAutomaticResendConfirmed: true,
      reason: 'Explicit operator decision', ...patch } } });
  await command({ runId: 'other' }); assert.equal(messages[0].payload.code, 'DELIVERY_RECOVERY_MISMATCH');
  assert.equal((await f.store.read()).currentDeliveryId, 'd');
  await command(); assert.equal(messages[1].type, 'web.delivery.discarded');
  assert.equal((await f.store.read()).lastDeliveryDiscard.deliveryId, 'd');
  await command(); assert.equal(messages[2].type, 'web.delivery.discarded');
  await f.store.reserveDelivery('new'); await command();
  assert.equal(messages[3].payload.code, 'DELIVERY_RECOVERY_MISMATCH');
  assert.equal((await f.store.read()).currentDeliveryId, 'new');
});

test('authenticated inspection correlates the exact reply and rejects an altered owner', async () => {
  const sent = [], inspector = createServerDeliveryInspector({ send: message => { sent.push(message); return true; } });
  const owner = { currentDeliveryId: 'd', sessionId: 's', runId: 'r', conversationUrl: 'https://chatgpt.com/c/test' };
  const first = inspector.inspect(owner);
  inspector.accept({ type: 'controller.delivery.inspected', requestId: sent[0].requestId,
    payload: { status: 'MISSING', expected: owner, records: [] } });
  assert.equal((await first).status, 'MISSING');
  const second = inspector.inspect(owner);
  inspector.accept({ type: 'controller.delivery.inspected', requestId: sent[1].requestId,
    payload: { status: 'MISSING', expected: { ...owner, runId: 'different' } } });
  await assert.rejects(second, { code: 'DELIVERY_RECOVERY_MISMATCH' });
});

test('missing, different active owner and matching server records are not conflated', () => {
  const expected = { currentDeliveryId: 'd', sessionId: 's', runId: 'r', conversationUrl: 'https://chatgpt.com/c/test' };
  const record = { deliveryId: 'd', sessionId: 's', runId: 'r', conversationUrl: expected.conversationUrl, active: true };
  assert.equal(classifyDeliveryOwnership(expected, []).status, 'MISSING');
  assert.equal(classifyDeliveryOwnership(expected, [record]).status, 'MATCHED');
  assert.equal(classifyDeliveryOwnership(expected, [{ ...record, deliveryId: 'other' }]).status, 'MISMATCH');
  assert.equal(classifyDeliveryOwnership(expected, [{ ...record, runId: 'other' }]).status, 'MISMATCH');
});

test('failed server storage reads yield UNAVAILABLE, never MISSING', async () => {
  const transport = new EventEmitter(); const replies = [];
  transport.send = value => replies.push(value);
  installDeliveryOwnershipInspection({ transport, getSources: async () => { throw new Error('DB unavailable'); } });
  transport.emit('message', { type: 'extension.delivery.inspect', requestId: 'i', payload: { currentDeliveryId: 'd', sessionId: 's', runId: 'r', conversationUrl: 'u' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies[0].payload.status, 'UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(replies), /DB unavailable/u);
});

test('inspection of a durable preparation carries ACK state but no response body', async () => {
  const expected = { currentDeliveryId: 'd', sessionId: 's', runId: 'r', conversationUrl: 'https://chatgpt.com/c/test' };
  const sources = async () => ({ runs: [], contexts: [{ preparationId: 'r', webSession: { sessionId: 's', conversationUrl: expected.conversationUrl,
    activeDeliveryId: 'd' }, deliveries: [{ deliveryId: 'd', sessionId: 's', state: 'RESPONSE_COMPLETED', processingState: 'ACK_PENDING', response: { rawText: 'PRIVATE' } }] }] });
  const result = await inspectDeliveryOwnership(expected, sources);
  assert.equal(result.status, 'MATCHED'); assert.equal(result.records[0].processingState, 'ACK_PENDING');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/u);
});

test('review response receipt is durable before ACK and final owner release', async t => {
  const f = setupAudit(t, { reviewVerdicts: ['SATISFIED'] });
  const web = f.options.webSession, original = web.acknowledgeDelivery;
  let checked = 0;
  web.acknowledgeDelivery = async function(input) {
    const run = f.service.list()[0], receipt = run.webDeliveryReceipts.find(item => item.deliveryId === input.turnId);
    assert.equal(receipt.state, 'ACK_PENDING');
    assert.ok(run.conversationBindings.some(binding => binding.activeDeliveryId === input.turnId));
    assert.equal(f.options.artifactStore.verify(receipt.responseRef.sha256), true);
    checked++; return original.call(this, input);
  };
  const run = await f.run(); assert.equal(run.stage, 'AWAITING_APPLY', run.error);
  assert.ok(checked >= 2); assert.ok(run.webDeliveryReceipts.every(receipt => receipt.state === 'ACKNOWLEDGED'));
  await f.reopen(); assert.equal(f.service.get(run.runId).webDeliveryReceipts.length, run.webDeliveryReceipts.length);
});

test('receipt persistence rejects different bytes under the same delivery identity', () => {
  let run = { conversationBindings: [{ role: 'JUDGE', sessionId: 's', activeDeliveryId: 'd' }], webDeliveryReceipts: [] };
  const service = { get: () => run, update: (_id, patch) => { run = { ...run, ...patch }; },
    artifactStore: { put: value => ({ sha256: value }) } };
  const response = { turnId: 'd', binding: { runId: 'r', sessionId: 's', conversationUrl: 'u' }, body: 'First', packet: { type: 'REVIEW_ASSERTIONS' } };
  persistWebDeliveryReceipt(service, 'r', 'JUDGE', 'd', response);
  persistWebDeliveryReceipt(service, 'r', 'JUDGE', 'd', response);
  assert.equal(run.webDeliveryReceipts.length, 1);
  assert.throws(() => persistWebDeliveryReceipt(service, 'r', 'JUDGE', 'd', { ...response, body: 'Different' }), { code: 'DELIVERY_RECEIPT_MISMATCH' });
});

function recoveryHarness() {
  const owner = { currentDeliveryId: 'd', sessionId: 's', runId: 'r', conversationUrl: 'https://chatgpt.com/c/test' };
  let run = { runId: 'r', conversationBindings: [{ role: 'JUDGE', sessionId: 's', conversationUrl: owner.conversationUrl, activeDeliveryId: 'd' }],
    webDeliveryReceipts: [{ deliveryId: 'd', sessionId: 's', conversationUrl: owner.conversationUrl, state: 'ACK_PENDING',
      responseRef: { sha256: 'response' }, packetRef: { sha256: 'packet' } }] };
  let observed = { ...owner, pageReachable: true, pageBusy: false, generating: false, extensionBusy: false };
  let dropDiscardReply = false, dropAckReply = false, validEvidence = true, discardCalls = 0, ackCalls = 0;
  const codeChanges = { jobs: new Map(), workers: new Map(), reviewerWebBusy: () => false,
    get: () => run, update: (_id, patch) => { run = { ...run, ...patch }; }, artifactStore: { verify: () => validEvidence } };
  const web = { inspect: async () => ({ binding: { ...owner } }), inspectDelivery: async () => structuredClone(observed),
    discardDelivery: async input => {
      assert.equal(run.webDeliveryDiscardIntent.currentDeliveryId, input.currentDeliveryId); discardCalls++;
      observed = { ...observed, currentDeliveryId: null, lastDeliveryDiscard: { ...owner, deliveryId: 'd' } };
      if (dropDiscardReply) { dropDiscardReply = false; throw Object.assign(new Error('Lost reply'), { code: 'EXTENSION_DISCONNECTED' }); }
      return { ...input, result: 'discarded' };
    }, acknowledgeDelivery: async () => {
      assert.equal(run.webDeliveryReceipts[0].state, 'ACK_PENDING'); assert.equal(run.conversationBindings[0].activeDeliveryId, 'd');
      ackCalls++; observed = { ...observed, currentDeliveryId: null, lastAcknowledgedDelivery: { ...owner, deliveryId: 'd' } };
      if (dropAckReply) { dropAckReply = false; throw Object.assign(new Error('Lost reply'), { code: 'EXTENSION_DISCONNECTED' }); }
      return { ...owner, currentDeliveryId: null };
    } };
  const actions = createDeliveryRecoveryActions({ web, getSources: async () => ({ contexts: [], runs: [run] }),
    getServices: async () => ({ codeChanges }) });
  return { actions, codeChanges, owner, run: () => run, observe: patch => { observed = { ...observed, ...patch }; },
    discard: () => actions.discard({ ...owner, reason: 'Reviewed original conversation', unresolvedResultConfirmed: true, noAutomaticResendConfirmed: true }),
    dropDiscard: () => { dropDiscardReply = true; }, dropAck: () => { dropAckReply = true; }, invalidEvidence: () => { validEvidence = false; },
    calls: () => ({ discardCalls, ackCalls }) };
}

test('server discard retains its owner after a lost reply and finalizes only the exact extension receipt', async () => {
  const f = recoveryHarness(); f.dropDiscard();
  await assert.rejects(f.discard(), { code: 'EXTENSION_DISCONNECTED' });
  assert.equal(f.run().conversationBindings[0].activeDeliveryId, 'd');
  const seen = await f.actions.inspect(f.owner); assert.equal(seen.extension.discardConfirmed, true);
  await f.discard(); await f.discard();
  assert.equal(f.run().conversationBindings[0].activeDeliveryId, null); assert.equal(f.run().stage, 'HOLD');
  assert.equal(f.run().webDeliveryReceipts[0].state, 'DISCARDED'); assert.equal(f.calls().discardCalls, 2);
});

test('server discard cannot convert a missing extension record or a new owner into success', async () => {
  const f = recoveryHarness(); f.observe({ currentDeliveryId: null });
  await assert.rejects(f.discard(), { code: 'DELIVERY_RECOVERY_MISMATCH' });
  f.observe({ currentDeliveryId: 'new-owner' });
  await assert.rejects(f.discard(), { code: 'DELIVERY_RECOVERY_MISMATCH' });
  assert.equal(f.run().conversationBindings[0].activeDeliveryId, 'd'); assert.equal(f.calls().discardCalls, 0);
});

test('a server-only owner needs an additional explicit missing-extension confirmation', async () => {
  const f = recoveryHarness(); f.observe({ currentDeliveryId: null });
  await f.actions.discard({ ...f.owner, reason: 'Reviewed server-only ownership', unresolvedResultConfirmed: true,
    noAutomaticResendConfirmed: true, extensionRecordMissingConfirmed: true });
  assert.equal(f.run().conversationBindings[0].activeDeliveryId, null); assert.equal(f.run().webDeliveryReceipts[0].state, 'DISCARDED');
  const parked = recoveryHarness(); parked.observe({ currentDeliveryId: null, scopedDeliveries: [{ sessionId: 's', deliveryId: 'd' }] });
  await assert.rejects(parked.actions.discard({ ...parked.owner, reason: 'Reviewed', unresolvedResultConfirmed: true,
    noAutomaticResendConfirmed: true, extensionRecordMissingConfirmed: true }), { code: 'DELIVERY_RECOVERY_MISMATCH' });
});

test('extension confirms a server-only discard without clearing a new or parked delivery', async () => {
  const f = await harness({ stored: { currentDeliveryId: null } }), messages = [];
  const command = patch => discardExactDelivery({ store: f.store, turnGate: f.turnGate, send: message => messages.push(message),
    message: { requestId: 'discard-server-only', payload: { ...f.owner, currentDeliveryId: 'd', reason: 'Reviewed server owner',
      unresolvedResultConfirmed: true, noAutomaticResendConfirmed: true, ...patch } } });
  await command(); assert.equal(messages[0].payload.code, 'DELIVERY_RECOVERY_MISMATCH');
  await command({ extensionRecordMissingConfirmed: true }); assert.equal(messages[1].type, 'web.delivery.discarded');
  assert.equal((await f.store.read()).lastDeliveryDiscard.remoteAlreadyMissing, true);
  await f.store.reserveDelivery('new'); await command({ extensionRecordMissingConfirmed: true });
  assert.equal(messages[2].payload.code, 'DELIVERY_RECOVERY_MISMATCH'); assert.equal((await f.store.read()).currentDeliveryId, 'new');
});

test('server discard rejects active generation and missing explicit confirmation', async () => {
  const f = recoveryHarness(); f.observe({ generating: true });
  await assert.rejects(f.discard(), { code: 'WEB_SESSION_BUSY' });
  await assert.rejects(f.actions.discard({ ...f.owner, reason: 'Reviewed' }), { code: 'DISCARD_CONFIRMATION_REQUIRED' });
  assert.equal(f.calls().discardCalls, 0);
});

test('ACK recovery checks durable evidence and retains server ownership until the exact reply succeeds', async () => {
  const invalid = recoveryHarness(); invalid.invalidEvidence();
  await assert.rejects(invalid.actions.acknowledge(invalid.owner), { code: 'DELIVERY_RESPONSE_REQUIRED' });
  assert.equal(invalid.calls().ackCalls, 0);
  const f = recoveryHarness(); f.dropAck();
  await assert.rejects(f.actions.acknowledge(f.owner), { code: 'EXTENSION_DISCONNECTED' });
  assert.equal(f.run().conversationBindings[0].activeDeliveryId, 'd'); assert.equal(f.run().webDeliveryReceipts[0].state, 'ACK_PENDING');
  await f.actions.acknowledge(f.owner); await f.actions.acknowledge(f.owner);
  assert.equal(f.calls().ackCalls, 2); assert.equal(f.run().conversationBindings[0].activeDeliveryId, null);
  assert.equal(f.run().webDeliveryReceipts[0].state, 'ACKNOWLEDGED'); assert.equal(f.run().stage, 'HOLD');
});

test('parked deliveries retain ownership, block the same target and can be selected without clearing or sending', async () => {
  const f = await harness();
  await f.store.bindSession({ lastBoundSessionId: 'other-session', lastBoundRunId: 'other-run', tabId: 8,
    windowId: 3, documentId: 'other-doc', frameId: 0, conversationUrl: 'https://chatgpt.com/c/other', conversationId: 'other' });
  assert.equal((await f.store.read()).deliveryScopes.s.lastBoundRunId, 'r');
  await f.store.bindSession({ lastBoundSessionId: 'other-session', lastBoundRunId: 'other-run', tabId: 7,
    windowId: 3, documentId: 'new-doc', frameId: 0, conversationUrl: 'https://chatgpt.com/c/test', conversationId: 'test' });
  await assert.rejects(f.store.reserveDelivery('new'), { code: 'RECOVERY_REQUIRED' });
  await f.review.selectScope({ sessionId: 's', deliveryId: 'd' });
  const restored = await f.store.read(); assert.equal(restored.currentDeliveryId, 'd');
  assert.equal(restored.lastBoundRunId, 'r'); assert.equal(restored.documentId, 'doc');
  await assert.rejects(f.store.bindSession({ lastBoundSessionId: 's', lastBoundRunId: 'different' }), { code: 'DELIVERY_RECOVERY_MISMATCH' });
});

test('old scopes without binding metadata stay preserved and cannot be guessed by the popup', async () => {
  const f = await harness({ stored: { deliveryScopes: { old: { currentDeliveryId: 'legacy' } } } });
  await assert.rejects(f.review.selectScope({ sessionId: 'old', deliveryId: 'legacy' }), { code: 'DELIVERY_SCOPE_OWNER_UNCONFIRMED' });
  assert.equal((await f.store.read()).deliveryScopes.old.currentDeliveryId, 'legacy');
  assert.equal((await f.store.read()).currentDeliveryId, 'd');
});

test('diagnostic metadata excludes response bytes and secrets while preserving injection causes', () => {
  const details = { code: 'CONTENT_SCRIPT_INJECTION_FAILED', causeCode: 'PERMISSION_DENIED',
    completedDelivery: { turnId: 'd', text: 'private-response', packet: { body: 'private-body' } }, sharedSecret: 'private-secret' };
  const logged = JSON.stringify(diagnosticMetadata(details));
  assert.match(logged, /PERMISSION_DENIED/u); assert.doesNotMatch(logged, /private-/u);
  assert.doesNotMatch(diagnosticError({ code: 'INJECTION_FAILED', message: 'Failure', details }), /private-/u);
});

test('dashboard distinguishes a durable ACK wait from an unresolved held reviewer delivery', () => {
  const f = recoveryHarness(), run = { ...f.run(), phase: 'HOLD' };
  const pending = reviewerRoleSummary(run, null, 'JUDGE'); assert.equal(pending.tone, 'warn'); assert.match(pending.status, /ACK/u);
  run.webDeliveryReceipts = [];
  const unknown = reviewerRoleSummary(run, null, 'JUDGE'); assert.equal(unknown.tone, 'warn'); assert.match(unknown.status, /전송 결과 확인/u);
});

test('production HTTP recovery routes enforce read credentials, mutation origin and explicit confirmations', async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-review-http-'));
  const f = recoveryHarness(), token = 'delivery-test-dashboard-token-0123456789';
  const config = { host: '127.0.0.1', port: 0, baseUrl: 'http://127.0.0.1:0', workspace: scratch, demoMode: false,
    persistence: { databasePath: path.join(scratch, 'controller.sqlite') }, dashboard: { token },
    webExtension: { enabled: true, expectedExtensionIdentity: 'delivery-test-extension', sharedSecret: 'delivery-test-extension-secret-0123456789' }, relay: { webResponseTimeoutMs: 1000 } };
  f.codeChanges.list = () => [f.run()];
  const bridge = createBridgeServer({ runtimeConfig: config, createLiveRuntime: async () => ({
    codeChanges: f.codeChanges, store: { getDelivery: () => null }, close: async () => {} }) });
  bridge.webSession.inspectDelivery = async () => ({ ...f.owner, pageReachable: true, pageBusy: false, generating: false, extensionBusy: false });
  t.after(async () => { await bridge.close(); fs.rmSync(scratch, { recursive: true, force: true }); });
  const address = await bridge.listen(), base = 'http://127.0.0.1:' + address.port;
  const query = '/api/delivery-review?' + new URLSearchParams(f.owner);
  assert.equal((await fetch(base + query)).status, 401);
  const response = await fetch(base + query, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200); assert.equal((await response.json()).server.status, 'MATCHED');
  const post = (endpoint, origin, body) => fetch(base + endpoint, { method: 'POST', body: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + token, Origin: origin, 'Content-Type': 'application/json' } });
  assert.equal((await post('/api/delivery-review/discard', 'https://outside.example', f.owner)).status, 403);
  assert.equal((await post('/api/delivery-review/ack', 'https://outside.example', f.owner)).status, 403);
  const missing = await post('/api/delivery-review/discard', config.baseUrl, f.owner);
  assert.equal(missing.status, 409); assert.equal((await missing.json()).code, 'DISCARD_CONFIRMATION_REQUIRED');
  assert.equal(f.run().conversationBindings[0].activeDeliveryId, 'd'); assert.equal(f.calls().discardCalls, 0);
});

test('orphan replay still checks server absence and cannot bypass a newly present server record',async()=>{
  const f=await harness();await f.discard();
  const review=createDeliveryReview({store:f.store,turnGate:f.turnGate,tabs:f.tabs,inspectServer:async()=>({status:'MATCHED',records:[{state:'RECOVERY_DISCARDED'}]})});
  await assert.rejects(review.discardOrphan({...f.owner,reason:'Reviewed',unresolvedResultConfirmed:true,noAutomaticResendConfirmed:true,
    serverMissingConfirmed:true}),{code:'SERVER_DELIVERY_NOT_MISSING'});
  assert.equal((await f.store.read()).lastDeliveryDiscard.deliveryId,'d');
});
