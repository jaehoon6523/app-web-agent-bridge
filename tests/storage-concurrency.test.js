import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {PreparationService} from '../src/orchestration/preparation-service.js';
import {enqueueAgentReport,readAgentReport} from '../src/diagnostics/report-store.js';
import {removeOwnedFixture} from '../scripts/e2e/helpers/owned-fixture.mjs';

const reportModule = new URL('../src/diagnostics/report-store.js',import.meta.url).href;
const serverModule = new URL('../src/server.js',import.meta.url).href;
const configModule = new URL('../src/config.js',import.meta.url).href;
const serviceOptions = root => ({filename:path.join(root,'preparations.sqlite'),web:null,
  available:()=>false,assertStart:async()=>{},approve:async()=>{},findRun:async()=>null});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bridge-storage-concurrency-'));
  const children = [];
  const resources = [];
  t.after(async () => {
    for (const close of resources.reverse()) await close();
    for (const {child,closed} of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
    await removeOwnedFixture(root);
  });
  const start = (script,args=[]) => {
    const child = spawn(process.execPath,[...args,'--input-type=module','-e',script],
      {stdio:['ignore','ignore','pipe','ipc']});
    let stderr = '';
    child.stderr.on('data',chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once('close',(code,signal) => resolve({code,signal})));
    const messages = [];
    child.on('message',message => messages.push(message));
    children.push({child,closed});
    return {child,closed, async wait(type) {
      const deadline = Date.now()+8000;
      while (!messages.some(message => message.type === type)) {
        if (Date.now() >= deadline || child.exitCode !== null) throw Error('Missing '+type+': '+stderr);
        await new Promise(resolve => setTimeout(resolve,10));
      }
      return messages.find(message => message.type === type);
    }};
  };
  return {root,start,own:close=>resources.push(close)};
}

test('worker persistence retains same-id ownership before commit and drains accepted writes on close',async t => {
  const {root,own} = fixture(t), options = serviceOptions(root);
  const service = await PreparationService.open(options);
  own(()=>service.close());
  let dispatched = 0;
  service.dispatch = async () => { dispatched++; return {ok:true}; };
  const locker = new DatabaseSync(options.filename);
  locker.exec('BEGIN EXCLUSIVE');
  let locked = true;
  own(()=>{if(locked)locker.exec('ROLLBACK');locker.close();});
  const result = service.execute('test.command',{requestId:'same-id'});
  void result.catch(()=>{});
  await assert.rejects(service.execute('test.command',{requestId:'same-id'}),{code:'UNKNOWN_RESULT'});
  await assert.rejects(service.execute('different.command',{requestId:'same-id'}),{code:'REQUEST_ID_CONFLICT'});
  assert.equal(service.receipt('same-id').status,'NOT_FOUND');
  assert.equal(dispatched,0);
  locker.exec('ROLLBACK');locked=false;
  assert.deepEqual(await result,{ok:true});
  assert.equal(dispatched,1);
  service.data.projectConversations.accepted = {conversationId:'durable'};
  const saved=service.save(), closed=service.close();
  await Promise.all([saved,closed]);
  const reopened=await PreparationService.open(options);
  try {
    assert.equal(reopened.data.projectConversations.accepted.conversationId,'durable');
    assert.equal(reopened.receipt('same-id').status,'COMPLETED');
    assert.deepEqual(await reopened.execute('test.command',{requestId:'same-id'}),{ok:true});
  } finally { await reopened.close(); }
});

test('private fsync does not block another process and stale candidates remerge every section',{timeout:15000},async t => {
  const {root,start} = fixture(t);
  await enqueueAgentReport(root,'server',{source:'baseline'});
  const writer = start(`
    import io from 'node:fs/promises';
    import {enqueueAgentReport} from ${JSON.stringify(reportModule)};
    const open=io.open.bind(io);let held=false;
    io.open=async(...args)=>{const fd=await open(...args);
      if(String(args[0]).endsWith('.tmp')&&!held){held=true;const sync=fd.sync.bind(fd);
        fd.sync=async()=>{process.send({type:'held'});await new Promise(resolve=>process.once('message',resolve));await sync();};}
      return fd;};
    await enqueueAgentReport(${JSON.stringify(root)},'repair',{code:'slow-writer'});
    process.disconnect();
  `);
  await writer.wait('held');
  // This must finish before releasing the slow writer, within the existing lock budget.
  await enqueueAgentReport(root,'extension',{status:'independent-writer'});
  assert.equal(readAgentReport(root).repair,null);
  writer.child.send('release');
  assert.deepEqual(await writer.closed,{code:0,signal:null});
  const report = readAgentReport(root);
  assert.equal(report.server.source,'baseline');
  assert.equal(report.repair.code,'slow-writer');
  assert.equal(report.extension.status,'independent-writer');
  assert.deepEqual(fs.readdirSync(root),['runtime-latest.json']);
});

test('shutdown during a pending initial receipt cannot dispatch the command',async t => {
  const {root,own} = fixture(t), options=serviceOptions(root);
  const service=await PreparationService.open(options);own(()=>service.close());
  const locker=new DatabaseSync(options.filename);locker.exec('BEGIN EXCLUSIVE');
  let locked=true;own(()=>{if(locked)locker.exec('ROLLBACK');locker.close();});
  let dispatched=0;service.dispatch=async()=>{dispatched++;return {ok:true};};
  const pending=service.execute('test.command',{requestId:'closing'});
  const rejected=assert.rejects(pending,{code:'PREPARATION_CONFLICT'});
  const closed=service.close();
  locker.exec('ROLLBACK');locked=false;
  await Promise.all([rejected,closed]);
  assert.equal(dispatched,0);
});

test('worker native close failure stays a failure and still waits for worker exit',async t => {
  const {root,start}=fixture(t);
  const preload=path.join(root,'close-fault.mjs');
  fs.writeFileSync(preload,`
    import {DatabaseSync} from 'node:sqlite';import {isMainThread} from 'node:worker_threads';
    if(!isMainThread){const close=DatabaseSync.prototype.close;
      DatabaseSync.prototype.close=function(){close.call(this);throw Object.assign(Error('close reporting failure'),{code:'TEST_CLOSE_FAILED'});};}
  `);
  const module=new URL('../src/orchestration/preparation-service.js',import.meta.url).href;
  const child=start(`
    import assert from 'node:assert/strict';import {PreparationService} from ${JSON.stringify(module)};
    const service=await PreparationService.open({filename:${JSON.stringify(path.join(root,'preparations.sqlite'))},web:null});
    await assert.rejects(service.close(),{code:'TEST_CLOSE_FAILED'});process.disconnect();
  `,['--import',pathToFileURL(preload).href]);
  assert.deepEqual(await child.closed,{code:0,signal:null});
});

for (const shutdown of [false,true]) test('blocked preparation native initialization keeps HTTP responsive; shutdown='+shutdown,
  {timeout:15000},async t => {
    const {root,start} = fixture(t);
    const held = path.join(root,'held'), release = path.join(root,'release');
    const preload = path.join(root,'hold-preparation.mjs');
    fs.writeFileSync(preload,`
      import fs from 'node:fs';
      const mkdir=fs.mkdirSync;
      fs.mkdirSync=function(...args){
        if(/preparation-(?:service|storage-worker)\\.js/.test(new Error().stack)){
          fs.writeFileSync(${JSON.stringify(held)},'held');
          const deadline=Date.now()+8000;
          while(!fs.existsSync(${JSON.stringify(release)})){
            if(Date.now()>deadline)throw Error('Preparation test gate timed out');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
          }
        }
        return mkdir.apply(this,args);
      };
    `);
    const token = 'storage-concurrency-dashboard-token-0123456789';
    const server = start(`
      import {createBridgeServer} from ${JSON.stringify(serverModule)};
      import {loadConfig} from ${JSON.stringify(configModule)};
      const config={...loadConfig({env:{CONTROLLER_DATA_DIR:${JSON.stringify(root)},DASHBOARD_TOKEN:${JSON.stringify(token)}}}),port:0};
      const bridge=createBridgeServer({runtimeConfig:config,createLiveRuntime:async()=>({store:{listRuns:()=>[]},composition:{},codeChanges:{list:()=>[]},close:async()=>{}})});
      process.on('message',async()=>{await bridge.close();process.send({type:'closed'});process.disconnect();});
      process.send({type:'listening',port:(await bridge.listen()).port});
    `,['--import',pathToFileURL(preload).href]);
    const {port} = await server.wait('listening');
    const base = 'http://127.0.0.1:'+port;
    const states = Array.from({length:2},()=>fetch(base+'/api/state',
      {headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)}).then(async response=>({status:response.status,body:await response.json()})));
    void Promise.allSettled(states);
    const deadline = Date.now()+6000;
    while(!fs.existsSync(held)) {
      if(Date.now()>deadline)throw Error('Preparation did not reach native initialization');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    for(const route of ['/api/health','/api/preflight']) {
      const response = await fetch(base+route,{signal:AbortSignal.timeout(500)});
      assert.equal(response.status,200);await response.json();
    }
    if(shutdown) server.child.send('close');
    fs.writeFileSync(release,'release');
    const responses=await Promise.all(states);
    if(!shutdown) {
      assert.ok(responses.every(response=>response.status===200));
      server.child.send('close');
    }
    await server.wait('closed');
    assert.deepEqual(await server.closed,{code:0,signal:null});
    // Successful shutdown includes the storage worker exit, so the directory is removable.
  });
