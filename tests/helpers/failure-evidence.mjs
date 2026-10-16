import fs from 'node:fs';
import path from 'node:path';
import {acquireLatestRun} from '../../scripts/latest-run.mjs';
import {verificationSource} from '../../scripts/verification-source.mjs';
import {test as registerTest,before,after} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

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
    if (record.cleanupErrors.length || record.preservationErrors.length) record.status = 'FAIL';
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

// These four incident files share one timeline format and retain evidence before
// their temporary servers are removed. This does not change any test deadline.
export function evidenceTestFile(url) {
  const repository = fileURLToPath(new URL('../../',import.meta.url));
  const label = path.basename(fileURLToPath(url)).replace(/\.test\.[cm]?js$/u,'');
  let run;
  before(() => {
    run = beginTestEvidenceRun(repository,label);
    run.record.source = verificationSource(repository);
    run.record.node = process.version;run.record.platform = process.platform;
    run.record.automaticDiagnostics = true;run.save();
  });
  after(() => run?.close());
  return (name, options, body) => {
    if (typeof options === 'function') {body = options;options = {};}
    return registerTest(name,options,async t => {
      const id = createHash('sha256').update(name).digest('hex').slice(0,12);
      const evidence = run.scenario('case-'+id), timeline = [];
      const originalAfter = t.after.bind(t), cleanups = [];
      // Release resources in reverse acquisition order. Attempt every cleanup,
      // including after a failed hook, and report errors only after saving.
      t.after = callback => {cleanups.push(callback);};
      t.evidence = {...evidence,
        event(event) {timeline.push({at:new Date().toISOString(),monotonicMs:performance.timeOrigin+performance.now(),
          pid:process.pid,...event,receivedMonotonicMs:performance.timeOrigin+performance.now()});},
        preserve(root) {for (const sub of ['diagnostics','.agent-controller/diagnostics']) evidence.copy(path.join(root,sub),'internal/'+sub);},
      };
      evidence.record.name = name;evidence.record.sourceSha256 = run.record.source.sourceSha256;evidence.save();
      let failure, bodyCompleted = false;
      originalAfter(async () => {
        for (const cleanup of cleanups.reverse()) {
          try {await cleanup(t);}
          catch (error) {evidence.record.cleanupErrors.push({code:error.code,message:error.message,stack:error.stack});evidence.save();}
        }
        fs.writeFileSync(path.join(evidence.directory,'timeline.jsonl'),timeline.map(event => JSON.stringify(event)+'\n').join(''));
        const http = timeline.filter(event => event.type?.startsWith('client.http.'));
        evidence.record.observations = {httpStarted:http.filter(event => event.type === 'client.http.started').length,
          httpCompleted:http.filter(event => event.type === 'client.http.completed').length,
          httpFailed:http.filter(event => event.type === 'client.http.failed').length,
          heartbeatWarnings:timeline.filter(event => event.type === 'watchdog.unresponsive').length,
          measuredLoopDelays:timeline.filter(event => event.type === 'heartbeat').map(event => event.loopDelayMs)};
        if (!bodyCompleted) evidence.finish(Object.assign(new Error('Test body did not complete.'),{code:'TEST_DID_NOT_COMPLETE'}));
        evidence.close();
        t.diagnostic(JSON.stringify({evidenceRunId:run.record.runId,sourceSha256:run.record.source.sourceSha256,
          timeline:path.join(evidence.directory,'timeline.jsonl'),...evidence.record.observations}));
        if (evidence.record.cleanupErrors.length || evidence.record.preservationErrors.length)
          throw Object.assign(new Error('Test cleanup or evidence preservation failed.'),{code:'EVIDENCE_CLEANUP_FAILED'});
      });
      try {await body(t);}
      catch (error) {failure = error;throw error;}
      finally {bodyCompleted = true;if (!evidence.record.terminal) evidence.finish(failure);}
    });
  };
}

export async function evidenceFetch(evidence, url, options = {}) {
  const route = new URL(url).pathname, started = performance.now();
  evidence?.event({type:'client.http.started',route});
  try {
    const response = await fetch(url,options);
    // Clone consumption observes the complete response, preserving the caller's body.
    await response.clone().arrayBuffer();
    evidence?.event({type:'client.http.completed',route,status:response.status,elapsedMs:performance.now()-started});
    return response;
  } catch (error) {
    evidence?.event({type:'client.http.failed',route,elapsedMs:performance.now()-started,
      code:error.code ?? error.name,timedOut:options.signal?.reason?.name === 'TimeoutError',aborted:Boolean(options.signal?.aborted)});
    throw error;
  }
}
