import test from 'node:test';
import assert from 'node:assert/strict';
function fixture(){return {
  workflow:{stage:'PREPARE',state:'DISCUSSING',preparationId:'p1',preparationVersion:3},
  preparation:{preparationId:'p1',version:3,state:'WEB_BLOCKED',lifecycle:'ACTIVE',objective:'handoff',targetRoot:'C:/project',
    agreement:{status:'DISCUSSING',summary:'handoff',unresolvedQuestions:[],requirements:[]},
    discussion:[{turnId:'t1',preparationId:'p1',sequence:1,actor:'USER',content:'handoff'}],
    webSession:{sessionId:'s1',conversationId:'c1',conversationUrl:'https://chatgpt.com/c/c1',activeDeliveryId:'d1'},
    error:{code:'WEB_TAB_SELECTION_REQUIRED',details:{browserDispatchStarted:false,candidates:[
      {tabId:7,url:'https://chatgpt.com/'},{tabId:8,url:'https://chatgpt.com/'}]}}},
  runs:[],run:null,preflight:{checks:{extensionAuthenticated:true}},commandCapabilities:['web.rebind','preparation.cancel']};}

export function registerCandidateSelectionTests(dashboard) {
for (const rerender of [false,true]) test(`selected unconfirmed candidate stays blocked across recovery (rerender=${rerender})`,async()=>{
  const state=fixture();let inspected=false;
  const ui=await dashboard(state,async url=>{
    if(url==='/api/preparations/tab-focus')throw Object.assign(new Error('timeout'),{code:'WEB_RESPONSE_TIMEOUT'});
    if(url==='/api/selector-diagnostics') {
      if(!inspected)throw new Error('inspection unavailable');
      return {tabs:state.preparation.error.details.candidates};
    }
    return {};
  });
  const choice=()=>ui.elements.get('proposalSummary').children.find(x=>x.className==='preparation-tab-choice');
  const buttons=()=>choice().querySelectorAll('button');
  const refresh=()=>buttons().find(x=>x.textContent==='최신 상태 조회');
  const send=()=>buttons().find(x=>x.className==='tab-choice-send');
  const radio=()=>choice().querySelectorAll('input');
  radio()[0].listeners.change();const oldSend=send(),oldRadio=radio()[0];
  await buttons().find(x=>x.className==='tab-choice-view').listeners.click();
  if(rerender)await ui.run('refresh()');
  await refresh().listeners.click();
  assert.equal(radio()[0].disabled,true);assert.equal(radio()[1].disabled,false);
  assert.equal(send().disabled,true);
  oldRadio.listeners.change();oldSend.disabled=false;await oldSend.listeners.click();
  assert.equal(ui.calls.filter(x=>x.url==='/api/preparations/web').length,0);
  inspected=true;await refresh().listeners.click();
  radio()[0].listeners.change();await send().listeners.click();
  const requests=ui.calls.filter(x=>x.url==='/api/preparations/web');
  assert.equal(requests.length,1);assert.equal(requests[0].body.selectedTabId,7);
});

test('old selection handlers cannot send after preparation version changes; another candidate remains usable',async()=>{
  const state=fixture();
  const ui=await dashboard(state,async url=>{
    if(url==='/api/preparations/tab-focus')throw Object.assign(new Error('timeout'),{code:'WEB_RESPONSE_TIMEOUT'});
    if(url==='/api/selector-diagnostics')throw new Error('unavailable');
    return {};
  });
  const choice=()=>ui.elements.get('proposalSummary').children.find(x=>x.className==='preparation-tab-choice');
  const button=name=>choice().querySelectorAll('button').find(x=>x.className===name);
  const oldRadio=choice().querySelectorAll('input')[0], oldSend=button('tab-choice-send');
  oldRadio.listeners.change();await button('tab-choice-view').listeners.click();
  state.preparation.version=4;state.workflow.preparationVersion=4;await ui.run('refresh()');
  await button('tab-choice-refresh').listeners.click();
  oldRadio.listeners.change();oldSend.disabled=false;await oldSend.listeners.click();
  assert.equal(ui.calls.filter(x=>x.url==='/api/preparations/web').length,0);
  choice().querySelectorAll('input')[1].listeners.change();await button('tab-choice-send').listeners.click();
  const requests=ui.calls.filter(x=>x.url==='/api/preparations/web');
  assert.equal(requests.length,1);assert.equal(requests[0].body.selectedTabId,8);
});

test('handoff: an unconfirmed candidate must not generate a rebind request',async()=>{
  const ui=await dashboard(fixture(),async url=>{
    if(url==='/api/preparations/tab-focus')throw Object.assign(new Error('timeout'),{code:'WEB_RESPONSE_TIMEOUT'});
    if(url==='/api/selector-diagnostics')throw Object.assign(new Error('cannot inspect'),{code:'TAB_INSPECTION_TIMEOUT'});
    return {};
  });
  const choice=()=>ui.elements.get('proposalSummary').children.find(element=>element.className==='preparation-tab-choice');
  const view=()=>choice().querySelectorAll('button').find(element=>element.className==='tab-choice-view');
  const button=label=>choice().querySelectorAll('button').find(element=>element.textContent===label);
  await view().listeners.click();await button('최신 상태 조회').listeners.click();
  const radio=choice().querySelectorAll('input')[0];
  const selectionBlocked=radio.disabled;
  // Direct invocation also tests the event-handler guard, beyond disabled styling.
  radio.listeners.change();
  const send=button('이 탭에서 요청 전송 계속'),submitBlocked=send.disabled;
  await send.listeners.click();
  const requests=ui.calls.filter(call=>call.url==='/api/preparations/web');
  console.log('HANDOFF_EVIDENCE',JSON.stringify({case:'unconfirmed_candidate',selectionBlocked,submitBlocked,requests}));
  assert.equal(requests.length,0,'an unconfirmed target must never generate web.rebind');
  assert.equal(selectionBlocked,true);
  assert.equal(submitBlocked,true);
});
}
