import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { createBridgeServer } from '../src/server.js';
import { computeWebChallengeHmac } from '../src/runtime/web/auth.js';
import { readAgentReport } from '../src/diagnostics/report-store.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
test('HTTP and authenticated extension export share a current report without starting the execution runtime', {timeout:15000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-diagnostics-http-'));
  const secret='fixture-extension-secret-0123456789', token='fixture-dashboard-token-0123456789';
  const config={...loadConfig({env:{CONTROLLER_DATA_DIR:root,DASHBOARD_TOKEN:token,WEB_EXTENSION_SHARED_SECRET:secret,
    WEB_EXTENSION_EXPECTED_IDENTITY:'fixture-extension'}}),port:0};
  let starts=0;
  const bridge=createBridgeServer({runtimeConfig:config,createLiveRuntime:()=>{starts++;throw new Error('Execution runtime must remain lazy.');}});
  await bridge.listen();t.after(async()=>{await bridge.close();fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${bridge.server.address().port}`;
  const unauthorized=await fetch(base+'/api/agent-diagnostics');assert.equal(unauthorized.status,401);await unauthorized.text();
  const socket=new WebSocket(base.replace('http:','ws:')+'/ws/extension');t.after(()=>socket.terminate());
  await new Promise(resolve=>socket.on('message',raw=>{
    const message=JSON.parse(String(raw));
    if(message.type==='controller.auth.challenge')socket.send(JSON.stringify({protocolVersion:2,type:'extension.auth.response',
      challengeId:message.challengeId,extensionIdentity:'fixture-extension',hmacSha256:computeWebChallengeHmac(message.nonce,secret)}));
    if(message.type==='controller.auth.accepted')resolve();
    if(message.type==='controller.diagnostics.inspect')socket.send(JSON.stringify({protocolVersion:2,type:'extension.diagnostics.inspected',requestId:message.requestId,
      payload:{tabs:[{tabId:7,pageStatus:'READY',composerPresent:true,selectorVersion:'2026-10-10.4',responseBody:'PRIVATE_RESPONSE'}],
        delivery:{currentDeliveryId:null}}}));
  }));
  const response=await fetch(base+'/api/agent-diagnostics',{headers:{Authorization:'Bearer '+token}});
  assert.equal(response.status,200);const value=await response.json();
  assert.equal(value.server.tabs[0].decision,'REPAIR_NOT_NEEDED');assert.equal(value.server.tabs[0].selectorVersion,'2026-10-10.4');
  const requestId='618fcd37-ec59-4d1b-9151-eb437b6468e2';
  const exported=new Promise(resolve=>socket.on('message',raw=>{const m=JSON.parse(String(raw));if(m.type==='controller.agent-report.result'&&m.requestId===requestId)resolve(m.payload);}));
  socket.send(JSON.stringify({protocolVersion:2,type:'extension.agent-report.get',requestId}));
  const fromExtension=await exported;assert.equal(fromExtension.server.source,'CONTROLLER');assert.equal(starts,0);
  assert.equal(fs.existsSync(path.join(root,'controller.sqlite')),false);
  assert.doesNotMatch(JSON.stringify(fromExtension),/PRIVATE_RESPONSE|fixture-extension-secret/u);
});
test('server configuration failures leave a safe startup record before runtime initialization',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-diagnostics-startup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const server=new URL('../src/server.js',import.meta.url).pathname;
  await assert.rejects(promisify(execFile)(process.execPath,[server],{cwd:root,env:{...process.env,HOST:'PRIVATE_INVALID_HOST'}}));
  const value=readAgentReport(path.join(root,'.agent-controller','diagnostics'));
  assert.equal(value.startup.stage,'CONFIG');assert.equal(value.startup.status,'UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE_INVALID_HOST/u);
});
