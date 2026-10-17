import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {verificationPlan} from '../scripts/verification-plan.mjs';
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
