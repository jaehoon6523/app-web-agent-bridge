import test from 'node:test';
import assert from 'node:assert/strict';
import {runProgressiveIO} from '../helpers/progressive-io.mjs';
import {dashboard} from '../helpers/dashboard-ui.mjs';

// Progressive I/O observations of the existing Dashboard; not a claim that
// every private function in app.js has been instrumented.
// IO_DEPTH=1..10 runs a single depth. No variable means the full 10-depth path.
const requestedDepth = process.env.IO_DEPTH == null ? 10 : Number(process.env.IO_DEPTH);
if (!Number.isInteger(requestedDepth) || requestedDepth < 1 || requestedDepth > 10) {
  throw new TypeError('IO_DEPTH must be an integer from 1 to 10');
}
const rawState = () => {
  const run = {id:'A',status:'WORKER_RUNNING',version:3,objective:'작업 A'};
  return {
    workflow:{stage:'WORK',state:'WORKER_RUNNING',runId:'A',runVersion:3},
    run, runs:[{runId:'A',phase:'WORKER_RUNNING',version:3,objective:'작업 A'}],
    commandCapabilities:['run.stop'],
    preflight:{checks:{}},
    dataKnowledge:{runs:{status:'AVAILABLE_NONEMPTY'}},
  };
};

function levels() {
  const chain = [
    { name:'01 입력 runId', process:async x=>({...x,target:x.selected}),
      observe:o=>({runId:o.target}),expected:{runId:'A'} },
    { name:'02 Dashboard 실행', process:async x=>({...x,ui:await dashboard(x.raw)}),
      observe:o=>({hasDashboard:Boolean(o.ui?.elements && o.ui?.calls)}),expected:{hasDashboard:true} },
    { name:'03 세션 요청', process:async x=>({...x,sessionRequest:x.ui.calls.find(c=>c.url==='/api/dashboard/session')}),
      observe:o=>({path:o.sessionRequest?.url??null}),expected:{path:'/api/dashboard/session'} },
    { name:'04 상태 요청', process:async x=>({...x,stateRequest:x.ui.calls.find(c=>c.url.startsWith('/api/state'))}),
      observe:o=>({path:o.stateRequest?.url??null}),expected:{path:'/api/state'} },
    { name:'05 원본 데이터 로드', process:async x=>({...x,rawRunId:x.raw.run.id,rawVersion:x.raw.run.version}),
      observe:o=>({runId:o.rawRunId,version:o.rawVersion}),expected:{runId:'A',version:3} },
    { name:'06 정규화 결과', process:async x=>({...x,normalized:{
      runId:x.ui.run('snapshot.run.runId'),phase:x.ui.run('snapshot.run.phase'),version:x.ui.run('snapshot.run.version'),
    }}),observe:o=>o.normalized,expected:{runId:'A',phase:'WORKER_RUNNING',version:3} },
    { name:'07 워크플로 대상', process:async x=>({...x,owner:{
      runId:x.ui.run('workflow.runId'),version:x.ui.run('workflow.runVersion'),
    }}),observe:o=>o.owner,expected:{runId:'A',version:3} },
    { name:'08 화면 렌더링', process:async x=>({...x,view:{
      title:x.ui.elements.get('runObjective').textContent,
      status:x.ui.elements.get('runStatus').textContent,
    }}),observe:o=>o.view,expected:{title:'작업 A',status:'구현·수정 중'} },
    { name:'09 화면 대상 및 조작 가능', process:async x=>({...x,controls:{
      runId:x.ui.elements.get('runPanel').dataset.runId,
      stopEnabled:!x.ui.elements.get('stopRun').disabled,
    }}),observe:o=>o.controls,expected:{runId:'A',stopEnabled:true} },
    { name:'10 실제 명령 출력', process:async x=>{
      const before=x.ui.calls.filter(c=>c.url==='/api/commands').length;
      await x.ui.run('command("run.stop")');
      const commands=x.ui.calls.filter(c=>c.url==='/api/commands');
      const command=commands.at(-1)?.body;
      return {...x,submission:{count:commands.length-before,type:command?.type??null,
        runId:command?.payload?.runId??null,version:command?.payload?.expectedVersion??null}};
    },observe:o=>o.submission,
    expected:{count:1,type:'run.stop',runId:'A',version:3} },
  ];
  // A node's INPUT is the exact prior node's OUTPUT projection, not another fixture.
  return chain.map((node,index)=>({
    ...node,
    expectedInput:index===0?{selected:'A'}:chain[index-1].expected,
    observeInput:index===0?(value=>({selected:value.selected})):chain[index-1].observe,
  }));
}

test(`Dashboard Input→Process→Output progressive depth ${requestedDepth}/10`, async t => {
  const state = rawState();
  const result = await runProgressiveIO(t,{feature:'Dashboard 상태 로드→실제 DOM→명령',
    input:{selected:'A',raw:state},levels:levels(),depth:requestedDepth});
  assert.equal(result.records.filter(x=>x.status==='PASS').length,requestedDepth);
  assert.equal(result.records.at(-1).status,requestedDepth===10?'COMPLETE':'PARTIAL');
});

test('injected DOM corruption is detected at depth 08 and cannot reach command', async t => {
  const actualLevels=levels();
  let ui;
  const normalRender=actualLevels[7].process;
  actualLevels[7]={...actualLevels[7],process:async input=>{
    ui=input.ui;
    input.ui.elements.get('runStatus').textContent='대기 중';
    return normalRender(input);
  }};
  await assert.rejects(runProgressiveIO(t,{feature:'Dashboard DOM fault',
    input:{selected:'A',raw:rawState()},levels:actualLevels,depth:10}),
    /IO_DEPTH_FAILED Dashboard DOM fault > 8/);
  assert.ok(ui);
  assert.equal(ui.calls.filter(x=>x.url==='/api/commands').length,0);
});
