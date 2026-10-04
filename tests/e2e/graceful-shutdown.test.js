import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { CodexProcessManager } from '../../src/runtime/codex/process-manager.js';
import { productionProcess, repository } from '../../scripts/e2e/helpers/process.mjs';
import { readHttpHeaders } from '../helpers/socket-headers.mjs';

test('production IPC stop drains HTTP resources and exits naturally without a kill', {timeout:15000}, async t => {
  const server=await productionProcess();
  t.after(()=>server.dispose());
  await server.ready();
  const result=await server.stop();
  assert.deepEqual(result,{code:0,signal:null,forced:false});
  assert.deepEqual(await server.stop(),result);
});

test('Codex manager close waits for delayed persistent child EOF cleanup', {timeout:10000}, async t => {
  let child, closed=false;
  const source=`const readline=require('node:readline');
    const rl=readline.createInterface({input:process.stdin});
    rl.on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'cleanup-peer'}})+'\\n');});
    rl.on('close',()=>setTimeout(()=>{},250));`;
  const manager=await CodexProcessManager.create({executablePath:process.execPath,workspaceRoot:repository,
    appServerArgs:['-e',source],sourceEnv:process.env,initializeTimeoutMs:3000,
    spawn:(command,args,options)=>{child=spawn(command,args,options);child.once('close',()=>{closed=true;});return child;}});
  t.after(()=>manager.close());
  await manager.start();
  const started=Date.now();
  await Promise.all([manager.close(),manager.close()]);
  assert.equal(closed,true,'close must wait for child and stdio closure');
  assert.equal(child.exitCode,0);
  assert.equal(child.signalCode,null);
  assert.ok(Date.now()-started>=200,'persistent peer must receive time to finish EOF cleanup');
  await manager.close();
});

for (const mode of ['nonzero', 'stuck']) {
  test(`Codex ${mode} EOF cleanup reports failure while status becomes STOPPED`, {timeout:10000}, async () => {
    let child;
    const source=`const rl=require('node:readline').createInterface({input:process.stdin});
      rl.on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'cleanup-peer'}})+'\\n');});
      rl.on('close',()=>{${mode === 'stuck' ? 'setInterval(()=>{},1000);' : 'process.exitCode=7;'}});`;
    const manager=await CodexProcessManager.create({executablePath:process.execPath,workspaceRoot:repository,
      appServerArgs:['-e',source],sourceEnv:process.env,initializeTimeoutMs:3000,
      spawn:(command,args,options)=>(child=spawn(command,args,options))});
    try {
      await manager.start();
      await assert.rejects(manager.close(), mode === 'stuck' ? /did not exit after stdin EOF/u : /did not exit cleanly/u);
      assert.equal(manager.status,'STOPPED');
      assert.equal(manager.processId,null);
      assert.ok(child.exitCode!==null || child.signalCode!==null);
      await assert.rejects(manager.close());
      assert.equal(manager.status,'STOPPED');
    } finally { if(child && child.exitCode===null && child.signalCode===null)child.kill('SIGKILL'); }
  });
}

for (const mode of ['pending','reject']) {
test(`production shutdown failsafe exits nonzero after ${mode} with an HTTP handle remaining`, {timeout:12000}, async t => {
  const {mkdtempSync,rmSync}=await import('node:fs');
  const os=await import('node:os');
  const path=await import('node:path');
  const net=await import('node:net');
  const {once}=await import('node:events');
  const root=mkdtempSync(path.join(os.tmpdir(),'bridge-shutdown-failsafe-'));
  const probe=net.createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  const source=`import {main} from ${JSON.stringify(new URL('../../src/server.js',import.meta.url).href)};
    const bridge=await main(); bridge.server.close=(callback)=>{${mode === 'reject' ? "callback(new Error('controlled close rejection')); return bridge.server;" : 'return bridge.server;'}}; process.send({ready:true});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{cwd:root,
    env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,HOST:'127.0.0.1',PORT:String(port),WORKSPACE:root,DEMO_MODE:'false'},stdio:['ignore','pipe','pipe','ipc']});
  let errors='';child.stdout.resume();child.stderr.on('data',chunk=>{errors+=chunk;});
  const closed=once(child,'close');
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');await closed;rmSync(root,{recursive:true,force:true});});
  await Promise.race([once(child,'message'),closed.then(()=>{throw new Error(`server exited before readiness: ${errors}`);})]);
  child.send({type:'bridge.shutdown'});
  assert.deepEqual(await closed,[1,null]);
  assert.match(errors,/Graceful shutdown deadline exceeded/u);
});

}

// NetworkLifecycle contract; retained here to avoid an unrelated directory move.
test('NetworkLifecycle / TCP half-close: production shutdown is bounded for a closing extension peer', {timeout:15000}, async t => {
  const net=await import('node:net');
  const {once}=await import('node:events');
  const server=await productionProcess({configured:true});
  let socket;
  t.after(async()=>{socket?.destroy();await server.dispose();});
  await server.ready();
  const url=new URL(server.baseUrl);
  socket=net.createConnection({host:url.hostname,port:Number(url.port),allowHalfOpen:true});
  socket.on('error',()=>{});
  await once(socket,'connect');
  const upgraded=readHttpHeaders(socket);
  socket.write(`GET /ws/extension HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const headers=await upgraded;
  assert.match(headers.toString('latin1'),/^HTTP\/1\.1 101(?: [^\r\n]*)?\r\n/u);
  // A masked empty close frame. Keep the writable half open after server FIN,
  // reproducing a peer that has begun closing but never finishes TCP teardown.
  const ended=once(socket,'end');
  socket.write(Buffer.from([0x88,0x80,0,0,0,0]));
  await ended;
  assert.equal(socket.writableEnded,false,'the peer must leave its writable TCP half open');
  assert.equal(socket.destroyed,false,'the half-open peer must remain present until shutdown');
  const result=await server.stop();
  // forced describes harness containment, not the production WebSocket close policy.
  assert.deepEqual(result,{code:0,signal:null,forced:false},JSON.stringify(server.logs()));
});
