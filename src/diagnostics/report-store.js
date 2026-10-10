import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { mergeDiagnosticIncident } from './diagnostic-schema.js';
const sections = new Set(['server','repair','deliveryReview','extension','startup']);
const queues = new Map();
export function readAgentReport(directory) {
  const filename = path.join(directory,'runtime-latest.json');
  try {
    if (fs.statSync(filename).size > 262144) return {};
    const value = JSON.parse(fs.readFileSync(filename,'utf8'));
    return value?.schemaVersion === 1 ? value : {};
  } catch (error) {if (error.code !== 'ENOENT') throw error; return {};}
}
function reclaimDeadWriter(lock) {
  const recovery = lock + ".recovery";
  let guard;
  try {guard = fs.openSync(recovery,"wx",0o600);} catch {return false;}
  try {
    const owner = JSON.parse(fs.readFileSync(lock,"utf8"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
    try {process.kill(owner.pid,0);return false;}
    catch (error) {if (error.code !== "ESRCH") return false;}
    fs.unlinkSync(lock);return true;
  } catch {return false;}
  finally {fs.closeSync(guard);fs.unlinkSync(recovery);}
}
// Serialize the read/merge/rename across processes. A live owner's lock is never stolen.
export function writeAgentReport(directory, section, record) {
  if (!sections.has(section) && section !== 'incident') throw new TypeError('Unsupported diagnostic section.');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const filename = path.join(directory,'runtime-latest.json'), lock = filename + '.lock';
  let fd;
  const busy = () => Object.assign(new Error('Diagnostic writer busy.'),{code:'DIAGNOSTIC_WRITER_BUSY'});
  if (fs.existsSync(lock + '.recovery')) throw busy();
  try {fd = fs.openSync(lock,'wx',0o600);}
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!reclaimDeadWriter(lock)) throw busy();
    try {fd = fs.openSync(lock,'wx',0o600);} catch (retry) {if (retry.code === 'EEXIST') throw busy();throw retry;}
  }
  let temporary;
  try {
    fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));
    const previous = readAgentReport(directory), diagnosticId = randomUUID();
    const result = {schemaVersion:1,updatedAt:new Date().toISOString(),diagnosticId,
      server:previous.server ?? null,repair:previous.repair ?? null,deliveryReview:previous.deliveryReview ?? null,
      extension:previous.extension ?? null,startup:previous.startup ?? null,incidents:previous.incidents ?? []};
    if (section === 'incident') result.incidents = mergeDiagnosticIncident(result.incidents,record);
    else result[section] = {...record,diagnosticId,observedAt:record.observedAt ?? result.updatedAt};
    const json = JSON.stringify(result,null,2);
    if (Buffer.byteLength(json) > 262144) throw Object.assign(new Error('Diagnostic size limit.'),{code:'DIAGNOSTIC_SIZE_LIMIT'});
    temporary = filename + '.' + randomUUID() + '.tmp';
    const output = fs.openSync(temporary,'wx',0o600);
    try {fs.writeFileSync(output,json);fs.fsyncSync(output);} finally {fs.closeSync(output);}
    fs.renameSync(temporary,filename); temporary = null;
    return {diagnosticId,logFile:filename};
  } finally {
    if (temporary) {try {fs.unlinkSync(temporary);} catch { /* Preserve the original write failure. */ }}
    fs.closeSync(fd); fs.unlinkSync(lock);
  }
}
export function enqueueAgentReport(directory, section, record) {
  const key = path.resolve(directory);
  const operation = async () => {
    const deadline = Date.now()+2000;
    for (;;) {
      try {return writeAgentReport(directory,section,record);}
      catch (error) {if (error.code !== 'DIAGNOSTIC_WRITER_BUSY' || Date.now() >= deadline) throw error; await wait(20);}
    }
  };
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(operation,operation);
  queues.set(key,result);
  void result.finally(() => {if (queues.get(key) === result) queues.delete(key);}).catch(() => {});
  return result;
}
