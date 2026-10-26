import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import {
  firstLoadBrowser, faultPeer, deferred, credentialDigest,
  expectBlocked, expectCode, expectReachable,
} from '../tests/helpers/dashboard-first-load-browser.mjs';

// Run explicitly: npm run test:first-load. Browser tests are kept out of the
// default Node unit discovery. No app source, AbortSignal or timer is replaced.
const SESSION = '/api/dashboard/session', STATE = '/api/state';
const options = { timeout:40000 };
const json = (route, status, body) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(body) });

function loadedRunState(base, id, phase = 'WORKER_RUNNING', aliases = false) {
  const run = {runId:id, phase, version:3, objective:`작업 ${id}`, requirements:{items:[]}, extensionField:{retained:true}};
  const state = {...base,run:{...run},preparation:null,
    workflow:{stage:phase === 'APPLIED' ? 'RESULT' : 'WORK',state:phase,runId:id,runVersion:3},
    runs:[run,{...run,runId:id === 'A' ? 'B' : 'A',objective:`작업 ${id === 'A' ? 'B' : 'A'}`}],
    dataKnowledge:{runs:{status:'AVAILABLE_NONEMPTY'}},commandCapabilities:['run.stop'],extensionField:{retained:true}};
  if (aliases) {state.run.id=id;state.run.status=phase;delete state.run.runId;delete state.run.phase;}
  return state;
}

test('[데이터 전달/렌더링] actual browser shows normalized title/status/ID and sends the same command target', options, async t => {
  let command;
  const f = await firstLoadBrowser(t, {expectedCommands:['run.stop'],intercept:async ({route,pathname}) => {
    if(pathname === '/api/commands') {command=route.request().postDataJSON();await json(route,200,{payload:{}});return true;}
    if(pathname !== STATE) return false;
    const base=await (await route.fetch()).json();await json(route,200,loadedRunState(base,'A','WORKER_RUNNING',true));return true;
  }});
  await f.open();await f.ready();
  assert.equal(await f.page.locator('#runObjective').innerText(),'작업 A');
  assert.equal(await f.page.locator('#runStatus').innerText(),'구현·수정 중','[데이터 렌더링] #runStatus 기대=구현·수정 중');
  assert.equal(await f.page.locator('#runPanel').getAttribute('data-run-id'),'A');
  assert.match(await f.page.locator('#runTime').innerText(),/작업 ID A · 버전 3/u);
  assert.equal(await f.page.locator('#stepWork').getAttribute('aria-current'),'step');
  await f.page.locator('#runSecondaryTier > summary').click();
  const refreshed=f.page.waitForResponse(r=>new URL(r.url()).pathname === STATE);
  await f.page.locator('#stopRun').click();await refreshed;
  assert.equal(command.payload.runId,'A');assert.equal(command.payload.expectedVersion,3);
  t.diagnostic(JSON.stringify({contract:'normalized DOM and command',title:await f.page.locator('#runObjective').innerText(),
    status:await f.page.locator('#runStatus').innerText(),displayedRunId:await f.page.locator('#runPanel').getAttribute('data-run-id'),commandRunId:command.payload.runId,version:command.payload.expectedVersion}));
});

test('[로딩 연결] actual browser ignores late A after B and blocks commands while switching', options, async t => {
  const held=deferred(),release=deferred(),delivered=deferred();let holdA=false,command;
  const f=await firstLoadBrowser(t,{expectedCommands:['run.stop'],intercept:async({route,pathname})=>{
    if(pathname==='/api/commands') {command=route.request().postDataJSON();await json(route,200,{payload:{}});return true;}
    if(pathname!==STATE)return false;
    const id=new URL(route.request().url()).searchParams.get('runId') || 'A';
    const base=await (await route.fetch()).json();
    if(id==='A' && holdA) {holdA=false;held.resolve();await release.promise;await json(route,200,loadedRunState(base,'A'));delivered.resolve();}
    else await json(route,200,loadedRunState(base,id,id==='B'?'HOLD':'WORKER_RUNNING'));
    return true;
  }});
  f.owner.add('release dashboard A',()=>release.resolve(),0);
  await f.open();await f.ready();holdA=true;
  await f.page.locator('#runList .run-item').filter({hasText:'작업 A'}).click();await held.promise;
  assert.equal(await f.page.locator('#stopRun').isDisabled(),true,'[로딩 연결] LOADING 명령 차단');
  await f.page.locator('#runList .run-item').filter({hasText:'작업 B'}).click();await f.ready();
  assert.equal(await f.page.locator('#runObjective').innerText(),'작업 B');
  assert.equal(await f.page.locator('#runStatus').innerText(),'확인 필요');
  assert.equal(await f.page.locator('#runPanel').getAttribute('data-run-id'),'B');
  assert.match(await f.page.locator('#runTime').innerText(),/작업 ID B · 버전 3/u);
  release.resolve();await delivered.promise;
  await f.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await f.page.locator('#runObjective').innerText(),'작업 B');
  assert.equal(await f.page.locator('#runPanel').getAttribute('data-run-id'),'B');
  assert.match(await f.page.locator('#runList .run-item.active').innerText(),/작업 B/u);
  await f.page.locator('#runSecondaryTier > summary').click();
  const refreshed=f.page.waitForResponse(r=>new URL(r.url()).pathname===STATE);
  await f.page.locator('#stopRun').click();await refreshed;
  assert.equal(command.payload.runId,'B');assert.equal(command.payload.expectedVersion,3);
  t.diagnostic(JSON.stringify({contract:'late A ignored after B',title:await f.page.locator('#runObjective').innerText(),
    status:await f.page.locator('#runStatus').innerText(),displayedRunId:await f.page.locator('#runPanel').getAttribute('data-run-id'),commandRunId:command.payload.runId}));
});

test('[로딩 연결] same-run failure labels the last confirmed data and normal recovery removes the stale notice',options,async t=>{
  let broken=false;
  const f=await firstLoadBrowser(t,{intercept:async({route,pathname})=>{
    if(pathname!==STATE)return false;
    if(broken)await route.fulfill({status:200,contentType:'application/json',body:'{"run":'});
    else {const base=await(await route.fetch()).json();await json(route,200,loadedRunState(base,'A'));}
    return true;
  }});
  await f.open();await f.ready();broken=true;
  await f.page.locator('#refreshDashboard').click();await expectCode(f.page,'INVALID_SERVER_RESPONSE');
  assert.equal(await f.page.locator('#runObjective').innerText(),'작업 A');
  assert.equal(await f.page.locator('#runStatus').innerText(),'구현·수정 중');
  assert.equal(await f.page.locator('#runPanel').getAttribute('data-load-state'),'ERROR');
  assert.match(await f.page.locator('#connectionNotice').innerText(),/마지막 확인 데이터/u);
  assert.equal(await f.page.locator('#stopRun').isDisabled(),true);
  broken=false;await f.page.locator('#refreshDashboard').click();await f.ready();
  assert.equal(await f.page.locator('#runPanel').getAttribute('data-load-state'),'READY');
  assert.doesNotMatch(await f.page.locator('#connectionNotice').innerText(),/마지막 확인 데이터/u);
});

for(const fault of ['json','http','network','wrong-run','wrong-version']) {
  test(`[데이터 로드/로딩 연결] browser ${fault} for B cannot publish A or enable commands and recovers`,options,async t=>{
    let broken=true;
    const f=await firstLoadBrowser(t,{intercept:async({route,pathname})=>{
      if(pathname!==STATE)return false;
      const id=new URL(route.request().url()).searchParams.get('runId')||'A';
      if(id==='B' && broken) {
        if(fault==='network')await route.abort();
        else if(fault==='json')await route.fulfill({status:200,contentType:'application/json',body:'{"run":'});
        else if(fault==='http')await json(route,503,{error:'controlled read failure'});
        else {const base=await(await route.fetch()).json();const state=loadedRunState(base,fault==='wrong-run'?'A':'B');if(fault==='wrong-version')state.run.version=2;await json(route,200,state);}
        return true;
      }
      const base=await(await route.fetch()).json();await json(route,200,loadedRunState(base,id));return true;
    }});
    await f.open();await f.ready();
    await f.page.locator('#runList .run-item').filter({hasText:'작업 B'}).click();
    await f.page.waitForFunction(()=>document.getElementById('dashboardErrorCode').textContent!=='없음');
    assert.equal(await f.page.locator('#runPanel').isHidden(),true,'[로딩 연결] 실패한 B에 A 상세 표시 금지');
    assert.equal(await f.page.locator('#runPanel').getAttribute('data-load-state'),'ERROR');
    assert.equal(await f.page.locator('#stopRun').isDisabled(),true);
    broken=false;await f.page.locator('#refreshDashboard').click();await f.ready();
    assert.equal(await f.page.locator('#runObjective').innerText(),'작업 B');
    assert.equal(await f.page.locator('#runStatus').innerText(),'구현·수정 중');
    assert.equal(await f.page.locator('#runPanel').getAttribute('data-run-id'),'B');
    assert.equal(await f.page.locator('#runPanel').getAttribute('data-load-state'),'READY');
  });
}

test('FL-01: real first load authenticates before state and does not bypass missing dependencies', options, async t => {
  const f = await firstLoadBrowser(t);
  await f.open(); await f.ready();
  const [session, state] = f.requests;
  assert.equal(session.pathname, SESSION); assert.equal(session.method, 'POST');
  assert.equal(session.credential, null);
  assert.equal(state.pathname, STATE); assert.equal(state.method, 'GET');
  assert.equal(typeof state.credential, 'string');
  assert.equal(f.count(SESSION), 1); assert.equal(f.count(STATE), 1);
  await expectBlocked(f.page, {folder:false});
  assert.equal(await f.page.locator('#chooseFolder').isEnabled(), true);
  assert.match(await f.page.locator('#historyFilterSummary').textContent(), /작업 기록 조회 불가/u);
});

for (const variant of ['missing-token', 'json-syntax', 'rejected-origin']) {
  test(`FL-02/${variant}: invalid session never reaches state and polling requests a session again`, options, async t => {
    let fault = true;
    const code = variant === 'missing-token' ? 'DASHBOARD_SESSION_INVALID'
      : variant === 'json-syntax' ? 'INVALID_SERVER_RESPONSE' : 'LOCAL_BROWSER_REQUIRED';
    const f = await firstLoadBrowser(t, { intercept:async ({route, pathname}) => {
      if (pathname !== SESSION || !fault) return false;
      if (variant === 'json-syntax') await route.fulfill({status:200, contentType:'application/json', body:'{"token":'});
      else await json(route, variant === 'rejected-origin' ? 403 : 200,
        variant === 'rejected-origin' ? {code, message:'Controlled origin rejection'} : {});
      return true;
    } });
    await f.open(); await expectCode(f.page, code);
    await expectReachable(f.page); await expectBlocked(f.page);
    assert.equal(f.count(STATE), 0, 'no state request may use an absent/unverified token');
    const sessions = f.count(SESSION);
    fault = false;
    await f.ready();
    assert.ok(f.count(SESSION) > sessions, 'poll must issue another session POST');
    assert.ok(f.requests.findLast(r => r.pathname === STATE).credential);
  });
}

test('FL-03: invalid state JSON fails after HTTP receipt and recovers without replacing the session', options, async t => {
  let fault = true;
  const f = await firstLoadBrowser(t, { intercept:async ({route, pathname}) => {
    if (pathname !== STATE || !fault) return false;
    await route.fulfill({status:200, contentType:'application/json', body:'{"runs":'}); return true;
  } });
  await f.open(); await expectCode(f.page, 'INVALID_SERVER_RESPONSE');
  await expectReachable(f.page); await expectBlocked(f.page, {folder:false});
  assert.equal(await f.page.locator('#sessionHealth').evaluate(el => el.classList.contains('ok')), true);
  fault = false; await f.ready();
  assert.equal(f.count(SESSION), 1, 'a parse failure must not discard valid authentication');
});

for (const status of [401, 403]) {
  test(`FL-04/${status}: rejected state clears the credential before the next session POST and state GET`, options, async t => {
    let fault = true;
    const refreshedCredential = deferred();
    const f = await firstLoadBrowser(t, { intercept:async ({route, pathname}) => {
      if (pathname === STATE && fault) {
        await json(route, status, {code:'DASHBOARD_AUTH_INVALID', message:'Controlled authentication rejection'}); return true;
      }
      return false;
    } });
    // Keep this browser POST untouched: route.fetch() would use an API client
    // and lose browser-only Sec-Fetch-* headers required by verifyLocalBrowser.
    f.page.on('response', async response => {
      if (new URL(response.url()).pathname === SESSION && !fault && response.status() === 200)
        refreshedCredential.resolve(credentialDigest((await response.json()).token));
    });
    await f.open(); await expectCode(f.page, 'DASHBOARD_AUTH_INVALID');
    await expectReachable(f.page); await expectBlocked(f.page);
    const rejectedIndex = f.requests.findLastIndex(r => r.pathname === STATE);
    fault = false; await f.ready();
    const retry = f.requests.slice(rejectedIndex+1);
    assert.equal(retry[0].pathname, SESSION); assert.equal(retry[0].method, 'POST');
    assert.equal(retry[0].credential, null, 'discarded credential must not leak into reauthentication');
    assert.equal(retry[1].pathname, STATE); assert.equal(retry[1].method, 'GET');
    assert.equal(retry[1].credential, await refreshedCredential.promise, 'state must use the credential returned by reauthentication');
    assert.equal(f.count(SESSION), 2);
    // The server intentionally reuses a process-lifetime browser token. Token
    // rotation is not required; the POST and its use are the observed contract.
  });
}

for (const endpoint of [SESSION, STATE]) {
  test(`FL-05/${endpoint}: actual ten-second header timeout blocks actions and polling recovers`, options, async t => {
    let fault = true, peer;
    const received = deferred();
    const f = await firstLoadBrowser(t, { intercept:async ({route, pathname}) => {
      if (pathname !== endpoint || !fault) return false;
      await route.continue({url:peer+pathname}); return true;
    } });
    peer = await faultPeer(f, () => { received.resolve(performance.now()); });
    await f.open();
    const started = await received.promise;
    await expectCode(f.page, 'REQUEST_UNREACHABLE');
    const elapsed = performance.now()-started;
    assert.ok(elapsed >= 9500 && elapsed < 13000, `actual header timeout was ${Math.round(elapsed)}ms`);
    assert.match(await f.page.locator('#connectionNotice').textContent(), /서버 응답 없음/u);
    assert.doesNotMatch(await f.page.locator('#dashboardErrorCode').textContent(), /UNKNOWN_RESULT/u);
    await expectBlocked(f.page);
    const sessions = f.count(SESSION);
    if (endpoint === SESSION) assert.equal(f.count(STATE), 0);
    fault = false; await f.ready();
    assert.equal(f.count(SESSION), endpoint === SESSION ? sessions+1 : sessions);
    t.diagnostic(JSON.stringify({endpoint, observedTimeoutMs:Math.round(elapsed), realTenSecondTimeout:true}));
  });
}

test('FL-06: received headers plus a hanging body produces RESPONSE_READ_FAILED and keeps reachability', options, async t => {
  let fault = true, peer;
  const received = deferred();
  const f = await firstLoadBrowser(t, { intercept:async ({route, pathname}) => {
    if (pathname !== STATE || !fault) return false;
    await route.continue({url:peer+pathname}); return true;
  } });
  peer = await faultPeer(f, (_request, response) => {
    response.writeHead(200, {'content-type':'application/json', 'cache-control':'no-store'});
    response.flushHeaders(); response.write('{"runs":['); received.resolve(performance.now());
  });
  const headers = f.page.waitForResponse(r => new URL(r.url()).pathname === STATE && r.status() === 200);
  await f.open(); const started = await received.promise;
  await headers;
  await expectCode(f.page, 'RESPONSE_READ_FAILED');
  const elapsed = performance.now()-started;
  assert.ok(elapsed >= 9500 && elapsed < 13000, `actual body timeout was ${Math.round(elapsed)}ms`);
  await expectReachable(f.page); await expectBlocked(f.page, {folder:false});
  fault = false; await f.ready();
  assert.equal(f.count(SESSION), 1);
  t.diagnostic(JSON.stringify({observedTimeoutMs:Math.round(elapsed), responseHeadersReceived:true}));
});

test('FL-07: prematurely closed JSON body cannot become READY and a complete later response recovers', options, async t => {
  let fault = true, peer;
  const f = await firstLoadBrowser(t, { intercept:async ({route, pathname}) => {
    if (pathname !== STATE || !fault) return false;
    await route.continue({url:peer+pathname}); return true;
  } });
  peer = await faultPeer(f, (_request, response) => {
    response.writeHead(200, {'content-type':'application/json', 'content-length':'1000', connection:'close'});
    response.end('{"runs":[');
  });
  await f.open(); await expectCode(f.page, 'INVALID_SERVER_RESPONSE');
  await expectReachable(f.page); await expectBlocked(f.page, {folder:false});
  assert.equal(await f.page.locator('#dashboardLastConfirmed').textContent(), '없음');
  fault = false; await f.ready(); assert.equal(f.count(SESSION), 1);
});

test('FL-08: state headers and a partial JSON body must not publish a confirmed snapshot', options, async t => {
  let peer, completeBody, response;
  const partial = deferred();
  const f = await firstLoadBrowser(t, { intercept:async ({route, pathname}) => {
    if (pathname !== STATE) return false;
    const actual = await route.fetch(); completeBody = await actual.text();
    await route.continue({url:peer+pathname}); return true;
  } });
  peer = await faultPeer(f, (_request, res) => {
    response = res;
    response.writeHead(200, {'content-type':'application/json', 'content-length':String(Buffer.byteLength(completeBody))});
    response.flushHeaders(); response.write(completeBody.slice(0,1)); partial.resolve();
  });
  await f.open(); await partial.promise;
  assert.equal(await f.page.locator('#dashboardLastConfirmed').textContent(), '없음');
  await expectBlocked(f.page);
  assert.notEqual(await f.page.locator('#dashboardPhase').textContent(), '최신 상태 확인 완료');
  response.end(completeBody.slice(1));
  await f.ready(); assert.notEqual(await f.page.locator('#dashboardLastConfirmed').textContent(), '없음');
});

test('FL-09: an older failed state response cannot overwrite a newer successful manual refresh', options, async t => {
  const held = deferred(), release = deferred(), delivered = deferred();
  let first = true;
  const f = await firstLoadBrowser(t, { intercept:async ({route, pathname}) => {
    if (pathname !== STATE || !first) return false;
    first = false; held.resolve();
    await release.promise;
    await json(route, 503, {error:'Controlled obsolete response'}); delivered.resolve(); return true;
  } });
  f.owner.add('release held first-load response', () => release.resolve(), 0);
  await f.open(); await held.promise;
  await f.page.locator('#refreshDashboard').click(); await f.ready();
  const confirmed = await f.page.locator('#dashboardLastConfirmed').textContent();
  release.resolve(); await delivered.promise;
  await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await f.page.locator('#dashboardPhase').textContent(), '최신 상태 확인 완료');
  assert.equal(await f.page.locator('#dashboardErrorCode').textContent(), '없음');
  assert.equal(await f.page.locator('#dashboardLastConfirmed').textContent(), confirmed);
  await expectReachable(f.page); assert.equal(f.count(SESSION), 1);
});

test('FL-10: an actual render exception blocks controls, stops polling and reloads through the visible button', options, async t => {
  const f = await firstLoadBrowser(t, { init:() => {
    if (sessionStorage.getItem('first-load-render-fault')) return;
    const original = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function(...children) {
      if (this.id === 'runList') {
        sessionStorage.setItem('first-load-render-fault', 'observed');
        throw new Error('Controlled first-load render failure');
      }
      return original.apply(this, children);
    };
  } });
  await f.open(); await f.page.locator('#dashboardPageError').waitFor({state:'visible'});
  await expectCode(f.page, 'DASHBOARD_RENDER_FAILED');
  assert.equal(await f.page.locator('button').evaluateAll(buttons => buttons
    .filter(button => button.id !== 'refreshDashboard').every(button => button.disabled)), true);
  assert.equal(await f.page.locator('#refreshDashboard').isEnabled(), true);
  const stateRequests = f.count(STATE);
  // Observe more than two real 2.5s polling intervals; zero extra GETs is the
  // negative assertion. This wait does not accelerate or replace app timers.
  await wait(5500, undefined, {signal:t.signal});
  assert.equal(f.count(STATE), stateRequests, 'fatal render failure must stop automatic polling');
  await f.page.locator('#refreshDashboard').click(); await f.ready();
  assert.equal(await f.page.locator('#dashboardPageError').isHidden(), true);
  assert.equal(f.count(SESSION), 2, 'reload must bootstrap a fresh page session');
});
