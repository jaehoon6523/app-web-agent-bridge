import fs from 'node:fs';
import io from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { mergeDiagnosticIncident } from './diagnostic-schema.js';

const sections = new Set(['server','repair','deliveryReview','extension','startup','deliveryRecovery']);
const queues = new Map();
const abandonedRecoveryPreparations = new Set();
const limit = 262144;
const decode = text => { const value = JSON.parse(text); return value?.schemaVersion === 1 ? value : {}; };
// Synchronous compatibility reader for offline tools. The server uses the async reader.
export function readAgentReport(directory) {
  const filename = path.join(directory,'runtime-latest.json');
  try { return fs.statSync(filename).size > limit ? {} : decode(fs.readFileSync(filename,'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
}
export async function readAgentReportAsync(directory) {
  const filename = path.join(directory,'runtime-latest.json');
  try { return (await io.stat(filename)).size > limit ? {} : decode(await io.readFile(filename,'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
}
function emit(sink, type, detail = {}) {
  try { sink?.({type,at:new Date().toISOString(),monotonicMs:performance.timeOrigin+performance.now(),pid:process.pid,...detail}); }
  catch { /* An observation must not alter the write result. */ }
}
function ownerState(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return 'UNVERIFIED';
  try { process.kill(pid,0); return 'LIVE'; }
  catch (error) { return error.code === 'ESRCH' ? 'DEAD' : 'UNVERIFIED'; }
}
async function lockObservation(lock) {
  try {
    const stat = await io.lstat(lock);
    if (!stat.isFile() || stat.isSymbolicLink()) return {state:'INVALID',exists:true};
    let owner;
    try { owner = JSON.parse(await io.readFile(lock,'utf8')); }
    catch (error) { return {state:error.code === 'ENOENT' ? 'MISSING' : error.code ? 'UNREADABLE' : stat.size === 0 ? 'INITIALIZING' : 'MALFORMED',
      exists:error.code !== 'ENOENT',errorCode:error.code ?? 'INVALID_JSON',identity:stat.ino}; }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return {state:'UNVERIFIED',exists:true,identity:stat.ino};
    return {state:ownerState(owner.pid),exists:true,pid:owner.pid,token:owner.token ?? null,temporary:owner.temporary ?? null,identity:stat.ino};
  } catch (error) {
    if (error.code === 'ENOENT') return {state:'MISSING',exists:false};
    return {state:'UNREADABLE',exists:null,errorCode:error.code};
  }
}
function busy(cause, observation) {
  return Object.assign(new Error('Diagnostic writer busy.',{cause}),{code:'DIAGNOSTIC_WRITER_BUSY',lockState:observation});
}
const recoveryOwnerPattern = /^owner-([1-9][0-9]*)-([a-f0-9-]{36})$/u;
async function recoveryObservation(recovery) {
  try {
    const stat = await io.lstat(recovery);
    // Legacy ownerless files and links cannot establish a dead owner.
    if (!stat.isDirectory() || stat.isSymbolicLink()) return {state:'UNVERIFIED',exists:true,identity:stat.ino};
    const names = await io.readdir(recovery);
    if (names.length === 0) return {state:'EMPTY',exists:true,identity:stat.ino};
    const match = names.length === 1 && recoveryOwnerPattern.exec(names[0]);
    if (!match) return {state:'INVALID',exists:true,identity:stat.ino};
    const marker = path.join(recovery,names[0]), owner = await io.lstat(marker);
    if (!owner.isDirectory() || owner.isSymbolicLink() || (await io.readdir(marker)).length !== 0)
      return {state:'INVALID',exists:true,identity:stat.ino};
    const pid = Number(match[1]);
    return {state:ownerState(pid),exists:true,pid,token:match[2],marker:names[0],identity:stat.ino,markerIdentity:owner.ino};
  } catch (error) {
    if (error.code === 'ENOENT') return {state:'MISSING',exists:false};
    throw error;
  }
}
async function removeRecoveryDirectory(recovery, marker) {
  if (marker) {
    try { await io.rmdir(path.join(recovery,marker)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { await io.rmdir(recovery); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return true;
    // A replacement owner is published as a NONEMPTY directory. A late reaper
    // cannot remove its different marker or rmdir that active owner's guard.
    if (['ENOTEMPTY','EEXIST'].includes(error.code)) return false;
    throw error;
  }
}
async function recoveryAvailable(recovery, event) {
  const observed = await recoveryObservation(recovery);
  if (!observed.exists) return;
  event('agent.report.recovery.observed',{path:recovery,recoveryOwner:observed});
  if (observed.state === 'EMPTY' || observed.state === 'DEAD') {
    const current = await recoveryObservation(recovery);
    if (current.state === observed.state && current.identity === observed.identity && current.marker === observed.marker &&
        current.markerIdentity === observed.markerIdentity && await removeRecoveryDirectory(recovery,current.marker)) {
      event('agent.report.recovery.recovered',{path:recovery,recoveryOwner:current}); return;
    }
    if (!current.exists) return;
  }
  throw busy(null,{state:'RECOVERY',path:recovery,recoveryOwner:await recoveryObservation(recovery)});
}
async function pruneRecoveryPreparations(recovery, event) {
  const directory = path.dirname(recovery), prefix = path.basename(recovery)+'.prepare-';
  for (const name of await io.readdir(directory)) {
    if (!name.startsWith(prefix)) continue;
    const match = recoveryOwnerPattern.exec('owner-'+name.slice(prefix.length));
    if (!match) continue;
    const staging = path.join(directory,name), abandoned = abandonedRecoveryPreparations.has(path.resolve(staging));
    if (!abandoned && ownerState(Number(match[1])) !== 'DEAD') continue;
    const stat = await io.lstat(staging).catch(error => {
      if (error.code !== 'ENOENT') throw error; return null;
    });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
    const marker = 'owner-'+name.slice(prefix.length), names = await io.readdir(staging).catch(error => {
      if (error.code !== 'ENOENT') throw error; return null;
    });
    if (!names) continue;
    if (names.length > 1 || names.length === 1 && names[0] !== marker) continue;
    if (await removeRecoveryDirectory(staging,names[0])) abandonedRecoveryPreparations.delete(path.resolve(staging));
    event('agent.report.recovery.preparation.recovered',{path:staging,ownerPid:Number(match[1]),state:abandoned?'ABANDONED':'DEAD'});
  }
}
async function acquireRecovery(recovery, event) {
  await recoveryAvailable(recovery,event);
  const token = randomUUID(), marker = `owner-${process.pid}-${token}`, staging = `${recovery}.prepare-${process.pid}-${token}`;
  let created = false, published = false, failure;
  try {
    await io.mkdir(staging,{mode:0o700}); created = true;
    await io.mkdir(path.join(staging,marker),{mode:0o700});
    // Atomic publication has no ownerless interval, even if this process dies
    // immediately after the rename. A live guard is always nonempty.
    try { await io.rename(staging,recovery); }
    catch (error) {
      const observed = await recoveryObservation(recovery);
      if (observed.exists && (['EEXIST','ENOTEMPTY','ENOTDIR','EISDIR'].includes(error.code) ||
          error.code === 'EPERM' && ['LIVE','DEAD','EMPTY'].includes(observed.state)))
        throw busy(error,{state:'RECOVERY',path:recovery,recoveryOwner:observed});
      throw error;
    }
    published = true;
    event('agent.report.recovery.acquired',{path:recovery,pid:process.pid,token,marker});
    return marker;
  } catch (error) { failure = error; throw error; }
  finally {
    if (created && !published) {
      try { await removeRecoveryDirectory(staging,marker); }
      catch (error) {
        abandonedRecoveryPreparations.add(path.resolve(staging));
        if (failure) failure.cleanupErrors = [...failure.cleanupErrors ?? [],{operation:'lock.recovery.preparation.remove',code:error.code,path:error.path}];
        else throw error;
      }
    }
  }
}
async function reclaimDeadWriter(lock, observed, event) {
  const recovery = lock+'.recovery';
  let marker;
  try { marker = await acquireRecovery(recovery,event); }
  catch (error) { error.diagnosticOperation ??= 'lock.recovery.acquire'; throw error; }
  let failure;
  try {
    const current = await lockObservation(lock);
    if (current.state !== 'DEAD' || current.pid !== observed.pid || current.token !== observed.token || current.identity !== observed.identity) return false;
    // Only the confirmed dead writer's own temporary output may be removed.
    if (typeof current.temporary === 'string' && /^runtime-latest\.json\.[a-f0-9-]{36}\.tmp$/u.test(current.temporary))
      await io.unlink(path.join(path.dirname(lock),current.temporary)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await io.unlink(lock);
    event('agent.report.lock.recovered',{lockState:current});
    return true;
  } catch (error) {failure = error;throw error;}
  finally {
    try { await removeRecoveryDirectory(recovery,marker); }
    catch (error) {
      const errors = [{operation:'lock.recovery.remove',code:error.code,path:error.path}];
      if (failure) failure.cleanupErrors = [...failure.cleanupErrors ?? [],...errors];
      else throw Object.assign(new Error('Diagnostic lock recovery cleanup failed.',{cause:error}),{code:'DIAGNOSTIC_RECOVERY_CLEANUP_FAILED',cleanupErrors:errors});
    }
  }
}

// Async I/O preserves the lock over read/merge/fsync/rename without blocking HTTP.
/** @param {string} directory @param {string} section @param {any} record @param {any} [options] */
export async function writeAgentReport(directory, section, record, {onDiagnostic} = {}) {
  if (!sections.has(section) && section !== 'incident') throw new TypeError('Unsupported diagnostic section.');
  const filename = path.join(directory,'runtime-latest.json'), lock = filename+'.lock';
  const operationId = randomUUID(), started = performance.now();
  const event = (type,detail = {}) => emit(onDiagnostic,type,{operationId,section,...detail});
  const step = async (operation, work) => {
    const begin = performance.now(); event('agent.report.io.started',{operation});
    try { const value = await work(); event('agent.report.io.completed',{operation,elapsedMs:performance.now()-begin}); return value; }
    catch (error) {
      error.diagnosticOperation ??= operation;
      event('agent.report.io.failed',{operation,elapsedMs:performance.now()-begin,code:error.code,syscall:error.syscall,path:error.path});
      throw error;
    }
  };
  let fd, temporary, result, failure;
  const cleanupErrors = [];
  event('agent.report.write.started');
  try {
    await step('mkdir',() => io.mkdir(directory,{recursive:true,mode:0o700}));
    await step('lock.recovery.preparations',() => pruneRecoveryPreparations(lock+'.recovery',event));
    await step('lock.recovery.observe',() => recoveryAvailable(lock+'.recovery',event));
    try { fd = await step('lock.open',() => io.open(lock,'wx',0o600)); }
    catch (error) {
      if (!['EEXIST','EPERM'].includes(error.code)) throw error;
      const observed = await lockObservation(lock);
      event('agent.report.lock.observed',{operation:'open',path:lock,code:error.code,lockState:observed});
      // EPERM alone is not contention. Missing/unreadable paths keep their real error.
      const contended = observed.exists === true && ['LIVE','DEAD','INITIALIZING'].includes(observed.state);
      if (error.code === 'EPERM' && !contended) { error.lockState = observed; throw error; }
      if (observed.state === 'DEAD' && await reclaimDeadWriter(lock,observed,event)) {
        try { fd = await step('lock.open',() => io.open(lock,'wx',0o600)); }
        catch (retry) {
          const current = await lockObservation(lock);
          if (retry.code === 'EEXIST' || retry.code === 'EPERM' && current.exists === true && ['LIVE','DEAD','INITIALIZING'].includes(current.state)) throw busy(retry,current);
          retry.lockState = current; throw retry;
        }
      } else throw busy(error,observed);
    }
    const token = randomUUID();
    temporary = filename+'.'+token+'.tmp';
    await step('lock.owner',() => fd.writeFile(JSON.stringify({pid:process.pid,token,temporary:path.basename(temporary)})));
    event('agent.report.lock.acquired',{path:lock});
    const previous = await step('read',() => readAgentReportAsync(directory)), diagnosticId = randomUUID();
    const value = {schemaVersion:1,updatedAt:new Date().toISOString(),diagnosticId,
      server:previous.server ?? null,repair:previous.repair ?? null,deliveryReview:previous.deliveryReview ?? null,
      extension:previous.extension ?? null,startup:previous.startup ?? null,deliveryRecovery:previous.deliveryRecovery ?? null,incidents:previous.incidents ?? []};
    if (section === 'incident') value.incidents = mergeDiagnosticIncident(value.incidents,record);
    else value[section] = {...record,diagnosticId,observedAt:record.observedAt ?? value.updatedAt};
    const json = JSON.stringify(value,null,2);
    if (Buffer.byteLength(json) > limit) throw Object.assign(new Error('Diagnostic size limit.'),{code:'DIAGNOSTIC_SIZE_LIMIT'});
    const output = await step('output.open',() => io.open(temporary,'wx',0o600));
    let outputFailure;
    try {
      await step('output.write',() => output.writeFile(json));
      await step('output.sync',() => output.sync());
    } catch (error) {outputFailure = error;}
    finally {
      try {await step('output.close',() => output.close());}
      catch (error) {cleanupErrors.push({operation:'output.close',code:error.code});outputFailure ??= error;}
    }
    if (outputFailure) throw outputFailure;
    await step('output.rename',() => io.rename(temporary,filename)); temporary = null;
    result = {diagnosticId,logFile:filename};
  } catch (error) { failure = error; }
  finally {
    const cleanup = async (operation, work) => {
      try { await step(operation,work); }
      catch (error) { cleanupErrors.push({operation,code:error.code,syscall:error.syscall,path:error.path}); failure ??= error; }
    };
    if (fd) {
      if (temporary) await cleanup('output.remove',async () => { try { await io.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } });
      await cleanup('lock.close',() => fd.close());
      await cleanup('lock.remove',() => io.unlink(lock));
    }
    if (failure && cleanupErrors.length) failure.cleanupErrors = [...failure.cleanupErrors ?? [],...cleanupErrors];
    event('agent.report.write.completed',{elapsedMs:performance.now()-started,status:failure ? 'FAIL' : 'PASS',code:failure?.code,cleanupErrors});
  }
  if (failure) throw failure;
  return result;
}
/** @param {string} directory @param {string} section @param {any} record @param {any} [options] */
export function enqueueAgentReport(directory, section, record, {onDiagnostic,lockTimeoutMs = 2000} = {}) {
  const key = path.resolve(directory), enqueued = performance.now();
  const event = (type,detail = {}) => emit(onDiagnostic,type,{section,...detail});
  const operation = async () => {
    const started = performance.now(), deadline = started+lockTimeoutMs;
    let retries = 0, acquiredAt;
    const observe = entry => {
      if (entry.type === 'agent.report.lock.acquired') acquiredAt = performance.now();
      try {onDiagnostic?.(entry);} catch { /* Observation only. */ }
    };
    const timing = () => ({queueMs:started-enqueued,lockWaitMs:(acquiredAt ?? performance.now())-started,
      saveMs:acquiredAt === undefined ? null : performance.now()-acquiredAt,elapsedMs:performance.now()-started,retries});
    for (;;) {
      try {
        const result = await writeAgentReport(directory,section,record,{onDiagnostic:observe});
        event('agent.report.queue.completed',{...timing(),status:'PASS'});
        return result;
      } catch (error) {
        if (error.code !== 'DIAGNOSTIC_WRITER_BUSY' || error.cleanupErrors?.length || performance.now() >= deadline) {
          const failure = error.code === 'DIAGNOSTIC_WRITER_BUSY' && !error.cleanupErrors?.length && error.cause?.code === 'EPERM' ? Object.assign(error.cause,{lockState:error.lockState}) : error;
          event('agent.report.queue.completed',{...timing(),status:'FAIL',code:failure.code,operation:failure.diagnosticOperation,path:failure.path,lockState:failure.lockState});
          throw failure;
        }
        retries++; event('agent.report.lock.wait',{elapsedMs:performance.now()-started,retries,code:error.cause?.code,lockState:error.lockState});
        await wait(Math.min(20,Math.max(1,deadline-performance.now())));
      }
    }
  };
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(operation,operation);
  queues.set(key,result);
  void result.finally(() => {if (queues.get(key) === result) queues.delete(key);}).catch(() => {});
  return result;
}
