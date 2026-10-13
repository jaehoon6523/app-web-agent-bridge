import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createControlledPrompt } from '../extension/runtime/markers.js';
import { nativeExtensionComplete, sendNativePrompt } from './native-extension-contract.js';

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
    headless: true, viewport:null, ignoreDefaultArgs: ['--disable-extensions'],
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
  result.steps.push({ id:'injection', name: 'native automatic injection plus two manual reinjections', pass: true }); save();
  const state = { lastBoundSessionId: 'native-session', lastBoundRunId: 'native-run', currentDeliveryId: 'native-delivery',
    webProvider: 'CHATGPT_WEB', tabId: tab.id, windowId: tab.windowId, documentId: original, frameId: 0,
    conversationUrl: observed.url, conversationId: 'native-fixture', bindingStatus: 'BOUND' };
  await worker.evaluate(value => chrome.storage.local.set(value), state);
  const popup = await context.newPage();
  popup.on('dialog', dialog => dialog.accept());
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  for (const style of ['display:none', 'visibility:hidden', 'width:0;height:0;padding:0;border:0;min-width:0;min-height:0']) {
    await page.locator('#prompt-textarea').evaluate((element, value) => element.setAttribute('style', value), style);
    const inspected = await popup.evaluate(() => chrome.runtime.sendMessage({ type:'bridge.inspectTabs' }));
    assert.equal(inspected.ok, true);
    const snapshot = inspected.result.find(item => item.tabId === tab.id);
    assert.equal(snapshot.composerPresent, false); assert.equal(snapshot.ready, false);
    assert.equal(snapshot.documentId, original); assert.equal(snapshot.frameId, 0);
    assert.equal(snapshot.transport.status, 'RESPONDED'); assert.equal(snapshot.transport.tabStatus, 'FOUND');
    const counts = snapshot.diagnostics.composerSelectors.find(item => item.selector === '#prompt-textarea');
    assert.equal(counts.matched, 1); assert.equal(counts.visible, 0);
    assert.equal(counts.samples[0].acceptedByVisibility, false);
    assert.equal(snapshot.pageState.readyState, 'complete');
  }
  await popup.locator('#inspectTabs').click();
  await popup.locator('#diagnosticTab').selectOption(String(tab.id));
  await popup.locator('#includeRawDiagnostic').check();
  const downloading = popup.waitForEvent('download');
  await popup.locator('#exportAgentDiagnostics').click();
  const download = await downloading, stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const exportedTab = report.popupObservation.tabs.find(item => item.tabId === tab.id);
  assert.equal(exportedTab.composerPresent, false);
  assert.equal(exportedTab.documentId, original);
  assert.equal(exportedTab.diagnostics.composerSelectors.find(item => item.selector === '#prompt-textarea').visible, 0);
  assert.match(report.popupObservation.tabDetail, /문서 ID\(콘텐츠 토큰\)/u);
  assert.equal(await worker.evaluate(() => chrome.storage.local.get('currentDeliveryId').then(value => value.currentDeliveryId)), 'native-delivery');
  assert.equal(await page.evaluate(() => window.fixtureClicks ?? 0), 0);
  await page.locator('#prompt-textarea').evaluate(element => element.removeAttribute('style'));
  const inspectedVisible = await popup.evaluate(() => chrome.runtime.sendMessage({ type:'bridge.inspectTabs' }));
  assert.equal(inspectedVisible.result.find(item => item.tabId === tab.id).diagnostics.composerSelectors[0].visible, 1);
  result.steps.push({ id:'diagnostic-export', name:'native composer visibility evidence reaches the actual popup download without dispatch or clearing ownership', pass:true }); save();
  const ownerKeys = Object.keys(state);
  const readOwner = () => worker.evaluate(keys => chrome.storage.local.get(keys), ownerKeys);
  const ownerBefore = await readOwner();
  const opened = context.waitForEvent('page');
  await popup.locator('#openResizableWindow').click();
  const detached = await opened;
  await detached.locator('body.window-view').waitFor();
  const nativeWindow = await worker.evaluate(async () => {
    const url = chrome.runtime.getURL('popup.html?view=window');
    return (await chrome.windows.getAll({populate:true})).find(win => win.tabs.some(item => item.url === url));
  });
  assert.ok(nativeWindow, 'the button must create an actual Chrome extension window');
  const widths = [];
  for (const size of [{width:640,height:600},{width:900,height:760}]) {
    const changed = await worker.evaluate(({id,size}) => chrome.windows.update(id,size), {id:nativeWindow.id,size});
    assert.equal(changed.width,size.width); assert.equal(changed.height,size.height);
    await detached.waitForFunction(previous => innerWidth !== previous, widths.at(-1) ?? -1);
    widths.push(await detached.evaluate(() => innerWidth));
    assert.equal(await detached.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    assert.equal(await detached.locator('body').evaluate(element => Math.round(element.getBoundingClientRect().width)), widths.at(-1));
  }
  assert.ok(widths[1] > widths[0], 'native window resizing must change the rendered viewport');
  assert.deepEqual(await readOwner(),ownerBefore);
  assert.equal(await page.evaluate(() => window.fixtureClicks ?? 0),0);
  await detached.close();
  result.steps.push({id:'window-resize',name:'native window creation and API resize preserve exact ownership and never dispatch',pass:true}); save();
  const text = createControlledPrompt({ controllerMessageId: 'native-delivery', runId: 'native-run', text: 'Controlled fixture lifecycle test' });
  const prompt = worker.evaluate(sendNativePrompt, {tabId:tab.id,binding:state,text});
  // Completion stays pending for the lifecycle checks; immediate rejection must fail at dispatch.
  await Promise.race([
    page.waitForFunction(() => window.fixtureClicks === 1, null, {timeout:10_000}),
    prompt.then(() => {throw new Error('Native prompt completed before pending lifecycle observation.');}),
  ]);
  assert.equal((await ping()).activeRequestId, 'native-delivery');
  await worker.evaluate(({ tabId, files, documentId }) => chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, files }),
    { tabId: tab.id, files, documentId: nativeDocumentId });
  assert.equal((await ping()).activeRequestId, 'native-delivery');
  result.steps.push({ id:'pending-reinjection', name: 'native reinjection preserves the active job and document token', pass: true }); save();
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
  result.steps.push({ id:'worker-restart', name: 'native service worker restart preserves pending delivery and page job', pass: true }); save();
  await worker.evaluate(id => chrome.tabs.sendMessage(id, { type: 'agent.cancel', requestId: 'native-delivery' }), tab.id);
  await page.reload();
  for (let attempt = 0; attempt < 20; attempt++) {
    observed = await ping().catch(() => null); if (observed?.ok && observed.documentId !== original) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.notEqual(observed.documentId, original); assert.equal(observed.busy, false);
  assert.equal(await worker.evaluate(() => chrome.storage.local.get('currentDeliveryId').then(value => value.currentDeliveryId)), 'native-delivery');
  result.steps.push({ id:'navigation', name: 'native navigation creates a new token and preserves unresolved ownership', pass: true }); save();
  const reloaded = context.waitForEvent('serviceworker', { timeout: 10_000 });
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  worker = await reloaded;
  assert.equal(await worker.evaluate(() => chrome.storage.local.get('currentDeliveryId').then(value => value.currentDeliveryId)), 'native-delivery');
  assert.equal(await page.evaluate(() => window.fixtureClicks ?? 0), 0);
  result.steps.push({ id:'extension-reload', name: 'native extension reload preserves storage and does not resend', pass: true });
  assert.deepEqual(errors, []); result.status = 'PASS';
} catch (error) {
  result.status = initialized ? 'FAIL' : 'UNVERIFIED'; result.error = error.message;
  process.exitCode = initialized ? 1 : 2;
} finally {
  try { await context?.close(); } catch (error) { result.status = 'FAIL'; result.cleanupError = error.message; process.exitCode = 1; }
  fs.rmSync(scratch, { recursive: true, force: true }); result.completed = true;
  if (result.status === 'PASS' && !nativeExtensionComplete(result)) {
    result.status = 'FAIL'; result.error = 'Incomplete native boundary verification'; process.exitCode = 1;
  }
  save();
  console.log('NATIVE_EXTENSION_RESULT ' + JSON.stringify(result));
}
