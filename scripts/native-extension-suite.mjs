import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createControlledPrompt } from '../extension/runtime/markers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.env.BRIDGE_VERIFICATION_OUTPUT ?? path.join(root, '.agent-controller'));
fs.mkdirSync(directory, { recursive: true });
const receiptPath = path.join(directory, 'latest-native-extension.json');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-native-extension-'));
const result = { nativeExtension: true, status: 'RUNNING', platform: process.platform, steps: [], completed: false };
const save = () => fs.writeFileSync(receiptPath, JSON.stringify(result, null, 2) + '\n');
let context, initialized = false;
save();
try {
  const extension = path.join(scratch, 'extension');
  fs.cpSync(path.join(root, 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  const files = manifest.content_scripts[0].js;
  // Production files are copied byte for byte. This test-only prelude counts
  // native listener registrations in the isolated world before automatic init.
  fs.writeFileSync(path.join(extension, 'native-observer.js'), `(function () {
    if (globalThis.nativeBridgeObserver) return;
    const observer = globalThis.nativeBridgeObserver = { registrations: 0 };
    const add = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
    chrome.runtime.onMessage.addListener = listener => { observer.registrations++; return add(listener); };
  })();`);
  for (const entry of manifest.content_scripts) entry.js = ['native-observer.js', ...entry.js];
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    ...(process.env.UI_BROWSER_EXECUTABLE ? { executablePath: process.env.UI_BROWSER_EXECUTABLE } : { channel: 'chromium' }),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    timeout: 15_000,
  });
  result.browser = context.browser()?.version() ?? 'Chromium persistent context';
  let worker = context.serviceWorkers()[0]
    ?? await context.waitForEvent('serviceworker', { timeout: 8000 });
  initialized = true;
  const extensionId = new URL(worker.url()).hostname;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <title>Native extension lifecycle fixture</title><main id="messages"></main>
    <textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button>
    <script>document.querySelector('button').onclick = () => {
      const article = document.createElement('article'); article.setAttribute('data-message-author-role', 'user'); article.id = 'u1';
      const body = document.createElement('div'); body.setAttribute('data-message-content', ''); body.textContent = document.querySelector('textarea').value;
      article.append(body); document.querySelector('main').append(article); document.querySelector('textarea').value = '';
      window.fixtureClicks = (window.fixtureClicks || 0) + 1;
    };</script>` }));
  await page.goto('https://chatgpt.com/c/native-fixture');
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: 'https://chatgpt.com/c/native-fixture' }));
  const ping = async () => worker.evaluate(id => chrome.tabs.sendMessage(id, { type: 'agent.ping' }, { frameId: 0 }), tab.id);
  let observed;
  for (let attempt = 0; attempt < 20; attempt++) {
    observed = await ping().catch(() => null);
    if (observed?.ok) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(observed?.documentId); const original = observed.documentId;
  const pinned = await worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, func: () => location.href }), tab.id);
  const nativeDocumentId = pinned[0].documentId;
  await worker.evaluate(async ({ tabId, documentId, files }) => {
    const inject = () => chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, files });
    await Promise.all([inject(), inject()]);
  }, { tabId: tab.id, documentId: nativeDocumentId, files: ['native-observer.js', ...files] });
  const counters = await worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id },
    func: () => ({ listeners: globalThis.nativeBridgeObserver.registrations, token: globalThis.ChatGptBridgeContentRuntime.documentId }) }), tab.id);
  assert.equal(counters[0].result.listeners, 1); assert.equal(counters[0].result.token, original);
  result.steps.push({ name: 'native automatic injection plus two manual reinjections', pass: true }); save();
  const state = { lastBoundSessionId: 'native-session', lastBoundRunId: 'native-run', currentDeliveryId: 'native-delivery',
    webProvider: 'CHATGPT_WEB', tabId: tab.id, windowId: tab.windowId, documentId: original, frameId: 0,
    conversationUrl: observed.url, conversationId: 'native-fixture', bindingStatus: 'BOUND' };
  await worker.evaluate(value => chrome.storage.local.set(value), state);
  const text = createControlledPrompt({ controllerMessageId: 'native-delivery', runId: 'native-run', text: 'Controlled fixture lifecycle test' });
  await worker.evaluate(({ id, text, documentId, url }) => {
    void chrome.tabs.sendMessage(id, { type: 'agent.prompt', requestId: 'native-delivery', payload: {
      text, expectedDocumentId: documentId, expectedFrameId: 0, expectedConversationUrl: url,
      timeoutMs: 60_000, stableMs: 1000,
    } }).catch(() => {});
  }, { id: tab.id, text, documentId: original, url: observed.url });
  await page.waitForFunction(() => window.fixtureClicks === 1, { timeout: 10_000 });
  assert.equal((await ping()).activeRequestId, 'native-delivery');
  await worker.evaluate(({ tabId, files, documentId }) => chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, files }),
    { tabId: tab.id, files, documentId: nativeDocumentId });
  assert.equal((await ping()).activeRequestId, 'native-delivery');
  result.steps.push({ name: 'native reinjection preserves the active job and document token', pass: true }); save();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const cdp = await context.newCDPSession(page);
  let versions = [];
  cdp.on('ServiceWorker.workerVersionUpdated', event => { versions = event.versions; });
  await cdp.send('ServiceWorker.enable');
  for (let attempt = 0; attempt < 20 && !versions.some(item => item.scriptURL === worker.url()); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  const version = versions.find(item => item.scriptURL === worker.url()); assert.ok(version, 'Native service worker version must be observable');
  const restarted = context.waitForEvent('serviceworker', { timeout: 10_000 });
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'bridge.getState' }));
  worker = await restarted;
  assert.equal((await ping()).documentId, original); assert.equal((await ping()).activeRequestId, 'native-delivery');
  assert.equal(await worker.evaluate(() => chrome.storage.local.get('currentDeliveryId').then(value => value.currentDeliveryId)), 'native-delivery');
  result.steps.push({ name: 'native service worker restart preserves pending delivery and page job', pass: true }); save();
  await worker.evaluate(id => chrome.tabs.sendMessage(id, { type: 'agent.cancel', requestId: 'native-delivery' }), tab.id);
  await page.reload();
  for (let attempt = 0; attempt < 20; attempt++) {
    observed = await ping().catch(() => null); if (observed?.ok && observed.documentId !== original) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.notEqual(observed.documentId, original); assert.equal(observed.busy, false);
  assert.equal(await worker.evaluate(() => chrome.storage.local.get('currentDeliveryId').then(value => value.currentDeliveryId)), 'native-delivery');
  result.steps.push({ name: 'native navigation creates a new token and preserves unresolved ownership', pass: true }); save();
  const reloaded = context.waitForEvent('serviceworker', { timeout: 10_000 });
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  worker = await reloaded;
  assert.equal(await worker.evaluate(() => chrome.storage.local.get('currentDeliveryId').then(value => value.currentDeliveryId)), 'native-delivery');
  assert.equal(await page.evaluate(() => window.fixtureClicks ?? 0), 0);
  result.steps.push({ name: 'native extension reload preserves storage and does not resend', pass: true });
  assert.deepEqual(errors, []); result.status = 'PASS';
} catch (error) {
  result.status = initialized ? 'FAIL' : 'UNVERIFIED'; result.error = error.message;
  process.exitCode = initialized ? 1 : 2;
} finally {
  try { await context?.close(); } catch (error) { result.status = 'FAIL'; result.cleanupError = error.message; process.exitCode = 1; }
  fs.rmSync(scratch, { recursive: true, force: true }); result.completed = true; save();
  console.log('NATIVE_EXTENSION_RESULT ' + JSON.stringify(result));
}
