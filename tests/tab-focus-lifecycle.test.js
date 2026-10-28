import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebExtensionTransport, ChatGptWebSessionAdapter, computeWebChallengeHmac } from '../src/runtime/web/index.js';
import { PreparationService } from '../src/orchestration/preparation-service.js';
import { replyToTabFocus } from '../extension/runtime/tab-diagnostics.js';
const secret='test-focus-lifecycle-secret-0123456789';
const target={tabId:7,url:'https://chatgpt.com/'};
class Socket extends EventEmitter {
  readyState=1; sent=[];
  send(raw) {this.sent.push(JSON.parse(raw));}
  close() {this.readyState=3;} // Real WebSocket close arrives asynchronously.
  receive(message) {this.emit('message',JSON.stringify({protocolVersion:2,...message}));}
}
function fixture(t) {
  let now=0;
  const transport=new WebExtensionTransport({sharedSecret:secret,expectedExtensionIdentity:'focus'},{now:()=>now,staleAfterMs:65000});
  function connect() {
    const socket=new Socket(); transport.attach(socket); const challenge=socket.sent[0];
    socket.receive({type:'extension.auth.response',challengeId:challenge.challengeId,extensionIdentity:'focus',hmacSha256:computeWebChallengeHmac(challenge.nonce,secret)});
    return socket;
  }
  const socket=connect(),adapter=new ChatGptWebSessionAdapter({transport,responseTimeoutMs:500});
  t.after(async()=>{await adapter.close();transport.close();});
  return {transport,socket,adapter,connect,stale:()=>{now=66000;}};
}
function reply(socket,request,payload={opened:true,tabId:7}) {socket.receive({type:'web.tab.focused',requestId:request.requestId,payload});}
test('focus rejects a response for another tab and next valid request succeeds',async t=>{
  const {socket,adapter}=fixture(t);
  const first=adapter.focusCandidateTab(target); reply(socket,socket.sent.at(-1),{opened:true,tabId:8});
  await assert.rejects(first,{code:'TAB_FOCUS_UNCONFIRMED'});
  const next=adapter.focusCandidateTab(target);reply(socket,socket.sent.at(-1));assert.equal((await next).opened,true);
});
test('replacement immediately ends old pending and old response cannot complete the next request',async t=>{
  const {socket,adapter,stale,connect}=fixture(t);
  let settled=false;
  const first=adapter.focusCandidateTab(target).catch(error=>{settled=true;return error;});
  const old=socket.sent.at(-1);stale(); const replacement=connect();await new Promise(setImmediate);
  assert.equal(settled,true,'replacement must settle before its delayed close event');
  assert.equal((await first).code,'EXTENSION_DISCONNECTED');
  const next=adapter.focusCandidateTab(target); const current=replacement.sent.at(-1);
  let done=false;next.then(()=>{done=true;});reply(socket,old);reply(replacement,old);await Promise.resolve();assert.equal(done,false);
  reply(replacement,current);assert.equal((await next).opened,true);
});
test('timeout after real handler execution stays unknown; late reply is isolated and explicit next focus succeeds',async t=>{
  const {socket,adapter}=fixture(t);t.mock.timers.enable({apis:['setTimeout']});
  let active=false;const replies=[];
  const chrome={tabs:{get:async()=>({id:7,url:target.url,windowId:9,active}),update:async()=>{active=true;}},windows:{update:async()=>({focused:true})}};
  const first=adapter.focusCandidateTab(target);const rejected=assert.rejects(first,{code:'WEB_RESPONSE_TIMEOUT'});
  await replyToTabFocus(chrome,m=>replies.push(m),socket.sent.at(-1));assert.equal(active,true);
  t.mock.timers.tick(10001);await rejected;
  const next=adapter.focusCandidateTab(target);let done=false;next.then(()=>{done=true;});socket.receive(replies[0]);await Promise.resolve();assert.equal(done,false);
  await replyToTabFocus(chrome,m=>socket.receive(m),socket.sent.at(-1));assert.equal((await next).opened,true);
});
test('changed preparation rejects old success and allows a fresh context',async()=>{
  let finish;
  const current={preparationId:'prep',lifecycle:'ACTIVE',webSession:{activeDeliveryId:'delivery'},error:{code:'WEB_TAB_SELECTION_REQUIRED',details:{candidates:[target]}}};
  const service={current,jobs:new Map(),web:{focusCandidateTab:()=>new Promise(resolve=>{finish=resolve;})}};
  const input={preparationId:'prep',deliveryId:'delivery',tabId:7};
  const first=PreparationService.prototype.focusCandidateTab.call(service,input);
  service.current=structuredClone(current);finish({opened:true,tabId:7});
  await assert.rejects(first,error=>error.code==='TAB_FOCUS_STALE'
    && error.details.executionOutcome==='SUCCEEDED' && error.details.applicable===false);
  const next=PreparationService.prototype.focusCandidateTab.call(service,input);finish({opened:true,tabId:7});assert.equal((await next).opened,true);
});
test('preparation version is checked before dispatch and after confirmed execution',async()=>{
  let finish,calls=0;
  const current={preparationId:'prep',version:3,lifecycle:'ACTIVE',webSession:{activeDeliveryId:'delivery'},
    error:{code:'WEB_TAB_SELECTION_REQUIRED',details:{candidates:[target]}}};
  const service={current,jobs:new Map(),web:{focusCandidateTab:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}}};
  const input={preparationId:'prep',preparationVersion:2,deliveryId:'delivery',tabId:7};
  await assert.rejects(PreparationService.prototype.focusCandidateTab.call(service,input),{code:'TAB_CHANGED'});assert.equal(calls,0);
  input.preparationVersion=3;const pending=PreparationService.prototype.focusCandidateTab.call(service,input);
  current.version=4;finish({opened:true,tabId:7});
  await assert.rejects(pending,error=>error.details?.executionOutcome==='SUCCEEDED' && error.details.applicable===false);
});
test('window failure after activation is not reported as tab not executed',async()=>{
  let active=false;const replies=[];
  const chrome={tabs:{get:async()=>({id:7,url:target.url,windowId:9,active}),update:async()=>{active=true;}},windows:{update:async()=>{throw Error('synthetic');}}};
  await replyToTabFocus(chrome,m=>replies.push(m),{requestId:'r',payload:target});
  assert.equal(active,true);assert.equal(replies[0].payload.code,'TAB_FOCUS_UNCONFIRMED');
});
test('navigation during activation cannot produce a confirmed success',async()=>{
  let url=target.url;const replies=[];
  const chrome={tabs:{get:async()=>({id:7,url,windowId:9,active:true}),update:async()=>{url='https://chatgpt.com/c/changed';}},windows:{update:async()=>({focused:true})}};
  await replyToTabFocus(chrome,m=>replies.push(m),{requestId:'r',payload:target});
  assert.equal(replies[0].type,'web.session.error');assert.equal(replies[0].payload.code,'TAB_FOCUS_UNCONFIRMED');
});
test('no connection and duplicate requests are blocked; disconnect releases focus lock',async t=>{
  const {socket,adapter,connect}=fixture(t);
  const pending=adapter.focusCandidateTab(target);const request=socket.sent.at(-1);
  await assert.rejects(adapter.focusCandidateTab(target),{code:'WEB_SESSION_BUSY'});
  assert.equal(socket.sent.filter(m=>m.type==='web.tab.focus').length,1);
  const rejected=assert.rejects(pending,{code:'EXTENSION_DISCONNECTED'});
  socket.close();socket.emit('close');await rejected;
  await assert.rejects(adapter.focusCandidateTab(target),{code:'EXTENSION_NOT_AUTHENTICATED'});
  const nextSocket=connect();const next=adapter.focusCandidateTab(target);
  reply(nextSocket,request);reply(nextSocket,nextSocket.sent.at(-1));assert.equal((await next).opened,true);
});
test('connection change during tab lookup prevents activation and never sends on a replacement peer',async()=>{
  let current=true,updates=0;const replies=[];
  const chrome={tabs:{get:async()=>{current=false;return {id:7,url:target.url,windowId:9};},update:async()=>{updates++;}}};
  await replyToTabFocus(chrome,m=>{if(current)replies.push(m);return current;},{requestId:'old',payload:target},{isCurrent:()=>current});
  assert.equal(updates,0);assert.deepEqual(replies,[]);
});
