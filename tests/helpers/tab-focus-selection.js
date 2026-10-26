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

test('same-owner read updates permission without replacing selection; changed candidates invalidate it', async()=>{
  const state=fixture(), ui=await dashboard(state);
  const choice=()=>ui.elements.get('proposalSummary').children.find(x=>x.className==='preparation-tab-choice');
  const root=choice(), radio=root.querySelectorAll('input')[0];
  const send=()=>choice().querySelectorAll('button').find(x=>x.className==='tab-choice-send');
  radio.checked=true;radio.listeners.change();
  ui.elements.get('objective').value='unsaved objective';ui.elements.get('conversationUrl').value='https://chatgpt.com/c/draft';
  let release;const fetch=ui.context.fetch;
  ui.context.fetch=async(...args)=>{await new Promise(resolve=>{release=resolve;});return fetch(...args);};
  const pending=ui.run('refresh()');await new Promise(setImmediate);
  assert.equal(ui.run('projectDashboardKnowledge(connectionState).session.currentlyVerified'),true,'transport/auth survives a read');
  assert.equal(ui.run('dashboardStateReady(connectionState)'),false);
  assert.equal(choice(),root,'[permission → DOM] pending read must not recreate the same choice');
  assert.equal(radio.checked,true);assert.equal(send().disabled,true);
  await send().listeners.click();assert.equal(ui.calls.filter(x=>x.url==='/api/preparations/web').length,0);
  release();await pending;ui.context.fetch=fetch;
  assert.equal(choice(),root);assert.equal(radio.checked,true);assert.equal(send().disabled,false);
  assert.equal(ui.elements.get('objective').value,'unsaved objective');
  assert.equal(ui.elements.get('conversationUrl').value,'https://chatgpt.com/c/draft');
  const oldSend=send();state.preparation.error.details.candidates[0].url='https://chatgpt.com/c/replaced';
  await ui.run('refresh()');assert.notEqual(choice(),root);
  assert.equal(choice().querySelectorAll('input')[0].checked,false,'changed candidate identity requires a new explicit choice');
  oldSend.disabled=false;await oldSend.listeners.click();
  assert.equal(ui.calls.filter(x=>x.url==='/api/preparations/web').length,0,'stale handlers cannot submit');
  ui.context.fetch=(url,...args)=>url==='/api/preparations/web'
    ? (ui.calls.push({url}),Promise.resolve({ok:false,status:409,json:async()=>({error:{code:'TAB_CLOSED',message:'tab closed'}})}))
    : fetch(url,...args);
  choice().querySelectorAll('input')[1].listeners.change();await send().listeners.click();
  const recover=choice().querySelectorAll('button').find(x=>x.textContent==='후보 다시 보기');
  await recover.listeners.click();
  assert.equal(send().disabled,true,'known rejection requires a new explicit selection after recovery');
  assert.equal(choice().querySelectorAll('input').some(x=>x.checked),false);
  assert.equal(ui.calls.filter(x=>x.url==='/api/preparations/web').length,1,'recovery must not resend');

});


test('a late rejected rebind cannot poison a newer preparation version', async()=>{
  const state=fixture(),ui=await dashboard(state),fetch=ui.context.fetch;let release;
  ui.context.fetch=(url,...args)=>url==='/api/preparations/web'
    ? new Promise(resolve=>{ui.calls.push({url});release=resolve;}) : fetch(url,...args);
  const choice=()=>ui.elements.get('proposalSummary').children.find(x=>x.className==='preparation-tab-choice');
  const send=()=>choice().querySelectorAll('button').find(x=>x.className==='tab-choice-send');
  choice().querySelectorAll('input')[0].listeners.change();const pending=send().listeners.click();
  await new Promise(setImmediate);
  state.preparation.version++;state.workflow.preparationVersion=state.preparation.version;
  await ui.run('refresh()');
  release({ok:false,status:409,json:async()=>({error:{code:'TAB_CLOSED',message:'old tab closed'}})});
  await pending;
  assert.equal(ui.run('preparation.version'),4);
  assert.equal(ui.run('tabChoiceFailures.has("d1")'),false,'old-version refusal must not become the new version recovery state');
  choice().querySelectorAll('input')[1].listeners.change();assert.equal(send().disabled,false);
  assert.equal(ui.calls.filter(x=>x.url==='/api/preparations/web').length,1,'version recovery must never auto resend');
});

}
