import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { inspectChatGptTabs, openInspectedChatGptTab } from '../extension/runtime/tab-diagnostics.js';
import { projectPopupConnectionState } from '../extension/runtime/popup-state.js';
import { createDeliveryReview, deliveryOwner } from '../extension/runtime/delivery-review.js';

const ownerState = { currentDeliveryId: 'delivery-old', lastBoundSessionId: 'session-old',
  lastBoundRunId: 'run-old', conversationUrl: 'https://chatgpt.com/', documentId: 'doc-old',
  frameId: 0, tabId: 1, bindingStatus: 'AMBIGUOUS', bindingError: 'UI_CONTRACT_CHANGED: tab 9 failed' };
const readyPage = { ok: true, ready: true, busy: false, generating: false,
  composerPresent: true, pageUrl: 'https://chatgpt.com/', documentId: 'doc-old', runtimeVersion: '0.2.4' };

test('multiple root tab diagnosis is read-only and excludes response and prompt content', async () => {
  const calls = [], saved = structuredClone(ownerState);
  const tabs = { query: async () => [{ id: 1, url: 'https://chatgpt.com/' },
    { id: 2, url: 'https://chatgpt.com/' }, { id: 3, url: 'https://example.com/' }],
  sendMessage: async (id, message, options) => {
    calls.push({ id, message, options });
    return id === 1 ? { ...readyPage, title: 'Private title', prompt: 'Private prompt', response: 'Private response' }
      : { ...readyPage, ready: false, composerPresent: false, runtimeVersion: '0.2.1',
        inspectionError: { code: 'UI_CONTRACT_CHANGED', message: 'Composer unavailable', stack: 'Private stack' } };
  }};
  const result = await inspectChatGptTabs(tabs);
  assert.equal(result.length, 2); assert.equal(result[0].ready, true); assert.equal(result[1].ready, false);
  assert.equal(result[1].inspectionError.code, 'UI_CONTRACT_CHANGED');
  assert.doesNotMatch(JSON.stringify(result), /Private/);
  assert.deepEqual(calls.map(call => call.message.type), ['agent.ping', 'agent.ping']);
  assert.ok(calls.every(call => call.options.frameId === 0));
  assert.deepEqual(saved, ownerState);
});

test('tab diagnosis handles receiver failure and does not claim readiness across navigation', async () => {
  const result = await inspectChatGptTabs({ query: async () => [1, 2].map(id => ({ id, url: 'https://chatgpt.com/' })),
    sendMessage: async id => { if (id === 1) throw new Error('No receiver');
      return { ...readyPage, pageUrl: 'https://chatgpt.com/c/other' }; } });
  assert.equal(result[0].reachable, false); assert.equal(result[0].ready, false);
  assert.equal(result[1].reachable, true); assert.equal(result[1].ready, false);
});

test('opening an inspected tab only focuses it and rejects closed, changed, or unsupported targets', async () => {
  const focused = [], tabs = { get: async id => ({ id, url: 'https://chatgpt.com/' }),
    update: async (...args) => focused.push(args) };
  await openInspectedChatGptTab(tabs, { tabId: 2, url: 'https://chatgpt.com/' });
  assert.deepEqual(focused, [[2, { active: true }]]);
  await assert.rejects(openInspectedChatGptTab(tabs, { tabId: 2, url: 'https://chatgpt.com/c/old' }), /주소가 변경/);
  await assert.rejects(openInspectedChatGptTab(tabs, { tabId: 2, url: 'https://example.com/' }), /ChatGPT 탭/);
  await assert.rejects(openInspectedChatGptTab({ ...tabs, get: async () => { throw new Error('Closed'); } },
    { tabId: 2, url: 'https://chatgpt.com/' }), /닫혔거나/);
  assert.equal(focused.length, 1);
});

test('multiple roots preserve pending ownership and still inspect the bound page', async () => {
  const saved = structuredClone(ownerState), queried = [];
  const result = await projectPopupConnectionState({ store: { read: async () => saved,
    updateIf: async () => { throw new Error('Must not mutate'); } },
  chromeApi: { tabs: { query: async () => [1, 2].map(id => ({ id, url: 'https://chatgpt.com/' })),
    sendMessage: async id => { queried.push(id); return { ...readyPage, activeRequestId: saved.currentDeliveryId }; } } },
  turnGate: { active: false }, authenticated: true, socket: { readyState: 1 } });
  assert.equal(result.deliveryPhase, 'IN_FLIGHT'); assert.equal(result.contentVersion, '0.2.4');
  assert.deepEqual(queried, [1]); assert.equal(result.bindingStatus, 'AMBIGUOUS');
  assert.deepEqual(result.deliveryOwner, deliveryOwner(saved)); assert.deepEqual(saved, ownerState);
});

test('an active request in a different document does not certify the owned delivery is in flight', async () => {
  const review = createDeliveryReview({ store: { read: async () => ownerState }, turnGate: { active: false },
    tabs: { sendMessage: async () => ({ ...readyPage, documentId: 'doc-new', activeRequestId: ownerState.currentDeliveryId }) },
    inspectServer: async () => ({ status: 'MISSING', records: [] }) });
  const result = await review.inspect(); assert.equal(result.phase, 'UNRESOLVED');
  assert.equal(result.page.documentMatches, false);
});

function popupFixture() {
  const ids = [...fs.readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8').matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  const node = () => ({ value: '', textContent: '', checked: false, disabled: false, handlers: {}, options: [],
    addEventListener(type, handler) { this.handlers[type] = handler; },
    replaceChildren(...children) { this.options = children; this.value = children[0]?.value ?? ''; } });
  const nodes = Object.fromEntries(ids.map(id => [id, node()])), sent = [];
  const state = { ...ownerState, connected: true, deliveryPhase: 'UNRESOLVED', extensionVersion: '0.2.4',
    deliveryOwner: deliveryOwner(ownerState) };
  const context = vm.createContext({ document: { querySelector: selector => nodes[selector.slice(1)], createElement: node },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
      sent.push(message);
      if (message.type === 'bridge.getState') return { ok: true, state };
      if (message.type === 'bridge.inspectDelivery') return { ok: true, result: {
        owner: deliveryOwner(ownerState), phase: 'UNRESOLVED', server: { status: 'MISSING' },
        page: { reachable: true, busy: false, generating: false }, extensionBusy: false } };
      if (message.type === 'bridge.inspectTabs') return { ok: true, result: [
        { tabId: 1, url: 'https://chatgpt.com/', reachable: true, ready: false, composerPresent: false, runtimeVersion: '0.2.1' },
        { tabId: 9, url: 'https://chatgpt.com/', reachable: true, ready: true, composerPresent: true, runtimeVersion: '0.2.4' }] };
      return { ok: true };
    } } } });
  vm.runInContext(fs.readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8'), context);
  return { nodes, sent, state, context };
}

test('popup allows another tab to be diagnosed and opened while the original delivery stays unresolved', async () => {
  const f = popupFixture(); await vm.runInContext('refresh()', f.context);
  await f.nodes.inspectTabs.handlers.click();
  assert.equal(f.nodes.diagnosticTab.options.length, 2);
  assert.match(f.nodes.tabDiagnosticDetail.textContent, /전송 소유 탭/);
  assert.match(f.nodes.tabDiagnosticDetail.textContent, /콘텐츠 버전이 다릅니다/);
  f.nodes.diagnosticTab.value = '9'; f.nodes.diagnosticTab.handlers.change();
  assert.match(f.nodes.tabDiagnosticDetail.textContent, /별도 탭/);
  await f.nodes.openDiagnosticTab.handlers.click();
  assert.equal(f.sent.at(-1).type, 'bridge.openInspectedTab');
  assert.equal(f.sent.at(-1).payload.tabId, 9);
  assert.equal(f.state.currentDeliveryId, ownerState.currentDeliveryId);
  assert.equal(f.nodes.status.textContent, '전송 확인 필요');
  assert.match(f.nodes.detail.textContent, /저장된 실패 원인/);
  assert.ok(f.sent.every(message => !/discard|prepare|sendTurn|selectDelivery/.test(message.type)));
});

test('popup invalidates server inspection when ownership changes with the same delivery ID', async () => {
  const f = popupFixture(); await vm.runInContext('refresh()', f.context);
  await f.nodes.inspectDelivery.handlers.click();
  const confirmations = ['unresolvedConfirmed', 'noResendConfirmed', 'serverMissingConfirmed'];
  confirmations.forEach(id => { f.nodes[id].checked = true; }); f.nodes.discardReason.value = 'Reviewed';
  f.nodes.discardReason.handlers.input(); assert.equal(f.nodes.discardOrphan.disabled, false);
  f.state.deliveryOwner = { ...f.state.deliveryOwner, documentId: 'different-document' };
  await vm.runInContext('refresh()', f.context);
  assert.equal(f.nodes.discardOrphan.disabled, true); assert.equal(f.nodes.openDelivery.disabled, true);
  assert.ok(confirmations.every(id => !f.nodes[id].checked));
});
