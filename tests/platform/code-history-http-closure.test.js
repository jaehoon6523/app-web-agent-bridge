import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {loadConfig} from '../../src/config.js';
import {SqliteStore} from '../../src/persistence/sqlite-store.js';
import {observeChildClose,waitChildClose} from '../../src/runtime/child-close.js';
import {seedHistory} from '../helpers/code-history-fixture.js';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const cases=[
  {id:1,label:'integrity failure with normal resource closure',corrupt:true,exit:0},
  {id:2,label:'nonzero Worker exit retains failed closure',worker:'process.exit(7)',exit:1},
  {id:3,label:'Worker error retains failed closure',worker:'throw new Error("controlled Worker failure")',exit:1},
  {id:4,label:'resultless normal Worker exit remains an operation failure',worker:'',exit:0},
  {id:5,label:'native Worker database close followed by reporting failure',closeFault:true,exit:1},
  {id:6,label:'noncooperative Worker is forced during pending initialization',worker:'setInterval(()=>{},1000)',pending:true,exit:1},
];
for(const config of cases){
  test(`HTTP closure ${config.id}: ${config.label}`,{timeout:20000},async t=>{
    // Repository ancestor resolves installed dependencies on both platforms;
    // no POSIX symlinks, shell processes or Windows symlink privileges needed.
    const root=fs.mkdtempSync(path.join(repository,'.history-http-closure-'));
    let stop;
    try{
      const program=path.join(root,'program');fs.mkdirSync(program);
      fs.cpSync(path.join(repository,'src'),path.join(program,'src'),{recursive:true});
      fs.cpSync(path.join(repository,'scripts'),path.join(program,'scripts'),{recursive:true});
      fs.writeFileSync(path.join(program,'package.json'),'{"type":"module"}');
      if(config.worker!==undefined)fs.writeFileSync(path.join(program,'src/persistence/code-change-history-worker.js'),config.worker);
      if(config.closeFault)fs.writeFileSync(path.join(program,'src/persistence/sqlite-database.js'),`
        import {DatabaseSync as Native} from 'node:sqlite';
        import {isMainThread} from 'node:worker_threads';
        export class DatabaseSync extends Native {
          close(){super.close();if(!isMainThread)throw Object.assign(new Error('controlled close reporting failure'),{code:'CLOSE_REPORT_FAILED'});}
        }
      `);
      const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
      const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
      const token='closure-contract-token-0123456789abcdef';
      const runtimeConfig=loadConfig({cwd:root,env:{WORKSPACE:root,CONTROLLER_DATA_DIR:root,PORT:String(port),DASHBOARD_TOKEN:token,
        WEB_EXTENSION_SHARED_SECRET:'closure-extension-secret-0123456789abcdef',WEB_EXTENSION_EXPECTED_IDENTITY:'closure-extension'}});
      new SqliteStore(runtimeConfig.persistence.databasePath).close();
      seedHistory(runtimeConfig.persistence.databasePath,{versions:8});
      if(config.corrupt){const db=new DatabaseSync(runtimeConfig.persistence.databasePath);
        try{db.exec("UPDATE code_change_history SET record_json='{broken' WHERE version=1");}finally{db.close();}}
      const events=[],changed=new EventEmitter();
      const {runDiagnosticServer}=await import(pathToFileURL(path.join(program,'scripts/diagnose-server.mjs')));
      const child=runDiagnosticServer({runtimeConfig,outputFile:path.join(root,'events.jsonl'),onEvent:event=>{events.push(event);changed.emit('event',event);}});
      const observation=observeChildClose(child);let stopped;
      stop=()=>stopped??=waitChildClose(child,observation,{timeoutMs:8000,request:()=>{if(child.connected)child.send({type:'bridge.shutdown'});}});
      async function until(type){
        if(events.some(event=>event.type===type))return;
        let listener,timer;
        try{await new Promise((resolve,reject)=>{
          listener=event=>{if(event.type===type)resolve();};changed.on('event',listener);
          timer=setTimeout(()=>reject(new Error('Missing checkpoint '+type)),10000);
        });}finally{changed.off('event',listener);clearTimeout(timer);}
      }
      await until('server.listening');
      const pending=fetch(runtimeConfig.baseUrl+'/api/state',{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(6000)});
      pending.catch(()=>{});
      await until('persistence.code-store.history-background.started');
      if(!config.pending){const response=await pending;assert.equal(response.status,200);
        const state=await response.json();assert.equal(state.runtimeAvailability.ready,false);
        assert.equal(state.dataKnowledge.runs.status,'UNAVAILABLE');}
      for(const route of ['/api/health','/api/preflight']){
        const response=await fetch(runtimeConfig.baseUrl+route,{signal:AbortSignal.timeout(1500)});
        await response.arrayBuffer();assert.equal(response.status,200);
      }
      const closure=await stop();await pending.catch(()=>{});
      const errors=events.filter(event=>event.type==='shutdown.stage.error');
      t.diagnostic(JSON.stringify({case:config.id,platform:process.platform,node:process.version,closure,errors,
        completed:events.some(event=>event.type==='persistence.code-store.history-background.completed'),
        deadline:events.some(event=>event.type==='shutdown.deadline')}));
      assert.deepEqual(closure,{code:config.exit,signal:null});
      assert.equal(events.some(event=>event.type==='shutdown.deadline'),false);
      assert.equal(events.some(event=>event.type==='persistence.code-store.history-background.completed'),false);
      assert.equal(errors.length,config.exit===1?1:0);
      if(config.exit===1)assert.equal(errors[0].errorCode,'LIVE_RUNTIME_CLEANUP_FAILED');
      assert.ok(events.some(event=>event.type==='shutdown.ipc.start'));
      assert.ok(events.some(event=>event.type==='shutdown.stage.done' && event.stage==='HTTP server close'));
      fs.unlinkSync(runtimeConfig.persistence.databasePath);
    }finally{
      try{if(stop)await stop();}finally{fs.rmSync(root,{recursive:true,force:true});}
    }
  });
}
