import { diagnosticSummary } from "../src/orchestration/preparation-diagnostics.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {createBrowserRuntime} from '../extension/runtime/browser-runtime.js';
import {createExtensionStateStore} from '../extension/runtime/storage.js';
import * as providerTarget from '../extension/runtime/provider-target.js';
import {errorPayload} from '../extension/runtime/document-binding.js';
import {PreparationService} from '../src/orchestration/preparation-service.js';
import {inspectChatGptTabs} from '../extension/runtime/tab-diagnostics.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url)));
const scripts = manifest.content_scripts[0].js.map(file => [file,
  fs.readFileSync(new URL('../extension/' + file, import.meta.url), 'utf8')]);
const background = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

function contentFixture(mode) {
  const state = {mode}, listeners = [], window = {}; window.top = window;
  class HTMLElement { getBoundingClientRect() { return state.mode === 'zero-size'
    ? {width:0, height:0} : {width:500, height:100}; } }
  class HTMLTextAreaElement extends HTMLElement { value = 'PRIVATE COMPOSER TEXT'; tagName = 'TEXTAREA'; }
  const composer = new HTMLTextAreaElement();
  const context = vm.createContext({URL, crypto:webcrypto, window, location:{href:'https://chatgpt.com/'},
    document:{title:'PRIVATE TITLE', body:{innerText:'PRIVATE CONVERSATION'},
      readyState:'complete', visibilityState:'visible', hasFocus:() => true,
      querySelectorAll:selector => selector === '#prompt-textarea' && state.mode !== 'absent' && state.mode !== 'unregistered'
        || selector === "[role='textbox']" && state.mode === 'unregistered' ? [composer] : []},
    HTMLElement, HTMLTextAreaElement, HTMLInputElement:class extends HTMLElement {},
    getComputedStyle:() => ({display:state.mode === 'hidden' ? 'none' : 'block',
      visibility:state.mode === 'visibility-hidden' ? 'hidden' : 'visible'}),
    AbortController, DOMException, setTimeout, clearTimeout, console:{info() {}},
    chrome:{runtime:{getManifest:() => manifest, onMessage:{addListener:fn => listeners.push(fn)}, sendMessage:async () => {}}}});
  for (const [file, source] of scripts) vm.runInContext(source, context, {filename:file});
  const resolver = context.ChatGptBridgeSelectors.resolveSendButtonState;
  if (mode === 'dependency-failure') context.ChatGptBridgeSelectors.resolveSendButtonState = undefined;
  return {state, restore:() => {context.ChatGptBridgeSelectors.resolveSendButtonState = resolver;},
    ping:(message = {type:'agent.ping'}) => new Promise(resolve => listeners[0](message, {}, resolve))};
}

test('tab inspection carries actual provider counts and page observations through ping without private text', async () => {
  const f = contentFixture('hidden'), calls = [];
  const [page] = await inspectChatGptTabs({query:async () => [{id:19, url:'https://chatgpt.com/'}],
    sendMessage:async (_id, message) => {calls.push(message); return f.ping(message);}});
  assert.equal(page.reachable, true); assert.equal(page.ready, false);
  assert.equal(page.pageState.readyState, 'complete'); assert.equal(page.pageState.hasFocus, true);
  assert.equal(page.frameId, 0); assert.equal(typeof page.documentId, 'string');
  const counts = page.diagnostics.composerSelectors.find(item => item.selector === '#prompt-textarea');
  assert.equal(counts.matched, 1); assert.equal(counts.visible, 0);
  assert.equal(counts.samples[0].acceptedByVisibility, false);
  assert.equal(page.diagnostics.editableCandidates.length, 3);
  assert.equal(calls[0].includeDiagnostics, true);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE/u);
});

test('diagnostic ping obtains visible selector counts without changing normal readiness', async () => {
  const f = contentFixture('visible');
  assert.equal((await f.ping()).diagnostics, null);
  const [page] = await inspectChatGptTabs({query:async () => [{id:19, url:'https://chatgpt.com/'}],
    sendMessage:async (_id, message) => f.ping(message)});
  assert.equal(page.ready, true);
  assert.equal(page.diagnostics.composerSelectors[0].visible, 1);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE/u);
});

test('inspection exceptions report unknown composer presence instead of asserting absence', async () => {
  const page = await contentFixture('dependency-failure').ping();
  assert.equal(page.composerPresent, null); assert.equal(page.ready, false);
  assert.equal(page.pageState.readyState, 'complete');
  assert.equal(page.inspectionError.code, 'UI_CONTRACT_CHANGED');
});

for (const mode of ['visibility-hidden', 'zero-size']) {
  test(mode + ' composer explains a visibility rejection using provider metadata', async () => {
    const page = await contentFixture(mode).ping({type:'agent.ping', includeDiagnostics:true});
    assert.equal(page.composerPresent, false);
    const counts = page.diagnostics.composerSelectors[0];
    assert.equal(counts.matched, 1); assert.equal(counts.visible, 0);
    assert.equal(counts.samples[0].acceptedByVisibility, false);
    if (mode === 'visibility-hidden') assert.equal(counts.samples[0].visibility, 'hidden');
    else assert.equal(counts.samples[0].width, 0);
    assert.doesNotMatch(JSON.stringify(page.diagnostics), /PRIVATE/u);
  });
}

test('diagnostic-only textbox candidates never become a fallback composer', async () => {
  const page = await contentFixture('unregistered').ping({type:'agent.ping', includeDiagnostics:true});
  assert.equal(page.composerPresent, false); assert.equal(page.ready, false);
  assert.ok(page.diagnostics.composerSelectors.every(item => item.matched === 0));
  assert.equal(page.diagnostics.editableCandidates.find(item => item.selector === "[role='textbox']").visible, 1);
});

function browserFixture(content) {
  const root = {id:19, windowId:2, url:'https://chatgpt.com/', status:'complete'};
  const chrome = {runtime:{id:'fixture-extension', getManifest:() => manifest},
    tabs:{get:async () => root, query:async () => [root], sendMessage:async () => content.ping()}};
  return {chrome, runtime:createBrowserRuntime(chrome)};
}

test('visible composer remains ready without retaining composer text in diagnostics', async () => {
  const page = await contentFixture('visible').ping();
  assert.equal(page.ready, true);
  assert.equal(page.inspectionError, null);
  assert.equal(page.diagnostics, null);
  assert.equal(page.runtimeVersion, manifest.version);
});

for (const mode of ['absent', 'hidden']) {
  test(`${mode} composer reports selector match and visibility counts through timeout`, async () => {
    const f = browserFixture(contentFixture(mode));
    await assert.rejects(f.runtime.waitForContentScript(19, 100, true), error => {
      assert.equal(error.code, 'UI_CONTRACT_CHANGED');
      const observed = error.details.readiness;
      assert.equal(observed.tabUrl, 'https://chatgpt.com/');
      assert.equal(observed.lastReadiness.pageUrl, observed.tabUrl);
      assert.equal(observed.lastReadiness.composerPresent, false);
      assert.equal(observed.lastReadiness.runtimeVersion, manifest.version);
      const selector = observed.lastReadiness.diagnostics.composerSelectors.find(item => item.selector === '#prompt-textarea');
      assert.equal(selector.matched, mode === 'hidden' ? 1 : 0);
      assert.equal(selector.visible, 0);
      if (mode === 'hidden') assert.equal(selector.samples[0].display, 'none');
      assert.equal(observed.lastInspectionError, null);
      assert.doesNotMatch(JSON.stringify(observed), /PRIVATE/u);
      return true;
    });
  });
}

test('an inspection exception retains its code and safe summary and is cleared on fresh preparation', async () => {
  const content = contentFixture('dependency-failure'), f = browserFixture(content);
  await assert.rejects(f.runtime.waitForContentScript(19, 100, true), error => {
    const original = error.details.readiness.lastInspectionError;
    assert.equal(original.code, 'UI_CONTRACT_CHANGED');
    assert.equal(original.message, diagnosticSummary('UI_CONTRACT_CHANGED'));
    assert.equal(original.stack, undefined);
    assert.equal(error.details.readiness.lastReadiness.inspectionError.message, original.message);
    return true;
  });
  content.restore(); content.state.mode = 'absent';
  await assert.rejects(f.runtime.waitForContentScript(19, 100, true), error => {
    assert.equal(error.details.readiness.lastInspectionError, null);
    assert.equal(error.details.readiness.lastReadiness.inspectionError, null);
    return true;
  });
});

for (const stage of ['LOAD', 'CREATE']) {
  test(`${stage} bootstrap preserves diagnostics through the extension error payload and server stderr`, async t => {
    const f = browserFixture(contentFixture('dependency-failure'));
    let saved = {};
    const store = createExtensionStateStore({get:async () => structuredClone(saved), set:async value => {saved = value;}});
    if (stage === 'CREATE') f.chrome.tabs.query = async () => [];
    const context = vm.createContext({...providerTarget, console:{info() {}}, chrome:f.chrome, store,
      waitForContentScript:tabId => f.runtime.waitForContentScript(tabId, 100, true),
      createConversationBootstrapTab:async () => {await f.runtime.waitForContentScript(19, 100, true);},
      ExtensionOperationError:class extends Error {
        constructor(code, message, details) {super(message); this.code = code; this.details = details;}
      }});
    vm.runInContext(background.slice(background.indexOf('function requireBindingInput('),
      background.indexOf('async function rebindSession(')), context);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-diagnostics-')), logs = [];
    t.mock.method(console, 'error', (...args) => logs.push(args));
    const service = new PreparationService({filename:path.join(root, 'state.sqlite'), available:() => true,
      assertStart:async () => {}, findRun:async () => null, approve:async () => {throw Error('Unexpected approval');},
      web:{resume:async () => {
        try {return await context.prepareBoundSession({sessionId:'session', runId:'run', conversationUrl:null, conversationId:null});}
        catch (error) {
          // Exercise the JSON wire boundary rather than sharing the original Error object.
          const payload = JSON.parse(JSON.stringify(errorPayload(error)));
          throw Object.assign(new Error(payload.message), {code:payload.code, details:payload.details});
        }
      }, submitTurn:async () => {throw Error('Unexpected send');}}});
    t.after(() => {service.close(); fs.rmSync(root, {recursive:true, force:true});});
    await service.execute('preparation.start', {requestId:'start', objective:'fixture', targetRoot:root,
      conversationUrl:'https://chatgpt.com/'});
    await Promise.all([...service.jobs.values()].filter(value => value && typeof value.then === 'function'));
    const output = logs.find(([event]) => event === '[bridge:preparation:failed]')[1];
    const logged = JSON.parse(output);
    assert.equal(logged.stage, stage);
    assert.equal(logged.unsent, true);
    assert.equal(logged.details.extensionVersion, manifest.version);
    assert.equal(logged.details.causeDetails.readiness.tabUrl, 'https://chatgpt.com/');
    assert.equal(logged.details.causeDetails.readiness.lastInspectionError.message,
      diagnosticSummary('UI_CONTRACT_CHANGED'));
    assert.doesNotMatch(output, /assertContract|Send-control state resolver/u);
    assert.doesNotMatch(output, /\[Object\]|PRIVATE/u);
    assert.equal(service.current.error.details.causeDetails.readiness.lastReadiness.pageStatus, 'UI_CONTRACT_CHANGED');
    assert.equal(service.current.state, 'WEB_BLOCKED');
  });
}
