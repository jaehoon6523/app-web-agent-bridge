import fs from 'node:fs';
import path from 'node:path';
import {acquireLatestRun} from '../../scripts/latest-run.mjs';

function copyFiles(from, to) {
  if (!fs.existsSync(from)) return;
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(to,{recursive:true});
    for (const name of fs.readdirSync(from)) copyFiles(path.join(from,name),path.join(to,name));
  } else if (stat.isFile()) { fs.mkdirSync(path.dirname(to),{recursive:true}); fs.copyFileSync(from,to); }
}

// A test file owns one latest run. Scenarios share its lease and never clear
// another scenario's command output, journal or verification receipts.
export function beginTestEvidenceRun(repository, label) {
  const base = path.join(repository,'.agent-controller'), lease = acquireLatestRun(base,label);
  const directory = path.join(base,'latest-'+label);
  try { fs.rmSync(directory,{recursive:true,force:true}); fs.mkdirSync(directory,{recursive:true}); }
  catch (error) { lease.release(); throw error; }
  const record = {runId:lease.runId,verificationRunId:process.env.BRIDGE_VERIFICATION_RUN_ID ?? null,
    status:'RUNNING',terminal:false,startedAt:new Date().toISOString(),scenarios:[],cleanupErrors:[]};
  let closed = false;
  const save = () => {
    if (closed) throw Error('EVIDENCE_RUN_CLOSED');
    record.status = record.failure || record.cleanupErrors.length || record.scenarios.some(item => item.status === 'FAIL') ? 'FAIL'
      : !record.terminal ? 'RUNNING'
      : record.scenarios.length && record.scenarios.every(item => item.terminal && item.status === 'PASS') ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(record,null,2)+'\n');
  };
  try { save(); } catch (error) { lease.release(); throw error; }
  return {directory,record,save,
    scenario(name) {
      if (closed || !/^[a-z0-9-]+$/u.test(name) || record.scenarios.some(item => item.name === name)) throw Error('INVALID_EVIDENCE_SCENARIO');
      const relative = 'scenarios/'+name, target = path.join(directory,relative);
      fs.mkdirSync(target,{recursive:true});
      const summary = {name,directory:relative,status:'RUNNING',terminal:false};
      record.scenarios.push(summary);
      return scenarioEvidence(target,lease.runId,name,item => {
        Object.assign(summary,{status:item.status,terminal:item.terminal,
          failure:item.failure ?? null,cleanupErrors:item.cleanupErrors,preservationErrors:item.preservationErrors});
        save();
      });
    },
    close() {
      if (closed) return;
      record.terminal = true; record.finishedAt = new Date().toISOString();
      try { save(); } finally { closed = true; lease.release(); }
    },
  };
}

function scenarioEvidence(directory, runId, scenarioId, changed) {
  const record = {runId,scenarioId,status:'RUNNING',terminal:false,startedAt:new Date().toISOString(),
    commands:[],cleanupErrors:[],preservationErrors:[]};
  const save = () => {
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(record,null,2)+'\n'); changed(record);
  };
  save();
  return {directory,record,save,
    copy(from, relative) { try { copyFiles(from,path.join(directory,relative)); }
      catch (error) { record.preservationErrors.push(error.message); save(); } },
    preserve(checkout) { try { copyFiles(path.join(checkout,'.agent-controller'),path.join(directory,'internal')); }
      catch (error) { record.preservationErrors.push(error.message); save(); } },
    async command(executable,args,options,run) {
      const item = {executable,args,cwd:options.cwd,startedAt:new Date().toISOString()}; record.commands.push(item); save();
      try { const result = await run(executable,args,options);
        Object.assign(item,{exitCode:0,signal:null,timedOut:false,stdout:result.stdout,stderr:result.stderr}); return result;
      } catch (error) {
        Object.assign(item,{exitCode:error.code ?? null,signal:error.signal ?? null,
          timedOut:Boolean(error.killed && options.timeout),error:error.message,stdout:error.stdout ?? '',stderr:error.stderr ?? ''});
        throw error;
      } finally { item.finishedAt = new Date().toISOString(); save(); }
    },
    finish(error) { if (record.status !== 'FAIL') record.status = error ? 'FAIL' : 'PASS';
      if (error) record.failure = {code:error.code ?? null,message:error.message,stack:error.stack}; save(); },
    close() { if (record.terminal) return;
      if (record.status === 'RUNNING') record.status = 'FAIL';
      record.terminal = true; record.finishedAt = new Date().toISOString();
      if (record.cleanupErrors.length || record.preservationErrors.length) record.status = 'FAIL';
      save(); },
  };
}

// Single-scenario callers still get an independent run with the same cleanup
// and replacement rules; multi-scenario files must own the run explicitly.
export function beginTestEvidence(repository, label) {
  const run = beginTestEvidenceRun(repository,label);
  const scenario = run.scenario('single');
  return {...scenario,close() { try { scenario.close(); } finally { run.close(); } }};
}
