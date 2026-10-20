import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {observeChildClose,waitChildClose} from '../../src/runtime/child-close.js';
import {inheritedPipeScript,waitForPipeHolder,assertPipeHolderAlive,stopPipeHolder,removeOwnedPipeFixture} from '../helpers/inherited-pipes-fixture.js';

test('inherited-pipe fixture proves parent exit with a live descendant and open stdio', {timeout:25000}, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-pipe-precondition-'));
  const pidFile=path.join(root,'pid'), markerFile=path.join(root,'heartbeat');
  const child=spawn(process.execPath,['-e',inheritedPipeScript({pidFile,markerFile})],
    {windowsHide:true,stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');
  const observation=observeChildClose(child);
  child.stdout.resume(); child.stderr.resume();
  try {
    await waitForPipeHolder({pidFile,markerFile});
    let timer;
    try {await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture parent did not exit')),3000);})]);}
    finally {clearTimeout(timer);}
    assert.equal(child.exitCode,0);
    const heartbeat=await assertPipeHolderAlive(markerFile);
    assert.equal(observation.result,undefined);
    assert.equal(child.stdout.closed,false); assert.equal(child.stderr.closed,false);
    await assert.rejects(waitChildClose(child,observation,{timeoutMs:200}),{code:'CHILD_CLOSE_DEADLINE'});
    assert.equal(observation.result,undefined);
    t.diagnostic(JSON.stringify({node:process.version,platform:process.platform,parentExitCode:child.exitCode,
      heartbeat,stdoutClosed:child.stdout.closed,stderrClosed:child.stderr.closed}));
  } finally {
    if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
    await stopPipeHolder(pidFile);
    await waitChildClose(child,observation,{timeoutMs:5000});
    child.stdout.destroy(); child.stderr.destroy();
    await removeOwnedPipeFixture(root);
  }
});

test('startup failure cancels a descendant before its PID is published', {timeout:20000}, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-pipe-registration-'));
  const pidFile=path.join(root,'pid'), markerFile=path.join(root,'heartbeat');
  const witness=path.join(root,'started'), release=path.join(root,'release');
  // Hold the real descendant before registration, independently of scheduler speed.
  const barrier=`const gateFs=require('node:fs');
    gateFs.writeFileSync(${JSON.stringify(witness)},String(process.pid));
    while(!gateFs.existsSync(${JSON.stringify(release)}))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`;
  const injection=`const cp=require('node:child_process'), originalSpawn=cp.spawn;
    cp.spawn=(exe,args,options)=>originalSpawn(exe,[args[0],${JSON.stringify(barrier)}+args[1],...args.slice(2)],options);
    const parentFs=require('node:fs'), originalWrite=parentFs.writeFileSync;
    parentFs.writeFileSync=(file,...args)=>{
      if(file!==${JSON.stringify(pidFile)}) return originalWrite(file,...args);
    };`;
  const child=spawn(process.execPath,['-e',injection+inheritedPipeScript({pidFile,markerFile,stdinProtocol:true})],
    {windowsHide:true,stdio:['pipe','pipe','pipe']});
  const observation=observeChildClose(child);
  child.stdout.resume(); child.stderr.resume();
  try {
    const deadline=performance.now()+3000;
    while(!fs.existsSync(witness)) {
      assert.ok(performance.now()<deadline,'the real descendant must reach the registration barrier');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await assert.rejects(waitForPipeHolder({pidFile,markerFile}),
      /owned descendant must perform real work before the closure oracle/u);
    assert.equal(fs.existsSync(pidFile),false);
    child.kill('SIGKILL');
    await stopPipeHolder(pidFile);
    fs.writeFileSync(release,'release');
    await waitChildClose(child,observation,{timeoutMs:3000});
    assert.equal(fs.existsSync(markerFile),false,'a cancelled late descendant must never start work');
  } finally {
    // Independent recovery protects the test host if the implementation regresses.
    child.kill('SIGKILL');
    fs.writeFileSync(release,'release');
    if(fs.existsSync(witness)) {
      const rescue=path.join(root,'rescue.pid');
      fs.writeFileSync(rescue,fs.readFileSync(witness));
      await stopPipeHolder(rescue);
    }
    await waitChildClose(child,observation,{timeoutMs:5000});
    await removeOwnedPipeFixture(root);
  }
});
