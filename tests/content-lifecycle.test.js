import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createBrowserRuntime } from '../extension/runtime/browser-runtime.js';
import { installCurrentTargetTracking } from '../extension/runtime/current-target.js';
import { createCoalescedTask } from '../extension/runtime/coalesced-task.js';
import { createActiveTurnGate } from '../extension/runtime/turn-guard.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url)));
const scripts = manifest.content_scripts[0].js.map(file => [file, fs.readFileSync(new URL('../extension/' + file, import.meta.url), 'utf8')]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const event = () => { const listeners = []; return { addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } }; };

function contentWorld({ active = false } = {}) {
  const listeners = [], window = {}; window.top = window;
  const context = vm.createContext({ URL, crypto, window, location: { href: 'https://chatgpt.com/c/test' },
    document: { title: 'Fixture' }, AbortController, DOMException, setTimeout, clearTimeout,
    console: { info() {} }, chrome: { runtime: { getManifest: () => manifest,
      sendMessage: async () => {}, onMessage: { addListener(fn) { listeners.push(fn); } } } } });
  for (const [file, source] of scripts) {
    if (active && file === 'content.js') {
      const provider = { provider: 'CHATGPT_WEB', rootUrl: 'https://chatgpt.com/', assertContract() {},
        canonicalizeUrl: value => value, conversationIdFromUrl: () => 'test', resetEvidence() {},
        readConversationIdentity: () => ({ conversationUrl: 'https://chatgpt.com/c/test', conversationId: 'test' }),
        inspectPageState: () => ({ status: 'READY', composerPresent: true }), evidence: () => ({}),
        readMessages: () => [], detectGeneration: () => false, cancelGeneration() {},
        submitPrompt: (_text, signal) => new Promise((_, reject) => signal.addEventListener('abort',
          () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) };
      context.WebBridgePageProviders = { resolve: () => provider, provider: () => provider };
    }
    vm.runInContext(source, context, { filename: file });
  }
  const reinject = () => { for (const [file, source] of scripts) vm.runInContext(source, context, { filename: file }); };
  const send = message => new Promise(resolve => listeners[0](message, {}, resolve));
  return { context, listeners, reinject, send };
}

test('all manifest files can be injected twice with one listener, document and provider registry', () => {
  const f = contentWorld();
  const before = f.context.ChatGptBridgeContentRuntime;
  const providers = f.context.WebBridgePageProviders;
  const provider = providers.provider('CHATGPT_WEB');
  f.reinject(); f.reinject();
  assert.equal(f.listeners.length, 1);
  assert.equal(f.context.ChatGptBridgeContentRuntime, before);
  assert.equal(f.context.WebBridgePageProviders, providers);
  assert.equal(providers.provider('CHATGPT_WEB'), provider);
  assert.notEqual(contentWorld().context.ChatGptBridgeContentRuntime.documentId, before.documentId);
});

test('reinjection preserves an active prompt and the cancellation owner', async () => {
  const f = contentWorld({ active: true });
  const first = await f.send({ type: 'agent.ping' });
  const completion = f.send({ type: 'agent.prompt', requestId: 'delivery', payload: {
    expectedDocumentId: first.documentId, expectedFrameId: 0,
    expectedConversationUrl: first.url, expectedConversationId: 'test',
    controllerMessageId: 'delivery', runId: 'run', text: '[controller_message_id:delivery]\n[run_id:run]\nFixture',
  } });
  f.reinject();
  const during = await f.send({ type: 'agent.ping' });
  assert.equal(during.busy, true); assert.equal(during.activeRequestId, 'delivery');
  assert.equal(during.documentId, first.documentId);
  assert.equal((await f.send({ type: 'agent.cancel', requestId: 'unrelated' })).cancelled, false);
  assert.equal((await f.send({ type: 'agent.cancel', requestId: 'delivery' })).cancelled, true);
  assert.equal((await completion).code, 'TURN_INTERRUPTED');
  assert.equal((await f.send({ type: 'agent.ping' })).busy, false);
});

function browserHarness() {
  const models = new Map([7, 8].map(id => [id, { id, url: 'https://chatgpt.com/c/test', status: 'complete', ready: false, present: false, documentId: 'content-' + id }]));
  const injections = [], probes = [], pings = [];
  const chrome = { runtime: { getManifest: () => manifest }, windows: { update: async () => {} },
    tabs: { get: async id => ({ ...models.get(id) }), update: async () => {}, onUpdated: event(), onRemoved: event(),
      sendMessage: async id => {
        pings.push(id); const model = models.get(id);
        if (model.ping) return model.ping();
        if (!model.present) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { ok: true, ready: model.ready, pageStatus: 'READY', busy: model.busy ?? false,
          activeRequestId: model.busy ? 'active-delivery' : null, documentId: model.documentId, frameId: 0 };
      } },
    scripting: { executeScript: async options => {
      const id = options.target.tabId, model = models.get(id);
      if (options.func) {
        probes.push(id); model.probe?.();
        return [{ frameId: 0, documentId: 'chrome-' + model.documentId, result: { url: model.url, initialized: model.present } }];
      }
      injections.push(id);
      if (model.failure) throw new Error(model.failure);
      assert.deepEqual(options.target.documentIds, ['chrome-' + model.documentId]);
      await delay(5); model.present = true; model.ready = true;
      return [{ frameId: 0, documentId: 'chrome-' + model.documentId }];
    } } };
  return { chrome, models, injections, probes, pings, runtime: createBrowserRuntime(chrome) };
}

test('concurrent callers on one tab share one document-pinned file injection', async () => {
  const f = browserHarness();
  const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => f.runtime.waitForContentScript(7, 2000, i % 2 === 0)));
  assert.equal(f.injections.length, 1); assert.equal(f.probes.length, 1);
  assert.ok(replies.every(reply => reply.documentId === 'content-7'));
  assert.ok(f.pings.length <= 4);
});

test('automatic injection finishing before the manual probe prevents another file injection', async () => {
  const f = browserHarness(); f.models.get(7).probe = () => { f.models.get(7).present = true; f.models.get(7).ready = true; };
  await f.runtime.waitForContentScript(7, 2000, true);
  assert.equal(f.probes.length, 1); assert.equal(f.injections.length, 0);
});

test('different tabs prepare independently', async () => {
  const f = browserHarness();
  await Promise.all([7, 8].map(id => f.runtime.waitForContentScript(id, 2000, true)));
  assert.deepEqual(f.injections.sort(), [7, 8]);
});

test('composer requirements and per-caller timeouts survive shared polling', async () => {
  const f = browserHarness(), model = f.models.get(7); model.present = true;
  const short = assert.rejects(f.runtime.waitForContentScript(7, 50, true), { code: 'UI_CONTRACT_CHANGED' });
  const long = f.runtime.waitForContentScript(7, 1500, true);
  const presence = await f.runtime.waitForContentScript(7, 100, false);
  assert.equal(presence.ready, false); await short;
  model.ready = true; assert.equal((await long).ready, true);
  assert.equal(f.injections.length, 0);
});

test('navigation rejects an old result without invalidating the new preparation', async () => {
  const f = browserHarness(), old = deferred(), model = f.models.get(7);
  model.ping = () => old.promise;
  const rejected = assert.rejects(f.runtime.waitForContentScript(7, 1500, true), { code: 'WEB_DOCUMENT_CHANGED' });
  await delay(10);
  model.ping = null; model.present = true; model.ready = true; model.documentId = 'new-document';
  f.chrome.tabs.onUpdated.emit(7, { status: 'loading' });
  const fresh = f.runtime.waitForContentScript(7, 1000, true);
  old.resolve({ ok: true, ready: true, documentId: 'old-document', frameId: 0 });
  await rejected;
  assert.equal((await fresh).documentId, 'new-document');
  assert.equal(f.injections.length, 0);
});

test('worker restart pings an existing busy document without resetting or injecting it', async () => {
  const f = browserHarness(), model = f.models.get(7); model.present = true; model.ready = true; model.busy = true;
  const restarted = createBrowserRuntime(f.chrome);
  const reply = await restarted.waitForContentScript(7, 1000, false);
  assert.equal(reply.busy, true); assert.equal(reply.activeRequestId, 'active-delivery');
  assert.equal(reply.documentId, model.documentId); assert.equal(f.injections.length, 0);
});

test('injection failure is retained across calls and navigation alone permits a new attempt', async () => {
  const f = browserHarness(), model = f.models.get(7); model.failure = 'Cannot access contents of the page';
  const expected = error => error.code === 'CONTENT_SCRIPT_INJECTION_FAILED' && error.cause.message === model.failure;
  await assert.rejects(f.runtime.waitForContentScript(7, 2000), expected);
  await assert.rejects(f.runtime.waitForContentScript(7, 2000), expected);
  assert.equal(f.injections.length, 1);
  model.failure = null; f.chrome.tabs.onUpdated.emit(7, { status: 'loading' });
  await f.runtime.waitForContentScript(7, 2000); assert.equal(f.injections.length, 2);
});

for (const message of ['The message port closed before a response was received.', 'Extension context invalidated.', 'Permission denied']) {
  test('a non-receiver messaging failure never triggers injection: ' + message, async () => {
    const f = browserHarness(); f.models.get(7).ping = async () => { throw new Error(message); };
    await assert.rejects(f.runtime.waitForContentScript(7, 1000), { code: 'CONTENT_SCRIPT_CONNECTION_FAILED' });
    assert.equal(f.probes.length, 0); assert.equal(f.injections.length, 0);
  });
}

test('a timed-out last caller leaves no background polling or late injection', async () => {
  const f = browserHarness();
  await assert.rejects(f.runtime.waitForContentScript(7, 50), { code: 'CONTENT_SCRIPT_UNAVAILABLE' });
  const count = f.pings.length; await delay(400);
  assert.equal(f.pings.length, count); assert.equal(f.injections.length, 0);
});

test('tab and focus bursts coalesce observations and do not commit a stale selected tab', async () => {
  const tabs = { get: async id => ({ id, windowId: 3, url: 'https://chatgpt.com/c/test' }),
    query: async () => [], onActivated: event(), onRemoved: event() };
  const windows = { onFocusChanged: event(), WINDOW_ID_NONE: -1 };
  const waits = new Map(), updates = [];
  installCurrentTargetTracking({ tabs, windows, store: { update: async patch => updates.push(patch), read: async () => ({}) },
    waitForContentScript: id => { const item = deferred(); waits.set(id, item); return item.promise; } });
  tabs.onActivated.emit({ tabId: 7 }); await delay(1);
  for (let i = 0; i < 100; i++) tabs.onActivated.emit({ tabId: 7 });
  assert.equal(waits.size, 1);
  tabs.onActivated.emit({ tabId: 8 }); await delay(1);
  const page = { ok: true, url: 'https://chatgpt.com/c/test', conversationId: 'test', documentId: 'new', frameId: 0 };
  waits.get(7).resolve(page); waits.get(8).resolve(page); await delay(10);
  assert.equal(updates.length, 1); assert.equal(updates[0].lastActiveWebTarget.tabId, 8);
});

test('topology and popup burst scheduling retains one operation and one latest follow-up', async () => {
  const first = deferred(), calls = [];
  const task = createCoalescedTask(async value => { calls.push(value); if (calls.length === 1) await first.promise; });
  const pending = task('initial'); await delay(0);
  for (let i = 0; i < 100; i++) assert.equal(task(i), pending);
  first.resolve(); await pending; assert.deepEqual(calls, ['initial', 99]);
  await task('after'); assert.deepEqual(calls, ['initial', 99, 'after']);
});

test('concurrent session preparation cannot race a prompt or change another pending binding', async () => {
  const pending = deferred(), messages = [], gate = createActiveTurnGate();
  const background = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const context = vm.createContext({ bridgeLog() {}, turnGate: gate, lastError: null,
    prepareBoundSession: async () => pending.promise, rebindSession: async () => pending.promise,
    store: { update: async () => {}, read: async () => ({ currentDeliveryId: 'old' }) },
    broadcastPopupState() {}, diagnosticError: error => error.code,
    errorPayload: error => ({ code: error.code }), send: message => messages.push(message),
    deliveryDetails: async () => ({ currentDeliveryId: 'old' }) });
  vm.runInContext(background.slice(background.indexOf('async function handlePrepare('), background.indexOf('async function handleDeliveryAcknowledgement(')), context);
  const first = context.handlePrepare({ requestId: 'first', payload: {} }, false);
  assert.equal(gate.active, true); assert.throws(() => gate.reserve('prompt'), { code: 'WEB_SESSION_BUSY' });
  await context.handlePrepare({ requestId: 'second', payload: {} }, false);
  assert.equal(messages[0].payload.code, 'WEB_SESSION_BUSY'); assert.equal(gate.activeRequestId, 'first');
  pending.resolve({ sessionId: 's', runId: 'r' }); await first;
  assert.equal(messages[1].type, 'web.session.ready'); assert.equal(gate.active, false);
});
