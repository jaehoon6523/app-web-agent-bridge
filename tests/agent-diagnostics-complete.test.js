import {evidenceTestFile,evidenceFetch} from './helpers/failure-evidence.mjs';
const test = evidenceTestFile(import.meta.url);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile,spawn } from 'node:child_process';
import io from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from '../src/persistence/sqlite-database.js';
import { createAutomaticAgentReport, repositoryObservation, summarizeTabs } from '../src/diagnostics/agent-report.js';
import { enqueueAgentReport, readAgentReport, writeAgentReport } from '../src/diagnostics/report-store.js';
import { readPersistedDelivery } from '../src/diagnostics/persisted-delivery.js';
import { repairDiagnosticSummary } from '../src/diagnostics/repair-summary.js';
import { createExtensionAgentDiagnostics } from '../extension/runtime/agent-diagnostics.js';
import { removeOwnedFixture } from '../scripts/e2e/helpers/owned-fixture.mjs';
const id = '618fcd37-ec59-4d1b-9151-eb437b6468e2';
const owner = {currentDeliveryId:'delivery_'+id,sessionId:'web_prep_'+id,runId:'prep_'+id,conversationUrl:'https://chatgpt.com/',tabId:7};
function fixture(t) {const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-diag-complete-'));t.after(async()=>{t.evidence.preserve(root);await removeOwnedFixture(root);});return root;}
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
  const outcomes=await Promise.allSettled(Array.from({length:6},(_,index)=>t.evidence.command(process.execPath,['--input-type=module','-e',
    `import {enqueueAgentReport} from ${JSON.stringify(module)};await enqueueAgentReport(${JSON.stringify(root)},'incident',{source:'TEST',code:'WEB_FAILED',stage:'LOAD',occurredAt:new Date().toISOString()},{onDiagnostic:event=>process.stdout.write(JSON.stringify(event)+'\\n')});`],{cwd:process.cwd()},run).then(result=>{
      for(const line of result.stdout.trim().split(/\r?\n/u).filter(Boolean))t.evidence.event(JSON.parse(line));
    },error=>{t.evidence.record.childFailure={code:error.code,signal:error.signal,stdout:error.stdout,stderr:error.stderr};throw error;})));
  assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,6,JSON.stringify(t.evidence.record.childFailure));
  assert.equal(readAgentReport(root).incidents[0].count,6);
  await Promise.all([enqueueAgentReport(root,'server',{source:'CONTROLLER'}),enqueueAgentReport(root,'repair',{code:'REPAIR_NOT_NEEDED'})]);
  const result=readAgentReport(root);assert.equal(result.server.source,'CONTROLLER');assert.equal(result.repair.code,'REPAIR_NOT_NEEDED');
  assert.deepEqual(fs.readdirSync(root),['runtime-latest.json']);
});
test('a live writer lock is not stolen and a confirmed dead writer can be recovered',async t=>{
  const root=fixture(t), filename=path.join(root,'runtime-latest.json.lock');
  fs.writeFileSync(filename,JSON.stringify({pid:process.pid}));
  await assert.rejects(writeAgentReport(root,'server',{}),{code:'DIAGNOSTIC_WRITER_BUSY'});
  const child=await promisify(execFile)(process.execPath,['-e','process.stdout.write(String(process.pid))']);
  fs.writeFileSync(filename,JSON.stringify({pid:Number(child.stdout)}));
  assert.ok((await writeAgentReport(root,'server',{})).logFile);assert.equal(fs.existsSync(filename),false);
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

test('EPERM is retried only with an observed existing lock and never removes its live owner',async t=>{
  const root=fixture(t), lock=path.join(root,'runtime-latest.json.lock');
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid}));
  const original=io.open.bind(io);let denied=0, waits=0;
  const opened=t.mock.method(io,'open',async (filename,...args)=>{
    if(filename===lock && fs.existsSync(lock)) {denied++;throw Object.assign(new Error('Injected Windows lock contention'),{code:'EPERM',syscall:'open',path:lock});}
    return original(filename,...args);
  });
  const result=await enqueueAgentReport(root,'server',{source:'TEST'},{onDiagnostic:event=>{
    t.evidence.event(event);
    if(event.type==='agent.report.lock.wait' && !waits++) {
      assert.equal(JSON.parse(fs.readFileSync(lock,'utf8')).pid,process.pid);
      // The real owner releases its lock; the contender must not delete it.
      fs.unlinkSync(lock);
    }
  }});
  opened.mock.restore();
  assert.ok(denied>=1);assert.ok(waits>=1);assert.ok(result.logFile);
  assert.deepEqual(fs.readdirSync(root),['runtime-latest.json']);
});

test('EPERM without an existing lock is a write failure, is not retried, and leaves the previous report intact',async t=>{
  const root=fixture(t), lock=path.join(root,'runtime-latest.json.lock'), events=[];
  await enqueueAgentReport(root,'server',{source:'PREVIOUS'});
  const before=fs.readFileSync(path.join(root,'runtime-latest.json'));
  const original=io.open.bind(io);let denied=0;
  const opened=t.mock.method(io,'open',async (filename,...args)=>{
    if(filename===lock) {denied++;throw Object.assign(new Error('Injected permission failure'),{code:'EPERM',syscall:'open',path:lock});}
    return original(filename,...args);
  });
  await assert.rejects(enqueueAgentReport(root,'server',{source:'CURRENT'},{onDiagnostic:event=>{events.push(event);t.evidence.event(event);}}),
    error=>error.code==='EPERM' && error.diagnosticOperation==='lock.open' && error.lockState.state==='MISSING');
  opened.mock.restore();
  assert.equal(denied,1);assert.equal(events.some(event=>event.type==='agent.report.lock.wait'),false);
  assert.deepEqual(fs.readFileSync(path.join(root,'runtime-latest.json')),before);
  await enqueueAgentReport(root,'server',{source:'RECOVERED'});
  assert.equal(readAgentReport(root).server.source,'RECOVERED');
});

test('an unreleased observed lock has a bounded retry and returns the original EPERM with owner evidence',async t=>{
  const root=fixture(t), lock=path.join(root,'runtime-latest.json.lock');
  const bytes=JSON.stringify({pid:process.pid});fs.writeFileSync(lock,bytes);
  const original=io.open.bind(io);let denied=0;
  t.mock.method(io,'open',async (filename,...args)=>{
    if(filename===lock) {denied++;throw Object.assign(new Error('Injected persistent permission failure'),{code:'EPERM',syscall:'open',path:lock});}
    return original(filename,...args);
  });
  await assert.rejects(enqueueAgentReport(root,'server',{}, {lockTimeoutMs:60,onDiagnostic:t.evidence.event}),
    error=>error.code==='EPERM' && error.path===lock && error.lockState.state==='LIVE');
  assert.ok(denied>=1);assert.ok(denied<=8);assert.equal(fs.readFileSync(lock,'utf8'),bytes);
});

test('fsync failure is not a successful write and cleanup errors do not replace it',async t=>{
  const root=fixture(t);await enqueueAgentReport(root,'server',{source:'PREVIOUS'});
  const before=fs.readFileSync(path.join(root,'runtime-latest.json')), originalOpen=io.open.bind(io), originalUnlink=io.unlink.bind(io);
  const events=[];
  const opened=t.mock.method(io,'open',async (filename,...args)=>{
    const handle=await originalOpen(filename,...args);
    if(String(filename).endsWith('.tmp')) handle.sync=async()=>{throw Object.assign(new Error('Injected full disk'),{code:'ENOSPC',syscall:'fsync',path:filename});};
    return handle;
  });
  const unlinked=t.mock.method(io,'unlink',async filename=>{
    if(String(filename).endsWith('.tmp'))throw Object.assign(new Error('Injected cleanup denial'),{code:'EACCES',path:filename});
    return originalUnlink(filename);
  });
  await assert.rejects(enqueueAgentReport(root,'server',{source:'UNSAVED'},{onDiagnostic:event=>{events.push(event);t.evidence.event(event);}}),
    error=>error.code==='ENOSPC' && error.diagnosticOperation==='output.sync' && error.cleanupErrors[0].code==='EACCES');
  opened.mock.restore();unlinked.mock.restore();
  assert.equal(events.some(event=>event.operation==='output.rename'),false);
  assert.deepEqual(fs.readFileSync(path.join(root,'runtime-latest.json')),before);
  assert.equal(fs.existsSync(path.join(root,'runtime-latest.json.lock')),false);
  for(const filename of fs.readdirSync(root).filter(name=>name.endsWith('.tmp')))fs.unlinkSync(path.join(root,filename));
  await enqueueAgentReport(root,'repair',{code:'RECOVERED'});
  assert.equal(readAgentReport(root).server.source,'PREVIOUS');
});

test('a writer killed during an actual queued write is recovered on restart without losing committed sections', {timeout:10000},async t=>{
  const root=fixture(t);await enqueueAgentReport(root,'server',{source:'COMMITTED'});
  const module=new URL('../src/diagnostics/report-store.js',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import io from 'node:fs/promises';import {enqueueAgentReport} from ${JSON.stringify(module)};
    const open=io.open.bind(io);io.open=async(filename,...args)=>{const handle=await open(filename,...args);
      if(String(filename).endsWith('.tmp'))handle.sync=async()=>{process.send({type:'writer.held',pid:process.pid});await new Promise(()=>{});};return handle;};
    await enqueueAgentReport(${JSON.stringify(root)},'repair',{code:'UNCOMMITTED'});
  `],{stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});child.stdout.resume();
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;
    fs.writeFileSync(path.join(t.evidence.directory,'writer-stderr.log'),stderr);});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Writer did not hold its lock: '+stderr)),5000);
    child.on('message',event=>{t.evidence.event(event);if(event.type==='writer.held'){clearTimeout(timeout);resolve();}});
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'runtime-latest.json.lock'),'utf8')).pid,child.pid);
  child.kill('SIGKILL');await closed;
  await enqueueAgentReport(root,'repair',{code:'RESTARTED'},{onDiagnostic:t.evidence.event});
  const report=readAgentReport(root);assert.equal(report.server.source,'COMMITTED');assert.equal(report.repair.code,'RESTARTED');
  assert.deepEqual(fs.readdirSync(root),['runtime-latest.json']);
});

async function deadWriterFixture(t) {
  const root=fixture(t);await enqueueAgentReport(root,'server',{source:'COMMITTED'});
  const child=await promisify(execFile)(process.execPath,['-e','process.stdout.write(String(process.pid))']);
  const lock=path.join(root,'runtime-latest.json.lock'), temporary='runtime-latest.json.'+randomUUID()+'.tmp';
  fs.writeFileSync(lock,JSON.stringify({pid:Number(child.stdout),token:randomUUID(),temporary}));
  fs.writeFileSync(path.join(root,temporary),'UNCOMMITTED');
  return {root,lock,recovery:lock+'.recovery',previous:readAgentReport(root).server};
}
async function heldRecovery(t,root,stage) {
  const recovery=path.join(root,'runtime-latest.json.lock.recovery');
  const module=new URL('../src/diagnostics/report-store.js',import.meta.url).href;
  const args=['--input-type=module','-e',`
    import io from 'node:fs/promises';import path from 'node:path';import {enqueueAgentReport} from ${JSON.stringify(module)};
    const recovery=${JSON.stringify(recovery)},stage=${JSON.stringify(stage)};let held=false;
    const hold=async filename=>{if(held)return;held=true;const timer=setInterval(()=>{},1000);
      process.send({type:'recovery.held',stage,path:filename,pid:process.pid});
      try{await new Promise(resolve=>process.once('message',resolve));}finally{clearInterval(timer);}};
    const rename=io.rename.bind(io);io.rename=async(from,to)=>{await rename(from,to);if(stage==='published'&&to===recovery)await hold(to);};
    const mkdir=io.mkdir.bind(io);io.mkdir=async(filename,...options)=>{const result=await mkdir(filename,...options);
      if(stage==='preparing'&&path.dirname(filename)===path.dirname(recovery)&&path.basename(filename).startsWith(path.basename(recovery)+'.prepare-'))await hold(filename);return result;};
    const rmdir=io.rmdir.bind(io);io.rmdir=async filename=>{await rmdir(filename);
      if(stage==='released'&&path.dirname(filename)===recovery)await hold(filename);};
    try{await enqueueAgentReport(${JSON.stringify(root)},'repair',{code:'CHILD_FINISHED'},{onDiagnostic:event=>process.stdout.write(JSON.stringify(event)+'\\n')});}
    catch(error){process.stderr.write(JSON.stringify({code:error.code,path:error.path,operation:error.diagnosticOperation})+'\\n');process.exitCode=1;}
    finally{process.disconnect();}
  `];
  const child=spawn(process.execPath,args,{cwd:process.cwd(),stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  t.evidence.event({type:'recovery.child.started',command:process.execPath,args,cwd:process.cwd(),pid:child.pid,stage});
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>{
    const result={code,signal};t.evidence.event({type:'recovery.child.closed',pid:child.pid,stage,...result});resolve(result);
  }));
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;
    fs.writeFileSync(path.join(t.evidence.directory,`recovery-${stage}-${child.pid}-stdout.log`),stdout);
    fs.writeFileSync(path.join(t.evidence.directory,`recovery-${stage}-${child.pid}-stderr.log`),stderr);
  });
  const held=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Recovery did not reach '+stage+': '+stderr)),5000);
    child.once('message',event=>{clearTimeout(timer);t.evidence.event(event);resolve(event);});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    void closed.then(result=>{clearTimeout(timer);reject(new Error('Recovery exited before hold: '+JSON.stringify(result)+' '+stderr));});
  });
  return {child,closed,held};
}

test('transient Windows recovery publication EPERM retries only the owned staging guard',async t=>{
  const {root,recovery,previous}=await deadWriterFixture(t), rename=io.rename.bind(io);
  const denied=Object.assign(new Error('Transient Windows recovery publication'),{code:'EPERM',syscall:'rename',dest:recovery});
  let attempts=0;const events=[];
  t.mock.method(io,'rename',async(from,to)=>{
    if(to===recovery && ++attempts<=2) {
      assert.equal(fs.existsSync(recovery),false);
      assert.ok(fs.readdirSync(from)[0].startsWith('owner-'+process.pid+'-'));
      throw denied;
    }
    return rename(from,to);
  });
  await enqueueAgentReport(root,'repair',{code:'RECOVERED'},{onDiagnostic:event=>{events.push(event);t.evidence.event(event);}});
  assert.equal(attempts,3);
  assert.equal(events.filter(event=>event.type==='agent.report.recovery.publication.wait').length,2);
  assert.deepEqual(readAgentReport(root).server,previous);
  assert.equal(readAgentReport(root).repair.code,'RECOVERED');
  assert.deepEqual(fs.readdirSync(root),['runtime-latest.json']);
});

test('persistent recovery publication EPERM is bounded and preserves the original denial and report',async t=>{
  const {root,lock,recovery}=await deadWriterFixture(t), before=fs.readFileSync(path.join(root,'runtime-latest.json'));
  const lockBefore=fs.readFileSync(lock), rename=io.rename.bind(io);
  const denied=Object.assign(new Error('Persistent recovery permission denial'),{code:'EPERM',syscall:'rename',dest:recovery});
  let attempts=0;
  const mocked=t.mock.method(io,'rename',async(from,to)=>{
    if(to===recovery){attempts++;throw denied;}
    return rename(from,to);
  });
  await assert.rejects(enqueueAgentReport(root,'repair',{code:'NOT_STORED'},{onDiagnostic:t.evidence.event}),
    error=>error===denied && error.diagnosticOperation==='lock.recovery.acquire');
  assert.equal(attempts,5);
  assert.deepEqual(fs.readFileSync(path.join(root,'runtime-latest.json')),before);
  assert.deepEqual(fs.readFileSync(lock),lockBefore);
  assert.equal(fs.existsSync(recovery),false);
  assert.equal(fs.readdirSync(root).some(name=>name.includes('.prepare-')),false);
  mocked.mock.restore();
  await enqueueAgentReport(root,'repair',{code:'NEXT_WRITE'});
  assert.equal(readAgentReport(root).repair.code,'NEXT_WRITE');
});

test('a competing Windows dead-guard reaper may finish deletion after EPERM without losing the report',async t=>{
  const {root,recovery,previous}=await deadWriterFixture(t), worker=await heldRecovery(t,root,'published');
  const marker=path.join(recovery,fs.readdirSync(recovery)[0]);worker.child.kill('SIGKILL');await worker.closed;
  const rmdir=io.rmdir.bind(io);let attempts=0;
  t.mock.method(io,'rmdir',async directory=>{
    if(directory===marker && ++attempts===1) {
      await rmdir(directory);
      throw Object.assign(new Error('Windows deletion pending'),{code:'EPERM',syscall:'rmdir',path:directory});
    }
    return rmdir(directory);
  });
  await enqueueAgentReport(root,'repair',{code:'RESTARTED'},{onDiagnostic:t.evidence.event});
  assert.equal(attempts,2);
  assert.deepEqual(readAgentReport(root).server,previous);
  assert.equal(readAgentReport(root).repair.code,'RESTARTED');
  assert.deepEqual(fs.readdirSync(root),['runtime-latest.json']);
});

test('a live recovery is protected and a recovery killed immediately after publication is reclaimed without losing the report', {timeout:15000},async t=>{
  const {root,lock,recovery,previous}=await deadWriterFixture(t);
  const worker=await heldRecovery(t,root,'published'), marker=fs.readdirSync(recovery)[0];
  assert.ok(marker.startsWith('owner-'+worker.child.pid+'-'));
  const lockBefore=fs.readFileSync(lock), reportBefore=fs.readFileSync(path.join(root,'runtime-latest.json'));
  await assert.rejects(enqueueAgentReport(root,'extension',{status:'MUST_WAIT'},{lockTimeoutMs:60,onDiagnostic:t.evidence.event}),
    error=>error.code==='DIAGNOSTIC_WRITER_BUSY' && error.lockState.state==='RECOVERY' &&
      error.lockState.recoveryOwner.state==='LIVE' && error.lockState.recoveryOwner.pid===worker.child.pid);
  assert.deepEqual(fs.readdirSync(recovery),[marker]);assert.deepEqual(fs.readFileSync(lock),lockBefore);
  assert.deepEqual(fs.readFileSync(path.join(root,'runtime-latest.json')),reportBefore);
  worker.child.kill('SIGKILL');await worker.closed;
  await enqueueAgentReport(root,'repair',{code:'RESTARTED'},{onDiagnostic:t.evidence.event});
  await enqueueAgentReport(root,'extension',{status:'NEXT_WRITE'},{onDiagnostic:t.evidence.event});
  const report=readAgentReport(root);assert.deepEqual(report.server,previous);
  assert.equal(report.repair.code,'RESTARTED');assert.equal(report.extension.status,'NEXT_WRITE');
  assert.deepEqual(fs.readdirSync(root),['runtime-latest.json']);
});

test('death before recovery publication or after owner release cannot leave a permanent guard or preparation', {timeout:15000},async t=>{
  for(const stage of ['preparing','released']) {
    const {root,recovery,previous}=await deadWriterFixture(t), worker=await heldRecovery(t,root,stage);
    if(stage==='preparing') {
      assert.equal(fs.existsSync(recovery),false);
      await enqueueAgentReport(root,'extension',{status:'PEER_FINISHED'});
      assert.equal(fs.existsSync(recovery),false);
      assert.equal(fs.existsSync(worker.held.path),true);
    }
    else assert.deepEqual(fs.readdirSync(recovery),[]);
    worker.child.kill('SIGKILL');await worker.closed;
    await enqueueAgentReport(root,'repair',{code:'RESTARTED_'+stage},{onDiagnostic:t.evidence.event});
    assert.deepEqual(readAgentReport(root).server,previous);
    if(stage==='preparing')assert.equal(readAgentReport(root).extension.status,'PEER_FINISHED');
    assert.equal(readAgentReport(root).repair.code,'RESTARTED_'+stage);
    assert.deepEqual(fs.readdirSync(root),['runtime-latest.json']);
  }
});

test('a late dead-guard reaper cannot remove a newly published live recovery guard', {timeout:15000},async t=>{
  const {root,recovery,previous}=await deadWriterFixture(t), dead=await heldRecovery(t,root,'published');
  const oldMarker=path.join(recovery,fs.readdirSync(recovery)[0]);dead.child.kill('SIGKILL');await dead.closed;
  const rmdir=io.rmdir.bind(io);let active,replaced=false;
  const removed=t.mock.method(io,'rmdir',async filename=>{
    await rmdir(filename);
    if(filename===oldMarker&&!replaced) {
      replaced=true;await rmdir(recovery);
      active=await heldRecovery(t,root,'published');
    }
  });
  t.after(()=>removed.mock.restore());
  await assert.rejects(enqueueAgentReport(root,'extension',{status:'MUST_WAIT'},{lockTimeoutMs:60,onDiagnostic:t.evidence.event}),
    error=>error.code==='DIAGNOSTIC_WRITER_BUSY' && error.lockState.recoveryOwner.pid===active.child.pid &&
      error.lockState.recoveryOwner.state==='LIVE');
  removed.mock.restore();assert.equal(replaced,true);
  assert.ok(fs.readdirSync(recovery)[0].startsWith('owner-'+active.child.pid+'-'));
  active.child.send({type:'release'});assert.deepEqual(await active.closed,{code:0,signal:null});
  await enqueueAgentReport(root,'extension',{status:'AFTER_RECOVERY'},{onDiagnostic:t.evidence.event});
  assert.deepEqual(readAgentReport(root).server,previous);assert.equal(readAgentReport(root).repair.code,'CHILD_FINISHED');
  assert.equal(readAgentReport(root).extension.status,'AFTER_RECOVERY');assert.deepEqual(fs.readdirSync(root),['runtime-latest.json']);
});

test('concurrent restart writers retain every section after the recovery owner is killed', {timeout:15000},async t=>{
  for(const stage of ['published','preparing']) {
  const {root,previous}=await deadWriterFixture(t), worker=await heldRecovery(t,root,stage);
  worker.child.kill('SIGKILL');await worker.closed;
  const module=new URL('../src/diagnostics/report-store.js',import.meta.url).href, run=promisify(execFile);
  const sections=['repair','extension','startup','deliveryReview'];
  const outcomes=await Promise.allSettled(sections.map(section=>t.evidence.command(process.execPath,['--input-type=module','-e',
    `import {enqueueAgentReport} from ${JSON.stringify(module)};await enqueueAgentReport(${JSON.stringify(root)},${JSON.stringify(section)},{source:${JSON.stringify(section)}},{onDiagnostic:event=>process.stdout.write(JSON.stringify(event)+'\\n')});`],
    {cwd:process.cwd()},run).then(result=>{
      for(const line of result.stdout.trim().split(/\r?\n/u).filter(Boolean))t.evidence.event(JSON.parse(line));
    })));
  assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,sections.length,
    JSON.stringify(outcomes.map(outcome=>outcome.status==='rejected'?{code:outcome.reason.code,stderr:outcome.reason.stderr}:null)));
  const report=readAgentReport(root);assert.deepEqual(report.server,previous);
  for(const section of sections)assert.equal(report[section].source,section);
  assert.deepEqual(fs.readdirSync(root),['runtime-latest.json']);
  }
});

test('an ownerless legacy recovery file stays explicitly unverified instead of being stolen',async t=>{
  const root=fixture(t), recovery=path.join(root,'runtime-latest.json.lock.recovery');fs.writeFileSync(recovery,'');
  await assert.rejects(writeAgentReport(root,'server',{}),error=>error.code==='DIAGNOSTIC_WRITER_BUSY' &&
    error.lockState.state==='RECOVERY' && error.lockState.recoveryOwner.state==='UNVERIFIED');
  assert.equal(fs.readFileSync(recovery,'utf8'),'');
});

test('a recovery cleanup denial retains its operation and cause and the next write can finish cleanup',async t=>{
  const {root,recovery,previous}=await deadWriterFixture(t), before=fs.readFileSync(path.join(root,'runtime-latest.json'));
  const rmdir=io.rmdir.bind(io);
  const removed=t.mock.method(io,'rmdir',async filename=>{
    if(filename===recovery)throw Object.assign(new Error('Injected recovery cleanup denial'),{code:'EPERM',syscall:'rmdir',path:recovery});
    await rmdir(filename);
  });
  await assert.rejects(enqueueAgentReport(root,'repair',{code:'NOT_STORED'},{onDiagnostic:t.evidence.event}),error=>
    error.code==='DIAGNOSTIC_RECOVERY_CLEANUP_FAILED' && error.cause.code==='EPERM' &&
    error.cleanupErrors.some(item=>item.operation==='lock.recovery.remove' && item.code==='EPERM' && item.path===recovery));
  removed.mock.restore();assert.deepEqual(fs.readFileSync(path.join(root,'runtime-latest.json')),before);
  assert.deepEqual(fs.readdirSync(recovery),[]);
  await enqueueAgentReport(root,'repair',{code:'RESTARTED'},{onDiagnostic:t.evidence.event});
  assert.deepEqual(readAgentReport(root).server,previous);assert.equal(readAgentReport(root).repair.code,'RESTARTED');
  assert.deepEqual(fs.readdirSync(root),['runtime-latest.json']);

  const next=await deadWriterFixture(t), rename=io.rename.bind(io);let peer;
  const renamed=t.mock.method(io,'rename',async(from,to)=>{
    if(to===next.recovery)peer=await heldRecovery(t,next.root,'published');
    await rename(from,to);
  });
  const denied=t.mock.method(io,'rmdir',async filename=>{
    if(String(filename).startsWith(next.recovery+'.prepare-'))
      throw Object.assign(new Error('Injected preparation cleanup denial'),{code:'EACCES',syscall:'rmdir',path:filename});
    await rmdir(filename);
  });
  await assert.rejects(enqueueAgentReport(next.root,'extension',{status:'NOT_STORED'},{onDiagnostic:t.evidence.event}),
    error=>error.code==='DIAGNOSTIC_WRITER_BUSY' && error.cleanupErrors?.some(item=>
      item.operation==='lock.recovery.preparation.remove' && item.code==='EACCES'));
  renamed.mock.restore();denied.mock.restore();
  assert.ok(fs.readdirSync(next.recovery)[0].startsWith('owner-'+peer.child.pid+'-'));
  const preparations=fs.readdirSync(next.root).filter(name=>name.startsWith(path.basename(next.recovery)+'.prepare-'+process.pid+'-'));
  assert.equal(preparations.length,1);
  await assert.rejects(writeAgentReport(next.root,'extension',{}),error=>error.code==='DIAGNOSTIC_WRITER_BUSY' &&
    error.lockState.recoveryOwner.pid===peer.child.pid);
  assert.deepEqual(fs.readdirSync(next.root).filter(name=>name.startsWith(path.basename(next.recovery)+'.prepare-')),[]);
  peer.child.send({type:'release'});assert.deepEqual(await peer.closed,{code:0,signal:null});
  await enqueueAgentReport(next.root,'extension',{status:'AFTER_RECOVERY'});
  assert.deepEqual(readAgentReport(next.root).server,next.previous);assert.deepEqual(fs.readdirSync(next.root),['runtime-latest.json']);
});

test('slow Git and durable file sync leave real HTTP and heartbeat responsive with diagnostics enabled', {timeout:12000},async t=>{
  const root=fixture(t), events=[], gitChildren=[];
  const server=createServer((_request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.end('{"ok":true}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const original=io.open.bind(io);let syncStarted, finishSync;
  const syncing=new Promise(resolve=>{syncStarted=resolve;});
  const releaseSync=new Promise(resolve=>{finishSync=resolve;});
  const opened=t.mock.method(io,'open',async (filename,...args)=>{
    const handle=await original(filename,...args);
    if(String(filename).endsWith('.tmp')) {const sync=handle.sync.bind(handle);handle.sync=async()=>{syncStarted();await releaseSync;await sync();};}
    return handle;
  });
  let ticks=0,maxDelay=0,last=performance.now();
  const heartbeat=setInterval(()=>{const now=performance.now(),delay=Math.max(0,now-last-25);last=now;ticks++;maxDelay=Math.max(maxDelay,delay);
    t.evidence.event({type:'heartbeat',loopDelayMs:delay});},25);
  t.after(()=>{clearInterval(heartbeat);finishSync();});
  const execute=(_file,args,options,callback)=>{
    const stdout=args.includes('rev-parse') ? 'a'.repeat(40)+'\n' : '';
    const child=execFile(process.execPath,['-e',`setTimeout(()=>process.stdout.write(${JSON.stringify(stdout)}),500)`],options,callback);
    gitChildren.push(child);return child;
  };
  const report=createAutomaticAgentReport({root,directory:root,collect:async()=>({tabs:[]}),
    observeRepository:(repository,options)=>repositoryObservation(repository,{...options,execute}),
    onDiagnostic:event=>{events.push(event);t.evidence.event(event);}});
  t.after(async()=>{finishSync();await report.close();opened.mock.restore();});
  const probe=()=>evidenceFetch(t.evidence,`http://127.0.0.1:${server.address().port}/api/health`,{signal:AbortSignal.timeout(1000)});
  assert.equal((await probe()).status,200);
  await syncing;
  assert.equal((await probe()).status,200);
  assert.ok(ticks>=10);assert.ok(maxDelay<1000);
  finishSync();await report.ready;await report.close();opened.mock.restore();
  assert.ok(events.filter(event=>event.type==='agent.report.git.completed' && event.elapsedMs>=450).length>=2);
  assert.ok(events.some(event=>event.operation==='output.sync' && event.type==='agent.report.io.completed'));
  assert.ok(gitChildren.every(child=>child.exitCode!==null||child.signalCode!==null));
});

test('closing diagnostics cancels owned Git, drains accepted writes and reports storage failure', {timeout:10000},async t=>{
  const root=fixture(t), children=[];
  let started;const spawned=new Promise(resolve=>{started=resolve;});
  const execute=(_file,_args,options,callback)=>{
    const child=execFile(process.execPath,['-e','setTimeout(()=>{},30000)'],options,callback);
    children.push(child);child.once('spawn',started);return child;
  };
  const report=createAutomaticAgentReport({root,directory:root,collect:async()=>({tabs:[]}),
    observeRepository:(repository,options)=>repositoryObservation(repository,{...options,execute}),onDiagnostic:t.evidence.event});
  t.after(()=>report.close());
  await spawned;await report.close();
  assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null));
  assert.equal(fs.existsSync(path.join(root,'runtime-latest.json.lock')),false);
  await enqueueAgentReport(root,'server',{source:'PREVIOUS'});
  const before=fs.readFileSync(path.join(root,'runtime-latest.json')), lock=path.join(root,'runtime-latest.json.lock');
  const originalOpen=io.open.bind(io), failures=[], sent=[], transport=new EventEmitter();
  transport.send=message=>sent.push(message);
  const opened=t.mock.method(io,'open',async(filename,...args)=>{
    if(filename===lock)throw Object.assign(new Error('Injected write denial'),{code:'EPERM',syscall:'open',path:lock});
    return originalOpen(filename,...args);
  });
  let exportFailed;const observedFailure=new Promise(resolve=>{exportFailed=resolve;});
  const broken=createAutomaticAgentReport({root,directory:root,transport,collect:async()=>({tabs:[]}),onFailure:event=>failures.push(event),
    onDiagnostic:event=>{t.evidence.event(event);if(event.type==='agent.report.export.failed')exportFailed();}});
  t.after(async()=>{await broken.close().catch(()=>{});opened.mock.restore();});
  await broken.ready;
  const refresh=broken.refresh();transport.emit('message',{type:'extension.agent-report.get',requestId:id});await refresh;
  let timer;
  try {await Promise.race([observedFailure,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Missing export failure')),1000);})]);}
  finally {clearTimeout(timer);}
  assert.equal(sent.length,0,'a failed write cannot export the previous report as the current result');
  assert.deepEqual(fs.readFileSync(path.join(root,'runtime-latest.json')),before);
  await assert.rejects(broken.export(),{code:'EPERM'});await assert.rejects(broken.close(),{code:'EPERM'});opened.mock.restore();
  assert.ok(failures.length>0);
});

test('a first scenario failure and cleanup failure retain their timelines, and the next run replaces them', {timeout:10000},async t=>{
  const root=fixture(t), filename=path.join(root,'diagnostic-retention-probe.test.mjs');
  const helper=new URL('./helpers/failure-evidence.mjs',import.meta.url).href;
  const latest=new URL('../.agent-controller/latest-diagnostic-retention-probe/',import.meta.url);
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const script=(failed,cleanup)=>`
    import assert from 'node:assert/strict';import {evidenceTestFile} from ${JSON.stringify(helper)};
    const test=evidenceTestFile(import.meta.url);
    test('first',t=>{t.evidence.event({type:${JSON.stringify(failed?'FIRST_FAILURE':'CURRENT_SUCCESS')}});${failed?"assert.fail('FIRST_FAILURE');":''}});
    test('later',t=>{t.evidence.event({type:'LATER_SUCCESS'});${cleanup?"t.after(()=>{throw new Error('CLEANUP_FAILURE');});":''}});
  `;
  fs.writeFileSync(filename,script(true,true));
  await assert.rejects(t.evidence.command(process.execPath,['--test','--experimental-test-isolation=none',filename],{env,cwd:root},promisify(execFile)),{code:1});
  const first=JSON.parse(fs.readFileSync(new URL('result.json',latest),'utf8'));
  assert.equal(first.status,'FAIL');assert.equal(first.scenarios[0].status,'FAIL');assert.equal(first.scenarios[1].status,'FAIL');
  assert.match(first.scenarios[0].failure.message,/FIRST_FAILURE/u);
  assert.match(first.scenarios[1].cleanupErrors[0].message,/CLEANUP_FAILURE/u);
  assert.match(fs.readFileSync(new URL(first.scenarios[0].directory+'/timeline.jsonl',latest),'utf8'),/FIRST_FAILURE/u);
  t.evidence.copy(fileURLToPath(latest),'retained-first-run');
  fs.writeFileSync(filename,script(false,false));
  await t.evidence.command(process.execPath,['--test','--experimental-test-isolation=none',filename],{env,cwd:root},promisify(execFile));
  const second=JSON.parse(fs.readFileSync(new URL('result.json',latest),'utf8'));
  assert.equal(second.status,'PASS');assert.notEqual(second.runId,first.runId);
  assert.equal(second.scenarios.length,2);
  assert.doesNotMatch(fs.readFileSync(new URL(second.scenarios[0].directory+'/timeline.jsonl',latest),'utf8'),/FIRST_FAILURE/u);
});
