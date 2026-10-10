import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from '../src/persistence/sqlite-database.js';
import {createBridgeServer} from '../src/server.js';

test('production HTTP reads terminal preparation from SQLite and records verified recovery in audit and diagnostics',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-http-'));
  const owner={currentDeliveryId:'delivery_618fcd37-ec59-4d1b-9151-eb437b6468e2',sessionId:'web_prep_7240bc3a-7410-4927-a7f0-2295fb844b92',
    runId:'prep_7240bc3a-7410-4927-a7f0-2295fb844b92',conversationUrl:'https://chatgpt.com/'};
  const db=new DatabaseSync(path.join(root,'preparations.sqlite'));
  db.exec('CREATE TABLE preparation_state(id INTEGER PRIMARY KEY,json TEXT NOT NULL)');
  db.prepare('INSERT INTO preparation_state VALUES(1,?)').run(JSON.stringify({currentId:null,contexts:{[owner.runId]:{
    preparationId:owner.runId,lifecycle:'ABANDONED',webSession:{sessionId:owner.sessionId,conversationUrl:owner.conversationUrl,activeDeliveryId:null},
    deliveries:[{deliveryId:owner.currentDeliveryId,state:'RECOVERY_DISCARDED'}]}},receipts:{}}));db.close();
  const token='terminal-http-fixture-token-only-0123456789';
  const config={host:'127.0.0.1',port:0,baseUrl:'http://127.0.0.1:0',workspace:root,demoMode:false,
    persistence:{databasePath:path.join(root,'controller.sqlite')},dashboard:{token},
    webExtension:{enabled:true,expectedExtensionIdentity:'fixture-extension',sharedSecret:'terminal-http-fixture-secret-only-0123456789'},relay:{webResponseTimeoutMs:1000}};
  const codeChanges={list:()=>[],jobs:new Map(),workers:new Map(),reviewerWebBusy:()=>false};
  const bridge=createBridgeServer({runtimeConfig:config,createLiveRuntime:async()=>({codeChanges,store:{getDelivery:()=>null},close:async()=>{}})});
  t.after(async()=>{await bridge.close();fs.rmSync(root,{recursive:true,force:true});});
  let state={...owner,terminalDiscardProtocol:1,pageReachable:false,pageBusy:null,generating:null,extensionBusy:false,tabId:7,documentId:'doc',frameId:0};
  let calls=0;
  bridge.webSession.inspectDelivery=async()=>structuredClone(state);
  bridge.webSession.discardDelivery=async input=>{calls++;assert.equal(input.ownerSnapshot.documentId,'doc');
    state={...state,currentDeliveryId:null,lastDeliveryDiscard:{...owner,deliveryId:owner.currentDeliveryId}};return {...input,result:'discarded'};};
  const address=await bridge.listen(),base='http://127.0.0.1:'+address.port;
  const headers={Authorization:'Bearer '+token,Origin:config.baseUrl,'Content-Type':'application/json'};
  const input={...owner,reason:'PRIVATE_REASON_NOT_LOGGED',unresolvedResultConfirmed:true,noAutomaticResendConfirmed:true,
    terminalDiscardConfirmed:true,pageStateUnconfirmedConfirmed:true};
  const post=body=>fetch(base+'/api/delivery-review/discard',{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await post({...input,pageStateUnconfirmedConfirmed:false})).status,409);assert.equal(calls,0);
  const response=await post(input);assert.equal(response.status,200);assert.equal((await response.json()).disposalStatus,'BOTH_DISCARDED');
  assert.equal((await post(input)).status,200);assert.equal(calls,1);
  const seen=await (await fetch(base+'/api/delivery-review?'+new URLSearchParams(owner),{headers})).json();
  assert.equal(seen.server.records[0].state,'RECOVERY_DISCARDED');assert.equal(seen.extension.discardConfirmed,true);
  const audit=fs.readFileSync(path.join(root,'delivery-recovery','events.jsonl'),'utf8');
  assert.doesNotMatch(audit,/PRIVATE_REASON_NOT_LOGGED/u);
  assert.deepEqual(audit.trim().split('\n').map(s=>JSON.parse(s).phase),['FAILED','STARTED','COMPLETED','STARTED','COMPLETED']);
  const diagnostic=JSON.parse(fs.readFileSync(path.join(root,'diagnostics','runtime-latest.json'),'utf8'));
  assert.equal(diagnostic.deliveryRecovery.phase,'COMPLETED');assert.equal(diagnostic.deliveryRecovery.resultStatus,'UNKNOWN');
  assert.equal(diagnostic.deliveryReview.discardConfirmed,true);
});
