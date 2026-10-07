import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';

export function inheritedPipeScript({pidFile, markerFile, stdinProtocol = false}) {
  const descendant = `const fs=require('node:fs');
    fs.appendFileSync(process.argv[1],'x');
    setInterval(()=>fs.appendFileSync(process.argv[1],'x'),50);
    process.send('ready',()=>process.disconnect());`;
  // Windows libuv kills non-detached children when their spawning parent exits.
  // Only this owned fixture descendant is detached; production policy is untouched.
  return `const fs=require('node:fs');
    const d=require('node:child_process').spawn(process.execPath,
      ['-e',${JSON.stringify(descendant)},${JSON.stringify(markerFile)}],
      {detached:true,windowsHide:true,stdio:['ignore',1,2,'ipc']});
    fs.writeFileSync(${JSON.stringify(pidFile)},String(d.pid));
    d.once('message',()=>d.unref());
    ${stdinProtocol ? `const rl=require('node:readline').createInterface({input:process.stdin});
    rl.on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'pipe-contract'}})+'\\n');});` : ''}`;
}

export async function waitForPipeHolder({pidFile,markerFile}) {
  const deadline=performance.now()+3000;
  while (!fs.existsSync(markerFile) || fs.statSync(markerFile).size < 2) {
    assert.ok(performance.now()<deadline,'owned descendant must perform real work before the closure oracle');
    await wait(10);
  }
  const pid=Number(fs.readFileSync(pidFile,'utf8'));
  assert.ok(Number.isInteger(pid) && pid>0,'fixture must identify its exact owned descendant');
  return pid;
}

export async function assertPipeHolderAlive(markerFile) {
  const before=fs.statSync(markerFile).size;
  await wait(150);
  const after=fs.statSync(markerFile).size;
  assert.ok(after>before,'the descendant must survive parent exit, not merely have a stale PID');
  return {before,after};
}

function processHasExited(pid) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  if (process.platform === 'linux') {
    try {
      // Orphan zombies have exited but may await reaping by the container init.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return ['Z','X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
    } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
  return false;
}

export async function stopPipeHolder(pidFile, {timeoutMs = 3000} = {}) {
  if (!fs.existsSync(pidFile)) return;
  const pid=Number(fs.readFileSync(pidFile,'utf8'));
  assert.ok(Number.isInteger(pid) && pid>0);
  try {process.kill(pid,'SIGKILL');} catch (error) {if (error.code!=='ESRCH') throw error;}
  const deadline = performance.now() + timeoutMs;
  while (!processHasExited(pid)) {
    assert.ok(performance.now() < deadline, `Owned pipe holder ${pid} termination was not confirmed`);
    await wait(20);
  }
  // Preserve ownership evidence on failure; remove it only after observed exit.
  fs.unlinkSync(pidFile);
}
