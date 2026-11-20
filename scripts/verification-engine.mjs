import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {identityMatches,sameUniqueMembers,resourceClosureUnconfirmed} from './verification-identity.mjs';
import {nativeExtensionComplete} from './native-extension-contract.js';

export function receiptLocation(kind, root, directory) {
  return kind==='browser'?path.join(directory,'latest-browser-preparation.json'):kind==='gate'?path.join(root,'.agent-controller/latest-test-result.json')
    :kind==='e2e'?path.join(root,'.agent-controller/ui-qa/e2e-summary.json')
    :kind==='native'?path.join(directory,'latest-native-extension.json')
    :kind==='gui'?path.join(directory,'tab-ux-browser-latest.json'):null;
}
export function receiptComplete(kind, receipt, context) {
  if(!kind) return true;
  if(kind==='spec') {
    const sameSource=value=>value?.head===context.source.head && value?.sourceSha256===context.source.sourceSha256;
    return receipt?.schemaVersion===1 && receipt.status==='PASS' && receipt.exitCode===0
      && receipt.runId===context.runId && typeof receipt.finishedAt==='string' && Number.isFinite(Date.parse(receipt.finishedAt))
      && Array.isArray(receipt.errors) && receipt.errors.length===0
      && sameSource(receipt.source) && sameSource(receipt.sourceAfter)
      && !resourceClosureUnconfirmed(receipt) && receiptComplete('gate',context.testRun,context);
  }
  if(!identityMatches(receipt,context) || resourceClosureUnconfirmed(receipt)) return false;
  if(kind==='browser') return receipt.status==='PASS' && typeof receipt.version==='string' && typeof receipt.executable==='string';
  if(kind==='gate') return receipt.terminal===true && receipt.status==='PASS'
    && sameUniqueMembers(receipt.scheduled,context.expectedFiles)
    && Array.isArray(receipt.results) && sameUniqueMembers(receipt.results.map(item=>item.file),context.expectedFiles)
    && receipt.results.every(item=>item.pass && item.summary?.completed);
  if(kind==='e2e') return receipt.scope==='FULL SUITE' && receipt.failed===0 && receipt.unexpectedSkips===0
    && receipt.continuationBlocked===0 && receipt.fullRunnablePassed===context.expectedProfiles?.length
    && sameUniqueMembers(receipt.scheduledProfiles,context.expectedProfiles)
    && Array.isArray(receipt.profileResults) && sameUniqueMembers(receipt.profileResults.map(item=>item.id),context.expectedProfiles)
    && receipt.profileResults.every(item=>item.outcome==='PROFILE_PASS' || item.id==='UF-01A' && item.outcome==='PASS');
  if(kind==='native') return nativeExtensionComplete(receipt);
  if(kind==='gui') return receipt.exitCode===0 && typeof receipt.browserVersion==='string'
    && sameUniqueMembers(receipt.scheduledScenarios,context.expectedScenarios)
    && Array.isArray(receipt.scenarioResults)
    && sameUniqueMembers(receipt.scenarioResults.map(item=>item.id),context.expectedScenarios)
    && receipt.scenarioResults.every(item=>item.status==='PASS')
    && Array.isArray(receipt.assertions) && receipt.assertions.length>0
    && receipt.assertions.every(item=>item.status==='PASS' && context.expectedScenarios.includes(item.scenarioId))
    && context.expectedScenarios.every(id=>receipt.assertions.some(item=>item.scenarioId===id)) && !receipt.failure;
  return false;
}
function evidencePath(root,name) {
  if(typeof name!=='string' || path.isAbsolute(name) || name.split(/[\\/]/u).some(p=>!p || p==='.' || p==='..'))
    throw Error('UNSAFE_EVIDENCE_PATH');
  return path.join(root,'.agent-controller',name);
}
// Process closure and evidence validation are separate. Failures never disappear
// when a later independent stage succeeds. Callers inject execution for fault tests.
export async function executeVerification({root,directory,plan,source,readSource,run,
  signal,runId=randomUUID(),output=()=>{}}) {
  fs.mkdirSync(directory,{recursive:true});
  const runsRoot=path.join(directory,'verification-runs');
  if(fs.existsSync(runsRoot)) for(const name of fs.readdirSync(runsRoot)) {
    const previous=path.join(runsRoot,name);
    try {
      const receipt=JSON.parse(fs.readFileSync(path.join(previous,'result.json'),'utf8'));
      if(receipt.status==='PASS' || Date.now()-Date.parse(receipt.finishedAt)>30*86400000)
        fs.rmSync(previous,{recursive:true,force:true});
    } catch { /* Unknown or interrupted evidence is retained for inspection. */ }
  }
  const evidenceRoot=path.join(runsRoot,runId);
  fs.mkdirSync(evidenceRoot,{recursive:true});
  const result={runId,status:'RUNNING',startedAt:new Date().toISOString(),node:process.version,
    platform:process.platform,source,stages:structuredClone(plan),evidenceRoot,
    liveChatGpt:'UNVERIFIED: controlled external boundaries do not prove real ChatGPT delivery'};
  const resultPath=path.join(directory,'latest-verification.json'), logPath=path.join(directory,'latest-verification.log');
  fs.writeFileSync(logPath,''); let bytes=0;
  const save=()=>{
    const data=JSON.stringify(result,null,2)+'\n';
    for(const target of [resultPath,path.join(evidenceRoot,'result.json')]) {
      fs.writeFileSync(target+'.tmp',data); fs.renameSync(target+'.tmp',target);
    }
  };
  const log=chunk=>{const data=Buffer.from(chunk);fs.appendFileSync(logPath,data);bytes+=data.length;output(data);};
  save(); // The complete plan exists even if no child can start.
  let unsafe=false;
  try {
    for(const stage of result.stages) {
      if(!stage.applicable) {save();continue;}
      if(signal?.aborted || unsafe) {
        stage.reason=signal?.aborted?'CANCELLED':'RESOURCE_CLOSURE_UNCONFIRMED';save();continue;
      }
      const blocked=stage.needs.filter(id=>result.stages.find(item=>item.id===id)?.status!=='PASS');
      if(blocked.length) {stage.reason='PREPARATION_FAILED: '+blocked.join(',');save();continue;}
      const stageDirectory=path.join(evidenceRoot,stage.id);fs.mkdirSync(stageDirectory);
      stage.status='RUNNING';stage.reason=null;stage.startedAt=new Date().toISOString();
      stage.receiptKind=stage.receipt;stage.classification='UNKNOWN';stage.causeConfirmed=false;stage.logPath=path.join(stageDirectory,'output.log');
      fs.writeFileSync(stage.logPath,'');save();log('\nSTAGE '+stage.id+'\n');
      const write=chunk=>{fs.appendFileSync(stage.logPath,chunk);log(chunk);};
      const receiptKind=stage.receipt; delete stage.receipt;
      const receiptPath=stage.receiptKind==='spec'?path.join(stageDirectory,'spec-result.json'):receiptLocation(receiptKind,root,directory);
      let testRun;
      try {
        if(receiptPath) fs.rmSync(receiptPath,{force:true});
        for(const name of stage.evidencePaths || []) fs.rmSync(evidencePath(root,name),{recursive:true,force:true});
        // Per-stage identity also prevents a different stage's gate receipt from
        // being accepted when a producer accidentally stops writing evidence.
        const stageRunId=runId+'-'+stage.id;
        stage.verificationRunId=stageRunId;
        stage.closure=await run(stage,{write,stageRunId,signal,stageDirectory});

        if(stage.receiptKind==='spec') {
          const testPath=path.join(stageDirectory,'latest-test-result.json');
          if(fs.existsSync(testPath)) {
            try {testRun=JSON.parse(fs.readFileSync(testPath,'utf8'));}
            catch(error) {stage.testResultError=error.message;}
          }
        }

        if(receiptPath && fs.existsSync(receiptPath)) {
          stage.receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
          stage.receiptPath=stage.receiptKind==='spec'?receiptPath:path.join(stageDirectory,'receipt.json');
          if(stage.receiptKind!=='spec') fs.copyFileSync(receiptPath,stage.receiptPath);
        }
        if(receiptKind==='browser') result.browser=stage.receipt;
        const closed=stage.closure;
        const complete=receiptComplete(receiptKind,stage.receipt,{runId:stageRunId,source,testRun,expectedFiles:stage.expectedFiles,expectedProfiles:stage.expectedProfiles,expectedScenarios:stage.expectedScenarios});
        stage.status=closed.code===0 && closed.signal===null && !closed.forced && complete?'PASS':'FAIL';
        if(stage.status==='FAIL') stage.failurePhase=resourceClosureUnconfirmed(stage.receipt) || resourceClosureUnconfirmed(testRun)?'CLEANUP':closed.code!==0?'EXECUTION':!complete?'EVIDENCE':'CLEANUP';
        if(receiptKind==='native' && closed.code===2 && closed.signal===null && !closed.forced
          && stage.receipt?.status==='UNVERIFIED' && stage.receipt.completed===true
          && identityMatches(stage.receipt,{runId:stageRunId,source}) && !resourceClosureUnconfirmed(stage.receipt)) {
          stage.status='NOT_RUN';stage.reason='NATIVE_BOUNDARY_UNVERIFIED';stage.failurePhase='ENVIRONMENT';
        }
        if(closed.forced || closed.signal!==null) unsafe=true;
        if(resourceClosureUnconfirmed(stage.receipt) || resourceClosureUnconfirmed(testRun) || stage.receipt?.results?.some(item=>item.receiptCleanupError)) unsafe=true;
      } catch(error) {
        stage.status='FAIL';stage.error=error.message;stage.cleanupError=error.cleanupError;
        stage.failurePhase=error.cleanupError || resourceClosureUnconfirmed(testRun)?'CLEANUP':error.code==='E2E_RUNNER_DEADLINE'?'TIMEOUT':'EXECUTION';
        // A deadline/cleanup error leaves resource ownership uncertain. Ordinary
        // assertion/evidence failures are independent and do not block siblings.
        if(error.cleanupError || resourceClosureUnconfirmed(testRun) || error.code==='E2E_RUNNER_DEADLINE') unsafe=true;
      }
      try {
        const collected=path.join(stageDirectory,'evidence');fs.mkdirSync(collected);
        stage.collectedEvidence=[];
        for(const name of stage.evidencePaths || []) {
          const from=evidencePath(root,name);
          if(!fs.existsSync(from)) continue;
          const to=path.join(collected,name);
          fs.mkdirSync(path.dirname(to),{recursive:true});
          fs.cpSync(from,to,{recursive:true,filter:entry=>{
            if(fs.lstatSync(entry).isSymbolicLink()) throw Error('LINKED_EVIDENCE_PATH');
            return true;
          }});
          stage.collectedEvidence.push(name);
        }
      } catch(error) {stage.status='FAIL';stage.evidenceError=error.message;stage.failurePhase='EVIDENCE';}
      stage.finishedAt=new Date().toISOString();save();
      log('STAGE_RESULT '+JSON.stringify({id:stage.id,status:stage.status,reason:stage.reason,failurePhase:stage.failurePhase})+'\n');
    }
  } catch(error) {result.error=error.message;}
  finally {
    for(const stage of result.stages) if(stage.status==='RUNNING') {stage.status='FAIL';stage.reason='INTERRUPTED';}
    try {
      result.sourceAfter=readSource();
      result.candidateUnchanged=result.sourceAfter.head===source.head && result.sourceAfter.sourceSha256===source.sourceSha256;
      if(!result.candidateUnchanged) result.error='Source changed during verification';
    } catch(error) {result.error=error.message;}
    result.status=result.error || result.stages.some(s=>s.status==='FAIL')?'FAIL'
      :result.stages.some(s=>s.required && s.status!=='PASS')?'PARTIAL':'PASS';
    result.finishedAt=new Date().toISOString();log('\nVERIFICATION '+result.status+'\n');
    result.logBytes=fs.statSync(logPath).size;result.expectedLogBytes=bytes;
    if(result.logBytes!==bytes){result.status='FAIL';result.error='Incomplete verification log';}
    fs.copyFileSync(logPath,path.join(evidenceRoot,'output.log'));save();
  }
  return result;
}
