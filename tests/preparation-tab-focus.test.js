import test from 'node:test';
import assert from 'node:assert/strict';
import { PreparationService } from '../src/orchestration/preparation-service.js';
import { replyToTabFocus } from '../extension/runtime/tab-diagnostics.js';
const context = { preparationId:'prep', webSession:{activeDeliveryId:'delivery'},
  error:{code:'WEB_TAB_SELECTION_REQUIRED',details:{candidates:[{tabId:7,url:'https://chatgpt.com/'}]}} };
test('candidate view validates current preparation and delivery and never touches ownership', async () => {
  const calls=[], current=structuredClone(context), before=JSON.stringify(current);
  const service={current,jobs:new Map(),web:{focusCandidateTab:async target=>calls.push(target)}};
  for (const input of [{preparationId:'other',deliveryId:'delivery',tabId:7},{preparationId:'prep',deliveryId:'old',tabId:7},{preparationId:'prep',deliveryId:'delivery',tabId:9}]) {
    await assert.rejects(PreparationService.prototype.focusCandidateTab.call(service,input),{code:'TAB_CHANGED'});
  }
  await PreparationService.prototype.focusCandidateTab.call(service,{preparationId:'prep',deliveryId:'delivery',tabId:7});
  assert.deepEqual(calls,[{tabId:7,url:'https://chatgpt.com/'}]); assert.equal(JSON.stringify(current),before);
  service.jobs.set('prep',{});
  await assert.rejects(PreparationService.prototype.focusCandidateTab.call(service,{preparationId:'prep',deliveryId:'delivery',tabId:7}),{code:'TAB_CHANGED'});
});
test('focus protocol opens the exact tab and window, rejects navigation, and has no storage interface', async () => {
  const calls=[], replies=[]; let url='https://chatgpt.com/';
  const chrome={tabs:{get:async()=>({id:7,windowId:9,url}),update:async(...a)=>calls.push(a)},windows:{update:async(...a)=>calls.push(a)}};
  const message={requestId:'request',payload:{tabId:7,url}};
  await replyToTabFocus(chrome,m=>replies.push(m),message);
  assert.deepEqual(calls,[[7,{active:true}],[9,{focused:true}]]);
  assert.equal(replies[0].type,'web.tab.focused');
  url='https://chatgpt.com/c/moved';
  await replyToTabFocus(chrome,m=>replies.push(m),message);
  assert.equal(replies[1].type,'web.session.error'); assert.equal(calls.length,2);
});

test('authenticated transport focus response preserves the adapter binding', async () => {
  const { EventEmitter } = await import('node:events');
  const { WebExtensionTransport, ChatGptWebSessionAdapter, computeWebChallengeHmac } = await import('../src/runtime/web/index.js');
  const secret='test-only-focus-secret-0123456789abcdef';
  class Socket extends EventEmitter {
    readyState=1; sent=[];
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState=3; this.emit('close'); }
    receive(message) { this.emit('message',JSON.stringify({protocolVersion:2,...message})); }
  }
  const transport=new WebExtensionTransport({sharedSecret:secret,expectedExtensionIdentity:'test-focus'}), socket=new Socket();
  transport.attach(socket); const challenge=socket.sent[0];
  socket.receive({type:'extension.auth.response',challengeId:challenge.challengeId,extensionIdentity:'test-focus',hmacSha256:computeWebChallengeHmac(challenge.nonce,secret)});
  const adapter=new ChatGptWebSessionAdapter({transport,responseTimeoutMs:500});
  try {
    const before=await adapter.inspect(), response=adapter.focusCandidateTab({tabId:7,url:'https://chatgpt.com/'}), request=socket.sent.at(-1);
    assert.equal(request.type,'web.tab.focus');
    socket.receive({type:'web.tab.focused',requestId:request.requestId,payload:{opened:true,tabId:7}});
    assert.deepEqual(await response,{opened:true,tabId:7}); assert.deepEqual(await adapter.inspect(),before);
    assert.equal(socket.sent.some(m=>['web.prompt','web.session.rebind','web.delivery.discard'].includes(m.type)),false);
  } finally { await adapter.close(); transport.close(); }
});
