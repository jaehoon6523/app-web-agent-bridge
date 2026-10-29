import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTabFocusDeadlineTests } from './tab-focus-deadlines.js';

export function registerTabFocusUiContract({dashboard, prepared}) {
  function state() {
    const value = prepared();
    value.preparation.state = 'WEB_BLOCKED';
    value.preparation.error = {code:'WEB_TAB_SELECTION_REQUIRED',details:{candidates:[
      {tabId:7,url:'https://chatgpt.com/'},{tabId:8,url:'https://chatgpt.com/'}]}};
    value.commandCapabilities = ['web.rebind'];
    return value;
  }
  const root = ui => ui.elements.get('proposalSummary').children.find(x=>x.className==='preparation-tab-choice');
  const view = (ui,index=0) => root(ui).querySelectorAll('button').filter(x=>x.className==='tab-choice-view')[index];
  const refresh = ui => root(ui).querySelectorAll('button').find(x=>x.textContent==='최신 상태 조회');
  const reason = ui => root(ui).querySelectorAll('p').find(x=>x.className==='tab-choice-reason').textContent;
  const observed = {tabs:[{tabId:7,url:'https://chatgpt.com/'},{tabId:8,url:'https://chatgpt.com/'}]};
  const timeout = () => {throw Object.assign(new Error('timeout'),{code:'WEB_RESPONSE_TIMEOUT'});};
  registerTabFocusDeadlineTests({dashboard,state,view,refresh,reason,observed,timeout});

  test('old inspection cannot unlock a new preparation version; fresh recovery works',async()=>{
    const current=state();let release,hold=true;
    const ui=await dashboard(current,async url=>{
      if(url==='/api/preparations/tab-focus')return timeout();
      if(url==='/api/selector-diagnostics')return hold ? new Promise(resolve=>{release=resolve;}) : observed;
    });
    await view(ui).listeners.click();
    const stateReads=ui.calls.filter(x=>x.url.startsWith('/api/state')).length;
    const pending=refresh(ui).listeners.click();await new Promise(setImmediate);
    assert.equal(typeof release,'function','recovery must perform a read-only inspection');
    assert.equal(ui.calls.filter(x=>x.url.startsWith('/api/state')).length,stateReads+1,'server read starts before inspection settles');
    current.preparation.version=4;current.workflow.preparationVersion=4;await ui.run('refresh()');
    assert.equal(view(ui).disabled,true);
    release(observed);await pending;
    assert.equal(view(ui).disabled,true,'v3 observation must not unlock v4');
    hold=false;await refresh(ui).listeners.click();assert.equal(view(ui).disabled,false);
  });

  test('failed tab inspection still refreshes server state and permits another candidate',async()=>{
    let fail=true;
    const ui=await dashboard(state(),async url=>{
      if(url==='/api/preparations/tab-focus')return timeout();
      if(url==='/api/selector-diagnostics') {
        if(fail)throw Object.assign(new Error('inspection failed'),{code:'TAB_INSPECTION_TIMEOUT'});
        return observed;
      }
    });
    await view(ui).listeners.click();
    const before=ui.calls.filter(x=>x.url.startsWith('/api/state')).length;
    await refresh(ui).listeners.click();
    assert.equal(ui.calls.filter(x=>x.url.startsWith('/api/state')).length,before+1);
    assert.equal(view(ui).disabled,true,'unobserved target stays protected');
    assert.equal(view(ui,1).disabled,false,'unrelated candidate is not permanently blocked');
    assert.match(reason(ui),/서버 상태.*조회/);assert.match(reason(ui),/탭.*확인.*못/);
    fail=false;await refresh(ui).listeners.click();assert.equal(view(ui).disabled,false);
  });

  test('confirmed success that is inapplicable is never displayed as unknown execution',async()=>{
    const ui=await dashboard(state(),async()=>{throw Object.assign(new Error('stale'),{
      code:'TAB_FOCUS_STALE',executionOutcome:'SUCCEEDED',applicable:false});});
    await view(ui).listeners.click();
    assert.match(reason(ui),/탭 이동은 확인/);assert.match(reason(ui),/적용하지 않았/);
    assert.doesNotMatch(reason(ui),/미확인/);
  });

  for (const changed of ['version','session']) test(`delayed view success cannot unlock a new preparation ${changed}`,async()=>{
    const current=state();let release;
    const ui=await dashboard(current,async()=>new Promise(resolve=>{release=resolve;}));
    const pending=view(ui).listeners.click();await new Promise(setImmediate);
    if(changed==='version')current.preparation.version=4;
    else current.preparation.webSession.sessionId='s2';
    await ui.run('refresh()');
    release({opened:true,tabId:7});await pending;
    assert.equal(view(ui).disabled,true,'new context needs its own observation');
    assert.doesNotMatch(reason(ui),/탭 화면만 열었습니다/);
  });

  test('changed candidate URL invalidates inspection even without a version change',async()=>{
    const current=state();let release;
    const ui=await dashboard(current,async url=>url==='/api/preparations/tab-focus' ? timeout()
      : new Promise(resolve=>{release=resolve;}));
    await view(ui).listeners.click();const pending=refresh(ui).listeners.click();await new Promise(setImmediate);
    current.preparation.error.details.candidates[0].url='https://chatgpt.com/c/new';await ui.run('refresh()');
    release(observed);await pending;assert.equal(view(ui).disabled,true);
  });

  test('successful inspection cannot bypass a failed server refresh',async()=>{
    const ui=await dashboard(state(),async url=>url==='/api/preparations/tab-focus' ? timeout() : observed);
    await view(ui).listeners.click();const original=ui.context.fetch;
    ui.context.fetch=async (url,options)=>url.startsWith('/api/state')
      ? {ok:false,status:503,json:async()=>({code:'UNAVAILABLE'})} : original(url,options);
    await refresh(ui).listeners.click();assert.equal(view(ui).disabled,true);assert.equal(refresh(ui).disabled,false);
    assert.match(reason(ui),/서버 상태를 불러오지 못/);
    ui.context.fetch=original;await refresh(ui).listeners.click();assert.equal(view(ui).disabled,false);
  });

  test('an earlier inspection cannot clear a newer focus failure on another candidate',async()=>{
    let release;
    const ui=await dashboard(state(),async url=>url==='/api/preparations/tab-focus' ? timeout()
      : new Promise(resolve=>{release=resolve;}));
    await view(ui).listeners.click();const pending=refresh(ui).listeners.click();await new Promise(setImmediate);
    assert.equal(view(ui,1).disabled,false);
    await view(ui,1).listeners.click();assert.equal(view(ui,1).disabled,true);
    release(observed);await pending;
    assert.equal(view(ui,1).disabled,true);assert.match(reason(ui),/미확인/);
  });

  test('recovering one candidate does not clear a different unconfirmed candidate',async()=>{
    let inspections=0;
    const ui=await dashboard(state(),async url=>{
      if(url==='/api/preparations/tab-focus')return timeout();
      if(++inspections===1)throw new Error('first target unavailable');
      return observed;
    });
    await view(ui).listeners.click();await refresh(ui).listeners.click();
    assert.equal(view(ui).disabled,true);assert.equal(view(ui,1).disabled,false);
    await view(ui,1).listeners.click();await refresh(ui).listeners.click();
    assert.equal(view(ui,1).disabled,false);assert.equal(view(ui).disabled,true);
    await refresh(ui).listeners.click();assert.equal(view(ui).disabled,false);
  });
}
