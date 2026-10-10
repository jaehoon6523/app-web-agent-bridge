import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { createBridgeServer } from '../src/server.js';
import { computeWebChallengeHmac } from '../src/runtime/web/auth.js';

test('HTTP diagnostics requires dashboard authentication and collects a correlated snapshot over an authenticated WebSocket', {timeout:10000}, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-selector-http-'));
  const secret='fixture-extension-secret-0123456789', token='fixture-dashboard-token-0123456789';
  const config={...loadConfig({env:{CONTROLLER_DATA_DIR:root,DASHBOARD_TOKEN:token,
    WEB_EXTENSION_SHARED_SECRET:secret,WEB_EXTENSION_EXPECTED_IDENTITY:'fixture-extension'}}),port:0};
  const bridge=createBridgeServer({runtimeConfig:config});await bridge.listen();
  t.after(async()=>{await bridge.close();fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${bridge.server.address().port}`;
  const unauthorized=await fetch(base+'/api/selector-diagnostics');assert.equal(unauthorized.status,401);await unauthorized.text();
  const absent=await fetch(base+'/api/selector-diagnostics',{headers:{Authorization:'Bearer '+token}});
  assert.equal(absent.status,503);assert.equal((await absent.json()).code,'EXTENSION_NOT_AUTHENTICATED');
  const socket=new WebSocket(base.replace('http:','ws:')+'/ws/extension');
  t.after(()=>socket.terminate());
  let reads=0;
  const authenticated=new Promise(resolve=>socket.on('message',raw=>{
    const m=JSON.parse(String(raw));
    if(m.type==='controller.auth.challenge')socket.send(JSON.stringify({protocolVersion:2,type:'extension.auth.response',
      challengeId:m.challengeId,extensionIdentity:'fixture-extension',hmacSha256:computeWebChallengeHmac(m.nonce,secret)}));
    if(m.type==='controller.auth.accepted')resolve();
    if(m.type==='controller.diagnostics.inspect'){
      reads++;
      socket.send(JSON.stringify({protocolVersion:2,type:'extension.diagnostics.inspected',requestId:m.requestId,
        payload:{tabs:[{tabId:7,composerPresent:false,busy:false,generating:false,pageStatus:'UI_CONTRACT_CHANGED',
          details:{sharedSecret:secret,responseBody:'PRIVATE_RESPONSE'},diagnostics:{editableCandidates:[{visible:1,samples:[{
            role:'textbox',controls:[{controlLabel:'음성 입력',sharedSecret:secret}]}]}]}}]}}));
    }
  }));
  await authenticated;
  const response=await fetch(base+'/api/selector-diagnostics',{headers:{Authorization:'Bearer '+token}});
  assert.equal(response.status,200);const snapshot=await response.json();
  assert.equal(snapshot.tabs[0].tabId,7);assert.equal(reads,1);
  assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_RESPONSE|fixture-extension-secret/u);
});
