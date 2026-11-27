import test from "node:test";
import assert from "node:assert/strict";
import { fixture, settled, tick } from "./helpers/preparation-service-fixture.js";

async function failedRootFixture(t,{plain=false,wrongRun=false,relocated=false,uiChanged=false}={}) {
  const f=fixture(t);let submissions=0,acknowledged=false;
  f.web.submitTurn=async()=>{submissions++;throw Object.assign(new Error('temporary ID changed'),{
    code:uiChanged?'UI_CONTRACT_CHANGED':'MANUAL_INTERVENTION_DETECTED',details:{browserDispatchStarted:true,
      ...(uiChanged?{}:{observedUrl:'https://chatgpt.com/c/recovered',observedId:'recovered'})}});};
  await f.service.execute('preparation.start',{requestId:'root',objective:'original request',targetRoot:f.root,conversationUrl:'https://chatgpt.com/'});
  await settled(f.service);
  const c=f.service.current,s=c.webSession,d=c.deliveries[0];
  const binding={...s,sessionId:s.sessionId,runId:wrongRun?'other':c.preparationId,bindingStatus:'BOUND',
    conversationUrl:'https://chatgpt.com/c/recovered',conversationId:'recovered',documentId:uiChanged?s.documentId:'new-document',
    tabId:relocated?8:s.tabId,windowId:relocated?4:s.windowId,
    lastObservedUserMessageId:'u1',lastObservedAssistantMessageId:'a1'};
  const response={turnId:d.deliveryId,binding,rawText:plain?'방법 안내인가요, 기능 구현인가요?':
    JSON.stringify({type:'REQUIREMENTS_PROPOSAL',summary:'범위 확인',questions:['방법 안내인가요?'],items:[]}),
    confidence:'CONFIRMED_BY_UI_STATE',evidence:{userMessageId:'u1',assistantMessageId:'a1',
      conversationUrl:binding.conversationUrl,conversationId:binding.conversationId,documentId:binding.documentId,
      frameId:binding.frameId,responseAssociation:'DIRECT_DOM_ORDER'},
    trace:{requestId:d.deliveryId,actionId:d.deliveryId,bindingId:`${s.sessionId}:${c.preparationId}`,
      tabId:binding.tabId,documentId:binding.documentId,frameId:0,result:'success'}};
  const options=[];
  f.web.inspect=async()=>({binding});
  f.web.inspectDelivery=async o=>{if(o)options.push(o);return {currentDeliveryId:acknowledged?null:d.deliveryId,
    sessionId:s.sessionId,runId:c.preparationId,conversationUrl:binding.conversationUrl,conversationId:binding.conversationId,
    observedConversationUrl:binding.conversationUrl,tabId:binding.tabId,documentId:binding.documentId,
    observedDocumentId:binding.documentId,frameId:binding.frameId,pageReachable:true,generating:false,pageBusy:false,extensionBusy:false,
    lastObservedUserMessageId:'u1',lastObservedAssistantMessageId:'a1',completedDelivery:response};};
  f.web.acknowledgeDelivery=async()=>{acknowledged=true;};
  return {...f,get service(){return f.service;},identity:{sessionId:s.sessionId,conversationId:null,conversationUrl:'https://chatgpt.com/',deliveryId:d.deliveryId},
    options,response,submissions:()=>submissions,acknowledged:()=>acknowledged};
}

test('UI contract failure can recover the original root response using explicit evidence without resending',async t=>{
  const f=await failedRootFixture(t,{uiChanged:true});
  const before=structuredClone(f.service.current);
  f.restart();
  assert.equal(f.submissions(),1);
  assert.equal(f.service.current.version,before.version+1);
  assert.equal(f.service.current.webSession.activeDeliveryId,before.webSession.activeDeliveryId);
  assert.equal(f.service.current.webSession.documentId,before.webSession.documentId);
  assert.equal(f.service.current.error.code,'UI_CONTRACT_CHANGED');
  await f.command('web.reconcile',{...f.identity,recoveryTarget:{
    conversationUrl:'https://chatgpt.com/c/recovered',conversationId:'recovered',
    userMessageId:'u1',assistantMessageId:'a1',
  }});
  assert.equal(f.options[0].recoverSubmitted.allowTabRelocation,false);
  assert.equal(f.submissions(),1);
  assert.equal(f.service.current.deliveries[0].response.rawText,f.response.rawText);
  assert.equal(f.acknowledged(),true);
});

test('UI contract recovery preserves ownership and sends no ACK when the response write fails',async t=>{
  const f=await failedRootFixture(t,{uiChanged:true});
  const before=structuredClone(f.service.current), injected=failRecoveryWrite(f.service);
  try {
    await assert.rejects(f.command('web.reconcile',{...f.identity,recoveryTarget:{
      conversationUrl:'https://chatgpt.com/c/recovered',conversationId:'recovered',
      userMessageId:'u1',assistantMessageId:'a1',
    }}),/injected recovery write failure/);
    assert.deepEqual(f.service.current,before);
    const disk=JSON.parse(injected.real.prepare('SELECT json FROM preparation_state WHERE id=1').get().json);
    assert.deepEqual(disk.contexts[before.preparationId],before);
    assert.equal(f.submissions(),1);
    assert.equal(f.acknowledged(),false);
  } finally { injected.restore(); }
});

test('UI contract recovery persists verified document transfer before acknowledgement', async t => {
  const f = await failedRootFixture(t,{uiChanged:true,plain:true});
  const original = f.service.current.webSession;
  const from = {tabId:original.tabId,windowId:original.windowId,documentId:original.documentId,frameId:0};
  const replacement = {tabId:8,windowId:4,documentId:'replacement-document',frameId:0};
  Object.assign(f.response.binding,replacement);
  Object.assign(f.response.trace,{tabId:replacement.tabId,documentId:replacement.documentId});
  f.response.evidence.documentId = replacement.documentId;
  f.response.evidence.recoveryRebinding = {from,to:replacement};
  const input = {...f.identity,recoveryTarget:{conversationUrl:'https://chatgpt.com/c/recovered',
    conversationId:'recovered',userMessageId:'u1',assistantMessageId:'a1',replacement}};
  f.response.evidence.recoveryRebinding.from = {...from,documentId:'wrong-document'};
  await assert.rejects(f.command('web.reconcile',input),{code:'DELIVERY_RECOVERY_MISMATCH'});
  assert.equal(f.service.current.deliveries[0].response,null);
  f.response.evidence.recoveryRebinding.from = from;
  await assert.rejects(f.command('web.reconcile',input),{code:'INVALID_AGREEMENT'});
  const disk = JSON.parse(f.service.db.prepare('SELECT json FROM preparation_state WHERE id=1').get().json);
  const persisted = disk.contexts[disk.currentId];
  assert.equal(persisted.webSession.documentId,replacement.documentId);
  assert.deepEqual(persisted.deliveries[0].response.evidence.recoveryRebinding,{from,to:replacement});
  assert.equal(f.submissions(),1);
  assert.equal(f.acknowledged(),false);
});

test('explicit recovery imports the original root response and uses normal validation and ACK without resending',async t=>{
  const f=await failedRootFixture(t);
  assert.ok(f.service.capabilities().includes('web.reconcile'));
  await f.command('web.reconcile',f.identity);
  assert.equal(f.submissions(),1);assert.equal(f.acknowledged(),true);
  assert.equal(f.service.current.state,'DISCUSSING');
  assert.equal(f.service.current.deliveries[0].state,'ACKNOWLEDGED');
  assert.equal(f.service.current.webSession.conversationId,'recovered');
  assert.equal(f.options[0].recoverSubmitted.currentDeliveryId,f.identity.deliveryId);
  assert.equal(f.runs.size,0);
});

test('recovered plain response is preserved but cannot bypass the existing proposal format contract',async t=>{
  const f=await failedRootFixture(t,{plain:true});
  await assert.rejects(f.command('web.reconcile',f.identity),{code:'INVALID_AGREEMENT'});
  assert.equal(f.submissions(),1);assert.equal(f.acknowledged(),false);
  assert.equal(f.service.current.deliveries[0].response.rawText,'방법 안내인가요, 기능 구현인가요?');
  assert.equal(f.service.current.deliveries[0].validation.status,'CONFIRMED');
  assert.equal(f.service.current.deliveries[0].validation.format,'INVALID');
  f.restart();assert.equal(f.service.current.deliveries[0].response.rawText,'방법 안내인가요, 기능 구현인가요?');
});

test('recovery rejects another run before changing the durable root binding',async t=>{
  const f=await failedRootFixture(t,{wrongRun:true});
  await assert.rejects(f.command('web.reconcile',f.identity),{code:'DELIVERY_RECOVERY_MISMATCH'});
  assert.equal(f.service.current.webSession.conversationId,null);
  assert.equal(f.service.current.deliveries[0].response,null);
  assert.equal(f.submissions(),1);assert.equal(f.acknowledged(),false);
});
test("existing preparation mutations require the current version before side effects", async (t) => {
  const f = fixture(t); await f.start(); await settled(f.service);
  const before = f.service.snapshot();
  for (const type of ["preparation.reply", "preparation.approve", "preparation.cancel", "preparation.discard",
    "web.inspect", "web.focus", "web.stop", "web.rebind", "web.reconcile"]) {
    const input = {preparationId:before.preparationId,content:"stale input"};
    await assert.rejects(f.service.execute(type,{...input,requestId:`missing-${type}`}), {code:"PREPARATION_VERSION_REQUIRED"});
    await assert.rejects(f.service.execute(type,{...input,requestId:`stale-${type}`,expectedVersion:before.version - 1}),
      {code:"PREPARATION_VERSION_CONFLICT"});
  }
  assert.deepEqual(f.service.snapshot(),before);
  await assert.rejects(f.service.execute("preparation.start", { requestId: "start", objective: "different" }), /different command/);
});

for (const [label, observation] of Object.entries({
  run: { runId: "other" }, conversation: { conversationId: "other" },
  navigated: { observedConversationUrl: "https://chatgpt.com/c/other" },
  generating: { generating: true }, worker: { extensionBusy: true },
  response: { lastObservedAssistantMessageId: "other" },
})) {
  test(`ACK cannot settle delivery after ${label} evidence changes`, async (t) => {
    const f = fixture(t); f.afterAck(observation); await f.start(); await settled(f.service);
    assert.equal(f.service.current.state, "RECOVERY_REQUIRED");
    assert.equal(f.service.current.deliveries[0].state, "RESPONSE_COMPLETED");
    assert.ok(f.service.current.webSession.activeDeliveryId);
    assert.equal(f.service.current.discussion.length, 1);
  });
}

test("inspection never offers stop without an active delivery", async (t) => {
  const f = fixture(t); await f.start(); await settled(f.service);
  const session = f.service.current.webSession;
  f.observe({ generating: true, activeRequestId: null });
  await f.command("web.inspect", { sessionId: session.sessionId, conversationId: session.conversationId,
    conversationUrl: session.conversationUrl, deliveryId: null });
  assert.equal(f.service.current.diagnostics.canStop, false);
  assert.equal(f.service.capabilities().includes("web.stop"), false);
});

test("late stop does not change a delivery completed during its save", async t => {
  const f = fixture(t);
  const {promise:submitted, resolve:markSubmitted} = Promise.withResolvers();
  const {promise:responseGate, resolve:releaseResponse} = Promise.withResolvers();
  const submit = f.web.submitTurn.bind(f.web);
  const inspect = f.web.inspectDelivery.bind(f.web);
  let generating = true, stopConfirmed = false, completion;
  t.mock.method(f.web, "submitTurn", async input => {
    const result = await submit(input);
    markSubmitted();
    return {completion:responseGate.then(() => result.completion)};
  });
  t.mock.method(f.web, "inspectDelivery", async () => {
    const observed = await inspect();
    return {...observed, generating, pageBusy:generating, activeRequestId:generating ? observed.currentDeliveryId : null};
  });
  f.web.stopDelivery = async () => {
    generating = false;
    stopConfirmed = true;
    return f.web.inspectDelivery();
  };
  const touch = f.service.touch.bind(f.service);
  t.mock.method(f.service, "touch", async context => {
    if (!stopConfirmed) return touch(context);
    stopConfirmed = false;
    await touch(context);
    const completionJob = f.service.jobs.get(context.preparationId);
    assert.ok(completionJob);
    releaseResponse();
    await completionJob;
    assert.equal(context.webSession.activeDeliveryId, null);
    completion = structuredClone(context);
  });
  await f.start();
  await submitted;
  await tick();
  assert.equal(f.service.current.deliveries[0].state, "SUBMITTED");
  const {sessionId, conversationId, conversationUrl, activeDeliveryId:deliveryId} = f.service.current.webSession;
  const target = {sessionId, conversationId, conversationUrl, deliveryId};
  await f.command("web.inspect", target);
  await f.command("web.stop", target);
  assert.ok(completion);
  assert.equal(completion.deliveries[0].processingState, "COMPLETE");
  assert.deepEqual(f.service.current, completion);
  f.restart();
  assert.deepEqual(f.service.current, completion);
});

for (const mismatch of [{ conversationId: "other" }, { deliveryId: "other" }]) {
  test(`stop rejects mismatched ${Object.keys(mismatch)[0]} without dispatch`, async (t) => {
    const f = fixture(t); f.ackFailure(true); await f.start(); await settled(f.service);
    const session = f.service.current.webSession;
    f.observe({ generating: true, activeRequestId: session.activeDeliveryId });
    const identity = { sessionId: session.sessionId, conversationId: session.conversationId,
      conversationUrl: session.conversationUrl, deliveryId: session.activeDeliveryId };
    await f.command("web.inspect", identity);
    assert.equal(f.service.capabilities().includes("web.stop"), true);
    await assert.rejects(f.command("web.stop", { ...identity, ...mismatch }), { code: "DELIVERY_RECOVERY_MISMATCH" });
    assert.equal(f.service.current.webSession.activeDeliveryId, session.activeDeliveryId);
    assert.equal(f.calls.length, 1);
  });
}

function failRecoveryWrite(service,{rollbackFails=false}={}) {
  const real=service.db; let failed=false;
  service.db=new Proxy(real,{
    get(target,key) {
      if(key==='prepare') return sql=>{
        const statement=target.prepare(sql);
        if(!sql.startsWith('INSERT INTO preparation_state')) return statement;
        return {run:json=>{
          const data=JSON.parse(json),context=data.contexts[data.currentId];
          if(!failed && context?.deliveries.some(item=>item.response)) {
            failed=true; throw new Error('injected recovery write failure');
          }
          return statement.run(json);
        }};
      };
      if(key==='exec') return sql=>{
        const result=target.exec(sql);
        if(rollbackFails && failed && sql==='ROLLBACK') throw new Error('injected rollback failure');
        return result;
      };
      const value=Reflect.get(target,key,target);
      return typeof value==='function'?value.bind(target):value;
    },
  });
  return {real,restore(){service.db=real;}};
}

test("structured completion retains the delivery when its final commit fails", async t => {
  const f = fixture(t);
  const db = f.service.db;
  const readContext = () => {
    const data = JSON.parse(db.prepare("SELECT json FROM preparation_state WHERE id=1").get().json);
    return data.contexts[data.currentId];
  };
  const exec = db.exec.bind(db);
  let pending, atFailure, afterRollback, failed = false;
  f.web.confirmDeliveryAcknowledgement = async ({turnId}) => {
    if (pending) return;
    assert.equal((await f.web.inspectDelivery()).currentDeliveryId, null);
    pending = readContext();
    assert.equal(pending.webSession.activeDeliveryId, turnId);
    assert.equal(pending.deliveries[0].processingState, "ACK_PENDING");
  };
  t.mock.method(db, "exec", sql => {
    if (pending && !failed && sql === "COMMIT") {
      failed = true;
      atFailure = structuredClone(f.service.current);
      throw Object.assign(new Error("injected final completion commit failure"), {code:"TEST_COMMIT_FAILED"});
    }
    const result = exec(sql);
    if (failed && sql === "ROLLBACK") afterRollback = readContext();
    return result;
  });

  await f.start();
  await settled(f.service);
  assert.equal(failed, true);
  assert.deepEqual(afterRollback, pending);
  const {sessionId, conversationId, conversationUrl, activeDeliveryId:deliveryId} = pending.webSession;
  assert.deepEqual(atFailure.webSession, pending.webSession);
  assert.equal(atFailure.version, pending.version);
  assert.equal(atFailure.state, pending.state);
  assert.deepEqual(atFailure.discussion, pending.discussion);
  assert.deepEqual(atFailure.agreement, pending.agreement);
  assert.equal(atFailure.deliveries[0].state, pending.deliveries[0].state);
  assert.equal(atFailure.deliveries[0].processingState, "ACK_PENDING");
  assert.deepEqual(f.service.data.projectConversations, {});
  const blocked = f.service.current;
  assert.deepEqual(blocked, readContext());
  assert.equal(blocked.state, "RECOVERY_REQUIRED");
  assert.equal(blocked.error.details.completion.stage, "COMPLETION_PERSISTENCE");
  assert.equal(blocked.webSession.activeDeliveryId, deliveryId);
  assert.equal(blocked.deliveries[0].state, "RESPONSE_COMPLETED");
  assert.equal(blocked.deliveries[0].processingState, "ACK_PENDING");
  assert.equal(blocked.deliveries[0].response.rawText, pending.deliveries[0].response.rawText);
  assert.deepEqual(blocked.discussion, pending.discussion);

  f.restart();
  assert.equal(f.service.current.webSession.activeDeliveryId, deliveryId);
  assert.ok(f.service.capabilities().includes("web.reconcile"));
  await assert.rejects(f.command("preparation.reply", {content:"Do not send"}), /Reply is unavailable/);
  await f.command("web.reconcile", {sessionId, conversationId, conversationUrl, deliveryId});
  f.restart();
  const completed = f.service.current;
  assert.equal(completed.webSession.activeDeliveryId, null);
  assert.equal(completed.deliveries[0].state, "ACKNOWLEDGED");
  assert.equal(completed.deliveries[0].processingState, "COMPLETE");
  assert.equal(completed.deliveries[0].response.rawText, pending.deliveries[0].response.rawText);
  assert.equal(completed.discussion.filter(turn => turn.deliveryId === deliveryId).length, 1);
  assert.equal(f.service.data.projectConversations[completed.targetRoot].conversationId, conversationId);
  assert.equal(f.prompts.length, 1);
});

test('failed recovery write preserves memory and receipt context, then rereads the same delivery',async t=>{
  const f=await failedRootFixture(t,{plain:true,relocated:true});
  const before=structuredClone(f.service.current),injected=failRecoveryWrite(f.service);
  await assert.rejects(f.command('web.reconcile',{...f.identity,requestId:'write-failed'}),/injected recovery write failure/);
  assert.deepEqual(f.service.current,before);
  const disk=JSON.parse(injected.real.prepare('SELECT json FROM preparation_state WHERE id=1').get().json);
  assert.deepEqual(disk.contexts[before.preparationId],before);
  assert.equal(disk.receipts['write-failed'].status,'FAILED');
  injected.restore();
  await assert.rejects(f.command('web.reconcile',{...f.identity,requestId:'read-again'}),{code:'INVALID_AGREEMENT'});
  assert.equal(f.submissions(),1); assert.equal(f.acknowledged(),false);
  assert.equal(f.service.current.webSession.tabId,8);
  assert.equal(f.service.current.deliveries[0].deliveryId,f.identity.deliveryId);
  const response=structuredClone(f.service.current.deliveries[0].response);
  assert.ok(response.rawText);
  f.restart();
  assert.equal(f.service.current.webSession.tabId,8);
  assert.deepEqual(f.service.current.deliveries[0].response,response);
});

test('lost extension response is reread with a new request ID without resubmission',async t=>{
  const f=await failedRootFixture(t,{plain:true,relocated:true});
  const inspect=f.web.inspectDelivery,before=structuredClone(f.service.current);
  let captured;
  f.web.inspectDelivery=async options=>{
    captured=await inspect(options);
    throw Object.assign(new Error('lost response'),{code:'WEB_RESPONSE_TIMEOUT'});
  };
  await assert.rejects(f.command('web.reconcile',{...f.identity,requestId:'lost'}),{code:'WEB_RESPONSE_TIMEOUT'});
  assert.deepEqual(f.service.current,before);
  f.web.inspectDelivery=async()=>structuredClone(captured);
  await assert.rejects(f.command('web.reconcile',{...f.identity,requestId:'reread'}),{code:'INVALID_AGREEMENT'});
  assert.equal(f.submissions(),1);
  assert.equal(f.service.current.deliveries[0].response.turnId,f.identity.deliveryId);
  assert.equal(f.service.current.webSession.tabId,8);
});

test('unknown recovery transaction outcome blocks writes without a false failed receipt',async t=>{
  const f=await failedRootFixture(t,{plain:true,relocated:true});
  const before=structuredClone(f.service.current),injected=failRecoveryWrite(f.service,{rollbackFails:true});
  await assert.rejects(f.command('web.reconcile',{...f.identity,requestId:'uncertain'}),{code:'RECOVERY_PERSISTENCE_UNCERTAIN'});
  assert.deepEqual(f.service.current,before); assert.equal(f.service.closed,true);
  const disk=JSON.parse(injected.real.prepare('SELECT json FROM preparation_state WHERE id=1').get().json);
  assert.equal(disk.receipts.uncertain.status,'PROCESSING');
  assert.deepEqual(disk.contexts[before.preparationId],before);
  await assert.rejects(f.command('web.reconcile',{...f.identity,requestId:'blocked'}),/Server is closing/);
  injected.restore();
});

test('context changes during inspection are not overwritten by recovery',async t=>{
  const f=await failedRootFixture(t,{plain:true,relocated:true}),inspect=f.web.inspectDelivery;
  f.web.inspectDelivery=async options=>{
    const result=await inspect(options);
    f.service.current.version++; f.service.current.objective='changed while inspecting';
    return result;
  };
  await assert.rejects(f.command('web.reconcile',f.identity),{code:'DELIVERY_RECOVERY_MISMATCH'});
  assert.equal(f.service.current.objective,'changed while inspecting');
  assert.equal(f.service.current.webSession.conversationId,null);
  assert.equal(f.service.current.deliveries[0].response,null);
});

test('committed recovery survives a final receipt write failure without replaying the request',async t=>{
  const f=await failedRootFixture(t,{relocated:true});
  const saveReceipt=f.service.saveReceipt.bind(f.service);
  f.service.saveReceipt=async(requestId,receipt)=>{
    if(requestId==='receipt-write-failed' && receipt.status==='COMPLETED') {
      throw new Error('injected final receipt failure');
    }
    return saveReceipt(requestId,receipt);
  };
  const input = {...f.identity,requestId:'receipt-write-failed',expectedVersion:f.service.current.version};
  await assert.rejects(f.command('web.reconcile',input),/injected final receipt failure/);
  assert.equal(f.acknowledged(),true);assert.equal(f.submissions(),1);
  const response=structuredClone(f.service.current.deliveries[0].response);
  assert.ok(response.rawText);
  assert.equal(f.service.current.webSession.tabId,8);
  f.restart();
  assert.equal(f.service.current.webSession.tabId,8);
  assert.deepEqual(f.service.current.deliveries[0].response,response);
  assert.equal(f.service.data.receipts['receipt-write-failed'].status,'PROCESSING');
  await assert.rejects(f.command('web.reconcile',input),{code:'UNKNOWN_RESULT'});
  assert.equal(f.submissions(),1);
});
