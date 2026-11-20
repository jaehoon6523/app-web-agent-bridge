import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { observeChildClose } from '../../../src/runtime/child-close.js';

// Opt-in containment for the Native comparator, whose trials and Chromium can
// start new process groups. Keep launch ancestry plus process birth identity;
// a process-group kill alone cannot reach those detached descendants.
function trackLinuxDescendants(rootPid) {
  const namespace=fs.readlinkSync('/proc/self/ns/pid'),owned=new Map();
  const live=item=>{
    try {
      const stat=fs.readFileSync(item.file,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
      return fields[0]!=='Z' && fields[19]===item.birth;
    } catch(error) {if(['ENOENT','ESRCH'].includes(error.code))return false;throw error;}
  };
  const refresh=()=>{
    const rows=[];
    for(const name of fs.readdirSync('/proc')) {
      if(!/^\d+$/u.test(name))continue;
      try {
        if(fs.readlinkSync(`/proc/${name}/ns/pid`)!==namespace)continue;
        const file=`/proc/${name}/stat`,stat=fs.readFileSync(file,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
        const status=fs.readFileSync(`/proc/${name}/status`,'utf8');
        const pid=Number(status.match(/^NSpid:\s+(.+)$/mu)?.[1].trim().split(/\s+/u).at(-1));
        if(Number.isInteger(pid) && pid>0 && fields[0]!=='Z')rows.push({pid,visiblePid:Number(name),parent:Number(fields[1]),birth:fields[19],file});
      } catch(error) {
        const wasOwned=[...owned.values()].some(item=>item.visiblePid===Number(name));
        if(!['ENOENT','ESRCH'].includes(error.code)
          && !( !wasOwned && ['EACCES','EPERM'].includes(error.code)))throw error;
      }
    }
    let added;
    do {
      added=false;
      const parents=new Set(rows.filter(row=>owned.get(row.pid)?.birth===row.birth).map(row=>row.visiblePid));
      for(const row of rows) if(!owned.has(row.pid) && (row.pid===rootPid || parents.has(row.parent))) {
        owned.set(row.pid,row);added=true;
      }
    } while(added);
  };
  let trackingError;
  const sample=()=>{try {refresh();}catch(error){trackingError=error;}};
  sample();const timer=setInterval(sample,100);timer.unref();
  return {
    stop:()=>clearInterval(timer),
    async terminate() {
      clearInterval(timer);
      // Freeze known owners before the final ancestry scan so they cannot fork
      // between discovery and kill. Repeat for newly found detached groups.
      const stopped=new Set(),until=Date.now()+2000;
      try {
        if(!owned.has(rootPid))throw trackingError ?? Error('Native control launch identity was not observed');
        do {
          refresh();
          const pending=[...owned.values()].filter(item=>!stopped.has(item.pid) && live(item));
          if(!pending.length)break;
          for(const item of pending) {try {process.kill(item.pid,'SIGSTOP');stopped.add(item.pid);}catch(error){if(error.code!=='ESRCH')throw error;}}
          if(Date.now()>until)throw Error('Native descendant ancestry did not stabilize');
        } while(true);
      } finally {
        // Even a failed scan must release every already frozen owner.
        for(const item of owned.values()) if(live(item)) {try {process.kill(item.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')trackingError=error;}}
      }
      const deadline=Date.now()+2000;
      while([...owned.values()].some(live) && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
      const survivorPids=[...owned.values()].filter(live).map(item=>item.pid);
      if(trackingError || survivorPids.length)throw Error(`Native descendant termination unconfirmed: ${trackingError?.message ?? survivorPids.join(',')}`);
      return {terminationConfirmed:true,pids:[...owned.keys()],survivorPids};
    },
  };
}

// Failure containment only. Callers must retain FAIL after forced cleanup.
export async function forceProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide:true, timeout:5000 });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export function ownedSpawn(args, { cwd, env = process.env, ipc = false, extraStdio = [] } = {}) {
  return spawn(process.execPath, args, { cwd, env, windowsHide:true,
    // One process group per owner permits bounded descendant cleanup on POSIX.
    detached:process.platform !== 'win32',
    stdio:['ignore','pipe','pipe', ...(ipc ? ['ipc'] : []), ...extraStdio] });
}

export async function runOwnedNode(args, { cwd, env, timeoutMs, isComplete = () => false,
  drainMs = 10000, signal, onStdout = () => {}, onStderr = () => {}, onDeadline = () => {}, containDescendants=false } = {}) {
  const child = ownedSpawn(args, { cwd, env });
  const observation = observeChildClose(child);
  let descendants,timer,drainTimer,abort;
  const deadline = new Promise((_, reject) => {
    const expire = reason => {
      try { onDeadline({ reason, pid:child.pid, activeResources:process.getActiveResourcesInfo() }); } catch {}
      reject(Object.assign(new Error(`E2E runner resource closure failed: ${reason}`), { code:'E2E_RUNNER_DEADLINE' }));
    };
    timer = setTimeout(() => expire('execution deadline'), timeoutMs);
    abort = () => reject(Object.assign(new Error('Verification cancelled'), {code:'VERIFICATION_CANCELLED'}));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data', chunk => {
      onStdout(chunk);
      if (!drainTimer && isComplete()) drainTimer = setTimeout(() => expire('profiles completed but runner did not close'), drainMs);
    });
    child.stderr.on('data', onStderr);
    child.once('error', reject);
  });
  try {
    descendants=containDescendants && process.platform==='linux'?trackLinuxDescendants(child.pid):null;
    const result = await Promise.race([observation.promise, deadline]);
    return { ...result, forced:false };
  } catch (error) {
    try {
      if(descendants)error.descendantCleanup=await descendants.terminate();
      else await forceProcessTree(child);
      if(containDescendants) {
        let closeTimer;
        try {
          const closed=await Promise.race([observation.promise,new Promise(resolve=>{closeTimer=setTimeout(()=>resolve(null),1000);})]);
          if(!closed)throw Error('Native control child close not observed after termination');
          error.closure=closed;
        } finally {clearTimeout(closeTimer);}
      }
    } catch (cleanupError) {
      error.cleanupError = cleanupError.message;
      try { child.kill('SIGKILL'); } catch {}
    }
    // Inherited pipes can outlive an exited parent, even after a failed tree kill.
    child.stdout.destroy(); child.stderr.destroy();
    child.unref();
    throw error;
  } finally { descendants?.stop();clearTimeout(timer); clearTimeout(drainTimer); signal?.removeEventListener('abort',abort); }
}
