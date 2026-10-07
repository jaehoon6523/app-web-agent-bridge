import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {observeChildClose,waitChildClose} from '../../src/runtime/child-close.js';
import {inheritedPipeScript,waitForPipeHolder,assertPipeHolderAlive,stopPipeHolder} from '../helpers/inherited-pipes-fixture.js';

test('inherited-pipe fixture proves parent exit with a live descendant and open stdio', {timeout:10000}, async t => {
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
    try {await waitChildClose(child,observation,{timeoutMs:3000});}
    finally {child.stdout.destroy(); child.stderr.destroy(); fs.rmSync(root,{recursive:true,force:true});}
  }
});
