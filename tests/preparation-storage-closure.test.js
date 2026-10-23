import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const execute = promisify(execFile);
const storageModule = new URL('../src/orchestration/preparation-storage.js',import.meta.url).href;
const serverModule = new URL('../src/server.js',import.meta.url).href;
const configModule = new URL('../src/config.js',import.meta.url).href;

for (const mode of ['initialize','write','close','exit','write-error-exit']) {
  test('storage closure owns '+mode+' failure',{timeout:10000},async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'bridge-storage-closure-'));
    const preload = path.join(root,'inject.mjs');
    fs.writeFileSync(preload,`
      import fs from 'node:fs';
      import {isMainThread,parentPort} from 'node:worker_threads';
      const mode=${JSON.stringify(mode)};
      if(!isMainThread) {
        const hold=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
        if(mode==='initialize') fs.mkdirSync=hold;
        const on=parentPort.on.bind(parentPort);
        parentPort.on=(event,handler)=>on(event,event==='message'?message=>{
          if(message.type===mode) hold();
          if(mode==='write-error-exit' && message.type==='write') {
            parentPort.postMessage({id:message.id,error:{message:'write failed',code:'INJECTED_WRITE'}});return;
          }
          if(message.type==='close' && mode.endsWith('exit')) process.exitCode=7;
          return handler(message);
        }:handler);
      }
    `);
    try {
      const {stdout} = await execute(process.execPath,['--import',pathToFileURL(preload).href,'--input-type=module','-e',`
        import assert from 'node:assert/strict';
        import {openPreparationStorage} from ${JSON.stringify(storageModule)};
        const mode=${JSON.stringify(mode)};
        const leaves=e=>[e,...(e.errors??[]).flatMap(leaves)];
        let failure;
        try {
          const storage=await openPreparationStorage(${JSON.stringify(path.join(root,'state.sqlite'))},{timeoutMs:500,terminationMs:500});
          if(mode==='write' || mode==='write-error-exit') {
            const write=storage.persist(()=> '{}');
            void write.catch(()=>{});
          }
          await storage.close();
        } catch(error) { failure=error; }
        assert.ok(failure,'closure must fail');
        const errors=leaves(failure);
        if(mode.endsWith('exit')) {
          assert.ok(errors.some(e=>e.code==='PREPARATION_STORAGE_EXIT' && e.exitCode===7));
          if(mode==='write-error-exit') assert.ok(errors.some(e=>e.code==='INJECTED_WRITE'));
        } else {
          assert.ok(errors.some(e=>e.code==='PREPARATION_STORAGE_TIMEOUT'));
          assert.ok(errors.some(e=>e.code==='PREPARATION_STORAGE_FORCED_CLEANUP' && e.terminationConfirmed));
        }
        assert.equal(failure.resourceClosureFailed,true);
        console.log('CLOSURE_FAILURE_CONFIRMED');
      `],{timeout:8000});
      assert.match(stdout,/CLOSURE_FAILURE_CONFIRMED/);
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
  });
}

test('server shutdown reports initialization that never releases as a closure failure',{timeout:20000},async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-storage-server-close-'));
  const preload=path.join(root,'hold.mjs'), held=path.join(root,'held');
  fs.writeFileSync(preload,`
    import fs from 'node:fs';
    import {isMainThread,workerData} from 'node:worker_threads';
    if(!isMainThread && workerData?.filename?.endsWith('preparations.sqlite')) {
      fs.mkdirSync=()=>{
        fs.writeFileSync(${JSON.stringify(held)},'held');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
      };
    }
  `);
  try {
    const {stdout}=await execute(process.execPath,['--import',pathToFileURL(preload).href,'--input-type=module','-e',`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import {setTimeout as wait} from 'node:timers/promises';
      import {createBridgeServer} from ${JSON.stringify(serverModule)};
      import {loadConfig} from ${JSON.stringify(configModule)};
      const token='storage-shutdown-test-token-0123456789';
      const config={...loadConfig({env:{CONTROLLER_DATA_DIR:${JSON.stringify(root)},DASHBOARD_TOKEN:token}}),port:0};
      const bridge=createBridgeServer({runtimeConfig:config,createLiveRuntime:async()=>({store:{listRuns:()=>[]},composition:{},codeChanges:{list:()=>[]},close:async()=>{}})});
      const {port}=await bridge.listen();
      const response=fetch('http://127.0.0.1:'+port+'/api/state',{headers:{authorization:'Bearer '+token}}).then(r=>r.text());
      void response.catch(()=>{});
      const deadline=Date.now()+4000;
      while(!fs.existsSync(${JSON.stringify(held)})) {
        assert.ok(Date.now()<deadline,'initialization did not start');await wait(10);
      }
      const leaves=e=>[e,...(e.errors??[]).flatMap(leaves),...(e.cause?leaves(e.cause):[])];
      await assert.rejects(bridge.close(),error=>leaves(error).some(e=>e.code==='PREPARATION_STORAGE_FORCED_CLEANUP' && e.terminationConfirmed));
      await response.catch(()=>{});
      console.log('SERVER_CLOSURE_FAILURE_CONFIRMED');
    `],{timeout:17000});
    assert.match(stdout,/SERVER_CLOSURE_FAILURE_CONFIRMED/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
