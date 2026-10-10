import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from '../src/persistence/sqlite-database.js';
import { createAutomaticAgentReport, summarizeTabs } from '../src/diagnostics/agent-report.js';
import { enqueueAgentReport, readAgentReport, writeAgentReport } from '../src/diagnostics/report-store.js';
import { readPersistedDelivery } from '../src/diagnostics/persisted-delivery.js';
import { repairDiagnosticSummary } from '../src/diagnostics/repair-summary.js';
import { createExtensionAgentDiagnostics } from '../extension/runtime/agent-diagnostics.js';
const id = '618fcd37-ec59-4d1b-9151-eb437b6468e2';
const owner = {currentDeliveryId:'delivery_'+id,sessionId:'web_prep_'+id,runId:'prep_'+id,conversationUrl:'https://chatgpt.com/',tabId:7};
function fixture(t) {const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-diag-complete-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const paths = root => ({databasePath:path.join(root,'controller.sqlite'),preparationPath:path.join(root,'preparations.sqlite')});
function preparation(root, response = null) {
  const db = new DatabaseSync(paths(root).preparationPath);
  db.exec('CREATE TABLE preparation_state (id INTEGER PRIMARY KEY,json TEXT NOT NULL)');
  db.prepare('INSERT INTO preparation_state VALUES(1,?)').run(JSON.stringify({contexts:{[owner.runId]:{
    preparationId:owner.runId,webSession:{sessionId:owner.sessionId,conversationUrl:owner.conversationUrl,activeDeliveryId:null},
    deliveries:[{deliveryId:owner.currentDeliveryId,sessionId:owner.sessionId,state:'RECOVERY_DISCARDED',response}]}}}));
  db.close();
}
test('automatic error recording preserves cause, counts repeats, retains selector version and invalidates failed delivery reads',async t => {
  const root=fixture(t), transport=new EventEmitter();
  Object.assign(transport,{authenticated:true,responsive:true,snapshot:{connected:true}});
  const report=createAutomaticAgentReport({transport,directory:root,root,collect:async()=>({inspectedAt:new Date().toISOString(),tabs:[{
    tabId:7,pageStatus:'READY',composerPresent:true,selectorVersion:'2026-10-10.4',runtimeVersion:'0.2.12'}]})});
  t.after(()=>report.close());await report.refresh();
  for(let i=0;i<3;i++)transport.emit('message',{type:'web.prompt.error',requestId:owner.currentDeliveryId,
    payload:{code:'WEB_DOCUMENT_CHANGED',message:'PRIVATE_RESPONSE',details:{stage:'LOAD',tabId:7,sharedSecret:'PRIVATE_SECRET'}}});
  transport.emit('diagnostic',{type:'EXTENSION_CONNECTION_REJECTED',code:'AUTHENTICATED_EXTENSION_ALREADY_CONNECTED'});
  await report.observeDelivery({server:{status:'MATCHED',records:[{deliveryId:owner.currentDeliveryId,active:false}]},extension:{exact:true}});
  await report.deliveryFailure(new Error('PRIVATE_RESPONSE'));
  const value=await report.export();
  assert.equal(value.server.tabs[0].selectorVersion,'2026-10-10.4');
  assert.equal(value.incidents.find(i=>i.code==='WEB_DOCUMENT_CHANGED').count,3);
  assert.equal(value.incidents.find(i=>i.closeCode===4409).stage,'CONNECT');
  assert.equal(value.deliveryReview.status,'UNAVAILABLE');assert.equal(value.deliveryReview.records,null);
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE_SECRET|PRIVATE_RESPONSE/u);
});
test('inspection failures cannot become selector mismatches',()=>{
  const [tab]=summarizeTabs({tabs:[{tabId:7,pageStatus:'UI_CONTRACT_CHANGED',composerPresent:false,
    inspectionError:{code:'CONTENT_SCRIPT_TIMEOUT'},frameId:0}]});
  assert.equal(tab.decision,'STATUS_UNCONFIRMED');assert.equal(tab.composerPresent,null);
  assert.equal(tab.inspectionErrorCode,'CONTENT_SCRIPT_TIMEOUT');assert.equal(tab.frameId,0);
});
test('read-only storage detects settled server versus extension owner without creating or changing stores',async t=>{
  const root=fixture(t);preparation(root);
  const before=fs.readFileSync(paths(root).preparationPath);
  const value=await readPersistedDelivery(paths(root),owner);
  assert.equal(value.status,'MATCHED');assert.equal(value.assessment,'SERVER_SETTLED_EXTENSION_OWNED');
  assert.equal(value.records[0].responseStored,false);assert.equal(value.artifactIntegrity,'NOT_VERIFIED');
  assert.deepEqual(fs.readFileSync(paths(root).preparationPath),before);assert.equal(fs.existsSync(paths(root).databasePath),false);
  assert.doesNotMatch(JSON.stringify(value),/https:|responseBody/u);
});
test('receipt identity, corrupt stores and incomplete ownership never imply confirmed ACK or a missing delivery',async t=>{
  const root=fixture(t);preparation(root,'PRIVATE_RESPONSE');
  const receipt={deliveryId:owner.currentDeliveryId,sessionId:owner.sessionId,runId:owner.runId,conversationUrl:owner.conversationUrl};
  const matched=await readPersistedDelivery(paths(root),{...owner,currentDeliveryId:null,lastAcknowledgedDelivery:receipt});
  assert.equal(matched.ackConfirmed,true);assert.equal(matched.records[0].responseStored,true);
  const conflict=await readPersistedDelivery(paths(root),{...owner,currentDeliveryId:null,lastAcknowledgedDelivery:{...receipt,sessionId:'web_'+id}});
  assert.equal(conflict.ackConfirmed,false);
  fs.writeFileSync(paths(root).databasePath,'PRIVATE_SECRET');
  const failed=await readPersistedDelivery(paths(root),owner);assert.equal(failed.status,'UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(failed),/PRIVATE_SECRET|PRIVATE_RESPONSE/u);
  assert.equal((await readPersistedDelivery(paths(root),{currentDeliveryId:owner.currentDeliveryId})).reason,'DELIVERY_IDENTITY_INCOMPLETE');
});
test('cross-process latest report updates retain sections and repeated incident counts',async t=>{
  const root=fixture(t), module=new URL('../src/diagnostics/report-store.js',import.meta.url).href;
  const run=promisify(execFile);
  await Promise.all(Array.from({length:6},(_,index)=>run(process.execPath,['--input-type=module','-e',
    `import {enqueueAgentReport} from ${JSON.stringify(module)};await enqueueAgentReport(${JSON.stringify(root)},'incident',{source:'TEST',code:'WEB_FAILED',stage:'LOAD',occurredAt:new Date().toISOString()});`])));
  assert.equal(readAgentReport(root).incidents[0].count,6);
  await Promise.all([enqueueAgentReport(root,'server',{source:'CONTROLLER'}),enqueueAgentReport(root,'repair',{code:'REPAIR_NOT_NEEDED'})]);
  const result=readAgentReport(root);assert.equal(result.server.source,'CONTROLLER');assert.equal(result.repair.code,'REPAIR_NOT_NEEDED');
  assert.deepEqual(fs.readdirSync(root),['runtime-latest.json']);
});
test('a live writer lock is not stolen and a confirmed dead writer can be recovered',async t=>{
  const root=fixture(t), filename=path.join(root,'runtime-latest.json.lock');
  fs.writeFileSync(filename,JSON.stringify({pid:process.pid}));
  assert.throws(()=>writeAgentReport(root,'server',{}),{code:'DIAGNOSTIC_WRITER_BUSY'});
  const child=await promisify(execFile)(process.execPath,['-e','process.stdout.write(String(process.pid))']);
  fs.writeFileSync(filename,JSON.stringify({pid:Number(child.stdout)}));
  assert.ok(writeAgentReport(root,'server',{}).logFile);assert.equal(fs.existsSync(filename),false);
});
test('repair journal contributes exact patch hash, all verification results, approval and application state',t=>{
  const root=fixture(t), directory=path.join(root,'.agent-controller','selector-repair',id), patchHash='sha256:'+'a'.repeat(64);
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'state.json'),JSON.stringify({jobId:id,
    stage:'AWAITING_APPROVAL',baseCommit:'b'.repeat(40),diagnosticHash:'sha256:'+'c'.repeat(64),capture:{artifact:{sha256:patchHash}}}));
  const events=['lint','architecture','typecheck','regression'].map(verificationId=>({phase:'VERIFICATION_RESULT',jobId:id,patchHash,
    verificationId,exitCode:0,timedOut:false,aborted:false,terminationConfirmed:true,candidateUnchanged:true,failed:false}));
  fs.writeFileSync(path.join(directory,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  const value=repairDiagnosticSummary(root,id);assert.equal(value.patchHash,patchHash);assert.equal(value.verificationStatus,'PASSED');
  assert.equal(value.approval,'REQUIRED');assert.equal(value.application,'NOT_APPLIED');assert.equal(value.liveValidation,'NOT_CHECKED');
});
test('offline extension export survives worker recreation and never sends without authentication',async t=>{
  fixture(t);const saved={}, listeners=[];let sends=0;
  const chromeApi={storage:{local:{get:async keys=>Object.fromEntries(keys.map(k=>[k,saved[k]])),set:async patch=>Object.assign(saved,structuredClone(patch))}},
    runtime:{getManifest:()=>({version:'0.2.12'}),onMessage:{addListener:f=>listeners.push(f)}}};
  const setup=()=>createExtensionAgentDiagnostics({chromeApi,store:{read:async()=>({...owner,sharedSecret:'PRIVATE_SECRET'})},
    inspect:async()=>[{tabId:7,pageStatus:'READY',composerPresent:true,responseBody:'PRIVATE_RESPONSE'}],
    getConnection:()=>({authenticated:false,connected:false}),send:()=>{sends++;}});
  const first=setup();first.failure({code:'AUTHENTICATED_EXTENSION_ALREADY_CONNECTED',message:'PRIVATE_SECRET'},'CONNECT',4409);
  await first.inspectNow();setup();
  const result=await new Promise(resolve=>listeners.at(-1)({type:'bridge.exportDiagnostics'},null,resolve));
  assert.equal(result.ok,true);assert.equal(result.report.incidents[0].closeCode,4409);
  assert.equal(result.report.server.status,'UNAVAILABLE');assert.equal(result.report.tabs[0].decision,'REPAIR_NOT_NEEDED');
  assert.equal(sends,0);assert.equal(Object.keys(saved).length,1);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SECRET|PRIVATE_RESPONSE/u);
});
test('server owners are collected even when extension storage is unavailable, and review ACK metadata stays distinct from artifact verification',async t=>{
  const root=fixture(t), db=new DatabaseSync(paths(root).databasePath);
  db.exec('CREATE TABLE code_change_runs(run_id TEXT,record_json TEXT)');
  const run={runId:owner.runId,conversationBindings:[{sessionId:owner.sessionId,conversationUrl:owner.conversationUrl,
    activeDeliveryId:owner.currentDeliveryId}],webDeliveryReceipts:[{deliveryId:owner.currentDeliveryId,sessionId:owner.sessionId,
      conversationUrl:owner.conversationUrl,state:'ACK_PENDING',responseBody:'PRIVATE_RESPONSE'}]};
  db.prepare('INSERT INTO code_change_runs VALUES(?,?)').run(owner.runId,JSON.stringify(run));db.close();
  const serverOnly=await readPersistedDelivery(paths(root),null);
  assert.equal(serverOnly.status,'SERVER_ONLY');assert.equal(serverOnly.extensionStatus,'UNAVAILABLE');
  assert.equal(serverOnly.assessment,'SERVER_ACTIVE_EXTENSION_OWNER_UNCONFIRMED');assert.equal(serverOnly.records.length,1);
  const matched=await readPersistedDelivery(paths(root),owner);
  assert.equal(matched.status,'MATCHED');assert.equal(matched.records[0].processingState,'ACK_PENDING');
  assert.equal(matched.records[0].responseStored,true);assert.equal(matched.ackConfirmed,false);
  assert.equal(matched.artifactIntegrity,'NOT_VERIFIED');assert.doesNotMatch(JSON.stringify(matched),/PRIVATE_RESPONSE/u);
});

test('standalone server and packaged extension use the same bounded diagnostic schema',()=>{
  assert.deepEqual(fs.readFileSync(new URL('../src/diagnostics/diagnostic-schema.js',import.meta.url)),
    fs.readFileSync(new URL('../extension/runtime/agent-diagnostic-schema.js',import.meta.url)));
});
