import {beginVerificationIdentity,finishVerificationIdentity} from './verification-identity.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createControlledPrompt } from '../extension/runtime/markers.js';
import { nativeExtensionComplete, sendNativePrompt, nativeFixtureHtml } from './native-extension-contract.js';
import {collectNativeReloadControl} from './native-reload-control.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.env.BRIDGE_VERIFICATION_OUTPUT ?? path.join(root, '.agent-controller'));
fs.mkdirSync(directory, { recursive: true });
const receiptPath = path.join(directory, 'latest-native-extension.json');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-native-extension-'));
const identity=beginVerificationIdentity(root);
const result = { ...identity,nativeExtension: true, status: 'RUNNING', platform: process.platform, steps: [], completed: false };
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
  const executable=fs.realpathSync(process.env.UI_BROWSER_EXECUTABLE || chromium.executablePath());
  result.browserExecutable={path:executable,sha256:createHash('sha256').update(fs.readFileSync(executable)).digest('hex')};
  context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    ...(process.env.UI_BROWSER_EXECUTABLE ? { executablePath: process.env.UI_BROWSER_EXECUTABLE } : { channel: 'chromium' }),
    headless: true, viewport:null, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging'],
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
  await context.route('https://chatgpt.com/**', route => route.fulfill({contentType:'text/html',body:nativeFixtureHtml}));
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
  try {
    const actualCommandLine=(await cdp.send('Browser.getBrowserCommandLine')).arguments;
    const actualPath=fs.realpathSync(actualCommandLine[0]);
    result.browserExecutable.observed={path:actualPath,
      sha256:createHash('sha256').update(fs.readFileSync(actualPath)).digest('hex'),source:'CDP_BROWSER_COMMAND_LINE'};
  } catch(error) {result.browserExecutable.observationError=error.message;}
  const workerUrl = worker.url(), updates = [];
  // MV3 can restart under the same Playwright Worker target without emitting another serviceworker event.
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    for (const item of versions) if (item.scriptURL === workerUrl) {
      updates.push({ versionId:item.versionId, runningStatus:item.runningStatus });
    }
  });
  result.workerLifecycle = updates;
  await cdp.send('ServiceWorker.enable');
  const waitForStatus = async (status, since, stage) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (updates.slice(since).some(item => item.runningStatus === status)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`${stage}: no CDP ${status} transition: ${JSON.stringify(updates.slice(since))}`);
  };
  await waitForStatus('running', 0, 'initial-worker');
  const version = updates.find(item => item.runningStatus === 'running');
  assert.ok(version, 'Native service worker running version must be observable');
  // Prove that Chrome actually stopped and subsequently restarted the worker, not just that a popup replied.
  const stoppedFrom = updates.length;
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await waitForStatus('stopped', stoppedFrom, 'worker-restart');
  const restartedFrom = updates.length;
  const wake = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'bridge.getState' }));
  assert.equal(wake?.ok, true, 'The restarted background worker must answer bridge.getState');
  await waitForStatus('running', restartedFrom, 'worker-restart');
  // Do not use a possibly stale Playwright Worker execution context after the stop/start cycle.
  const popupPing = () => popup.evaluate(id => chrome.tabs.sendMessage(id, { type:'agent.ping' }, { frameId:0 }), tab.id);
  const ownerFromPopup = () => popup.evaluate(() => chrome.storage.local.get('currentDeliveryId').then(value => value.currentDeliveryId));
  assert.equal((await popupPing()).documentId, original);
  assert.equal((await popupPing()).activeRequestId, 'native-delivery');
  assert.equal(await ownerFromPopup(), 'native-delivery');
  assert.equal(await page.evaluate(() => window.fixtureClicks ?? 0), 1, 'Worker restart must not resend the prompt');
  result.steps.push({ id:'worker-restart', name:'CDP stop/start, background response, and exact pending delivery survive native restart', pass:true }); save();
  await popup.evaluate(id => chrome.tabs.sendMessage(id, { type:'agent.cancel', requestId:'native-delivery' }), tab.id);
  await page.reload();
  for (let attempt = 0; attempt < 20; attempt++) {
    observed = await popupPing().catch(() => null); if (observed?.ok && observed.documentId !== original) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(observed?.ok, 'Content script must respond after navigation');
  assert.notEqual(observed.documentId, original); assert.equal(observed.busy, false);
  assert.equal(await ownerFromPopup(), 'native-delivery');
  result.steps.push({ id:'navigation', name: 'native navigation creates a new token and preserves unresolved ownership', pass: true }); save();
  const reloadFrom = updates.length;
  const reloadRegistrations = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
    for (const registration of registrations) {
      if (registration.scopeURL?.startsWith(`chrome-extension://${extensionId}/`)) {
        reloadRegistrations.push({ registrationId:registration.registrationId, isDeleted:registration.isDeleted });
      }
    }
  });
  await popup.evaluate(() => chrome.runtime.reload()).catch(error => {
    // Reload may destroy the calling extension page before its evaluation returns.
    if (!/execution context was destroyed|target closed|page.*closed|navigation/i.test(String(error.message))) throw error;
  });
  const freshPopup = await context.newPage();
  let popupOpened = false, openError;
  for (let attempt = 0; attempt < 20 && !popupOpened; attempt++) {
    try {
      await freshPopup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil:'domcontentloaded', timeout:2000 });
      popupOpened = true;
    } catch (error) {
      openError = error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  // Capture the exact Chrome registration/target state even when popup reopening fails.
  // A blocked extension URL alone does not tell us whether reload failed or navigation was refused.
  let reloadTargetInfos = [], reloadTargetError = null;
  try {
    ({ targetInfos:reloadTargetInfos } = await cdp.send('Target.getTargets'));
  } catch (error) { reloadTargetError = error.message; }
  result.extensionReloadDiagnostics = {
    popupOpened,
    popupNavigationError:openError?.message ?? null,
    workerUpdates:updates.slice(reloadFrom),
    registrationUpdates:reloadRegistrations,
    extensionTargets:reloadTargetInfos.filter(target => target.url?.startsWith('chrome-extension://'))
      .map(target => ({ type:target.type, url:target.url, attached:target.attached })),
    targetQueryError:reloadTargetError,
  };
  save();
  assert.ok(popupOpened, `Extension popup did not reopen after runtime.reload: ${openError?.message ?? 'unknown error'}`);
  const reloadedState = await freshPopup.evaluate(() => chrome.runtime.sendMessage({ type:'bridge.getState' }));
  assert.equal(reloadedState?.ok, true, 'Reloaded extension must answer bridge.getState');
  // A changed version or a stopped status, followed by running, establishes a real reload boundary.
  let reloadConfirmed = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const events = updates.slice(reloadFrom);
    const boundary = events.findIndex(item => item.runningStatus === 'stopped' || item.versionId !== version.versionId);
    if (boundary !== -1 && events.slice(boundary).some(item => item.runningStatus === 'running')) {
      reloadConfirmed = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(reloadConfirmed, `Extension reload not observed via CDP: ${JSON.stringify(updates.slice(reloadFrom))}`);
  assert.equal(await freshPopup.evaluate(() => chrome.storage.local.get('currentDeliveryId').then(value => value.currentDeliveryId)), 'native-delivery');
  assert.equal(await page.evaluate(() => window.fixtureClicks ?? 0), 0);
  result.steps.push({ id:'extension-reload', name: 'native extension reload preserves storage and does not resend', pass: true });
  assert.deepEqual(errors, []); result.status = 'PASS';
} catch (error) {
  result.status = initialized ? 'FAIL' : 'UNVERIFIED'; result.error = error.message;
  process.exitCode = initialized ? 1 : 2;
} finally {
  try { await context?.close(); } catch (error) { result.status = 'FAIL'; result.cleanupError = error.message; process.exitCode = 1; }
  fs.rmSync(scratch, { recursive: true, force: true }); result.completed = true;
  // Preserve the original Native FAIL. Diagnose only its reload boundary using
  // the existing independent MV3 matrix, after releasing the Bridge browser.
  await collectNativeReloadControl({result,root,directory,identity,save});
  if (result.status === 'PASS' && !nativeExtensionComplete(result)) {
    result.status = 'FAIL'; result.error = 'Incomplete native boundary verification'; process.exitCode = 1;
  }
  Object.assign(result,finishVerificationIdentity(root,identity));
  if(!result.candidateUnchanged) {result.status='FAIL';result.error='Source changed during native verification';process.exitCode=1;}
  save();
  console.log('NATIVE_EXTENSION_RESULT ' + JSON.stringify(result));
}
