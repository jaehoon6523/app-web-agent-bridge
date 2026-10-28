import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createBridgeServer } from '../src/server.js';
import { PreparationService } from '../src/orchestration/preparation-service.js';
import { computeWebChallengeHmac } from '../src/runtime/web/auth.js';
import { replyToTabFocus, replyToSelectorDiagnostics } from '../extension/runtime/tab-diagnostics.js';
test('real HTTP and WebSocket round trip uses extension handler, survives partial failure, and preserves delivery',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'focus-http-'));
  const secret='test-focus-http-secret-0123456789',token='test-focus-http-token-0123456789';
  const input={preparationId:'prep',deliveryId:'delivery',tabId:7};
  const context={preparationId:'prep',lifecycle:'ACTIVE',state:'WEB_BLOCKED',version:1,
    webSession:{activeDeliveryId:'delivery'},deliveries:[{deliveryId:'delivery',state:'FAILED',unsent:true}],
    error:{code:'WEB_TAB_SELECTION_REQUIRED',details:{candidates:[{tabId:7,url:'https://chatgpt.com/'}]}}};
  const seed=new PreparationService({filename:path.join(dir,'preparations.sqlite'),web:null,available:()=>true,assertStart:async()=>{},approve:async()=>{},findRun:async()=>null});
  seed.data.currentId='prep';seed.data.contexts.prep=context;seed.saveSync();await seed.close();
  const config={demoMode:false,host:'127.0.0.1',port:0,baseUrl:'http://127.0.0.1:0',persistence:{databasePath:path.join(dir,'controller.sqlite')},
    codex:{executablePath:process.execPath},dashboard:{token},webExtension:{enabled:true,sharedSecret:secret,expectedExtensionIdentity:'focus-http'},relay:{webResponseTimeoutMs:1000}};
  const bridge=createBridgeServer({runtimeConfig:config});let socket;
  t.after(async()=>{socket?.terminate();await bridge.close();fs.rmSync(dir,{recursive:true,force:true});});
  const address=await bridge.listen(),base='http://127.0.0.1:'+address.port;
  let failWindow=true,active=false,focusCalls=0;
  const chrome={tabs:{get:async()=>({id:7,url:'https://chatgpt.com/',windowId:9,active}),update:async()=>{active=true;focusCalls++;},
    query:async()=>[{id:7,url:'https://chatgpt.com/'}],sendMessage:async()=>({ok:true,pageUrl:'https://chatgpt.com/'})},
    windows:{update:async()=>{if(failWindow)throw Error('Synthetic window failure');return {focused:true};}}};
  await new Promise((resolve,reject)=>{
    socket=new WebSocket('ws://127.0.0.1:'+address.port+'/ws/extension');socket.once('error',reject);
    socket.on('message',raw=>{
      const message=JSON.parse(String(raw)),send=m=>socket.send(JSON.stringify({protocolVersion:2,...m}));
      if(message.type==='controller.auth.challenge')send({type:'extension.auth.response',challengeId:message.challengeId,extensionIdentity:'focus-http',hmacSha256:computeWebChallengeHmac(message.nonce,secret)});
      if(message.type==='controller.auth.accepted')resolve();
      if(message.type==='web.tab.focus')void replyToTabFocus(chrome,send,message);
      if(message.type==='controller.diagnostics.inspect')void replyToSelectorDiagnostics(chrome.tabs,send,message.requestId,'test');
    });
  });
  const post=()=>fetch(base+'/api/preparations/tab-focus',{method:'POST',headers:{authorization:'Bearer '+token,origin:config.baseUrl,'content-type':'application/json'},body:JSON.stringify(input)});
  const inspected=await fetch(base+'/api/selector-diagnostics',{headers:{authorization:'Bearer '+token}});
  assert.equal(inspected.status,200);assert.equal((await inspected.json()).tabs[0].tabId,7);
  assert.equal(focusCalls,0,'inspection must not activate a tab');
  const failed=await post();assert.equal(failed.status,409);assert.equal((await failed.json()).code,'TAB_FOCUS_UNCONFIRMED');assert.equal(active,true);
  failWindow=false;const recovered=await post();assert.equal(recovered.status,200);assert.deepEqual(await recovered.json(),{opened:true,tabId:7});assert.equal(focusCalls,2);
  // Change only the in-memory preparation version while the real WebSocket request is pending.
  const focus=PreparationService.prototype.focusCandidateTab;
  t.mock.method(PreparationService.prototype,'focusCandidateTab',function(value){
    const pending=focus.call(this,value);this.current.version++;return pending;
  });
  const stale=await post(),result=await stale.json();
  assert.equal(stale.status,409);assert.equal(result.code,'TAB_FOCUS_STALE');
  assert.equal(result.executionOutcome,'SUCCEEDED');assert.equal(result.applicable,false);assert.equal(focusCalls,3);
  // The viewing operation must never change persisted delivery ownership.
  await bridge.close();
  const read=new PreparationService({filename:path.join(dir,'preparations.sqlite'),web:null,available:()=>true,assertStart:async()=>{},approve:async()=>{},findRun:async()=>null});
  try{assert.deepEqual(read.current,context);}finally{await read.close();}
});
