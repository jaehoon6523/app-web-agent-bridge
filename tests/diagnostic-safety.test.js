import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { diagnosticMetadata, diagnosticError, errorPayload } from '../extension/runtime/document-binding.js';
import { pageDiagnosticMetadata } from '../extension/runtime/delivery-page.js';
import { projectDiagnostics, bestEffortFailureLog, diagnosticSummary } from '../src/orchestration/preparation-diagnostics.js';
import { PreparationService } from '../src/orchestration/preparation-service.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url)));
const scripts = manifest.content_scripts[0].js.map(file => [file, fs.readFileSync(new URL('../extension/' + file, import.meta.url), 'utf8')]);

function hostileDetails() {
  const details = { flow:'ROOT_BOOTSTRAP_V2', stage:'LOAD', browserDispatchStarted:false,
    readiness:{ lastInspectionError:{ code:'UI_CONTRACT_CHANGED', message:'Composer inspection failed',
      evidence:{ selectorVersion:'fixture', response:'PRIVATE_RESPONSE', sharedSecret:'PRIVATE_SECRET',
        unexpected:{ token:'PRIVATE_TOKEN' }, tabId:19n } } },
    response:'PRIVATE_TOP_LEVEL', messageContent:'PRIVATE_MESSAGE_CONTENT', selectorsUsed:{messageContent:'[data-testid=message]'}, toJSON() { throw new Error('Must not invoke toJSON'); } };
  details.causeDetails = details;
  Object.defineProperty(details, 'page', { get() { throw new Error('Must not invoke accessor'); } });
  return details;
}

for (const [name, project] of [['extension', diagnosticMetadata], ['server', projectDiagnostics]]) {
  test(`${name} never invokes stack getters, including bound functions disguised as native`, () => {
    let calls=0;
    const getter=(function () { calls++; return 'PRIVATE_STACK'; }).bind(null);
    assert.match(Function.prototype.toString.call(getter), /\[native code\]/);
    const error={code:'UI_CONTRACT_CHANGED', message:'PRIVATE_MESSAGE'};
    Object.defineProperty(error,'stack',{get:getter});
    Object.defineProperty(error,'details',{get() {calls++; throw new Error('PRIVATE_GETTER');}});
    const result=project(error);
    assert.equal(calls,0); assert.equal(result.stack,undefined);
    assert.equal(result.message,diagnosticSummary(error.code));
    const hostileCode={toString() {calls++; throw new Error('Must not coerce diagnostic values');}};
    assert.doesNotThrow(() => project({code:hostileCode,message:'PRIVATE'}));
    assert.equal(calls,0);
  });

  test(`${name} preserves recovery structure while withholding free-form error strings`, () => {
    const binding={sessionId:'session',runId:'run',tabId:19,windowId:2,
      conversationUrl:'https://chatgpt.com/c/fixture',conversationId:'fixture',
      documentId:'document',frameId:0,bindingStatus:'AMBIGUOUS'};
    const input={code:'AMBIGUOUS',message:'PRIVATE_SECRET PRIVATE_RESPONSE',stack:'PRIVATE_STACK',
      details:{mode:'EXACT_CONVERSATION_RECOVERY',matchStatus:'AMBIGUOUS',storedTabId:19,
        requested:{...binding,message:'PRIVATE_REQUEST',token:'PRIVATE_TOKEN'},
        persisted:{...binding,response:'PRIVATE_RESPONSE'},
        message:'PRIVATE_NESTED_MESSAGE',causeMessage:'PRIVATE_CAUSE',cause:'PRIVATE_CAUSE',
        selectorsUsed:{message:'[data-testid^="conversation-turn-"]'}}};
    const result=project(input);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
    assert.deepEqual(result.details.requested,binding); assert.deepEqual(result.details.persisted,binding);
    assert.equal(result.details.mode,input.details.mode); assert.equal(result.details.storedTabId,19);
    assert.equal(result.details.matchStatus,'AMBIGUOUS');
    assert.deepEqual(result.details.selectorsUsed,input.details.selectorsUsed);
    assert.equal(result.message,diagnosticSummary('AMBIGUOUS'));
    assert.equal(result.details.message,diagnosticSummary(undefined));
  });

  test(`${name} diagnostic projection is bounded, cycle safe, and excludes unknown fields`, () => {
    const result = project(hostileDetails());
    const output = JSON.stringify(result);
    assert.doesNotMatch(output, /PRIVATE|toJSON|unexpected/);
    assert.equal(result.selectorsUsed.messageContent, '[data-testid=message]');
    assert.equal(result.stage, 'LOAD'); assert.equal(result.browserDispatchStarted, false);
    assert.equal(result.causeDetails, null);
    assert.equal(result.readiness.lastInspectionError.evidence.tabId, undefined);
    assert.equal(result.readiness.lastInspectionError.code, 'UI_CONTRACT_CHANGED');
    const input = { message:'a'.repeat(100000), samples:Array.from({length:10000}, () => ({ selector:'s'.repeat(10000) })) };
    const bounded = project(input);
    assert.ok(bounded.message.length <= 2048); assert.ok(bounded.samples.length <= 32);
    assert.ok(JSON.stringify(bounded).length < 25000);
    let deep = {}; for (let i=0; i<10000; i++) deep = { causeDetails:deep };
    assert.doesNotThrow(() => JSON.stringify(project(deep)));
  });
}

test('extension wire errors and displayed diagnostics contain only projected nested details', () => {
  const error = Object.assign(new Error('Original failure'), { code:'UI_CONTRACT_CHANGED', details:hostileDetails() });
  const wire = errorPayload(error);
  assert.equal(wire.code, error.code); assert.equal(wire.message, diagnosticSummary(error.code));
  assert.doesNotMatch(JSON.stringify(wire), /PRIVATE/);
  assert.doesNotMatch(diagnosticError(error), /PRIVATE/);
});

test('actual manifest content ping sanitizes a provider exception before returning it', async () => {
  const listeners=[], window={}; window.top=window;
  const context=vm.createContext({ URL, crypto:webcrypto, window, location:{href:'https://chatgpt.com/'},
    document:{ title:'PRIVATE_TITLE', body:{innerText:'PRIVATE_BODY'}, querySelectorAll:() => [] },
    HTMLElement:class {}, HTMLTextAreaElement:class {}, HTMLInputElement:class {}, getComputedStyle:() => ({}),
    AbortController, DOMException, setTimeout, clearTimeout, console:{info() {}},
    chrome:{ runtime:{getManifest:() => manifest, onMessage:{addListener:fn => listeners.push(fn)}, sendMessage:async () => {}} } });
  for (const [file,source] of scripts) vm.runInContext(source, context, {filename:file});
  const failure=Object.assign(new Error('Composer inspection failed'), { code:'UI_CONTRACT_CHANGED', evidence:hostileDetails() });
  context.ChatGptBridgeSelectors.resolveFirst=() => { throw failure; };
  const ping=await new Promise(resolve => listeners[0]({type:'agent.ping'}, {}, resolve));
  assert.equal(ping.composerPresent, null); assert.equal(ping.ready, false);
  assert.equal(ping.inspectionError.message, diagnosticSummary(failure.code));
  assert.doesNotMatch(JSON.stringify(ping.inspectionError), /PRIVATE/);
  assert.equal(ping.inspectionError.evidence.stage, 'LOAD');
  context.location.href='https://chatgpt.com/c/fixture';
  for (const type of ['agent.prompt','agent.observeSubmittedPrompt']) {
    const response=await new Promise(resolve => listeners[0]({type, requestId:'delivery', payload:{
      expectedDocumentId:ping.documentId, expectedFrameId:0,
      expectedConversationUrl:context.location.href, expectedConversationId:'fixture',
      controllerMessageId:'delivery', runId:'run', text:'[controller_message_id:delivery]\n[run_id:run]\nFixture',
    }}, {}, resolve));
    assert.equal(response.code,failure.code); assert.equal(response.error,diagnosticSummary(failure.code));
    assert.equal(response.evidence.stage,'LOAD');
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE/);
  }
});

test('logging remains best effort when console output throws', () => {
  const original=console.error;
  try { console.error=() => { throw new Error('stderr unavailable'); };
    assert.doesNotThrow(() => bestEffortFailureLog('fixture', hostileDetails()));
  } finally { console.error=original; }
});

test('background inspection also withholds raw exception text from older content versions', () => {
  const result=pageDiagnosticMetadata({inspectionError:{code:'UI_CONTRACT_CHANGED',
    message:'PRIVATE_SECRET PRIVATE_RESPONSE', stack:'PRIVATE_STACK'},
    diagnostics:{selectorVersion:'fixture',composerSelectors:[],editableCandidates:[]}});
  assert.equal(result.inspectionError.code,'UI_CONTRACT_CHANGED');
  assert.equal(result.inspectionError.message,diagnosticSummary('UI_CONTRACT_CHANGED'));
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
});

test('stderr failure records withhold top-level and nested arbitrary error strings', () => {
  const original=console.error, logs=[];
  try { console.error=(...args) => logs.push(args);
    bestEffortFailureLog('fixture',{code:'UI_CONTRACT_CHANGED',message:'PRIVATE_SECRET',stack:'PRIVATE_STACK',
      details:{stage:'LOAD',message:'PRIVATE_RESPONSE',cause:'PRIVATE_CAUSE',causeMessage:'PRIVATE_CAUSE'}});
  } finally { console.error=original; }
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE/);
  const result=JSON.parse(logs[0][1]);
  assert.equal(result.code,'UI_CONTRACT_CHANGED'); assert.equal(result.details.stage,'LOAD');
  assert.equal(result.message,diagnosticSummary('UI_CONTRACT_CHANGED'));
});

for (const blockedConsole of [false, true]) {
  test(`cyclic provider failure persists original state and ownership across restart (stderr blocked: ${blockedConsole})`, async t => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(), 'safe-preparation-'));
    let sends=0, discards=0, acknowledgements=0;
    const options={ filename:path.join(root,'state.sqlite'), available:() => true, assertStart:async () => {},
      web:{ resume:async () => { throw Object.assign(new Error('PRIVATE_ORIGINAL_COMPOSER_FAILURE'), {
        code:'UI_CONTRACT_CHANGED', details:hostileDetails() }); },
      submitTurn:async () => { sends++; throw new Error('Unexpected send'); },
      discardDelivery:async () => { discards++; }, acknowledgeDelivery:async () => { acknowledgements++; } } };
    let service=new PreparationService(options);
    t.after(() => { service.close(); fs.rmSync(root,{recursive:true,force:true}); });
    const original=console.error, logs=[];
    try {
      console.error=(...args) => { if (blockedConsole) throw new Error('stderr unavailable'); logs.push(args); };
      await service.execute('preparation.start', { requestId:'start', objective:'fixture', targetRoot:root,
        conversationUrl:'https://chatgpt.com/' });
      await Promise.all([...service.jobs.values()]);
    } finally { console.error=original; }
    const before=service.snapshot(), owner=before.webSession.activeDeliveryId;
    assert.equal(before.state,'WEB_BLOCKED'); assert.equal(before.lifecycle,'ACTIVE');
    assert.equal(before.error.code,'UI_CONTRACT_CHANGED'); assert.equal(before.error.message,diagnosticSummary('UI_CONTRACT_CHANGED'));
    assert.equal(before.deliveries[0].unsent,true); assert.ok(owner);
    assert.doesNotMatch(JSON.stringify(before.error), /PRIVATE/);
    if (!blockedConsole) {
      const logged=JSON.parse(logs.find(item => item[0]==='[bridge:preparation:failed]')[1]);
      assert.equal(logged.code,'UI_CONTRACT_CHANGED'); assert.equal(logged.deliveryId,owner);
      assert.doesNotMatch(JSON.stringify(logged), /PRIVATE/);
    }
    service.close(); service=new PreparationService(options);
    assert.equal(service.current.state,'WEB_BLOCKED'); assert.equal(service.current.error.code,'UI_CONTRACT_CHANGED');
    assert.equal(service.current.webSession.activeDeliveryId,owner);
    assert.deepEqual(service.current.error,before.error);
    assert.equal(sends+discards+acknowledgements,0);
  });
}
