import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeliveryRecoveryActions } from '../src/orchestration/delivery-recovery-actions.js';
import { createExtensionStateStore } from '../extension/runtime/storage.js';
import { discardExactDelivery } from '../extension/runtime/delivery-discard.js';
import { createActiveTurnGate } from '../extension/runtime/turn-guard.js';

async function fixture() {
  const owner = { currentDeliveryId:'d', sessionId:'s', runId:'r', conversationUrl:'https://chatgpt.com/' };
  let saved = { currentDeliveryId:'d', lastBoundSessionId:'s', lastBoundRunId:'r', conversationUrl:owner.conversationUrl,
    tabId:7, documentId:'doc', frameId:0, bindingStatus:'AMBIGUOUS' };
  let writeFailure=false;
  const area = {get:async () => structuredClone(saved),set:async value => {if(writeFailure) throw Object.assign(new Error('storage write failed'),{code:'STORAGE_FAILED'});saved = structuredClone(value);}};
  let store = createExtensionStateStore(area);
  const gate = createActiveTurnGate(), events = [];
  const context = {preparationId:'r',webSession:{sessionId:'s',conversationUrl:owner.conversationUrl,activeDeliveryId:null},
    lifecycle:'ABANDONED', deliveries:[{deliveryId:'d',sessionId:'s',state:'RECOVERY_DISCARDED'}]};
  const sources = {contexts:[context],runs:[]};
  const preparationService = {jobs:new Map(),data:{contexts:{r:context}},touch:async()=>{}};
  const codeChanges = {jobs:new Map(),workers:new Map(),reviewerWebBusy:() => false};
  let page = null, discardCalls = 0, dropReply = false, failInspect = false;
  const tabs = {sendMessage:async () => page};
  const web = {inspectDelivery:async () => {
    if (failInspect && discardCalls) throw Object.assign(new Error('private'),{code:'EXTENSION_DISCONNECTED'});
    const state = await store.read();
    return {currentDeliveryId:state.currentDeliveryId,sessionId:state.lastBoundSessionId,runId:state.lastBoundRunId,
      conversationUrl:state.conversationUrl,tabId:state.tabId,documentId:state.documentId,frameId:state.frameId,lastDeliveryDiscard:state.lastDeliveryDiscard,lastAcknowledgedDelivery:state.lastAcknowledgedDelivery,
      completedDelivery:state.completedDelivery,
      hasCompletedDelivery:state.completedDelivery !== null,
      scopedDeliveries:Object.values(state.deliveryScopes).map(s => ({deliveryId:s.currentDeliveryId,sessionId:s.lastBoundSessionId})),
      terminalDiscardProtocol:1,extensionBusy:gate.active,pageReachable:page?.ok === true,pageBusy:page?.busy ?? null,generating:page?.generating ?? null};
  },discardDelivery:async input => {
    discardCalls++;
    let reply;
    await discardExactDelivery({store,turnGate:gate,tabs,message:{requestId:'discard',payload:input},send:value => {reply=value;}});
    if (reply.type === 'web.session.error') throw Object.assign(new Error(reply.payload.message),{code:reply.payload.code});
    if (dropReply) {dropReply=false;throw Object.assign(new Error('lost'),{code:'EXTENSION_DISCONNECTED'});}
    return reply.payload;
  }};
  const options = {web,getSources:async () => sources,getServices:async () => ({preparationService,codeChanges}),
    audit:async event => events.push(event)};
  let actions = createDeliveryRecoveryActions(options);
  const input = {...owner,reason:'Operator decision',unresolvedResultConfirmed:true,noAutomaticResendConfirmed:true,
    terminalDiscardConfirmed:true,pageStateUnconfirmedConfirmed:true};
  return {owner,input,context,sources,preparationService,codeChanges,events,web,gate,
    inspect:() => actions.inspect(owner),discard:patch => actions.discard({...input,...patch}),
    failWrite:value => {writeFailure=value;},
    audit:callback => {options.audit=callback;actions=createDeliveryRecoveryActions(options);},
    read:() => store.read(),update:patch => store.update(patch),calls:() => discardCalls,
    page:value => {page=value;},drop:() => {dropReply=true;},failInspection:value => {failInspect=value;},
    restart:() => {store=createExtensionStateStore(area);actions=createDeliveryRecoveryActions(options);}};
}

test('terminal server discard plus unreachable exact extension owner is reconciled without resending',async () => {
  const f = await fixture();
  const before = structuredClone(f.context);
  const result = await f.discard();
  assert.equal(result.discarded,true);
  assert.equal(result.resultStatus,'UNKNOWN');
  assert.equal((await f.read()).currentDeliveryId,null);
  assert.deepEqual(f.context,before);
  const seen = await f.inspect();
  assert.equal(seen.extension.discardConfirmed,true);
  assert.equal(seen.extension.phase,'DISCARDED');
  assert.equal(seen.extension.resultStatus,'UNKNOWN');
  assert.deepEqual(f.events.map(e => e.phase),['STARTED','COMPLETED']);
  f.restart();await f.discard();assert.equal(f.calls(),1);
});

test('an active reviewer response awaiting ACK cannot enter the discard protocol', async () => {
  const owner = {currentDeliveryId:'review-d',sessionId:'review-s',runId:'review-r',conversationUrl:'https://chatgpt.com/'};
  const run = {runId:owner.runId,conversationBindings:[{sessionId:owner.sessionId,
    conversationUrl:owner.conversationUrl,activeDeliveryId:owner.currentDeliveryId}],
    webDeliveryReceipts:[{deliveryId:owner.currentDeliveryId,sessionId:owner.sessionId,
      conversationUrl:owner.conversationUrl,state:'ACK_PENDING',responseRef:{sha256:'stored'}}]};
  let dispatches = 0, updates = 0;
  const codeChanges = {jobs:new Map(),workers:new Map(),reviewerWebBusy:()=>false,
    get:()=>run,update:()=>{updates++;}};
  const actions = createDeliveryRecoveryActions({getSources:async()=>({contexts:[],runs:[run]}),
    getServices:async()=>({codeChanges}),web:{inspectDelivery:async()=>({
      currentDeliveryId:owner.currentDeliveryId,sessionId:owner.sessionId,runId:owner.runId,
      conversationUrl:owner.conversationUrl,pageReachable:false,pageBusy:null,generating:null,
      scopedDeliveries:[],hasCompletedDelivery:false,extensionBusy:false}),discardDelivery:async()=>{dispatches++;}}});
  const before = await actions.inspect(owner);
  assert.equal(before.server.records[0].responseStored,true);
  assert.equal(before.server.records[0].processingState,'ACK_PENDING');
  await assert.rejects(actions.discard({...owner,reason:'Operator decision',unresolvedResultConfirmed:true,
    noAutomaticResendConfirmed:true,pageStateUnconfirmedConfirmed:true}),{code:'DELIVERY_RESPONSE_REQUIRED'});
  assert.equal(dispatches,0);
  assert.equal(updates,0);
  assert.equal(run.webDeliveryReceipts[0].state,'ACK_PENDING');
  assert.equal(run.conversationBindings[0].activeDeliveryId,owner.currentDeliveryId);
});

test('an active preparation with a stored response cannot be discarded before ACK metadata appears', async () => {
  const f = await fixture();
  f.context.webSession.activeDeliveryId = f.owner.currentDeliveryId;
  f.context.deliveries[0].state = 'RESPONSE_RECEIVED';
  f.context.deliveries[0].response = {rawText:'PRIVATE'};
  await assert.rejects(f.discard({terminalDiscardConfirmed:false}), {code:'DELIVERY_RESPONSE_REQUIRED'});
  assert.equal(f.calls(),0);
  assert.equal(f.context.webSession.activeDeliveryId,f.owner.currentDeliveryId);
  assert.equal(f.context.deliveries[0].state,'RESPONSE_RECEIVED');
  assert.equal((await f.read()).currentDeliveryId,f.owner.currentDeliveryId);
});

test('a locally completed response is preserved even when the server has no stored response', async () => {
  const f = await fixture();
  await f.update({completedDelivery:{turnId:'d',text:'PRIVATE'}});
  await assert.rejects(f.discard(),{code:'DELIVERY_RESPONSE_REQUIRED'});
  assert.equal(f.calls(),0);
  assert.equal((await f.read()).completedDelivery.text,'PRIVATE');
  assert.equal((await f.read()).currentDeliveryId,'d');
});

test('an active preparation cannot be discarded with another active server owner', async () => {
  const f = await fixture();
  f.context.webSession.activeDeliveryId = f.owner.currentDeliveryId;
  f.context.deliveries[0].state = 'UNRESOLVED';
  f.sources.contexts.push({preparationId:'other',webSession:{sessionId:'other',
    conversationUrl:'https://chatgpt.com/c/other',activeDeliveryId:'other'},deliveries:[{deliveryId:'other'}]});
  await assert.rejects(f.discard({terminalDiscardConfirmed:false}),{code:'WEB_SESSION_BUSY'});
  assert.equal(f.calls(),0);
  assert.equal(f.context.webSession.activeDeliveryId,f.owner.currentDeliveryId);
});
test('real ownership inspection carries a different active REVIEW binding into the discard guard', async () => {
  const f = await fixture();
  f.context.webSession.activeDeliveryId = f.owner.currentDeliveryId;
  f.context.deliveries[0].state = 'UNRESOLVED';
  f.sources.runs.push({runId:'other-run',conversationBindings:[{sessionId:'other-session',
    conversationUrl:'https://chatgpt.com/c/other',activeDeliveryId:'other-delivery'}],webDeliveryReceipts:[]});
  assert.equal((await f.inspect()).server.otherActive,true);
  await assert.rejects(f.discard({terminalDiscardConfirmed:false}),{code:'WEB_SESSION_BUSY'});
  assert.equal(f.context.deliveries[0].discardIntent,undefined);
  assert.equal(f.calls(),0);
});
test('a different local completed response stops the server before a PREPARATION discard intent', async () => {
  const f = await fixture();
  f.context.webSession.activeDeliveryId = f.owner.currentDeliveryId;
  f.context.deliveries[0].state = 'UNRESOLVED';
  await f.update({completedDelivery:{turnId:'other-delivery',text:'PRIVATE'}});
  await assert.rejects(f.discard({terminalDiscardConfirmed:false}),{code:'DELIVERY_RESPONSE_REQUIRED'});
  assert.equal(f.context.deliveries[0].discardIntent,undefined);
  assert.equal(f.calls(),0);
  assert.equal((await f.read()).completedDelivery.text,'PRIVATE');
});
test('a response arriving after server intent leaves an explicit uncertain intent and the response intact', async () => {
  const f = await fixture();
  f.context.webSession.activeDeliveryId = f.owner.currentDeliveryId;
  f.context.deliveries[0].state = 'UNRESOLVED';
  const dispatch = f.web.discardDelivery;
  f.web.discardDelivery = async input => {
    await f.update({completedDelivery:{turnId:'other-delivery',text:'PRIVATE'}});
    return dispatch(input);
  };
  await assert.rejects(f.discard({terminalDiscardConfirmed:false}),{code:'DELIVERY_RESPONSE_REQUIRED'});
  assert.equal(f.context.deliveries[0].discardIntent.status,'VERIFY_REQUIRED');
  assert.equal(f.context.deliveries[0].discardIntent.lastErrorCode,'DELIVERY_RESPONSE_REQUIRED');
  assert.equal(f.context.deliveries[0].state,'UNRESOLVED');
  assert.equal(f.context.webSession.activeDeliveryId,f.owner.currentDeliveryId);
  assert.equal((await f.read()).completedDelivery.text,'PRIVATE');
  await assert.rejects(f.discard({terminalDiscardConfirmed:false}),{code:'DELIVERY_RESPONSE_REQUIRED'});
  assert.equal(f.calls(),1);
});
test('missing extension response-presence metadata blocks a server intent', async () => {
  const f = await fixture();
  f.context.webSession.activeDeliveryId = f.owner.currentDeliveryId;
  f.context.deliveries[0].state = 'UNRESOLVED';
  const inspect = f.web.inspectDelivery;
  f.web.inspectDelivery = async () => {const state = await inspect();delete state.hasCompletedDelivery;return state;};
  await assert.rejects(f.discard({terminalDiscardConfirmed:false}),{code:'EXTENSION_UPDATE_REQUIRED'});
  assert.equal(f.context.deliveries[0].discardIntent,undefined);
  assert.equal(f.calls(),0);
});
for (const [label,patch,code] of [
  ['terminal confirmation',{terminalDiscardConfirmed:false},'DISCARD_CONFIRMATION_REQUIRED'],
  ['page confirmation',{pageStateUnconfirmedConfirmed:false},'PAGE_STATE_CONFIRMATION_REQUIRED'],
  ['different target',{sessionId:'other'},'DELIVERY_RECOVERY_MISMATCH'],
]) test('terminal reconciliation rejects '+label,async () => {
  const f=await fixture();await assert.rejects(f.discard(patch),{code});assert.equal(f.calls(),0);
});
for (const label of ['response','ACK_PENDING','ACKNOWLEDGED','new-owner','other-server','other-scope','job','worker','generation']) {
  test('terminal reconciliation protects '+label,async () => {
    const f=await fixture(),d=f.context.deliveries[0];
    if(label==='response') d.response={rawText:'PRIVATE'};
    if(label==='ACK_PENDING') d.processingState='ACK_PENDING';
    if(label==='ACKNOWLEDGED') d.state='ACKNOWLEDGED';
    if(label==='new-owner') await f.update({currentDeliveryId:'new'});
    if(label==='other-server') f.sources.contexts.push({preparationId:'other',webSession:{sessionId:'other',activeDeliveryId:'other'},deliveries:[{deliveryId:'other'}]});
    if(label==='other-scope') await f.update({deliveryScopes:{other:{currentDeliveryId:'other',lastBoundSessionId:'other'}}});
    if(label==='job') f.preparationService.jobs.set('other',true);
    if(label==='worker') f.codeChanges.workers.set('other',true);
    if(label==='generation') f.page({ok:true,busy:false,generating:true});
    await assert.rejects(f.discard());assert.equal(f.calls(),0);assert.ok((await f.read()).currentDeliveryId);
  });
}
for (const failure of ['lost-reply','failed-verification']) test(failure+' is recoverable after reconstruction',async () => {
  const f=await fixture();if(failure==='lost-reply') f.drop();else f.failInspection(true);
  await assert.rejects(f.discard());assert.equal(f.events.at(-1).phase,'FAILED');
  f.failInspection(false);f.restart();await f.discard();assert.equal(f.calls(),1);
  assert.equal(f.events.at(-1).phase,'COMPLETED');
});

test('document ownership race never discard the replacement',async () => {
  const f=await fixture(), original=f.web.discardDelivery;
  f.web.discardDelivery=async input => {await f.update({documentId:'replacement'});return original(input);};
  await assert.rejects(f.discard(),{code:'DELIVERY_RECOVERY_MISMATCH'});
  assert.equal((await f.read()).currentDeliveryId,'d');assert.equal(f.events.at(-1).phase,'FAILED');
});
test('extension write failure preserves ownership and retry persists a verifiable receipt',async () => {
  const f=await fixture();f.failWrite(true);
  await assert.rejects(f.discard(),{code:'STORAGE_FAILED'});assert.equal((await f.read()).currentDeliveryId,'d');
  f.failWrite(false);await f.discard();assert.equal((await f.read()).lastDeliveryDiscard.deliveryId,'d');
});
test('old extension capability cannot enter terminal reconciliation',async () => {
  const f=await fixture(),original=f.web.inspectDelivery;
  f.web.inspectDelivery=async () => ({...await original(),terminalDiscardProtocol:undefined});
  await assert.rejects(f.discard(),{code:'EXTENSION_UPDATE_REQUIRED'});assert.equal(f.calls(),0);
});
test('an ACK receipt cannot be relabeled as a discard receipt',async () => {
  const f=await fixture();await f.update({currentDeliveryId:null,lastAcknowledgedDelivery:{deliveryId:'d',sessionId:'s',runId:'r',conversationUrl:f.owner.conversationUrl}});
  await assert.rejects(f.discard(),{code:'DELIVERY_RECOVERY_MISMATCH'});assert.equal(f.calls(),0);
});

test('durable intent failure cannot dispatch and server ownership drift after intent is rejected',async()=>{
  const f=await fixture();f.audit(async()=>{throw Object.assign(new Error('audit unavailable'),{code:'DELIVERY_AUDIT_WRITE_FAILED'});});
  await assert.rejects(f.discard(),{code:'DELIVERY_AUDIT_WRITE_FAILED'});assert.equal(f.calls(),0);
  f.audit(async event=>{if(event.phase==='STARTED') f.context.webSession.activeDeliveryId='replacement';});
  await assert.rejects(f.discard(),{code:'WEB_SESSION_BUSY'});assert.equal(f.calls(),0);
});
test('successful RPC without a persisted receipt is not disposal completion',async()=>{
  const f=await fixture();f.web.discardDelivery=async()=>({result:'discarded'});
  await assert.rejects(f.discard(),{code:'DISCARD_UNCONFIRMED'});assert.equal(f.events.at(-1).phase,'FAILED');
  assert.equal((await f.read()).currentDeliveryId,'d');
});
test('extension active gate and concurrent recovery both reject without clearing ownership',async()=>{
  const f=await fixture(),held=f.gate.reserve('active');
  await assert.rejects(f.discard(),{code:'WEB_SESSION_BUSY'});assert.equal(f.calls(),0);f.gate.release(held);
  let release,entered;const started=new Promise(resolve=>{entered=resolve;});
  f.audit(async event=>{if(event.phase==='STARTED'){entered();await new Promise(resolve=>{release=resolve;});}});
  const first=f.discard();await started;await assert.rejects(f.discard(),{code:'WEB_SESSION_BUSY'});release();await first;
  assert.equal(f.calls(),1);
});
