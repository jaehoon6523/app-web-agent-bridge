import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verificationPlan} from '../scripts/verification-plan.mjs';
import {discoverTests} from '../scripts/run-tests.mjs';
import {executeVerification,receiptComplete} from '../scripts/verification-engine.mjs';
const source={head:'candidate',sourceSha256:'source'};
const item=(id,extra={})=>({id,required:true,applicable:true,status:'NOT_RUN',reason:'PENDING',needs:[],...extra});
async function scenario(t,plan,run,options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-plan-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return executeVerification({root,directory:path.join(root,'.agent-controller'),source,
    readSource:()=>source,plan,run:async(stage,context)=>{
      context.write('observed '+stage.id+'\n');
      return await run?.(stage,context) || {code:0,signal:null,forced:false};
    },...options});
}
test('CI and local use the same catalog including every previously omitted gate',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/bridge-gates.yml',import.meta.url),'utf8');
  assert.match(workflow,/run: npm run verify:all\r?\n/u);
  assert.match(workflow,/run: npm run verify:all -- --scope=minimum/u);
  assert.doesNotMatch(workflow,/run: npm run (?:check|test:)/u);
  for(const platform of ['linux','win32']) {
    const plan=verificationPlan({platform});
    for(const id of ['discovery','integration','ui','browser','sabotage','native','tab-ux','cleanup','platform','e2e'])
      assert.ok(plan.find(s=>s.id===id));
    assert.equal(new Set(plan.map(s=>s.id)).size,plan.length);
    assert.equal(plan.find(s=>s.id==='ui').applicable,platform==='linux');
  }
});
test('preparation failure blocks dependents and still executes an independent check',async t=>{
  const seen=[];const result=await scenario(t,[item('prepare'),item('dependent',{needs:['prepare']}),item('independent')],s=>{
    seen.push(s.id);return {code:s.id==='prepare'?1:0,signal:null,forced:false};
  });
  assert.deepEqual(seen,['prepare','independent']);assert.equal(result.status,'FAIL');
  assert.equal(result.stages[1].status,'NOT_RUN');assert.match(result.stages[1].reason,/PREPARATION_FAILED/u);
});
test('Windows discovery groups cover exactly the Linux discovery inventory with unchanged deadlines',()=>{
  const linux=verificationPlan({platform:'linux'}).find(stage=>stage.id==='discovery');
  const groups=verificationPlan({platform:'win32'}).filter(stage=>/^discovery(?:-\d+)?$/u.test(stage.id));
  assert.equal(groups.length,4);
  const scheduled=groups.flatMap(stage=>stage.expectedFiles);
  assert.equal(new Set(scheduled).size,scheduled.length,'No duplicate scheduling');
  assert.deepEqual([...scheduled].sort(),[...linux.expectedFiles].sort(),'No missing or additional tests');
  assert.ok(groups.every(stage=>stage.timeoutMs===linux.timeoutMs && stage.receipt==='gate'));
  assert.ok(Math.max(...groups.map(stage=>stage.expectedFiles.length))-Math.min(...groups.map(stage=>stage.expectedFiles.length))<=1);
});

test('spec and discovery partition the full inventory on both platforms without changing minimum',()=>{
  const registry=JSON.parse(fs.readFileSync(new URL('../docs/spec/registry.json',import.meta.url),'utf8'));
  const registered=registry.boundaries.map(entry=>entry.testPath);
  const root=fileURLToPath(new URL('../',import.meta.url));
  const discovered=discoverTests(path.join(root,'tests')).map(file=>path.relative(root,file).split(path.sep).join('/'));
  for(const platform of ['win32','linux']) {
    const plan=verificationPlan({platform});
    const spec=plan.find(s=>s.id==='spec');
    const discovery=plan.filter(s=>/^discovery(?:-\d+)?$/u.test(s.id));
    const rest=discovery.flatMap(s=>s.expectedFiles);
    assert.deepEqual(spec.expectedFiles,registered);
    assert.equal(spec.command,'verify:spec');assert.equal(spec.receipt,'spec');
    assert.equal(plan.indexOf(spec),plan.findIndex(s=>s.id==='types')+1);
    assert.equal(new Set(registered).size,registered.length);
    assert.equal(new Set(rest).size,rest.length);
    assert.ok(registered.every(file=>discovered.includes(file)&&!rest.includes(file)));
    assert.deepEqual([...rest,...registered].sort(),discovered.sort());
    assert.ok(discovery.every(s=>s.timeoutMs===25*60*1000));
    assert.equal(discovery.length,platform==='win32'?4:1);
    assert.deepEqual(verificationPlan({scope:'minimum',platform}).map(s=>s.id),['minimum-dependencies','minimum-sqlite']);
  }
});
test('plan rejects duplicate and undiscovered registry paths before exclusion',t=>{
  const read=fs.readFileSync, registryPath=fileURLToPath(new URL('../docs/spec/registry.json',import.meta.url));
  const registry=JSON.parse(read(registryPath,'utf8'));
  let paths;
  t.mock.method(fs,'readFileSync',(file,...args)=>String(file)===registryPath
    ? JSON.stringify({...registry,boundaries:paths.map(testPath=>({testPath}))}) : read(file,...args));
  for(paths of [[registry.boundaries[0].testPath,registry.boundaries[0].testPath],['tests/not-discovered.gen.test.js']])
    assert.throws(()=>verificationPlan(),/INVALID_SPEC_FILE_SET/u);
});

function specEvidence(runId, baseline=source) {
  return {schemaVersion:1,runId,status:'PASS',exitCode:0,finishedAt:new Date().toISOString(),errors:[],
    source:baseline,sourceAfter:baseline};
}
function specRun(runId, baseline=source) {
  return {verificationRunId:runId,source:baseline,sourceAfter:baseline,candidateUnchanged:true,
    terminal:true,status:'PASS',scheduled:['a'],results:[{file:'a',pass:true,summary:{completed:true}}]};
}
test('spec receipt accepts current proof and rejects mismatched IDs and either source snapshot',()=>{
  const context={runId:'current-spec',source,expectedFiles:['a'],testRun:specRun('current-spec')};
  const good=specEvidence(context.runId);
  assert.equal(receiptComplete('spec',good,context),true);
  for(const change of [{runId:'previous-spec'},{source:{...source,head:'other'}},
    {source:{...source,sourceSha256:'changed'}},{sourceAfter:{...source,sourceSha256:'changed'}}])
    assert.equal(receiptComplete('spec',{...good,...change},context),false);
});
test('spec receipt rejects incomplete or unsuccessful summaries and internal gate evidence',()=>{
  const context={runId:'current-spec',source,expectedFiles:['a'],testRun:specRun('current-spec')};
  const good=specEvidence(context.runId);
  for(const change of [{schemaVersion:2},{status:'RUNNING'},{status:'FAIL'},{exitCode:1},{finishedAt:null},{errors:[{code:'FAIL'}]}])
    assert.equal(receiptComplete('spec',{...good,...change},context),false);
  for(const testRun of [undefined,specRun('old'),{...context.testRun,scheduled:['other']},
    {...context.testRun,sourceAfter:{...source,head:'other'}}])
    assert.equal(receiptComplete('spec',good,{...context,testRun}),false);
});
async function specScenario(t, mode) {
  const seen=[];
  const result=await scenario(t,[item('spec',{receipt:'spec',expectedFiles:['a']}),item('next')],(stage,{stageRunId,stageDirectory})=>{
    seen.push(stage.id);
    if(stage.id==='spec') {
      const proof=specEvidence(stageRunId), internal=specRun(stageRunId);
      if(mode==='preflight') {proof.status='FAIL';proof.exitCode=1;proof.errors=[{code:'SPEC_SCHEMA_INVALID'}];}
      if(mode.startsWith('cleanup')) internal.results[0].receiptCleanupError='still owned';
      if(mode==='wrong-source') {proof.source={...source,head:'later'};proof.sourceAfter=proof.source;internal.source=proof.source;internal.sourceAfter=proof.source;}
      fs.writeFileSync(path.join(stageDirectory,'spec-result.json'),mode==='cleanup-malformed-proof'?'{broken':JSON.stringify(proof));
      if(!['missing','preflight'].includes(mode)) fs.writeFileSync(path.join(stageDirectory,'latest-test-result.json'),mode==='malformed'?'{broken':JSON.stringify(internal));
      return {code:mode==='preflight'?1:0,signal:null,forced:false};
    }
  });
  return {result,seen};
}
test('spec engine reads stage-local files and keeps their original proof path',async t=>{
  const {result,seen}=await specScenario(t,'pass');
  assert.equal(result.status,'PASS');assert.deepEqual(seen,['spec','next']);
  assert.equal(path.basename(result.stages[0].receiptPath),'spec-result.json');
  assert.equal(fs.existsSync(path.join(path.dirname(result.stages[0].receiptPath),'receipt.json')),false);
});
test('spec PASS without readable internal evidence fails while independent checks continue',async t=>{
  for(const mode of ['missing','malformed']) {
    const {result,seen}=await specScenario(t,mode);
    assert.equal(result.status,'FAIL');assert.equal(result.stages[0].failurePhase,'EVIDENCE');
    assert.deepEqual(seen,['spec','next']);
  }
});
test('spec preflight failure needs no internal run and remains an ordinary failure',async t=>{
  const {result,seen}=await specScenario(t,'preflight');
  assert.equal(result.status,'FAIL');assert.equal(result.stages[0].failurePhase,'EXECUTION');
  assert.deepEqual(seen,['spec','next']);assert.equal(result.stages[0].receipt.errors[0].code,'SPEC_SCHEMA_INVALID');
});
test('spec internal cleanup uncertainty blocks later stages despite outer exit zero',async t=>{
  for(const mode of ['cleanup','cleanup-malformed-proof']) {
    const {result,seen}=await specScenario(t,mode);
    assert.equal(result.status,'FAIL');assert.equal(result.stages[0].failurePhase,'CLEANUP');
    assert.deepEqual(seen,['spec']);assert.equal(result.stages[1].reason,'RESOURCE_CLOSURE_UNCONFIRMED');
  }
});
test('spec engine never promotes a later child source to the parent baseline',async t=>{
  const {result,seen}=await specScenario(t,'wrong-source');
  assert.equal(result.status,'FAIL');assert.equal(result.stages[0].failurePhase,'EVIDENCE');
  assert.equal(result.source.head,source.head);assert.deepEqual(seen,['spec','next']);
});
test('ordinary first assertion failure preserves later independent observations',async t=>{
  const result=await scenario(t,[item('first'),item('last')],s=>({code:s.id==='first'?7:0,signal:null,forced:false}));
  assert.deepEqual(result.stages.map(s=>s.status),['FAIL','PASS']);assert.equal(result.status,'FAIL');
  assert.ok(fs.readFileSync(result.stages[1].logPath,'utf8').includes('observed last'));
});
test('missing, previous-stage and other-source completion receipts are refused',()=>{
  const receipt={verificationRunId:'current',source,sourceAfter:source,terminal:true,candidateUnchanged:true,status:'PASS',
    scheduled:['a'],results:[{file:'a',pass:true,summary:{completed:true}}]};
  assert.equal(receiptComplete('gate',receipt,{runId:'current',source,expectedFiles:['a']}),true);
  for(const invalid of [undefined,{...receipt,verificationRunId:'old'},
    {...receipt,source:{...source,head:'other'}},{...receipt,source:{...source,sourceSha256:'other'}},
    {...receipt,terminal:false},{...receipt,candidateUnchanged:false}])
    assert.ok(!receiptComplete('gate',invalid,{runId:'current',source,expectedFiles:['a']}));
});
test('policy exclusion is explicit and never counts as an OS observation',async t=>{
  const result=await scenario(t,[item('excluded',{applicable:false,required:false,reason:'POLICY_EXCLUDED_OS'}),item('real')]);
  assert.equal(result.status,'PASS');assert.equal(result.stages[0].status,'NOT_RUN');
  assert.equal(result.stages[0].reason,'POLICY_EXCLUDED_OS');assert.equal(result.stages[0].startedAt,undefined);
});
test('source mutation invalidates successful process results',async t=>{
  const result=await scenario(t,[item('check')],null,{readSource:()=>({...source,sourceSha256:'changed'})});
  assert.equal(result.stages[0].status,'PASS');assert.equal(result.status,'FAIL');assert.equal(result.candidateUnchanged,false);
});
test('unconfirmed resource closure prevents resource reuse',async t=>{
  const result=await scenario(t,[item('first'),item('last')],()=>{
    throw Object.assign(Error('cleanup failed'),{cleanupError:'process tree still owned'});
  });
  assert.equal(result.status,'FAIL');assert.equal(result.stages[0].failurePhase,'CLEANUP');
  assert.equal(result.stages[1].status,'NOT_RUN');assert.equal(result.stages[1].reason,'RESOURCE_CLOSURE_UNCONFIRMED');
});
test('cancellation preserves completed results and a reason for unexecuted checks',async t=>{
  const controller=new AbortController();
  const result=await scenario(t,[item('first'),item('last')],()=>{controller.abort();},{signal:controller.signal});
  assert.equal(result.stages[0].status,'PASS');assert.equal(result.stages[1].reason,'CANCELLED');assert.equal(result.status,'PARTIAL');
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.evidenceRoot,'result.json'))).stages.length,2);
});
test('deadline preserves results and blocks unsafe follow-up execution',async t=>{
  const result=await scenario(t,[item('first'),item('last')],()=>{throw Object.assign(Error('deadline'),{code:'E2E_RUNNER_DEADLINE'});});
  assert.equal(result.stages[0].failurePhase,'TIMEOUT');assert.equal(result.stages[1].status,'NOT_RUN');assert.equal(result.status,'FAIL');
});

const identity={verificationRunId:'run-gui',source,sourceAfter:source,candidateUnchanged:true};
test('E2E rejects zero-profile success and mismatched or duplicated profile results',()=>{
  const context={runId:'run-gui',source,expectedProfiles:['UF-A','UF-B']};
  const good={...identity,scope:'FULL SUITE',failed:0,unexpectedSkips:0,continuationBlocked:0,fullRunnablePassed:2,
    scheduledProfiles:['UF-A','UF-B'],profileResults:[{id:'UF-A',outcome:'PROFILE_PASS'},{id:'UF-B',outcome:'PROFILE_PASS'}]};
  assert.equal(receiptComplete('e2e',good,context),true);
  for(const bad of [{scope:'FULL SUITE',failed:0,unexpectedSkips:0,continuationBlocked:0},
    {...good,scheduledProfiles:[]},{...good,profileResults:[]},
    {...good,profileResults:[good.profileResults[0],good.profileResults[0]]},
    {...good,fullRunnablePassed:0},{...good,verificationRunId:'old'},
    {...good,sourceAfter:{...source,sourceSha256:'other'}},
    {...good,profileResults:[good.profileResults[0],{id:'UF-B',outcome:'MISSING'}]}])
    assert.equal(receiptComplete('e2e',bad,context),false);
});
test('gate refuses unrelated, missing and duplicate scheduled/results files',()=>{
  const context={runId:'run-gui',source,expectedFiles:['a','b']};
  const good={...identity,status:'PASS',terminal:true,scheduled:['a','b'],results:['a','b'].map(file=>({file,pass:true,summary:{completed:true}}))};
  assert.equal(receiptComplete('gate',good,context),true);
  for(const bad of [{...good,scheduled:['other','b']},{...good,scheduled:['a','a']},
    {...good,results:[good.results[0],good.results[0]]},{...good,results:good.results.slice(1)},
    {...good,results:[good.results[0],{...good.results[1],file:'other'}]}])
    assert.equal(receiptComplete('gate',bad,context),false);
});

for(const [kind,field] of [['gui','cleanupFailure'],['native','cleanupError'],['e2e','closureConfirmed']])
 test(kind+' cleanup uncertainty preserves failure and blocks follow-up',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-cleanup-contract-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'.agent-controller'),seen=[];
  const result=await executeVerification({root,directory,source,readSource:()=>source,
    plan:[item('producer',{receipt:kind}),item('next')],run:async(s,{stageRunId})=>{
      seen.push(s.id);
      const filename=kind==='gui'?'tab-ux-browser-latest.json':kind==='native'?'latest-native-extension.json':'ui-qa/e2e-summary.json';
      const target=path.join(directory,filename);fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target,JSON.stringify({...identity,verificationRunId:stageRunId,[field]:field==='closureConfirmed'?false:'resource still owned'}));
      return {code:0,signal:null,forced:false};
    }});
  assert.deepEqual(seen,['producer']);assert.equal(result.status,'FAIL');
  assert.equal(result.stages[0].failurePhase,'CLEANUP');
  assert.equal(result.stages[1].reason,'RESOURCE_CLOSURE_UNCONFIRMED');
 });
test('only catalog-declared evidence is copied and prior run data is cleared before dispatch',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-evidence-contract-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'.agent-controller');fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory,'own.log'),'old');fs.writeFileSync(path.join(directory,'unrelated.log'),'other');
  const result=await executeVerification({root,directory,source,readSource:()=>source,
    plan:[item('check',{evidencePaths:['own.log']})],run:async()=>{
      assert.equal(fs.existsSync(path.join(directory,'own.log')),false);
      fs.writeFileSync(path.join(directory,'own.log'),'current');return {code:0,signal:null,forced:false};
    }});
  const collected=path.join(result.evidenceRoot,'check/evidence');
  assert.equal(fs.readFileSync(path.join(collected,'own.log'),'utf8'),'current');
  assert.equal(fs.existsSync(path.join(collected,'unrelated.log')),false);
});

const guiContext={runId:'run-gui',source,expectedScenarios:['choice','export']};
const guiGood={...identity,exitCode:0,browserVersion:'fixture',scheduledScenarios:['choice','export'],
  scenarioResults:[{id:'choice',status:'PASS'},{id:'export',status:'PASS'}],
  assertions:[{scenarioId:'choice',status:'PASS'},{scenarioId:'export',status:'PASS'}]};
for(const [name,change] of [
  ['single assertion success',{scheduledScenarios:['choice'],scenarioResults:[{id:'choice',status:'PASS'}],assertions:[{scenarioId:'choice',status:'PASS'}]}],
  ['missing required scenario',{scenarioResults:[{id:'choice',status:'PASS'}]}],
  ['duplicate scenario',{scenarioResults:[{id:'choice',status:'PASS'},{id:'choice',status:'PASS'}]}],
  ['unexecuted scenario',{scenarioResults:[{id:'choice',status:'PASS'},{id:'export',status:'NOT_RUN'}]}],
  ['running scenario',{scenarioResults:[{id:'choice',status:'PASS'},{id:'export',status:'RUNNING'}]}],
  ['scenario without observations',{assertions:[{scenarioId:'choice',status:'PASS'}]}],
  ['other source',{sourceAfter:{...source,sourceSha256:'other'}}],
  ['old run',{verificationRunId:'old-run'}],
]) test('GUI refuses '+name,()=>{
  assert.equal(receiptComplete('gui',guiGood,guiContext),true);
  assert.equal(receiptComplete('gui',{...guiGood,...change},guiContext),false);
});
