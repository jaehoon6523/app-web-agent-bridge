import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto as crypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const owner = { currentDeliveryId: 'delivery_01', sessionId: 'session_01', runId: 'run_01', conversationUrl: 'https://chatgpt.com/c/test' };
const tick = () => new Promise(resolve => setImmediate(resolve));

function node() {
  const listeners = new Map();
  return { hidden: false, checked: false, disabled: false, textContent: '', value: '', options: [],
    addEventListener(name, listener) { listeners.set(name, listener); },
    async fire(name) { return listeners.get(name)?.(); },
    replaceChildren(...children) { this.options = children; },
  };
}
function dom() {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  return { get, document: { getElementById: get, querySelector: name => get(name.slice(1)), createElement: () => node() } };
}
async function controller(initial, after, outcome = { discarded: true }) {
  const ui = dom(); let current = initial, posted = null, readCount = 0;
  const fetch = async (url, opts = {}) => {
    if (url === '/api/dashboard/session') return { ok: true, json: async () => ({ token: 'session' }) };
    if (url.startsWith('/api/delivery-review?')) {
      readCount++;
      if (current?.inspectionError) return { ok: false, json: async () => ({ error: current.inspectionError }) };
      return { ok: true, json: async () => current };
    }
    if (url === '/api/delivery-review/ack') {
      if (outcome?.networkError) throw new Error(outcome.networkError);
      if (outcome?.httpError) return { ok: false, status: 409, json: async () => ({ error: outcome.httpError }) };
      current = after;
      return { ok: true, json: async () => ({ acknowledged: true }) };
    }
    if (url === '/api/delivery-review/discard') {
      posted = JSON.parse(opts.body);
      if (outcome?.networkError) throw new Error(outcome.networkError);
      if (outcome?.httpError) return { ok: false, status: 409, json: async () => ({ error: outcome.httpError }) };
      current = after;
      return { ok: true, json: async () => outcome };
    }
    throw Error('Unexpected request ' + url);
  };
  const script = await fs.readFile(path.join(root, 'public/delivery-recovery.js'), 'utf8');
  vm.runInNewContext(script, { document: ui.document, location: { search: '?' + new URLSearchParams(owner) },
    URL, URLSearchParams, AbortSignal, fetch }, { filename: 'delivery-recovery.js' });
  await tick();
  return { ...ui, posted: () => posted, readCount: () => readCount };
}
const record = { kind: 'PREPARATION', active: false, state: 'RECOVERY_DISCARDED', responseStored: false };
const before = { server: { status: 'MATCHED', records: [record], otherActive: false }, extension: {
  exact: true, discardConfirmed: false, ackConfirmed: false, extensionBusy: false, otherActive: false,
  pageReachable: false, pageIdentityConfirmed: false, pageBusy: null, generating: null,
  terminalDiscardProtocol: 1, hasCompletedDelivery: false, phase: 'UNRESOLVED' } };
const verified = { server: before.server, extension: { ...before.extension, exact: false, discardConfirmed: true } };

test('controller: default summary, detailed raw data, explicit uncertain-page consent and verified receipt', async () => {
  const ui = await controller(before, verified);
  assert.match(ui.get('recordStatus').textContent, /기록 불일치/);
  assert.match(ui.get('serverState').textContent, /이미 폐기/);
  assert.match(ui.get('extensionState').textContent, /소유권이 남아/);
  assert.match(ui.get('chatgptState').textContent, /미확정/);
  assert.match(ui.get('details').textContent, /terminalDiscardProtocol/);
  ui.get('ownership').checked = true;
  ui.get('reason').value = 'Operator reviewed';
  await ui.get('reason').fire('input');
  assert.equal(ui.get('discard').disabled, true, 'Unreachable page still needs explicit consent');
  ui.get('pageUnknown').checked = true;
  await ui.get('pageUnknown').fire('input');
  assert.equal(ui.get('discard').disabled, false);
  await ui.get('discard').fire('click');
  assert.equal(ui.readCount(), 2, 'Reinspection is required after mutation');
  assert.equal(ui.posted().noAutomaticResendConfirmed, ui.get('ownership').checked);
  assert.equal(ui.posted().terminalDiscardConfirmed, true);
  assert.equal(ui.posted().unresolvedResultConfirmed, true);
  assert.match(ui.get('status').textContent, /정리 완료/);
  assert.match(ui.get('status').textContent, /ChatGPT 처리 결과는 미확정/);
});

test('controller: a successful mutation response without persisted receipt is not success', async () => {
  const ui = await controller(before, before);
  ui.get('ownership').checked = true;
  ui.get('pageUnknown').checked = true;
  ui.get('reason').value = 'Operator reviewed';
  await ui.get('reason').fire('input');
  await ui.get('discard').fire('click');
  assert.match(ui.get('status').textContent, /최종 폐기 영수증을 확인하지 못했습니다/);
  assert.doesNotMatch(ui.get('status').textContent, /정리 완료/);
});

test('controller: generation in progress cannot enable discard', async () => {
  const running = { ...before, extension: { ...before.extension, generating: true } };
  const ui = await controller(running, running);
  ui.get('ownership').checked = true;
  ui.get('pageUnknown').checked = true;
  ui.get('reason').value = 'Operator reviewed';
  await ui.get('reason').fire('input');
  assert.equal(ui.get('discard').disabled, true);
});

test('controller: ownership change rejection and post-mutation reinspection failure stay distinct', async () => {
  const denied = await controller(before, before, { httpError: 'DELIVERY_RECOVERY_MISMATCH' });
  denied.get('ownership').checked = true;
  denied.get('pageUnknown').checked = true;
  denied.get('reason').value = 'Operator reviewed';
  await denied.get('reason').fire('input');
  await denied.get('discard').fire('click');
  assert.match(denied.get('status').textContent, /실행 거절/);
  assert.match(denied.get('status').textContent, /DELIVERY_RECOVERY_MISMATCH/);
  assert.doesNotMatch(denied.get('status').textContent, /정리 완료/);

  const uncertain = await controller(before, { inspectionError: 'Inspection disconnected' });
  uncertain.get('ownership').checked = true;
  uncertain.get('pageUnknown').checked = true;
  uncertain.get('reason').value = 'Operator reviewed';
  await uncertain.get('reason').fire('input');
  await uncertain.get('discard').fire('click');
  assert.match(uncertain.get('status').textContent, /정리 요청 후 최종 재확인 실패/);
  assert.match(uncertain.get('status').textContent, /Inspection disconnected/);
  assert.doesNotMatch(uncertain.get('status').textContent, /정리 완료/);
  assert.match(uncertain.get('serverState').textContent, /확인 불가/);
  assert.match(uncertain.get('extensionState').textContent, /확인 불가/);
  assert.equal(uncertain.get('details').textContent, '');
  assert.equal(uncertain.get('discard').disabled, true);
});

test('popup: MATCHED routes to controller and MISSING alone exposes orphan action', async () => {
  const ui = dom(); let serverStatus = 'MATCHED', discarded = false, backgroundListener;
  let phase = 'UNRESOLVED', otherActive = false;
  let currentDeliveryId = owner.currentDeliveryId;
  const sendMessage = async message => {
    if (message.type === 'bridge.getState') return { ok: true, state: {
      currentDeliveryId: discarded ? null : currentDeliveryId, tabId: 42,
      connected: true, bindingStatus: 'BOUND', extensionVersion: '0.2.5' } };
    if (message.type === 'bridge.inspectDelivery') return { ok: true, result: {
      owner, phase, server: { status: serverStatus, otherActive, records: [{ active: false, state: 'RECOVERY_DISCARDED' }] },
      page: { reachable: false, busy: null, generating: null }, extensionBusy: false } };
    if (message.type === 'bridge.openController') { assert.deepEqual({ ...message.payload }, { ...owner }); return { ok: true }; }
    if (message.type === 'bridge.discardOrphanDelivery') {
      assert.equal(serverStatus, 'MISSING');
      assert.equal(message.payload.noAutomaticResendConfirmed, ui.get('ownershipConfirmed').checked);
      assert.equal(message.payload.orphanOwnershipCleanupConfirmed, true);
      discarded = true;
      return { ok: true, result: { discarded: true, receiptVerified: true } };
    }
    throw Error('Unexpected message: ' + message.type);
  };
  const script = await fs.readFile(path.join(root, 'extension/popup.js'), 'utf8');
  vm.runInNewContext(script, { document: ui.document, chrome: { runtime: { sendMessage,
    onMessage: { addListener(listener) { backgroundListener = listener; } } } },
    URL, Blob, setTimeout }, { filename: 'popup.js' });
  await tick();
  await ui.get('inspectDelivery').fire('click');
  assert.equal(ui.get('orphanDiscardPanel').hidden, true);
  assert.equal(ui.get('openRecovery').hidden, false);
  assert.equal(ui.get('discardOrphan').disabled, true);
  assert.match(ui.get('recoveryActionState').textContent, /컨트롤러에서/);
  assert.match(ui.get('recoveryDetail').textContent, /기록 불일치/);
  await ui.get('openRecovery').fire('click');
  assert.match(ui.get('recoveryDetail').textContent, /컨트롤러에서/);
  serverStatus = 'MISSING';
  phase = 'RESPONSE_OBSERVED';
  await ui.get('inspectDelivery').fire('click');
  assert.equal(ui.get('orphanDiscardPanel').hidden,false);
  assert.equal(ui.get('discardOrphan').disabled,true);
  assert.match(ui.get('recoveryDetail').textContent,/완료 응답이 남아 있음/);
  phase = 'UNRESOLVED'; otherActive = true;
  await ui.get('inspectDelivery').fire('click');
  assert.equal(ui.get('discardOrphan').disabled,true);
  otherActive = false;
  await ui.get('inspectDelivery').fire('click');
  assert.equal(ui.get('orphanDiscardPanel').hidden, false);
  assert.equal(ui.get('openRecovery').hidden, true);
  ui.get('ownershipConfirmed').checked = true;
  ui.get('discardReason').value = 'Operator reviewed';
  await ui.get('discardReason').fire('input');
  assert.equal(ui.get('discardOrphan').disabled, true);
  ui.get('pageUnconfirmed').checked = true;
  await ui.get('pageUnconfirmed').fire('change');
  assert.equal(ui.get('discardOrphan').disabled, false);
  await ui.get('discardOrphan').fire('click');
  assert.equal(ui.get('deliveryRecovery').hidden, true);
  assert.match(ui.get('recoveryOutcome').textContent, /영수증 확인됨/);
  assert.match(ui.get('recoveryOutcome').textContent, /ChatGPT 처리 결과는 미확정/);
  currentDeliveryId = 'replacement';
  backgroundListener({type:'bridge.state',payload:{currentDeliveryId,connected:true,bindingStatus:'BOUND'}});
  assert.equal(ui.get('recoveryOutcome').textContent,'', 'A new owner cannot inherit the previous result');
});

test('extension orphan: only MISSING can clear ownership, and read-back receipt gates success and replay', async () => {
  const file = await fs.readFile(path.join(root, 'extension/runtime/delivery-review.js'), 'utf8');
  const source = file.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');
  class ExtensionStateError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const matches = (state, expected) => state.currentDeliveryId === null
    && state.lastDeliveryDiscard?.deliveryId === expected.currentDeliveryId
    && state.lastDeliveryDiscard.sessionId === expected.sessionId
    && state.lastDeliveryDiscard.runId === expected.runId
    && state.lastDeliveryDiscard.conversationUrl === expected.conversationUrl;
  const context = { ExtensionStateError, hasExactDiscardReceipt: matches, crypto,
    readDeliveryPage: async () => null, inspectDeliveryPage: async () => ({}), pageDiagnosticMetadata: () => ({}),
    resolveStoredWebTargetProvider: () => null, validateLocalControllerUrl: x => x };
  vm.runInNewContext(source + '\nthis.createDeliveryReview = createDeliveryReview;', context);
  const stored = { currentDeliveryId: owner.currentDeliveryId, lastBoundSessionId: owner.sessionId,
    lastBoundRunId: owner.runId, conversationUrl: owner.conversationUrl, documentId: 'doc', frameId: 0, tabId: 7,
    completedDelivery:null,deliveryScopes:{} };
  const expected = { ...owner, documentId: 'doc', frameId: 0, tabId: 7,
    unresolvedResultConfirmed: true, noAutomaticResendConfirmed: true,
    orphanOwnershipCleanupConfirmed: true, pageStateUnconfirmedConfirmed: true, reason: 'Operator reviewed' };
  let updates = 0, serverStatus = 'MATCHED', stale = false;
  const store = { async read() { return { ...stored }; }, async updateIf(_match, change) {
    updates++;
    if (!stale) Object.assign(stored, change);
  } };
  const gate = { active: false, reserve() { this.active = true; return 'held'; }, release() { this.active = false; } };
  const bridge = context.createDeliveryReview({ store, turnGate: gate, tabs: {},
    inspectServer: async () => ({ status: serverStatus, records: [] }) });
  await assert.rejects(bridge.discardOrphan(expected), { code: 'SERVER_DELIVERY_NOT_MISSING' });
  assert.equal(updates, 0);
  serverStatus = 'MISSING';
  await assert.rejects(bridge.discardOrphan({ ...expected, pageStateUnconfirmedConfirmed: false }),
    { code: 'PAGE_STATE_CONFIRMATION_REQUIRED' });
  assert.equal(updates, 0);
  stale = true;
  await assert.rejects(bridge.discardOrphan(expected), { code: 'DISCARD_UNCONFIRMED' });
  assert.equal(stored.currentDeliveryId, owner.currentDeliveryId);
  stale = false;
  const success = await bridge.discardOrphan(expected);
  assert.equal(success.receiptVerified, true);
  assert.equal(stored.currentDeliveryId, null);
  const again = await bridge.discardOrphan(expected);
  assert.equal(again.receiptVerified, true);
  assert.equal(updates, 2, 'Replay must not re-discard');
});


test('extension: controller navigation refuses a changed delivery snapshot', async () => {
  const file = await fs.readFile(path.join(root, 'extension/runtime/delivery-review.js'), 'utf8');
  const source = file.replace(/^import .*;\s*$/gm, '').replace(/^export /gm, '');
  class ExtensionStateError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const context = { ExtensionStateError, crypto, URL, validateLocalControllerUrl: value => value,
    resolveStoredWebTargetProvider: () => null, readDeliveryPage: async () => null,
    inspectDeliveryPage: async () => ({}), pageDiagnosticMetadata: () => ({}) };
  vm.runInNewContext(source + '\nthis.createDeliveryReview = createDeliveryReview;', context);
  const stored = { currentDeliveryId: 'replacement', lastBoundSessionId: owner.sessionId,
    lastBoundRunId: owner.runId, conversationUrl: owner.conversationUrl, documentId: 'doc',
    frameId: 0, tabId: 7, controllerUrl: 'ws://127.0.0.1:8787' };
  let opened = 0;
  const bridge = context.createDeliveryReview({store:{read: async () => stored},
    tabs:{create:async () => {opened++; return {id:1};}}, turnGate:{}, inspectServer:async () => ({})});
  await assert.rejects(bridge.openController({...owner,documentId:'doc',frameId:0,tabId:7}), {code:'DELIVERY_RECOVERY_MISMATCH'});
  assert.equal(opened,0);
  await bridge.openController(); // The ordinary controller entry point is not bound to a delivery snapshot.
  assert.equal(opened,1);
});

test('controller: explicit decision drives all confirmation flags; unknown request outcome stays uncertain', async () => {
  const ui = await controller(before, before);
  ui.get('reason').value = 'Operator reviewed';
  ui.get('pageUnknown').checked = true;
  await ui.get('reason').fire('input');
  assert.equal(ui.get('discard').disabled,true);
  ui.get('ownership').checked = true;
  await ui.get('ownership').fire('input');
  assert.equal(ui.get('discard').disabled,false);
  await ui.get('discard').fire('click');
  assert.equal(ui.posted().unresolvedResultConfirmed,true);
  assert.equal(ui.posted().noAutomaticResendConfirmed,true);
  assert.equal(ui.posted().terminalDiscardConfirmed,true);
  assert.equal(ui.posted().pageStateUnconfirmedConfirmed,true);
  assert.match(ui.get('actionState').textContent,/정리 가능/);
});


test('controller: lost mutation response is uncertain, never a confirmed rejection', async () => {
  const ui = await controller(before, before, { networkError: 'connection lost after POST' });
  ui.get('ownership').checked = true;
  ui.get('pageUnknown').checked = true;
  ui.get('reason').value = 'Operator reviewed';
  await ui.get('reason').fire('input');
  await ui.get('discard').fire('click');
  assert.match(ui.get('status').textContent, /요청 결과 확인 불가/);
  assert.doesNotMatch(ui.get('status').textContent, /정리 완료|실행 거절/);
});

test('background bridge.openController forwards exact owner snapshot for navigation validation', async () => {
  const source = await fs.readFile(path.join(root, 'extension/background.js'), 'utf8');
  assert.match(source, /deliveryReview\.openController\(message\.payload \?\? null\)/);
  const popup = await fs.readFile(path.join(root, 'extension/popup.js'), 'utf8');
  assert.match(popup, /type: "bridge\.openController", payload: selectedOwner/);
});


test('controller ACK: only verified acknowledgement receipt is completion', async () => {
  const ackBefore = { server: {status:'MATCHED', records:[{kind:'REVIEW',active:true,state:'ACK_PENDING',responseStored:true}],otherActive:false},
    extension: {...before.extension, phase:'ACK_PENDING',exact:true,pageReachable:true,pageIdentityConfirmed:true,pageBusy:false,generating:false} };
  const ackAfter = { server: {status:'MATCHED',records:[{kind:'REVIEW',active:false,state:'ACKNOWLEDGED',responseStored:true}],otherActive:false},
    extension: {...ackBefore.extension,exact:false,ackConfirmed:true,phase:'ACKNOWLEDGED'} };
  const verifiedUi = await controller(ackBefore,ackAfter);
  assert.equal(verifiedUi.get('ack').hidden,false);
  assert.equal(verifiedUi.get('discardPanel').hidden,true);
  assert.match(verifiedUi.get('actionState').textContent,/기록 정리 불가/);
  await verifiedUi.get('ack').fire('click');
  assert.match(verifiedUi.get('status').textContent,/ACK 확인 완료/);
  assert.match(verifiedUi.get('chatgptState').textContent,/응답 저장 근거/);
  const staleUi = await controller(ackBefore,ackBefore);
  await staleUi.get('ack').fire('click');
  assert.match(staleUi.get('status').textContent,/최종 영수증을 확인하지 못했습니다/);
  assert.doesNotMatch(staleUi.get('status').textContent,/ACK 확인 완료/);
});

test('controller: stored response without ACK metadata never offers discard', async () => {
  const response = {server:{status:'MATCHED',records:[{kind:'PREPARATION',active:true,
    state:'RESPONSE_RECEIVED',responseStored:true,processingState:null}],otherActive:false},
    extension:{...before.extension,exact:true,pageReachable:true,pageBusy:false,generating:false}};
  const ui = await controller(response,response);
  assert.equal(ui.get('discardPanel').hidden,true);
  assert.equal(ui.get('discard').disabled,true);
  assert.match(ui.get('chatgptState').textContent,/응답 저장 근거/);
});
test('controller: a completed response belonging to another delivery cannot enable discard', async () => {
  const observed = {server:{status:'MATCHED',records:[{kind:'PREPARATION',active:true,
    state:'UNRESOLVED',responseStored:false,processingState:null}],otherActive:false},
    extension:{...before.extension,exact:true,hasCompletedDelivery:true,phase:'UNRESOLVED',
      pageReachable:true,pageBusy:false,generating:false}};
  const ui = await controller(observed,observed);
  assert.equal(ui.get('discardPanel').hidden,true);
  assert.equal(ui.get('discard').disabled,true);
  assert.match(ui.get('actionState').textContent,/응답 상태 확인/);
  assert.match(ui.get('chatgptState').textContent,/다른 전송의 응답/);
});

test('controller: conflicting ACK metadata and another active owner block the button', async () => {
  const conflict = {server:{status:'MATCHED',records:[{kind:'PREPARATION',active:true,
    state:'UNRESOLVED',responseStored:false,processingState:'ACK_PENDING'}],otherActive:false},
    extension:{...before.extension,exact:true,pageReachable:true,pageBusy:false,generating:false}};
  const conflicting = await controller(conflict,conflict);
  assert.equal(conflicting.get('discardPanel').hidden,true);
  assert.match(conflicting.get('chatgptState').textContent,/일치하지 않습니다/);
  const active = {server:{...conflict.server,otherActive:true,
    records:[{...conflict.server.records[0],processingState:null}]},extension:conflict.extension};
  const ui = await controller(active,active);
  assert.equal(ui.get('discardPanel').hidden,true);
  assert.match(ui.get('actionState').textContent,/다른 작업/);
});
