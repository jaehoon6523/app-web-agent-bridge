import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { PreparationService } from '../src/orchestration/preparation-service.js';
import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { persistPreparation } from '../src/orchestration/preparation-persistence.js';
import { watchServerProcess } from '../scripts/server-watchdog.mjs';
import { removeOwnedFixture } from '../scripts/e2e/helpers/owned-fixture.mjs';

const locks = new WeakMap();
async function closeLocks(t) { await Promise.all((locks.get(t) ?? []).map(w => w.terminate())); }
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'preparation-contention-'));
  const options={filename:path.join(root,'preparation.sqlite'),web:null,available:()=>false,assertStart:async()=>{},approve:async()=>{},findRun:async()=>null};
  let service=new PreparationService(options);
  let dispatched=0;
  service.dispatch=async()=>{dispatched++;return {ok:true}};
  t.after(async()=>{service.close();await closeLocks(t);fs.rmSync(root,{recursive:true,force:true})});
  return {get service(){return service},options,get dispatched(){return dispatched},restart(){service.close();service=new PreparationService(options);service.dispatch=async()=>{dispatched++;return {ok:true}}}};
}
async function lock(t,filename,releaseMs=null) {
  const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData.filename);db.exec('BEGIN EXCLUSIVE');parentPort.postMessage('locked');function release(){db.exec('ROLLBACK');db.close();parentPort.postMessage('released');parentPort.close()}parentPort.once('message',release);if(workerData.releaseMs!==null)setTimeout(release,workerData.releaseMs);`,{eval:true,workerData:{filename,releaseMs}});
  const workers=locks.get(t) ?? [];workers.push(worker);locks.set(t,workers);
  t.after(()=>worker.terminate());
  await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
  return async()=>{const done=new Promise(resolve=>worker.once('exit',resolve));worker.postMessage('release');await done};
}

test('mutation contention waits without blocking unrelated event-loop work and dispatches exactly once',{timeout:15000},async t=>{
  const f=fixture(t);await lock(t,f.options.filename,1200);
  let observed=false;const timer=setTimeout(()=>{observed=true},100);
  t.after(()=>clearTimeout(timer));
  const result=await f.service.execute('test.command',{requestId:'short-lock'});
  assert.equal(observed,true,'main event loop must run while SQLite remains locked');
  assert.deepEqual(result,{ok:true});assert.equal(f.dispatched,1);
  assert.equal(f.service.receipt('short-lock').status,'COMPLETED');
});

test('failed pre-dispatch persistence leaves no receipt; explicit same-id retry and restart remain correct',{timeout:20000},async t=>{
  const f=fixture(t);const release=await lock(t,f.options.filename);
  await assert.rejects(f.service.execute('test.command',{requestId:'locked'}));
  assert.equal(f.dispatched,0);
  assert.equal(f.service.receipt('locked').status,'NOT_FOUND');
  await release();
  assert.deepEqual(await f.service.execute('test.command',{requestId:'next'}),{ok:true});
  f.restart();
  assert.equal(f.service.receipt('locked').status,'NOT_FOUND');
  assert.deepEqual(await f.service.execute('test.command',{requestId:'locked'}),{ok:true});
  f.restart();
  assert.equal(f.service.receipt('locked').status,'COMPLETED');
  assert.deepEqual(await f.service.execute('test.command',{requestId:'locked'}),{ok:true});
});

test('watchdog reports the current mutation request instead of an old state projection',async t=>{
  const child=new EventEmitter();const events=[];
  const stop=watchServerProcess(child,e=>events.push(e),{intervalMs:10,staleMs:30});t.after(stop);
  child.emit('message',{type:'state.projection.completed'});
  child.emit('message',{type:'request.express',route:'preparation-mutation',requestId:'diagnostic-request'});
  child.emit('message',{type:'preparation.mutation.started',route:'preparation-mutation',requestId:'diagnostic-request'});
  await new Promise(resolve=>setTimeout(resolve,70));
  const stall=events.find(e=>e.type==='watchdog.unresponsive');assert.ok(stall);
  assert.equal(stall.lastStage,'preparation.mutation.started');assert.equal(stall.route,'preparation-mutation');
  assert.equal(stall.requestId,'diagnostic-request');
});

test('watchdog does not call its own delayed timer a server stall',{timeout:30000},async t=>{
  const child=new EventEmitter();const events=[];
  let resolveObserved;
  const observed=new Promise(resolve=>{resolveObserved=resolve});
  const stop=watchServerProcess(child,event=>{
    events.push(event);
    if(event.type==='watchdog.observerDelayed') {
      child.emit('message',{type:'heartbeat',loopDelayMs:0});
      resolveObserved();
    }
  },{intervalMs:10,staleMs:30});t.after(stop);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60);
  await observed;
  assert.ok(events.some(event=>event.type==='watchdog.observerDelayed'));
  assert.equal(events.some(event=>event.type==='watchdog.unresponsive'),false);
});

for (const releaseMs of [1200,null]) test(`HTTP independent endpoints remain responsive during ${releaseMs ?? 'expired'} mutation lock`,{timeout:20000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'preparation-http-contention-'));
  const token='preparation-http-contention-token-0123456789';
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));
  const port=socket.address().port;await new Promise(r=>socket.close(r));
  const config={...loadConfig({env:{CONTROLLER_DATA_DIR:root,DASHBOARD_TOKEN:token,
    WEB_EXTENSION_SHARED_SECRET:'contention-fixture-secret-0123456789',WEB_EXTENSION_EXPECTED_IDENTITY:'contention-fixture-extension'}}),port,baseUrl:`http://127.0.0.1:${port}`};
  const events=[];
  const serverUrl=new URL('../src/server.js',import.meta.url).href;
  const coldStartMs=releaseMs===1200 ? 1200 : 0;
  const script=`import {createBridgeServer} from ${JSON.stringify(serverUrl)};const bridge=createBridgeServer({runtimeConfig:${JSON.stringify(config)},onDiagnostic:e=>process.send(e),createLiveRuntime:async()=>{await new Promise(r=>setTimeout(r,${coldStartMs}));return {store:{listRuns:()=>[]},composition:{},codeChanges:{list:()=>[]},close:async()=>{}}}});await bridge.listen();process.send({type:'test.listening'});`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},stdio:['ignore','ignore','pipe','ipc']});
  const startupAt=performance.now();
  let stderrBytes=0,stderrTail='',messageCount=0,lastMessageType=null,exit=null;
  child.stderr.on('data',chunk=>{
    stderrBytes+=chunk.length;
    stderrTail=(stderrTail+chunk.toString()).slice(-2048);
  });
  child.once('exit',(code,signal)=>{exit={code,signal}});
  const exited=new Promise(resolve=>child.once('close',resolve));
  t.after(async()=>{await closeLocks(t);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;await removeOwnedFixture(root)});
  child.on('message',e=>events.push(e));
  const startupEvidence=(event,error=null)=>({event,elapsedMs:Math.round(performance.now()-startupAt),pid:child.pid ?? null,
    exit,exitCode:child.exitCode,signalCode:child.signalCode,messageCount,lastMessageType,
    stderrBytes,stderrTail:stderrTail.replaceAll(token,'[REDACTED]').replaceAll('contention-fixture-secret-0123456789','[REDACTED]'),
    error:error?.message ?? null});
  await new Promise((resolve,reject)=>{
    const finish=(event,error=null)=>{
      clearTimeout(deadline);
      child.off('message',onMessage);child.off('close',onClose);child.off('error',onError);
      const evidence=startupEvidence(event,error);
      t.diagnostic(JSON.stringify(evidence));
      if(error)reject(Error(`${error.message}: ${JSON.stringify(evidence)}`,{cause:error}));else resolve();
    };
    const onMessage=message=>{
      messageCount++;lastMessageType=message?.type ?? null;
      if(message?.type==='test.listening')finish('fixture.ready');
    };
    const onClose=(code,signal)=>finish('fixture.closed',Error(`HTTP fixture closed before listening (code=${code}, signal=${signal})`));
    const onError=error=>finish('fixture.error',error);
    const deadline=setTimeout(()=>finish('fixture.deadline',Error('HTTP fixture startup deadline')),5000);
    child.on('message',onMessage);child.once('close',onClose);child.once('error',onError);
  });
  const base=config.baseUrl;
  const headers={authorization:`Bearer ${token}`,origin:config.baseUrl,'content-type':'application/json'};
  // First state includes lazy runtime/storage initialization. Its setup budget
  // is separate from the unchanged 500 ms HTTP oracle under the SQLite lock.
  const initial=await fetch(base+'/api/state',{headers,signal:AbortSignal.timeout(5000)});assert.equal(initial.status,200);
  assert.equal((await initial.json()).runtimeAvailability.ready,true,'cold initialization must finish before the mutation oracle');
  const release=await lock(t,path.join(root,'preparations.sqlite'),releaseMs);
  const mutation=fetch(base+'/api/preparations',{method:'POST',headers,body:JSON.stringify({requestId:'http-locked',objective:'test'}),signal:AbortSignal.timeout(8000)}).then(async result=>({result,body:await result.json()}),error=>({error}));
  await new Promise(r=>setTimeout(r,100));
  const responses=await Promise.all(['/api/preflight','/api/health'].map(async route=>{
    const response=await fetch(base+route,{signal:AbortSignal.timeout(500)});await response.json();return response.status;
  }));assert.deepEqual(responses,[200,200]);
  const session=await fetch(base+'/api/dashboard/session',{method:'POST',headers:{origin:config.baseUrl,'sec-fetch-site':'same-origin','content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(500)});assert.equal(session.status,200);await session.json();
  const outcome=await mutation;if(outcome.error)throw outcome.error;const {result,body}=outcome;assert.equal(result.status,409);
  if(releaseMs===null){assert.match(body.message,/locked/u);await release();}
  const entered=events.find(e=>e.type==='preparation.mutation.started');assert.ok(entered);
  assert.equal(entered.route,'preparation-mutation');
  assert.ok(events.some(e=>e.type==='request.express'&&e.requestId===entered.requestId));
  assert.ok(events.some(e=>e.type==='preparation.mutation.failed'&&e.requestId===entered.requestId));
});

test('post-dispatch persistence failure preserves uncertain authority and never dispatches a same-id retry',async t=>{
  const f=fixture(t);const save=f.service.saveReceipt.bind(f.service);
  f.service.saveReceipt=async(id,receipt)=>{if(receipt.status==='COMPLETED')throw Error('injected post-dispatch persistence failure');return save(id,receipt)};
  await assert.rejects(f.service.execute('test.command',{requestId:'dispatched'}));
  assert.equal(f.dispatched,1);assert.equal(f.service.receipt('dispatched').status,'PROCESSING');
  await assert.rejects(f.service.execute('test.command',{requestId:'dispatched'}),e=>e.code==='UNKNOWN_RESULT');
  f.restart();await assert.rejects(f.service.execute('test.command',{requestId:'dispatched'}),e=>e.code==='UNKNOWN_RESULT');
  assert.equal(f.dispatched,1);
});

test('rollback uncertainty never retries a SQLite write',async()=>{
  let attempts=0;const busy=Object.assign(Error('busy'),{code:'ERR_SQLITE_ERROR',errcode:5});
  const cleanup=Error('rollback failed');
  const db={exec(sql){if(sql==='BEGIN IMMEDIATE')attempts++;if(sql==='COMMIT')throw busy;if(sql==='ROLLBACK')throw cleanup},prepare(){return {run(){}}}};
  await assert.rejects(persistPreparation(db,()=> '{}',()=>{},()=>false),e=>e instanceof AggregateError && e.cause===busy && e.errors[0]===busy && e.errors[1]===cleanup);assert.equal(attempts,1);
});

test('GET projection reconciliation fails fast on a write lock instead of spending the mutation wait budget',{timeout:10000},async t=>{
  const f=fixture(t);
  f.service.data.currentId='read-context';
  f.service.data.contexts['read-context']={reservedRunId:'known-run',resultingRunId:null,lifecycle:'ACTIVE',stage:'PREPARE',agreement:{status:'APPROVING'},webSession:{},discussion:[],deliveries:[],version:1};
  f.service.saveSync();f.service.findRun=async()=>({runId:'known-run'});
  const release=await lock(t,f.options.filename);
  const started=Date.now();
  await assert.rejects(f.service.project({runtimeAvailability:{ready:true},runs:[],run:null,commandCapabilities:[],deliveries:[]}),e=>e.errcode===5);
  assert.ok(Date.now()-started<500,'a GET reconciliation write must fail fast');
  await release();
});

test('a result awaiting its final commit stays PROCESSING and cannot acknowledge a same-id retry',{timeout:10000},async t=>{
  const f=fixture(t);const dispatch=f.service.dispatch;
  let release,ready;const locked=new Promise(resolve=>{ready=resolve});
  f.service.dispatch=async()=>{release=await lock(t,f.options.filename);ready();return dispatch()};
  const completion=f.service.execute('test.command',{requestId:'terminal-write'}).then(value=>({value}),error=>({error}));
  await locked;await new Promise(r=>setTimeout(r,40));
  assert.equal(f.service.receipt('terminal-write').status,'PROCESSING');
  await assert.rejects(f.service.execute('test.command',{requestId:'terminal-write'}),e=>e.code==='UNKNOWN_RESULT');
  await release();const outcome=await completion;if(outcome.error)throw outcome.error;
  assert.deepEqual(outcome.value,{ok:true});f.restart();
  assert.equal(f.service.receipt('terminal-write').status,'COMPLETED');assert.equal(f.dispatched,1);
});


test('read recovery publishes a completed approval receipt only after its recovery write commits',{timeout:10000},async t=>{
  const f=fixture(t);
  f.service.data.currentId='approved-context';
  f.service.data.contexts['approved-context']={preparationId:'approved-context',resultingRunId:'known-run',lifecycle:'COMPLETED',stage:'WORK',agreement:{status:'APPROVED'},webSession:{},discussion:[],deliveries:[],version:1};
  f.service.data.receipts.approval={status:'PROCESSING',hash:JSON.stringify({type:'preparation.approve',input:{preparationId:'approved-context'}})};
  f.service.saveSync();const release=await lock(t,f.options.filename);
  const snapshot={runtimeAvailability:{ready:true},runs:[],run:null,commandCapabilities:[],deliveries:[]};
  await assert.rejects(f.service.project(snapshot),e=>e.errcode===5);
  assert.equal(f.service.receipt('approval').status,'PROCESSING');
  await release();await f.service.project(snapshot);
  assert.equal(f.service.receipt('approval').status,'COMPLETED');
});

test('diagnostic child publishes its first heartbeat before server initialization after a slow bootstrap',{timeout:15000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'diagnostic-bootstrap-'));
  const probe=net.createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const config=loadConfig({cwd:root,env:{WORKSPACE:root,CONTROLLER_DATA_DIR:root,PORT:String(port),
    DASHBOARD_TOKEN:'bootstrap-dashboard-token-0123456789abcdef'}});
  const {fileURLToPath}=await import('node:url');
  const child=spawn(process.execPath,['--experimental-sqlite','--import',
    'data:text/javascript,Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1700)',
    fileURLToPath(new URL('../scripts/diagnose-server-child.mjs',import.meta.url))],
    {stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  const messages=[],events=[];let stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk});
  child.on('message',event=>messages.push(event));
  const stop=watchServerProcess(child,event=>events.push(event));
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  t.after(async()=>{
    stop();if(child.exitCode===null&&child.signalCode===null)child.kill();
    await closed;await removeOwnedFixture(root);
  });
  child.send({runtimeConfig:config});
  const deadline=Date.now()+10000;
  while(!messages.some(event=>event.type==='server.listening') || !messages.some(event=>event.type==='heartbeat')) {
    assert.ok(Date.now()<deadline,'Missing startup/heartbeat: '+stderr);
    assert.equal(child.exitCode,null,stderr);
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(messages[0].type,'heartbeat','Bootstrap time must end before server stages can be attributed a heartbeat gap');
  assert.equal(events.some(event=>event.type==='watchdog.unresponsive' && event.lastStage!=='process.starting'),false);
});