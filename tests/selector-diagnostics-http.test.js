import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { createBridgeServer } from '../src/server.js';
import { computeWebChallengeHmac } from '../src/runtime/web/auth.js';

function deferred() {
  let complete;
  const promise = new Promise(resolve => { complete = resolve; });
  return {promise, resolve:value => complete(value)};
}

for (const order of ['after automatic collection', 'during automatic collection']) {
test(`HTTP diagnostics ${order} requires authentication and returns only the correlated snapshot`, {timeout:10000}, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-selector-http-'));
  const secret='fixture-extension-secret-0123456789', token='fixture-dashboard-token-0123456789';
  const config={...loadConfig({env:{CONTROLLER_DATA_DIR:root,DASHBOARD_TOKEN:token,
    WEB_EXTENSION_SHARED_SECRET:secret,WEB_EXTENSION_EXPECTED_IDENTITY:'fixture-extension'}}),port:0};
  const requests = [], firstInspection = deferred(), automaticCompleted = deferred(), httpEntered = deferred();
  let socket, observeHttp = false;
  const bridge=createBridgeServer({runtimeConfig:config,onDiagnostic:event => {
    if (event.type === 'agent.report.collection.completed' && requests.length) automaticCompleted.resolve();
  }});
  bridge.server.on('request', req => {
    if (observeHttp && req.url === '/api/selector-diagnostics') httpEntered.resolve();
  });
  t.after(async()=>{socket?.terminate();await bridge.close();fs.rmSync(root,{recursive:true,force:true});});
  await bridge.listen();
  const base=`http://127.0.0.1:${bridge.server.address().port}`;
  const unauthorized=await fetch(base+'/api/selector-diagnostics');assert.equal(unauthorized.status,401);await unauthorized.text();
  const absent=await fetch(base+'/api/selector-diagnostics',{headers:{Authorization:'Bearer '+token}});
  assert.equal(absent.status,503);assert.equal((await absent.json()).code,'EXTENSION_NOT_AUTHENTICATED');
  socket=new WebSocket(base.replace('http:','ws:')+'/ws/extension');
  const respond = request => {
    const reply = (requestId, tabId) => socket.send(JSON.stringify({protocolVersion:2,type:'extension.diagnostics.inspected',requestId,
      payload:{tabs:[{tabId,composerPresent:false,busy:false,generating:false,pageStatus:'UI_CONTRACT_CHANGED',
        details:{sharedSecret:secret,responseBody:'PRIVATE_RESPONSE'},diagnostics:{editableCandidates:[{visible:1,samples:[{
          role:'textbox',controls:[{controlLabel:'음성 입력',sharedSecret:secret}]}]}]}}]}}));
    // A valid but unrelated response must not settle either automatic or HTTP collection.
    reply(randomUUID(), 999);
    reply(request.requestId, request.tabId);
  };
  const authenticated=new Promise(resolve=>socket.on('message',raw=>{
    const m=JSON.parse(String(raw));
    if(m.type==='controller.auth.challenge')socket.send(JSON.stringify({protocolVersion:2,type:'extension.auth.response',
      challengeId:m.challengeId,extensionIdentity:'fixture-extension',hmacSha256:computeWebChallengeHmac(m.nonce,secret)}));
    if(m.type==='controller.auth.accepted')resolve();
    if(m.type==='controller.diagnostics.inspect'){
      const request = {requestId:m.requestId,tabId:7+requests.length};
      requests.push(request);
      if (requests.length === 1) firstInspection.resolve(request);
      if (order === 'after automatic collection' || requests.length > 1) respond(request);
    }
  }));
  await authenticated;
  const automaticRequest = await firstInspection.promise;
  if (order === 'after automatic collection') await automaticCompleted.promise;
  assert.equal(requests.length,1,'automatic diagnostics must stay enabled and perform its own collection');
  const beforeHttp = requests.length;
  observeHttp = true;
  const responsePending=fetch(base+'/api/selector-diagnostics',{headers:{Authorization:'Bearer '+token}});
  if (order === 'during automatic collection') {
    // The route joins the pending read before its matching extension reply is released.
    await httpEntered.promise;
    respond(automaticRequest);
  }
  const response=await responsePending;
  assert.equal(response.status,200);const snapshot=await response.json();
  const additionalReads = order === 'after automatic collection' ? 1 : 0;
  assert.equal(requests.length-beforeHttp,additionalReads,'HTTP must start exactly one read or join the existing read');
  assert.equal(new Set(requests.map(request=>request.requestId)).size,requests.length);
  assert.equal(snapshot.tabs[0].tabId,order === 'after automatic collection' ? 8 : 7);
  assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_RESPONSE|fixture-extension-secret/u);
});
}
