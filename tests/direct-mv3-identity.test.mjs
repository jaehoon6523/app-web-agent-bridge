import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundCandidates, verifyMinimalExtension, discoverMinimalExtension, verifiedReloadIdentity, targetReloadEvents, assessDirectReload } from '../scripts/direct-mv3-identity.mjs';

const builtIn = 'nkeimhogjdpnpccoofpliimaahmaaome';
const unrelated = 'kmahanahodlaihbokoohlfkmomjjklmg';
const owned = 'glbjnfimcajjenihimblfaponejbkoph';
const second = 'abcdabcdabcdabcdabcdabcdabcdabcd';
const worker = id => ({ url: `chrome-extension://${id}/background.js` });
const identity = verifiedReloadIdentity(owned);
const approved = { popupAccessible: true, sentinelPreserved: true, backgroundResponded: true, instanceId: 'abc' };

test('CDP thunk.js is not the test extension', () => {
  assert.deepEqual(backgroundCandidates([{ url: `chrome-extension://${builtIn}/thunk.js` },worker(owned)], []),[owned]);
});
test('worker events supplement sparse targets', () => {
  assert.deepEqual(backgroundCandidates([], [{scriptURL:`chrome-extension://${owned}/background.js`}]),[owned]);
  assert.deepEqual(backgroundCandidates([{url:'about:blank'}], []),[]);
});
test('unrelated background.js is rejected and an eligible candidate is selected', async () => {
  const value=await verifyMinimalExtension([unrelated,owned],async id=>id === unrelated ? {popupAccessible:false} : approved);
  assert.equal(value.id,owned);
});
test('zero positive candidates fail closed', async () => {
  await assert.rejects(verifyMinimalExtension([unrelated],async()=>({popupAccessible:false})),{message:'EXPECTED_MINIMAL_EXTENSION_NOT_FOUND'});
});
test('multiple positive candidates are ambiguous', async () => {
  await assert.rejects(verifyMinimalExtension([unrelated,owned],async()=>approved),{message:'AMBIGUOUS_MINIMAL_EXTENSION_ID'});
});
test('execution flow: unrelated background first, owned extension appears later, then is positively checked', async () => {
  let time=0, enumerations=0; const attempts=[]; let ownedCalled=0;
  const result=await discoverMinimalExtension({timeoutMs:600,pollMs:50,retryMs:200,
    clock:()=>time,pause:async ms=>{time+=ms;},
    collect:async()=>{enumerations++;return backgroundCandidates(enumerations<4?[worker(unrelated)]:[worker(unrelated),worker(owned)]);},
    probe:async id=>{attempts.push({id,time});if(id===owned){ownedCalled++;return approved;}throw Error('NAVIGATION_FAILED net::ERR_FILE_NOT_FOUND');},
  });
  assert.equal(result.id,owned);
  assert.ok(ownedCalled>=1);
  assert.equal(attempts[0].id,unrelated);
  assert.ok(attempts.some(x=>x.id===owned && x.time>=150));
  assert.ok(result.attempted.find(x=>x.id===unrelated && x.verdict==='REJECTED'));
});
test('second positive candidate appearing later fails closed as ambiguous',async()=>{
  let time=0;
  await assert.rejects(discoverMinimalExtension({timeoutMs:400,pollMs:50,
    clock:()=>time,pause:async ms=>{time+=ms;},
    collect:async()=>backgroundCandidates(time<100?[worker(owned)]:[worker(owned),worker(second)]),
    probe:async()=>approved,
  }), {message:'AMBIGUOUS_MINIMAL_EXTENSION_ID'});
});
test('observed popup failure without reload invocation or teardown is UNVERIFIED, not FAIL',()=>{
  const observations={reloadInvocation:{evaluate:'interrupted'},popupAfter:{popupAccessible:false},
    popupFailures:['NAVIGATION_FAILED'],workerEventsAfterReload:[],registrationEventsAfterReload:[]};
  const result=assessDirectReload(observations,identity);
  assert.equal(result.execution,'INCOMPLETE');
  assert.equal(result.reloadResult,'UNVERIFIED');
  assert.equal(result.functionalRecovery,'FAIL');
  assert.deepEqual(observations.popupFailures,['NAVIGATION_FAILED']);
});
test('teardown independently proves a reload boundary even without returned evaluate',()=>{
  const result=assessDirectReload({reloadInvocation:{evaluate:'interrupted'},popupAfter:{popupAccessible:false},
    workerEventsAfterReload:[{runningStatus:'stopped',scriptURL:identity.workerScriptURL,sequence:1}],registrationEventsAfterReload:[]},identity);
  assert.equal(result.execution,'COMPLETE');
  assert.equal(result.reloadResult,'FAIL');
});

const otherWorker = `chrome-extension://${builtIn}/thunk.js`;
const otherScope = `chrome-extension://${builtIn}/`;
const foreignEvents = {
  workerEventsAfterReload: [{ sequence:2, runningStatus:'stopped', scriptURL:otherWorker }],
  registrationEventsAfterReload: [],
};

test('foreign thunk.js stop does not turn interrupted invocation and inaccessible popup into COMPLETE/FAIL', () => {
  const raw = { reloadInvocation:{evaluate:'interrupted'}, popupAfter:{popupAccessible:false},
    popupFailures:['NAVIGATION_FAILED'], ...foreignEvents };
  const result = assessDirectReload(raw, identity);
  assert.equal(result.execution, 'INCOMPLETE');
  assert.equal(result.reloadResult, 'UNVERIFIED');
  assert.equal(result.functionalRecovery, 'FAIL');
  assert.equal(result.reloadBoundaryEvidence, 'NOT_OBSERVED');
  assert.equal(result.reloadTeardownObserved, false);
  assert.equal(result.boundaryObserved, false);
  assert.equal(raw.workerEventsAfterReload.length, 1); // Preserve unrelated diagnostics.
  assert.deepEqual(result.targetWorkerEventsAfterReload, []);
});

test('foreign stopped then running plus deleted registration never establishes target reload', () => {
  const raw = { reloadInvocation:{evaluate:'interrupted'}, popupAfter:{popupAccessible:false},
    workerEventsAfterReload: [
      {sequence:3,runningStatus:'stopped',scriptURL:otherWorker},
      {sequence:4,runningStatus:'running',scriptURL:otherWorker},
      {sequence:5,runningStatus:'running',scriptURL:identity.workerScriptURL},
      {sequence:6,runningStatus:'stopped',scriptURL:null},
    ],
    registrationEventsAfterReload:[
      {sequence:7,isDeleted:true,scopeURL:otherScope},
      {sequence:8,isDeleted:true,scopeURL:null},
    ] };
  const result = assessDirectReload(raw, identity);
  assert.equal(result.execution,'INCOMPLETE');
  assert.equal(result.reloadResult,'UNVERIFIED');
  assert.equal(result.reloadBoundaryEvidence,'NOT_OBSERVED');
  assert.deepEqual(result.targetWorkerEventsAfterReload.map(x=>x.sequence),[5]);
  assert.deepEqual(result.targetRegistrationEventsAfterReload,[]);
});

test('foreign boundary plus target running cannot confirm successful reload', () => {
  const raw = { reloadInvocation:{evaluate:'returned'}, popupAfter:{
    popupAccessible:true,sentinelPreserved:true,backgroundResponded:true,instanceId:'new'},
    beforeReloadWorkerInstance:'old',
    workerEventsAfterReload:[
      {sequence:10,runningStatus:'stopped',scriptURL:otherWorker},
      {sequence:11,runningStatus:'running',scriptURL:identity.workerScriptURL},
    ], registrationEventsAfterReload:[{sequence:12,isDeleted:true,scopeURL:otherScope}] };
  const result=assessDirectReload(raw,identity);
  assert.equal(result.execution,'COMPLETE');
  assert.equal(result.functionalRecovery,'PASS');
  assert.equal(result.reloadResult,'UNVERIFIED');
  assert.equal(result.runningAfterBoundary,false);
  assert.equal(result.reloadBoundaryEvidence,'PARTIAL'); // Instance changed, but no target boundary.
});

test('target-owned teardown keeps previous COMPLETE/FAIL verdict, ignoring foreign events', () => {
  const raw={reloadInvocation:{evaluate:'interrupted'},popupAfter:{popupAccessible:false},
    workerEventsAfterReload:[
      {sequence:2,runningStatus:'stopped',scriptURL:otherWorker},
      {sequence:3,runningStatus:'stopped',scriptURL:identity.workerScriptURL},
      {sequence:4,runningStatus:'running',scriptURL:otherWorker},
    ],registrationEventsAfterReload:[{sequence:5,isDeleted:true,scopeURL:otherScope}]};
  const result=assessDirectReload(raw,identity);
  assert.equal(result.execution,'COMPLETE');
  assert.equal(result.reloadResult,'FAIL');
  assert.equal(result.reloadBoundaryEvidence,'PARTIAL');
  assert.equal(result.runningAfterBoundary,false);
  assert.deepEqual(result.targetWorkerEventsAfterReload.map(x=>x.sequence),[3]);
});

test('target-owned stop to running, deletion, and changed instance retains confirmed PASS', () => {
  const raw={reloadInvocation:{evaluate:'returned'}, beforeReloadWorkerInstance:'old',
    popupAfter:{popupAccessible:true,sentinelPreserved:true,backgroundResponded:true,instanceId:'new'},
    workerEventsAfterReload:[
      {sequence:1,runningStatus:'stopped',scriptURL:identity.workerScriptURL},
      {sequence:2,runningStatus:'running',scriptURL:identity.workerScriptURL},
    ], registrationEventsAfterReload:[{sequence:3,isDeleted:true,scopeURL:identity.registrationScopeURL}]};
  const result=assessDirectReload(raw,identity);
  assert.equal(result.execution,'COMPLETE');
  assert.equal(result.reloadResult,'PASS');
  assert.equal(result.reloadBoundaryEvidence,'CONFIRMED');
  assert.equal(result.runningAfterBoundary,true);
  assert.equal(result.reloadTeardownObserved,true);
});

test('identity captures only verified extension worker and registration references', () => {
  const own=verifiedReloadIdentity(owned,
    [{scriptURL:otherWorker,versionId:'other'},{scriptURL:identity.workerScriptURL,versionId:'2'}],
    [{scopeURL:otherScope,registrationId:'0'},{scopeURL:identity.registrationScopeURL,registrationId:'4'}]);
  assert.deepEqual(own.initialWorkerVersionIds,['2']);
  assert.deepEqual(own.initialRegistrationIds,['4']);
  const events=targetReloadEvents({workerEventsAfterReload:[
    {scriptURL:null},{scriptURL:otherWorker},{scriptURL:identity.workerScriptURL}],
    registrationEventsAfterReload:[{scopeURL:otherScope},{scopeURL:identity.registrationScopeURL}]},own);
  assert.equal(events.workers.length,1);
  assert.equal(events.registrations.length,1);
  assert.throws(()=>assessDirectReload({reloadInvocation:{evaluate:'returned'}},null),/VERIFIED_EXTENSION_ID_REQUIRED/);
});

test('target registration deletion independently establishes COMPLETE without a returned call',()=>{
  const result=assessDirectReload({reloadInvocation:{evaluate:'interrupted'},popupAfter:{popupAccessible:false},
    workerEventsAfterReload:[{sequence:2,runningStatus:'running',scriptURL:otherWorker}],
    registrationEventsAfterReload:[{sequence:3,isDeleted:true,scopeURL:identity.registrationScopeURL}]},identity);
  assert.equal(result.execution,'COMPLETE');
  assert.equal(result.reloadResult,'FAIL');
});

test('in-progress observation cannot report a completed functional failure',()=>{
  const result=assessDirectReload({reloadInvocation:{evaluate:'interrupted'},popupAfter:{popupAccessible:false},
    workerEventsAfterReload:[{sequence:2,runningStatus:'stopped',scriptURL:otherWorker}]},identity,{windowCompleted:false});
  assert.equal(result.functionalRecovery,'UNVERIFIED');
  assert.equal(result.execution,'INCOMPLETE');
  assert.equal(result.reloadResult,'UNVERIFIED');
});


test('returned reload with target boundary stays INCOMPLETE until observation finishes',()=>{
  const raw={reloadInvocation:{evaluate:'returned'}, beforeReloadWorkerInstance:'old',
    popupAfter:{popupAccessible:true,sentinelPreserved:true,backgroundResponded:true,instanceId:'new'},
    workerEventsAfterReload:[
      {sequence:1,runningStatus:'stopped',scriptURL:identity.workerScriptURL},
      {sequence:2,runningStatus:'running',scriptURL:identity.workerScriptURL},
    ]};
  const pending=assessDirectReload(raw,identity,{windowCompleted:false});
  assert.equal(pending.execution,'INCOMPLETE');
  assert.equal(pending.reloadResult,'UNVERIFIED');
  assert.equal(pending.functionalRecovery,'PASS');
  assert.equal(pending.reloadBoundaryEvidence,'CONFIRMED');
  const finished=assessDirectReload(raw,identity);
  assert.equal(finished.execution,'COMPLETE');
  assert.equal(finished.reloadResult,'PASS');
});
