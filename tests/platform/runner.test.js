import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { runOwnedNode } from '../../scripts/e2e/platform/process.mjs';
import { observeChildClose, waitChildClose } from '../../src/runtime/child-close.js';
import { CodexProcessManager } from '../../src/runtime/codex/process-manager.js';

test('normal and abnormal child closure are observed without imposing a POSIX signal oracle', async () => {
  assert.deepEqual(await runOwnedNode(['-e','process.exitCode=0'],{timeoutMs:5000}),{code:0,signal:null,forced:false});
  assert.deepEqual(await runOwnedNode(['-e','process.exitCode=7'],{timeoutMs:5000}),{code:7,signal:null,forced:false});
});

test('IPC disconnect is a cooperative closure contract on either OS', {timeout:10000}, async () => {
  const child = spawn(process.execPath, ['-e',"process.on('disconnect',()=>{process.exitCode=0;});process.send('ready');"],
    {stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  child.stdout.resume(); child.stderr.resume();
  const observation = observeChildClose(child);
  try {
    await Promise.race([once(child,'message'),observation.promise.then(()=>{throw new Error('child closed before ready');})]);
    assert.deepEqual(await waitChildClose(child,observation,{timeoutMs:5000,request:()=>child.disconnect()}),{code:0,signal:null});
  } finally {if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');}
});

test('a completed profile with a stuck descendant fails boundedly and cleans its owned tree', {timeout:15000}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-platform-tree-'));
  const pidFile = path.join(root,'pid');
  const marker = path.join(root,'still-running');
  const descendant = "const fs=require('node:fs');fs.appendFileSync(process.argv[1],'x');process.send('ready');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20);";
  const source = `const d=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[2]],{stdio:['ignore','ignore','ignore','ipc']});
    require('node:fs').writeFileSync(process.argv[1],String(d.pid));d.once('message',()=>process.stdout.write('PROFILE DONE\\n'));setInterval(()=>{},1000);`;
  let pid, completed = false, diagnostic;
  const started = Date.now();
  try {
    await assert.rejects(runOwnedNode(['-e',source,pidFile,marker],{timeoutMs:7000,drainMs:250,
      onStdout:chunk => {if(String(chunk).includes('PROFILE DONE'))completed=true;},isComplete:()=>completed,
      onDeadline:event => {diagnostic=event;}}),error=>error.code==='E2E_RUNNER_DEADLINE' && !error.cleanupError);
    pid = Number(fs.readFileSync(pidFile,'utf8'));
    assert.equal(diagnostic.reason,'profiles completed but runner did not close');
    assert.ok(Date.now()-started<7000);
    // POSIX may briefly retain a reaped child's zombie entry. A live descendant
    // is detected with its own marker below rather than relying on kill(0).
    const countBefore = fs.readFileSync(marker,'utf8').length;
    assert.ok(countBefore>1,'the descendant performed real work before forced cleanup');
    await wait(100);
    assert.equal(fs.readFileSync(marker,'utf8').length,countBefore);
  } finally {
    // Diagnostic cleanup remains a failure safeguard, never the PASS oracle.
    if(!pid && fs.existsSync(pidFile))pid=Number(fs.readFileSync(pidFile,'utf8'));
    if(pid)try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('Codex EOF deadline still rejects when an exited parent leaves inherited stdio open', {timeout:12000}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-platform-pipes-'));
  const pidFile = path.join(root,'pid');
  const source = `const d=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
    require('node:fs').writeFileSync(process.argv[1],String(d.pid));
    const rl=require('node:readline').createInterface({input:process.stdin});
    rl.on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'pipe-contract'}})+'\\n');});
    rl.on('close',()=>d.unref());`;
  let child, pid;
  const manager = await CodexProcessManager.create({executablePath:process.execPath,workspaceRoot:root,
    appServerArgs:['-e',source,pidFile],sourceEnv:process.env,initializeTimeoutMs:5000,
    spawn:(command,args,options)=>(child=spawn(command,args,options))});
  try {
    await manager.start();
    pid=Number(fs.readFileSync(pidFile,'utf8'));
    const started=Date.now();
    await assert.rejects(manager.close(),/did not exit after stdin EOF/u);
    assert.ok(Date.now()-started<6500,'a parent exit must not disable the resource closure deadline');
    assert.equal(child.exitCode,0);
    assert.equal(manager.status,'STOPPED');
  } finally {
    if(pid)try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
    if(child && child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
    fs.rmSync(root,{recursive:true,force:true});
  }
});
