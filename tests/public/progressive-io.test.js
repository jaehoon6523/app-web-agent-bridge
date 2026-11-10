import test from 'node:test';
import assert from 'node:assert/strict';
import {runProgressiveIO} from '../helpers/progressive-io.mjs';
import {normalizeDashboardState, buildCommandEnvelope} from '../../public/dashboard-model.js';

const fixture = () => ({
  workflow:{stage:'WORK',state:'WORKER_RUNNING',runId:'A',runVersion:3},
  run:{runId:'A',version:3,phase:'WORKER_RUNNING',objective:'작업 A'},
  runs:[{runId:'A',phase:'WORKER_RUNNING',objective:'작업 A'}],
  commandCapabilities:['run.stop'],
});

function exampleLevels() {
  // Real production normalizer and command builder; intermediate steps are observable projections.
  const levels = [
    {name:'사용자 입력',process:async x => ({selected:x.selected, raw:x.raw}),
      expected:{selected:'A'},observe:o=>({selected:o.selected})},
    {name:'조회 대상',process:async x => ({...x, request:{runId:x.selected}}),
      expected:{runId:'A'},observe:o=>({runId:o.request.runId})},
    {name:'응답 본문',process:async x => ({...x, payload:structuredClone(x.raw)}),
      expected:{runId:'A',version:3},observe:o=>({runId:o.payload.run.runId,version:o.payload.run.version})},
    {name:'응답 스키마',process:async x => ({...x, canonical:normalizeDashboardState(x.payload,x.request.runId)}),
      expected:{runId:'A'},observe:o=>({runId:o.canonical.run.runId})},
    {name:'작업 상태',process:async x => ({...x, run:oRun(x.canonical)}),
      expected:{phase:'WORKER_RUNNING'},observe:o=>({phase:o.run.phase})},
    {name:'작업 버전',process:async x => ({...x, version:x.run.version}),
      expected:{version:3},observe:o=>({version:o.version})},
    {name:'워크플로 연결',process:async x => ({...x, workflow:x.canonical.workflow}),
      expected:{runId:'A',version:3},observe:o=>({runId:o.workflow.runId,version:o.workflow.runVersion})},
    {name:'기능 권한',process:async x => ({...x, canStop:x.canonical.commandCapabilities.has('run.stop')}),
      expected:{canStop:true},observe:o=>({canStop:o.canStop})},
    {name:'명령 생성',process:async x => ({...x, command:buildCommandEnvelope({type:'run.stop',requestId:'req-1',run:x.run})}),
      expected:{command:'run.stop'},observe:o=>({command:o.command.type})},
    {name:'출력 대상',process:async x => ({...x, sent:x.command.payload}),
      expected:{runId:'A',version:3},observe:o=>({runId:o.sent.runId,version:o.sent.expectedVersion})},
  ];
  return levels;
}
const oRun = canonical => canonical.run;

for (let depth = 1; depth <= 10; depth++) {
  test(`progressive model-to-command IO depth ${depth}/10`, async t => {
    const {records} = await runProgressiveIO(t,{feature:'Dashboard 모델→명령',input:{selected:'A',raw:fixture()},levels:exampleLevels(),depth});
    assert.equal(records.filter(x=>x.status==='PASS').length,depth);
    assert.equal(records.at(-1).status,depth===10?'COMPLETE':'PARTIAL');
    assert.equal(records.filter(x=>x.status==='DEFERRED').length,10-depth);
  });
}

test('depth 10 detects incorrect identity at the raw-payload boundary', async t => {
  const bad=fixture();bad.run.runId='B';bad.workflow.runId='B';
  await assert.rejects(runProgressiveIO(t,{feature:'wrong-id',input:{selected:'A',raw:bad},levels:exampleLevels(),depth:10}),
    /IO_DEPTH_FAILED wrong-id > 3 응답 본문/);
});

test('render-like output mismatch blocks downstream side effects', async t => {
  let mutations=0;
  const levels=[
    {name:'fetch',process:async()=>({status:'WORKER_RUNNING'}),observe:o=>o,expected:{status:'WORKER_RUNNING'}},
    {name:'render',process:async()=>({text:'대기 중'}),observe:o=>o,expected:{text:'구현·수정 중'}},
    {name:'command',process:async x=>{mutations++;return x;},observe:o=>o,expected:{text:'구현·수정 중'}},
  ];
  await assert.rejects(runProgressiveIO(t,{feature:'render-failure',input:{},levels,depth:3}),
    /IO_DEPTH_FAILED render-failure > 2 render/);
  assert.equal(mutations,0);
});

test('exception from process fails closed and preserves the first failing depth', async t => {
  await assert.rejects(runProgressiveIO(t,{feature:'throws',input:1,depth:2,levels:[
    {name:'one',process:x=>x+1,observe:o=>({value:o}),expected:{value:2}},
    {name:'two',process:()=>{throw new Error('network failed');},observe:o=>({value:o}),expected:{value:3}},
    {name:'three',process:x=>x+1,observe:o=>({value:o}),expected:{value:4}},
  ]}), /IO_DEPTH_FAILED throws > 2 two: network failed/);
});

test('a missing observation is never counted PASS', async t => {
  await assert.rejects(runProgressiveIO(t,{feature:'unobservable',input:1,levels:[
    {name:'opaque',process:x=>x,observe:()=>({}),expected:{actualStatus:'OK'}},
  ]}),/actualStatus/);
});

test('nested process receives its parent output and executes exactly once', async t => {
  const executions = [];
  const input = Object.freeze({token:2});
  const one = Object.freeze({token:3});
  const two = Object.freeze({token:6});
  const result = await runProgressiveIO(t,{feature:'lineage',input,depth:2,levels:[
    {name:'parent',process:actual=>{assert.strictEqual(actual,input);executions.push('parent');return one;},
      observe:o=>({token:o.token}),expected:{token:3}},
    {name:'child',process:actual=>{assert.strictEqual(actual,one);executions.push('child');return two;},
      observe:o=>({token:o.token}),expected:{token:6}},
  ]});
  assert.strictEqual(result.output,two);
  assert.deepEqual(executions,['parent','child']);
});

test('partial depths never execute deferred mutation', async t => {
  let mutations=0;
  const result=await runProgressiveIO(t,{feature:'partial',input:1,depth:1,levels:[
    {name:'read',process:i=>i+1,observe:o=>({output:o}),expected:{output:2}},
    {name:'mutation',process:i=>{mutations++;return i+1;},observe:o=>({output:o}),expected:{output:3}},
  ]});
  assert.equal(mutations,0);
  assert.equal(result.records.at(-1).status,'PARTIAL');
  assert.equal(result.records[1].status,'DEFERRED');
});

test('misconfigured stage with no expected observable field is rejected before execution', async t => {
  let executed=false;
  await assert.rejects(runProgressiveIO(t,{feature:'bad-contract',input:1,levels:[
    {name:'empty',process:()=>{executed=true;return 1;},observe:o=>o,expected:{}},
  ]}),/PROGRESSIVE_IO_CONFIG_INVALID/);
  assert.equal(executed,false);
});

test('wrong child input fails at INPUT boundary before process execution', async t => {
  let called=false;
  const levels=[
    {name:'parent',process:i=>({value:i.value+1}),observe:o=>o,expected:{value:2}},
    {name:'child',expectedInput:{value:4},observeInput:i=>({value:i.value}),
      process:i=>{called=true;return i;},observe:o=>o,expected:{value:2}},
  ];
  await assert.rejects(runProgressiveIO(t,{feature:'bad-input',input:{value:1},levels,depth:2}),
    /IO_DEPTH_FAILED bad-input > 2 child input/);
  assert.equal(called,false);
});
