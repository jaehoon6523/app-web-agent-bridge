import test from 'node:test';
import assert from 'node:assert/strict';
import { closedBootstrapRootTabs, recoverBootstrapAfterNavigation, recoverSubmittedRoot, inspectSubmittedRoot } from '../extension/runtime/bootstrap-recovery.js';
import { readDeliveryPage } from '../extension/runtime/delivery-page.js';
import { createExtensionStateStore } from '../extension/runtime/storage.js';
import { submittedRootRecovery } from '../src/orchestration/submitted-root-recovery.js';

test("a disconnected root can recover only the completed response from its original tab", () => {
  const webSession = { sessionId:"web_prep_test", activeDeliveryId:"delivery-test", tabId:7, windowId:1,
    conversationUrl:"https://chatgpt.com/", conversationId:null, frameId:0, documentId:"root-doc" };
  const binding = { sessionId:webSession.sessionId, runId:"prep_test", tabId:7, windowId:1,
    conversationUrl:"https://chatgpt.com/c/test", conversationId:"test", bindingStatus:"BOUND" };
  const context = { preparationId:"prep_test", state:"RECOVERY_REQUIRED", error:{code:"WEB_TURN_AMBIGUOUS"}, webSession,
    deliveries:[{ deliveryId:webSession.activeDeliveryId, state:"RECOVERY_REQUIRED", unsent:false, response:null }],
    diagnostics:{ currentDeliveryId:webSession.activeDeliveryId, sessionId:webSession.sessionId, runId:"prep_test", tabId:7,
      completedDelivery:{ turnId:webSession.activeDeliveryId, confidence:"CONFIRMED_BY_UI_STATE",
        evidence:{responseAssociation:"DIRECT_DOM_ORDER"}, binding } } };
  const recovery = submittedRootRecovery(context);
  assert.equal(recovery.currentDeliveryId, webSession.activeDeliveryId);
  assert.equal(recovery.conversationId, "test");
  assert.equal(recovery.allowTabRelocation, false);
  binding.tabId = 9;
  assert.equal(submittedRootRecovery(context), null);
});
import * as documentBinding from "../extension/runtime/document-binding.js";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as conversation from "../extension/runtime/conversation.js";
import * as guards from "../extension/runtime/turn-guard.js";
import { createControlledPrompt } from "../extension/runtime/markers.js";
import * as currentTarget from "../extension/runtime/current-target.js";
import * as providerTarget from "../extension/runtime/provider-target.js";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function submittedFixture() {
  let saved = { lastBoundSessionId:'s1', lastBoundRunId:'prep_r1', currentDeliveryId:'d1', completedDelivery:null,
    conversationUrl:'https://chatgpt.com/', conversationId:null, tabId:7, windowId:3, documentId:'old', frameId:0,
    bindingStatus:'AMBIGUOUS' };
  const store = createExtensionStateStore({get:async()=>structuredClone(saved),set:async v=>{saved=structuredClone(v);}});
  const expected = {sessionId:'s1',runId:'prep_r1',currentDeliveryId:'d1',tabId:7,
    conversationUrl:'https://chatgpt.com/c/created',conversationId:'created'};
  const page = {ok:true,ready:true,busy:false,generating:false,url:expected.conversationUrl,conversationId:'created',documentId:'new',frameId:0};
  const result = {ok:true,text:'방법 안내인가요, 기능 구현인가요?',confidence:'CONFIRMED_BY_UI_STATE',
    evidence:{conversationUrl:page.url,conversationId:'created',documentId:'new',frameId:0,
      userMessageId:'u1',assistantMessageId:'a1',responseAssociation:'DIRECT_DOM_ORDER'}};
  const sent=[];
  const tabs={get:async()=>({id:7,windowId:3,url:page.url}),sendMessage:async(_id,m)=>{
    sent.push(m);return m.type==='agent.ping'?{...page}:structuredClone(result);
  }};
  return {store,expected,page,result,tabs,sent};
}

test('recovery logs failed page checks without exposing page content or writing binding',async t=>{
  const logs=[]; t.mock.method(console,'info',(...args)=>logs.push(args));
  const f=submittedFixture(),before=await f.store.read();
  Object.assign(f.page,{ready:false,generating:true,documentId:'',text:'PRIVATE_PAGE_TEXT'});
  await assert.rejects(recoverSubmittedRoot(f),{code:'DELIVERY_RECOVERY_UNCONFIRMED'});
  const entry=JSON.parse(logs.find(([prefix])=>prefix==='[bridge:submitted-root]')[1]);
  assert.equal(entry.stage,'CHECK_PAGE');
  assert.deepEqual(entry.failedChecks,['ready','generationStopped','documentId']);
  assert.equal(JSON.stringify(logs).includes('PRIVATE_PAGE_TEXT'),false);
  assert.deepEqual(await f.store.read(),before);
  assert.equal(f.sent.some(m=>m.type==='agent.recheck'),false);
});

test('recovery logs recheck rejection separately and survives a broken console',async t=>{
  const logs=[]; const logger=t.mock.method(console,'info',(...args)=>logs.push(args));
  const f=submittedFixture();
  Object.assign(f.result,{ok:false,code:'UI_CONTRACT_CHANGED',error:'Selector unavailable. '.repeat(40),
    details:{selectorGroup:'messages',matched:0}});
  await assert.rejects(recoverSubmittedRoot(f),{code:'UI_CONTRACT_CHANGED'});
  const entry=logs.map(args=>JSON.parse(args[1])).find(item=>item.stage==='RECHECK_RESULT');
  assert.equal(entry.code,'UI_CONTRACT_CHANGED'); assert.equal(entry.ok,false);
  assert.equal(entry.error,f.result.error.slice(0,500));
  assert.equal(entry.error.length,500);
  assert.deepEqual(entry.details,f.result.details);
  assert.equal(JSON.stringify(logs).includes(f.result.text),false);
  logger.mock.mockImplementation(()=>{throw new Error('console unavailable');});
  const healthy=submittedFixture(); await recoverSubmittedRoot(healthy);
  assert.equal((await healthy.store.read()).completedDelivery.rawText,healthy.result.text);
});

test('explicit root recovery validates the original response and commits it without sending or clearing',async()=>{
  const f=submittedFixture(); await recoverSubmittedRoot(f);
  const saved=await f.store.read();
  assert.equal(saved.currentDeliveryId,'d1');
  assert.equal(saved.completedDelivery.rawText,f.result.text);
  assert.equal(saved.completedDelivery.binding.conversationId,'created');
  assert.equal(saved.completedDelivery.trace.requestId,'d1');
  assert.deepEqual(f.sent.map(m=>m.type),['agent.ping','agent.recheck','agent.ping']);
  assert.equal(f.sent[1].payload.recoverSubmitted,true);
  assert.equal(f.sent[1].payload.controllerMessageId,'d1');
  const before=await f.store.read();
  await recoverSubmittedRoot(f);
  assert.deepEqual(await f.store.read(),before);
  assert.equal(f.sent.filter(m=>m.type==='agent.recheck').length,1,'lost recovery reply can be read without repeating observation');
});

test('pinned root recovery verifies both bindings when the original tab was closed', async () => {
  const f = submittedFixture();
  Object.assign(f.expected, { windowId:3, documentId:'old', frameId:0, userMessageId:'u1',
    assistantMessageId:'a1', allowTabRelocation:true, replacement:{tabId:8, windowId:4, documentId:'new', frameId:0} });
  const replacement = {id:8, windowId:4, url:f.page.url};
  f.tabs.get = async id => {
    if (id === 8) return replacement;
    throw new Error('No tab with id: 7.');
  };
  f.tabs.query = async () => [replacement];
  const after = await recoverSubmittedRoot(f);
  assert.equal(after.currentDeliveryId, 'd1');
  assert.equal(after.documentId, 'new');
  assert.equal(after.completedDelivery.evidence.recoveryRebinding.from.documentId, 'old');
  assert.equal(after.completedDelivery.evidence.recoveryRebinding.to.documentId, 'new');
  assert.ok(f.sent.every(m => ['agent.ping', 'agent.recheck'].includes(m.type)));
  assert.deepEqual(await recoverSubmittedRoot(f), after);
});

test('closed-tab handoff preserves delivery ownership after Chrome clears the stored document', async () => {
  for (const scenario of ['exact', 'original still open', 'duplicate', 'late duplicate', 'other conversation', 'wrong marker', 'wrong message', 'owner changed']) {
    const f = submittedFixture();
    const original = {tabId:7, windowId:3, documentId:'old', frameId:0};
    const replacement = {tabId:8, windowId:4, documentId:'new', frameId:0};
    Object.assign(f.expected, original, {userMessageId:'u1', assistantMessageId:'a1', allowTabRelocation:true, replacement});
    await f.store.update({tabId:null, windowId:null, documentId:null, frameId:null, bindingStatus:'NEEDS_REBIND'});
    const before = await f.store.read();
    const candidate = {id:8, windowId:4, url:scenario === 'other conversation' ? 'https://chatgpt.com/c/other' : f.page.url};
    f.tabs.get = async id => {
      if (id === candidate.id) return candidate;
      if (scenario === 'original still open') return {id:7, windowId:3, url:f.page.url};
      throw new Error('No tab with id: 7.');
    };
    f.tabs.query = async () => scenario === 'duplicate' || (scenario === 'late duplicate' && f.sent.some(m => m.type === 'agent.recheck'))
      ? [candidate, {...candidate, id:9}] : [candidate];
    const send = f.tabs.sendMessage;
    f.tabs.sendMessage = async (id, message, options) => {
      assert.equal(id, replacement.tabId);
      assert.equal(options?.frameId, 0);
      if (message.type === 'agent.recheck' && scenario === 'owner changed') await f.store.update({currentDeliveryId:'other'});
      return send(id, message);
    };
    if (scenario === 'wrong marker') Object.assign(f.result, {ok:false, code:'AMBIGUOUS_PROMPT_BINDING'});
    if (scenario === 'wrong message') f.result.evidence.assistantMessageId = 'other';
    if (scenario === 'exact') {
      const after = await recoverSubmittedRoot(f);
      assert.deepEqual(after.completedDelivery.evidence.recoveryRebinding, {from:original, to:replacement});
      assert.equal(after.windowId, replacement.windowId);
      assert.equal(after.currentDeliveryId, before.currentDeliveryId);
      const observation = f.sent.find(m => m.type === 'agent.recheck');
      assert.equal(observation.payload.controllerMessageId, before.currentDeliveryId);
      assert.equal(observation.payload.runId, before.lastBoundRunId);
      assert.equal(observation.payload.userMessageId, 'u1');
      assert.equal(observation.payload.assistantMessageId, 'a1');
      assert.deepEqual(await recoverSubmittedRoot(f), after);
      assert.equal(f.sent.filter(m => m.type === 'agent.recheck').length, 1);
    } else {
      await assert.rejects(recoverSubmittedRoot(f));
      assert.deepEqual(await f.store.read(), scenario === 'owner changed' ? {...before, currentDeliveryId:'other'} : before);
      if (['original still open', 'duplicate', 'other conversation'].includes(scenario)) assert.deepEqual(f.sent, []);
    }
    assert.ok(f.sent.every(m => ['agent.ping', 'agent.recheck'].includes(m.type)));
  }
});

test('pinned root recovery accepts only the exact original document and message pair', async () => {
  for (const scenario of ['exact', 'document', 'window', 'tab', 'conversation', 'assistant', 'generating', 'receipt']) {
    const f = submittedFixture();
    Object.assign(f.expected, {windowId:3, documentId:'old', frameId:0, userMessageId:'u1', assistantMessageId:'a1'});
    await f.store.update({lastAcknowledgedDelivery:{deliveryId:'previous-delivery'}});
    f.page.documentId = f.result.evidence.documentId = scenario === 'document' ? 'new' : 'old';
    if (scenario === 'window') f.expected.windowId = 4;
    if (scenario === 'tab') f.expected.tabId = 8;
    if (scenario === 'conversation') f.page.conversationId = 'other';
    if (scenario === 'assistant') f.result.evidence.assistantMessageId = 'other';
    if (scenario === 'generating') f.page.generating = true;
    if (scenario === 'receipt') await f.store.update({lastAcknowledgedDelivery:{deliveryId:'d1'}});
    const before = await f.store.read();
    if (scenario === 'exact') {
      const after = await recoverSubmittedRoot(f);
      assert.equal(after.completedDelivery.rawText, f.result.text);
      assert.equal(after.currentDeliveryId, 'd1');
      assert.equal(f.sent.find(m => m.type === 'agent.recheck').payload.assistantMessageId, 'a1');
    } else {
      await assert.rejects(recoverSubmittedRoot(f));
      assert.deepEqual(await f.store.read(), before);
    }
    assert.ok(f.sent.every(m => ['agent.ping', 'agent.recheck'].includes(m.type)));
  }
});

test('same-tab token handoff distinguishes the original, requested and observed tokens', async t => {
  const logs = [];
  t.mock.method(console, 'info', (_prefix, message) => logs.push(JSON.parse(message)));
  const f = submittedFixture();
  const saved = await f.store.read();
  const context = {
    preparationId:'prep_r1', state:'RECOVERY_REQUIRED',
    error:{code:'UI_CONTRACT_CHANGED', details:{browserDispatchStarted:true}},
    webSession:{...saved, sessionId:'s1', activeDeliveryId:'d1'},
    deliveries:[{deliveryId:'d1', state:'RECOVERY_REQUIRED', unsent:false}],
  };
  const target = {
    conversationUrl:f.page.url, conversationId:'created', userMessageId:'u1', assistantMessageId:'a1',
    replacement:{tabId:7, windowId:3, documentId:'new', frameId:0},
  };
  const expected = submittedRootRecovery(context, target);
  const {replacement, ...originalOnly} = expected;
  await assert.rejects(recoverSubmittedRoot({
    ...f, expected:{...originalOnly, allowTabRelocation:false},
  }), {code:'DELIVERY_RECOVERY_UNCONFIRMED'});
  assert.deepEqual(await f.store.read(), saved);
  assert.equal(f.sent.some(message => message.type === 'agent.recheck'), false);
  assert.deepEqual(logs[0].documentTokens, {stored:'old', expected:'old', observed:'new'});
  f.page.documentId = 'another-document';
  await assert.rejects(recoverSubmittedRoot({...f, expected}), {code:'DELIVERY_RECOVERY_UNCONFIRMED'});
  assert.deepEqual(logs[1].documentTokens, {stored:'old', expected:'new', observed:'another-document'});
  assert.deepEqual(await f.store.read(), saved);
  assert.equal(f.sent.some(message => message.type === 'agent.recheck'), false);
  f.page.documentId = 'new';
  const after = await recoverSubmittedRoot({...f, expected});
  assert.deepEqual(logs.find(entry => entry.stage === 'CHECK_PAGE' && !entry.failedChecks.length).documentTokens,
    {stored:'old', expected:'new', observed:'new'});
  assert.deepEqual(after.completedDelivery.evidence.recoveryRebinding, {
    from:{tabId:7, windowId:3, documentId:'old', frameId:0}, to:replacement,
  });
  assert.deepEqual(await recoverSubmittedRoot({...f, expected}), after);
  assert.equal(f.sent.filter(message => message.type === 'agent.recheck').length, 1);
  assert.ok(f.sent.every(message => ['agent.ping', 'agent.recheck'].includes(message.type)));
});

for(const boundary of ['owner','tab','generating','missing marker','wrong document','ambiguous response','heuristic response','owner changed','document changed']) {
  test(`root response recovery preserves the record on ${boundary}`,async()=>{
    const f=submittedFixture();
    if(boundary==='owner') f.expected.runId='other';
    if(boundary==='tab') f.tabs.get=async()=>({id:7,windowId:3,url:'https://chatgpt.com/c/other'});
    if(boundary==='generating') f.page.generating=true;
    if(boundary==='missing marker') Object.assign(f.result,{ok:false,code:'AMBIGUOUS_PROMPT_BINDING'});
    if(boundary==='wrong document') f.result.evidence.documentId='other';
    if(boundary==='ambiguous response') f.result.confidence='AMBIGUOUS';
    if(boundary==='heuristic response') f.result.confidence='HEURISTIC';
    if(boundary==='document changed') {
      const send=f.tabs.sendMessage;f.tabs.sendMessage=async(id,m)=>{
        const result=await send(id,m);if(m.type==='agent.recheck')f.page.documentId='changed';return result;
      };
    }
    if(boundary==='owner changed') {
      const send=f.tabs.sendMessage; f.tabs.sendMessage=async(id,m)=>{
        if(m.type==='agent.recheck') await f.store.update({lastBoundSessionId:'other'});
        return send(id,m);
      };
    }
    await assert.rejects(recoverSubmittedRoot(f));
    const saved=await f.store.read();
    assert.equal(saved.currentDeliveryId,'d1');assert.equal(saved.completedDelivery,null);
    assert.equal(saved.conversationUrl,'https://chatgpt.com/');
    assert.ok(f.sent.every(m=>['agent.ping','agent.recheck'].includes(m.type)));
  });
}

test('submitted-response recheck requires unique markers and direct message order',async()=>{
  const content=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
  const branch=content.slice(content.indexOf('  if (message?.type === "agent.recheck")'),content.indexOf('  if (message?.type === "agent.cancel")'));
  for(const scenario of ['valid','duplicate','manual user','multiple replies','changed reply','wrong marker','wrong user id']) {
    const messages=[{id:'u1',role:'user',index:0,matched:true},{id:'a1',role:'assistant',index:1}];
    if(scenario==='duplicate') messages.push({id:'u2',role:'user',index:2,matched:true});
    if(scenario==='manual user') messages.push({id:'u2',role:'user',index:2});
    if(scenario==='multiple replies') messages.push({id:'a2',role:'assistant',index:2});
    if(scenario==='wrong marker') messages[0].matched=false;
    if(scenario==='wrong user id') messages[0].id='other';
    let waits=0;
    const context=vm.createContext({currentJob:null,AbortController,ContentContractError:class extends Error{constructor(code,message){super(message);this.code=code;}},
      assertExpectedDocument(){},assertExpectedConversation(){},messageSnapshot:()=>messages,isExpectedUser:m=>m.matched===true,
      waitForAssistantResponse:async args=>{waits++;assert.equal(args.timeoutMs,15000);assert.equal(args.stableMs,3500);
        return {text:'reply',evidence:{assistantMessageId:scenario==='changed reply'?'a2':'a1'}};}});
    vm.runInContext('function receive(message,sendResponse){'+branch+'}',context);
    const result=await new Promise(resolve=>context.receive({type:'agent.recheck',payload:{
      recoverSubmitted:true,controllerMessageId:'d1',userMessageId:'u1',assistantMessageId:'a1'}},resolve));
    assert.equal(result.ok,scenario==='valid',scenario);
    assert.equal(context.currentJob,null);
    if(['duplicate','manual user','multiple replies'].includes(scenario)) assert.equal(waits,0);
  }
});

test('closed selected start tab returns current candidates without binding or sending', async () => {
  let bound = 0, sent = 0;
  const context = vm.createContext({ ...providerTarget, console,
    closedBootstrapRootTabs,
    ExtensionOperationError: class extends Error { constructor(code, message, details) { super(message); this.code=code; this.details=details; } },
    store:{bindSession:async()=>{bound++;}},
    chrome:{runtime:{id:'fixture',getManifest:()=>({version:'0.2.22'})},tabs:{
      get:async()=>{throw new Error('No tab with id: 7.');},
      query:async()=>[{id:8,windowId:2,url:'https://chatgpt.com/'},
        {id:9,windowId:2,url:'https://chatgpt.com/c/unrelated'}],
      sendMessage:async()=>{sent++;},
    }},
  });
  vm.runInContext(source.slice(source.indexOf('function requireBindingInput('),source.indexOf('async function focusTab(')),context);
  await assert.rejects(context.rebindSession({sessionId:'s1',runId:'r1',provider:'CHATGPT_WEB',
    conversationUrl:null,conversationId:null,tabId:7}),error=>{
    assert.equal(error.code,'AMBIGUOUS');
    assert.equal(error.details.originalCode,'TAB_CHANGED');
    assert.equal(error.details.browserDispatchStarted,false);
    assert.deepEqual(JSON.parse(JSON.stringify(error.details.rootTabs)),[{tabId:8,windowId:2,url:'https://chatgpt.com/'}]);
    return true;
  });
  assert.equal(bound,0);assert.equal(sent,0);
});

// Whole content/background scripts and their Web adapter connection are tested
// by npm run test:browser. These are focused recovery policy boundary checks.
function fixture({ current = {}, page = {}, tabUrls = ['https://chatgpt.com/uc/created'] } = {}) {
  const reservedState = { lastBoundSessionId: 's1', lastBoundRunId: 'r1', currentDeliveryId: 'd1',
    tabId: 7, windowId: 3, documentId: 'old-document', frameId: 0,
    conversationUrl: 'https://chatgpt.com/', conversationId: null, bindingStatus: 'ROOT_READY' };
  let saved = { ...reservedState, ...current };
  const sent = [];
  const store = createExtensionStateStore({ get: async () => structuredClone(saved), set: async value => { saved = structuredClone(value); } });
  const observed = { ok: true, url: 'https://chatgpt.com/uc/created', conversationId: 'created',
    documentId: 'new-document', frameId: 0, ...page };
  let tabRead = 0;
  const args = { store, reservedState, tab: { id: 7 }, turnIdentity: { requestId: 'd1', controllerMessageId: 'd1', runId: 'r1' },
    payload: {}, waitForContentScript: async () => observed, sleep: async () => {},
    tabs: { get: async () => ({ id: 7, windowId: 3, url: tabUrls[Math.min(tabRead++, tabUrls.length - 1)] }),
      sendMessage: async (tabId, message) => { sent.push({ tabId, ...message }); return { ok: true }; } } };
  return { args, sent, store };
}

test('bootstrap recovery persists the observed document and requests observation only', async () => {
  const f = fixture();
  const result = await recoverBootstrapAfterNavigation(f.args);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].type, 'agent.observeSubmittedPrompt');
  assert.equal(f.sent[0].payload.expectedDocumentId, 'new-document');
  assert.equal(f.sent[0].payload.controllerMessageId, 'd1');
  assert.equal(result.frozenTurn.documentId, 'new-document');
  assert.equal((await f.store.read()).currentDeliveryId, 'd1');
});
for (const temporaryId of ['WEB:temporary', 'local-chatgpt%3Atemporary']) {
test(`bootstrap recovery waits for temporary ${temporaryId} to settle`, async () => {
  const f = fixture({ tabUrls: [
    'https://chatgpt.com/c/' + temporaryId,
    'https://chatgpt.com/c/created',
  ], page: { url: 'https://chatgpt.com/c/created', conversationId: 'created' } });
  const result = await recoverBootstrapAfterNavigation(f.args);
  assert.equal(result.frozenTurn.conversationId, 'created');
  assert.equal((await f.store.read()).conversationUrl, 'https://chatgpt.com/c/created');
  assert.equal(f.sent.length, 1);
});
}

test("root prepare sends once on a separate tab and preserves an earlier delivery", async () => {
  let saved = { tabId:99, windowId:2, documentId:"old-document", frameId:0,
    bindingStatus:"AMBIGUOUS", conversationUrl:"https://chatgpt.com/", conversationId:null,
    lastBoundSessionId:"old-session", lastBoundRunId:"old-run", currentDeliveryId:"old-delivery" };
  const store = createExtensionStateStore({ get:async () => structuredClone(saved), set:async value => {
    saved = structuredClone(value);
  } });
  const tab = { id: 1, windowId: 2, url: "https://chatgpt.com/" };
  const sent = [], prompts = [];
  const context = vm.createContext({ ...documentBinding, ...conversation, ...guards, ...currentTarget, ...providerTarget, createControlledPrompt, conversationTabCandidates,
    console, Number, Date, setTimeout, clearTimeout, lastError: null,
    bridgeLog() {},
    CHATGPT_URL_PATTERNS: ["https://chatgpt.com/*"],
    turnGate: guards.createActiveTurnGate(), authenticated: false,
    broadcastPopupState() {}, waitForContentScript: async () => ({ ok: true, ready: true, busy: false, generating: false,
      url: tab.url, conversationId: conversation.conversationIdFromUrl(tab.url), documentId: "document-1", frameId: 0 }), focusTab: async () => {},
    send: m => sent.push(m), errorPayload: e => ({ code: e.code, message: e.message }),
    ExtensionOperationError: class extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } },
    store,
    chrome: { tabs: { query: async () => [tab], get: async () => ({ ...tab }), sendMessage: async (_id, m) => {
      if (m.type === "agent.ping") return { ok: true, ready: true, url: tab.url, conversationId: conversation.conversationIdFromUrl(tab.url), documentId: "document-1", frameId: 0 };
      prompts.push(m);
      assert.equal(tab.url, "https://chatgpt.com/");
      tab.url = "https://chatgpt.com/c/created";
      return { ok: true, text: "reply", confidence: "CONFIRMED_BY_UI_STATE",
        evidence: { documentId: "document-1", frameId: 0, conversationUrl: tab.url, conversationId: "created", userMessageId: "u1", assistantMessageId: "a1" } };
    } } },
  });
  vm.runInContext(source.slice(source.indexOf("function requireBindingInput("), source.indexOf("async function focusTab(")), context);
  const ready = await context.prepareBoundSession({ sessionId: "s1", runId: "r1", conversationUrl: null, conversationId: null });
  assert.equal(ready.bindingStatus, "ROOT_READY");
  assert.equal(prompts.length, 0);
  await context.handlePrompt({ requestId: "d1", payload: { runId: "r1", controllerMessageId: "d1", text: "request" } });
  assert.equal(prompts.length, 1);
  assert.equal(sent[0]?.type, "web.prompt.result", JSON.stringify(sent));
  const state = await store.read();
  assert.equal(state.conversationId, "created");
  assert.equal(state.completedDelivery.turnId, "d1");
  assert.equal(state.currentDeliveryId, "d1");
  assert.equal(state.deliveryScopes["old-session"].currentDeliveryId, "old-delivery");
  assert.equal(state.deliveryScopes["old-session"].tabId, 99);
  assert.deepEqual({ ...state.completedDelivery.trace }, {
    requestId: "d1", actionId: "d1", result: "success", tabId: 1,
    bindingId: "s1:r1", documentId: "document-1", frameId: 0,
  });
});

for (const current of [{ currentDeliveryId: 'other' }, { lastBoundSessionId: 'other' }, { lastBoundRunId: 'other' }, { tabId: 8 }]) {
  test(`bootstrap rejects a changed ${Object.keys(current)[0]} before observing or promoting`, async () => {
    const f = fixture({ current });
    const before = await f.store.read();
    await assert.rejects(recoverBootstrapAfterNavigation(f.args), { code: 'TURN_BINDING_CHANGED' });
    assert.deepEqual(await f.store.read(), before);
    assert.equal(f.sent.length, 0);
  });
}

for (const page of [{ url: 'https://chatgpt.com/c/other' }, { conversationId: 'other' }, { documentId: null }, { frameId: 1 }]) {
  test(`bootstrap rejects invalid observed ${Object.keys(page)[0]} and keeps the unresolved delivery`, async () => {
    const f = fixture({ page });
    const before = await f.store.read();
    await assert.rejects(recoverBootstrapAfterNavigation(f.args), { code: 'WEB_DOCUMENT_CHANGED' });
    assert.deepEqual(await f.store.read(), before);
    assert.equal(f.sent.length, 0);
  });
}

function relocateSubmittedFixture(f) {
  f.expected.allowTabRelocation=true;
  const target={id:8,windowId:4,url:f.page.url};
  f.tabs.get=async id=>{
    if(id!==8) throw new Error('No tab with id: '+id);
    return {...target};
  };
  f.tabs.query=async()=>[{...target}];
}

test('root relocation validates before writing and rereads a lost reply without resubmitting',async()=>{
  const f=submittedFixture(); relocateSubmittedFixture(f);
  const send=f.tabs.sendMessage;
  f.tabs.sendMessage=async(id,message)=>{
    assert.equal(id,8);
    if(message.type==='agent.recheck') {
      const before=await f.store.read();
      assert.equal(before.tabId,7); assert.equal(before.currentDeliveryId,'d1');
      assert.equal(before.completedDelivery,null);
    }
    return send(id,message);
  };
  const saved=await recoverSubmittedRoot(f);
  assert.deepEqual(saved,await f.store.read());
  assert.equal(saved.tabId,8); assert.equal(saved.windowId,4);
  assert.equal(saved.currentDeliveryId,'d1'); assert.equal(saved.completedDelivery.rawText,f.result.text);
  assert.deepEqual(await recoverSubmittedRoot(f),saved);
  assert.equal(f.sent.filter(m=>m.type==='agent.recheck').length,1);
  assert.ok(f.sent.every(m=>['agent.ping','agent.recheck'].includes(m.type)));
});

for(const change of ['none','text','user','assistant','document','owner','storage']) {
  test('completed response relocation preserves original state: '+change,async()=>{
    const f=submittedFixture(); await recoverSubmittedRoot(f);
    const before=await f.store.read(); relocateSubmittedFixture(f);
    f.page.documentId='replacement'; f.result.evidence.documentId='replacement';
    if(change==='text') f.result.text='different';
    if(change==='user') f.result.evidence.userMessageId='other-user';
    if(change==='assistant') f.result.evidence.assistantMessageId='other-assistant';
    let raceState;
    const send=f.tabs.sendMessage;
    f.tabs.sendMessage=async(id,message)=>{
      const result=await send(id,message);
      if(message.type==='agent.recheck' && change==='document') f.page.documentId='changed-again';
      if(message.type==='agent.recheck' && change==='owner') {
        await f.store.update({lastBoundSessionId:'other-session'}); raceState=await f.store.read();
      }
      return result;
    };
    if(change==='storage') f.store={...f.store,updateIf:async()=>{throw new Error('storage write failed');}};
    if(change!=='none') {
      await assert.rejects(recoverSubmittedRoot(f));
      assert.deepEqual(await f.store.read(),raceState??before);
    } else {
      const after=await recoverSubmittedRoot(f);
      assert.equal(after.tabId,8); assert.equal(after.currentDeliveryId,before.currentDeliveryId);
      assert.equal(after.completedDelivery.rawText,before.completedDelivery.rawText);
      assert.equal(after.completedDelivery.evidence.userMessageId,before.completedDelivery.evidence.userMessageId);
      assert.equal(after.completedDelivery.evidence.assistantMessageId,before.completedDelivery.evidence.assistantMessageId);
      const count=f.sent.filter(m=>m.type==='agent.recheck').length;
      assert.deepEqual(await recoverSubmittedRoot(f),after);
      assert.equal(f.sent.filter(m=>m.type==='agent.recheck').length,count);
    }
  });
}

for(const boundary of ['no opt-in','no candidate','ambiguous','old tab present','other owner']) {
  test('relocation rejects '+boundary+' without changing saved state',async()=>{
    const f=submittedFixture(); relocateSubmittedFixture(f);
    if(boundary==='no opt-in') delete f.expected.allowTabRelocation;
    if(boundary==='no candidate') f.tabs.query=async()=>[];
    if(boundary==='ambiguous') f.tabs.query=async()=>[8,9].map(id=>({id,windowId:4,url:f.page.url}));
    if(boundary==='old tab present') f.tabs.get=async()=>({id:7,windowId:3,url:'https://chatgpt.com/c/other'});
    if(boundary==='other owner') await f.store.update({deliveryScopes:{other:{currentDeliveryId:'other-delivery',tabId:8}}});
    const before=await f.store.read();
    await assert.rejects(recoverSubmittedRoot(f));
    assert.deepEqual(await f.store.read(),before);
    assert.equal(f.sent.filter(m=>m.type==='agent.recheck').length,0);
  });
}

test('completed-delivery CAS compares stored content rather than object identity',async()=>{
  const f=submittedFixture(); await recoverSubmittedRoot(f);
  const before=await f.store.read();
  await f.store.updateIf({completedDelivery:structuredClone(before.completedDelivery)},{bindingError:'checked'});
  await f.store.update({completedDelivery:{...before.completedDelivery,rawText:'changed'}});
  const changed=await f.store.read();
  await assert.rejects(f.store.updateIf({completedDelivery:before.completedDelivery},{tabId:99}),{code:'DELIVERY_RECOVERY_MISMATCH'});
  assert.deepEqual(await f.store.read(),changed);
});

function submittedDispatchFixture(f,{sendMode='open',detailsFail=false}={}) {
  const attempts=[],wire=[],gate=guards.createActiveTurnGate();
  const context=vm.createContext({authenticated:true,PROTOCOL_VERSION:2,inspectSubmittedRoot,readDeliveryPage,
    chrome:{tabs:f.tabs},store:f.store,turnGate:gate,errorPayload:error=>({code:error.code??'WEB_EXTENSION_ERROR'}),
    decisionEvidence:{accept:()=>false},agentDiagnostics:{accept:()=>false,recordMessage(){}},serverDeliveryInspector:{accept:()=>false},WebSocket:{OPEN:1},
    socket:{readyState:sendMode==='closed'?3:1,send:raw=>{
      if(sendMode==='throw') throw new Error('socket send failed');
      wire.push(JSON.parse(raw));
    }},attempts});
  const sendSource=source.slice(source.indexOf('function send(message,'),source.indexOf('const decisionEvidence ='));
  const detailsSource=source.slice(source.indexOf('async function deliveryDetails('),source.indexOf('async function handleDeliveryStop('));
  const dispatchSource=source.slice(source.indexOf('async function handleControllerMessage('),source.indexOf('async function handlePrepare('));
  assert.ok(sendSource && detailsSource && dispatchSource);
  vm.runInContext(sendSource+detailsSource+dispatchSource+
    'const originalSend=send; send=(message,...args)=>{attempts.push(message);return originalSend(message,...args);};',context);
  if(detailsFail) vm.runInContext('deliveryDetails=async()=>{throw new Error("details failed");};',context);
  return {attempts,wire,gate,run:requestId=>context.handleControllerMessage(JSON.stringify({
    protocolVersion:2,type:'web.delivery.inspect',requestId,payload:{recoverSubmitted:f.expected},
  }))};
}

test('actual background dispatch sends one success for recovery and one for an explicit completed reread',async()=>{
  const f=submittedFixture(); relocateSubmittedFixture(f);
  const d=submittedDispatchFixture(f);
  await d.run('first'); await d.run('second');
  assert.equal(d.attempts.length,2); assert.equal(d.wire.length,2);
  assert.deepEqual(d.wire.map(m=>[m.requestId,m.type]),[
    ['first','web.delivery.inspected'],['second','web.delivery.inspected']]);
  assert.ok(d.wire.every(m=>m.payload.currentDeliveryId==='d1' && m.payload.tabId===8 && m.payload.extensionBusy===false));
  assert.equal(f.sent.filter(m=>m.type==='agent.recheck').length,1);
  assert.equal(d.gate.active,false);
});

for(const failure of ['recheck','details','owner changed','reservation']) {
  test('actual background dispatch emits one error and no success: '+failure,async()=>{
    const f=submittedFixture(),d=submittedDispatchFixture(f,{detailsFail:failure==='details'});
    if(failure==='recheck') Object.assign(f.result,{ok:false,code:'RESPONSE_RECHECK_FAILED'});
    const send=f.tabs.sendMessage; let pings=0;
    f.tabs.sendMessage=async(id,message)=>{
      const result=await send(id,message);
      if(message.type==='agent.ping' && ++pings===3 && failure==='owner changed') {
        await f.store.update({currentDeliveryId:'another-delivery'});
      }
      return result;
    };
    const reservation=failure==='reservation'?d.gate.reserve('other'):null;
    await d.run('failed');
    assert.deepEqual(d.wire.map(m=>m.type),['web.session.error']);
    assert.equal(d.attempts.length,1);assert.equal(d.gate.active,reservation!==null);
    if(failure==='owner changed') assert.equal((await f.store.read()).currentDeliveryId,'another-delivery');
    if(reservation)d.gate.release(reservation);
  });
}

for(const sendMode of ['closed','throw']) {
  test('dispatch preserves completed response and never retries when transport is '+sendMode,async()=>{
    const f=submittedFixture(),d=submittedDispatchFixture(f,{sendMode});
    if(sendMode==='throw') await assert.rejects(d.run('failed-send'),/socket send failed/);
    else await d.run('failed-send');
    assert.equal(d.attempts.length,1);assert.equal(d.wire.length,0);assert.equal(d.gate.active,false);
    const saved=await f.store.read();assert.equal(saved.currentDeliveryId,'d1');assert.equal(saved.completedDelivery.rawText,f.result.text);
    const next=submittedDispatchFixture(f);await next.run('explicit-reread');
    assert.equal(next.wire.length,1);assert.equal(next.wire[0].type,'web.delivery.inspected');
    assert.equal(f.sent.filter(m=>m.type==='agent.recheck').length,1);
  });
}
import { conversationTabCandidates } from "../extension/runtime/conversation-bootstrap.js";
