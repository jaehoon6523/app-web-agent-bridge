import test from 'node:test';
import assert from 'node:assert/strict';
import {runProgressiveIO} from '../helpers/progressive-io.mjs';
import {dashboard} from '../helpers/dashboard-ui.mjs';
import {workflowForRun} from '../../src/orchestration/preparation-service.js';

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

test('one refresh renews a restarted server session and rereads state', async () => {
  const state = rawState();
  const ui = await dashboard(state);
  const requests = [];
  ui.context.fetch = async (url, {headers}) => {
    requests.push([url, headers.Authorization]);
    if (url === '/api/dashboard/session') return {ok:true, json:async () => ({token:'new-session'})};
    assert.equal(url, '/api/state');
    if (headers.Authorization === 'Bearer test') {
      return {ok:false, status:401, json:async () => ({code:'INVALID_TOKEN'})};
    }
    return {ok:true, json:async () => state};
  };
  await ui.run('refresh()');
  assert.deepEqual(requests, [
    ['/api/state', 'Bearer test'],
    ['/api/dashboard/session', undefined],
    ['/api/state', 'Bearer new-session'],
  ]);
  assert.equal(ui.run('connected'), true);
});

function prepared() {
  return {
    workflow: { stage: "PREPARE", state: "DISCUSSING", preparationId: "p1", preparationVersion: 3 },
    preparation: {
      preparationId: "p1", version: 3, objective: "  아무거나\n", targetRoot: "C:/project",
      agreement: { status: "DISCUSSING", summary: "어떤 기능이 필요한가요?", unresolvedQuestions: ["원하는 기능?"], requirements: [] },
      discussion: [{ turnId: "t1", preparationId: "p1", sequence: 1, actor: "USER", content: "아무거나" }],
      webSession: { sessionId: "s1", conversationId: "c1", conversationUrl: "https://chatgpt.com/c/c1", activeDeliveryId: "d1" },
    },
    runs: [], run: null, preflight: { checks: { extensionAuthenticated: true } }, commandCapabilities: ["preparation.reply", "web.reconcile"],
  };
}

function stateFor(run, capabilities) {
  return { workflow: workflowForRun(run), run, runs: [run], preparation: null,
    preflight: { checks: { extensionAuthenticated: true } }, commandCapabilities: capabilities,
    events: [], messages: [], assessments: [], findings: [], evidence: [] };
}

function withAvailableReviewers(state) {
  state.reviewerRuntimes = {
    JUDGE:{ availability:"AVAILABLE", provider:"CHATGPT_WEB" },
    CRITIC:{ availability:"AVAILABLE", provider:"CHATGPT_WEB" },
  };
  return state;
}

test("preparation discard confirmation follows the displayed delivery identity", async () => {
  const state = prepared();
  const prep = state.preparation;
  prep.state = "RECOVERY_REQUIRED";
  prep.deliveries = [{deliveryId:"d1",sessionId:"s1",state:"DISPATCHING"}];
  state.commandCapabilities = ["preparation.discard"];
  const ui = await dashboard(state);
  const button = ui.elements.get("discardDeliveryButton");
  const confirm = () => {
    ui.elements.get("discardUnresolved").checked = true;
    ui.elements.get("discardNoResend").checked = true;
    ui.elements.get("discardReason").value = "Original result could not be observed.";
    ui.run("render()");
    assert.equal(button.disabled, false);
  };
  confirm();
  prep.webSession.activeDeliveryId = prep.deliveries[0].deliveryId = "d2";
  prep.version = state.workflow.preparationVersion = 4;
  await ui.run("refresh()");
  assert.equal(button.disabled, true);
  confirm();
  await button.listeners.click();
  assert.equal(ui.calls.find(call => call.url === "/api/preparations/p1/discard")?.body.deliveryId, "d2");
});

test("invalid preparation abandonment requires explicit consent and resumes the same request", async () => {
  const state = prepared(), prep = state.preparation;
  prep.state = "RECOVERY_REQUIRED";
  const delivery = {deliveryId:"d1",sessionId:"s1",state:"RESPONSE_COMPLETED"};
  prep.deliveries = [delivery];
  state.commandCapabilities = ["preparation.discard","preparation.abandonInvalid"];
  const ui = await dashboard(state), button = ui.elements.get("discardDeliveryButton");
  ui.elements.get("discardUnresolved").checked = true;
  ui.elements.get("discardNoResend").checked = true;
  ui.elements.get("discardReason").value = "Keep the stored response";
  ui.run("render()");
  assert.equal(button.disabled, true);
  ui.elements.get("discardPageUnconfirmed").checked = true;
  ui.run("render()");
  assert.equal(button.disabled, false);
  await button.listeners.click();
  const first = ui.calls.find(call => call.url.endsWith("/discard")).body;
  assert.equal(first.abandonInvalidResponseConfirmed,true);
  assert.equal(first.pageStateUnconfirmedConfirmed,true);
  assert.equal(first.conversationId,"c1");
  delivery.invalidAbandonmentIntent = first;
  state.workflow.preparationVersion = prep.version = 4;
  await ui.run("refresh()");
  await button.listeners.click();
  assert.deepEqual(ui.calls.filter(call => call.url.endsWith("/discard")).at(-1).body, first);
});

test("a delayed deletion result preserves the run selected after submission", async () => {
  const first = {runId:"delete-A",version:4,phase:"APPLIED",objective:"Delete this task"};
  const second = {runId:"keep-B",version:9,phase:"APPLIED",objective:"Keep viewing this task"};
  const state = stateFor(first, ["run.delete"]);
  state.runs = [first,second];
  const {promise, resolve} = Promise.withResolvers();
  const ui = await dashboard(state, async () => promise);
  const deletion = ui.run('command("run.delete")');
  Object.assign(state, stateFor(second, []));
  ui.run('openRun("keep-B")');
  await ui.run("refresh()");
  assert.equal(ui.elements.get("runPanel").dataset.runId, second.runId);
  resolve({payload:{runId:first.runId,deleted:true}});
  await deletion;
  assert.equal(ui.run("selected"), second.runId);
  assert.equal(ui.elements.get("runPanel").dataset.runId, second.runId);
  assert.equal(ui.calls.at(-1).url, "/api/state?runId=keep-B");
});

test("a late operator note success preserves an identical draft on another run", async () => {
  const first = {runId:"notes-A",version:4,phase:"APPLIED",objective:"Original run"};
  const second = {runId:"view-B",version:9,phase:"APPLIED",objective:"Other run"};
  const state = stateFor(first, ["run.note.add"]);
  const {promise, resolve} = Promise.withResolvers();
  const ui = await dashboard(state, async () => promise);
  const input = ui.elements.get("operatorNoteText");
  const submit = ui.elements.get("addOperatorNote");
  const text = "Same note on both runs";
  input.value = text;
  input.listeners.input();
  assert.equal(submit.disabled, false);
  const pending = submit.listeners.click();
  assert.equal(ui.calls.find(call => call.url === "/api/commands").body.payload.runId, first.runId);

  Object.assign(state, stateFor(second, ["run.note.add"]));
  ui.run('openRun("view-B")');
  await ui.run("refresh()");
  assert.equal(ui.elements.get("runPanel").dataset.runId, second.runId);
  input.value = text;
  input.listeners.input();
  resolve({payload:{runId:first.runId,status:"RECORDED",noteId:"note-A"}});
  await pending;
  assert.equal(input.value, text);
});

test("a late unknown result and receipt never write status on another run", async () => {
  const first = {runId:"notes-A",version:4,phase:"APPLIED",objective:"Original run"};
  const second = {runId:"view-B",version:9,phase:"APPLIED",objective:"Other run"};
  const state = stateFor(first, ["run.note.add"]);
  const {promise,reject} = Promise.withResolvers();
  const ui = await dashboard(state, async () => promise);
  const fetch = ui.context.fetch;
  let receiptStatus = "NOT_FOUND";
  ui.context.fetch = (url, options) => url === "/api/state?requestId=request-1"
    ? Promise.resolve({ok:true,json:async () => ({requestResult:{requestId:"request-1",status:receiptStatus}})})
    : fetch(url, options);
  const pending = ui.run('command("run.note.add", {kind:"NOTE",text:"note on A"})');
  Object.assign(state, stateFor(second, []));
  ui.run('openRun("view-B")');
  await ui.run("refresh()");
  reject(Object.assign(new Error("lost reply"), {name:"TimeoutError"}));
  await pending;
  assert.equal(ui.run("operations.runCommand"), "UNKNOWN_RESULT");
  receiptStatus = "FAILED";
  await ui.run("refresh()");
  assert.equal(ui.elements.get("runPanel").dataset.runId, second.runId);
  assert.equal(ui.elements.get("commandResult").textContent, "");
  assert.equal(ui.run("operations.runCommand"), "IDLE");
});

for (const phase of ["AWAITING_APPLY", "RECOVERY_REQUIRED"]) {
  test(`review retry is reachable from ${phase} when authorized by the server`, async () => {
    const run = { runId:"review-recovery", version:5, phase, objective:"Recover the same candidate" };
    const ui = await dashboard(withAvailableReviewers(stateFor(run, ["code.review.retry"])));
    assert.equal(ui.elements.get("retryRun").disabled, false);
    await ui.elements.get("retryRun").listeners.click();
    assert.deepEqual(ui.calls.find(call => call.url === "/api/commands")?.body.payload,
      {runId:run.runId, expectedVersion:run.version});
  });
}

test("uncertain audit retry is not sent twice without a settled receipt", async () => {
  const run = { runId: "run-timeout", version: 3, phase: "HOLD", objective: "Greeting" };
  const state = withAvailableReviewers(stateFor(run, ["code.review.retry"]));
  const ui = await dashboard(state, async () => {
    throw Object.assign(new Error("request timed out"), { name: "TimeoutError" });
  });
  await ui.elements.get("retryRun").listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.elements.get("retryRun").disabled, true);
  await ui.elements.get("retryRun").listeners.click();
  assert.equal(ui.calls.filter(({ url }) => url === "/api/commands").length, 1);
  assert.ok(ui.calls.some(({ url }) => url === "/api/state?requestId=request-1"), JSON.stringify({ calls: ui.calls, connected: ui.run("connected"), state: ui.run("operations.runCommand") }));
  assert.match(ui.elements.get("commandResult").textContent, /같은 요청을 자동으로 다시 보내지 않습니다/u);
  const fetch = ui.context.fetch;
  ui.context.fetch = (url, options) => url === "/api/state?requestId=request-1"
    ? Promise.resolve({ok:true,json:async () => ({requestResult:{requestId:"request-1",status:"FAILED"}})})
    : fetch(url, options);
  await ui.run("refresh()");
  assert.equal(ui.elements.get("retryRun").disabled, false);
  assert.match(ui.elements.get("commandResult").textContent, /request-1: FAILED/u);
});
