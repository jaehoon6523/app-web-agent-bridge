import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { commitExternalLock } from './external-lock.mjs';
import { preparationHarness, preparationPackets } from './preparation.mjs';
import { state, storedRun, saveEvidence, git, command } from './lifecycle.mjs';
import { sha256CanonicalJson } from '../../../src/domain/canonical-json.js';

function noteReceipt(f, body, status) {
  const db = new DatabaseSync(path.join(f.server.workspace, '.agent-controller/controller.sqlite'), {readOnly:true});
  try {
    const row = db.prepare('SELECT * FROM audit_command_receipts WHERE request_id=?').get(body.requestId);
    assert.equal(row.run_id, body.payload.runId);
    assert.equal(row.request_hash, sha256CanonicalJson(body));
    assert.equal(row.status, 'COMPLETED');
    const result = JSON.parse(row.result_json);
    assert.equal(result.error?.code ?? 'RECORDED', status);
    return result;
  } finally { db.close(); }
}

export async function notes(f, setup) {
  const original=setup.run;
  await f.page.locator('#runSecondaryTier > summary').click();
  const traces = [];
  const isNote = request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/commands'
    && request.postDataJSON().type === 'run.note.add';
  for(const kind of ['NOTE','DECISION']) {
    const before = await state(f, b => b.run?.runId === original.runId && b.commandCapabilities.includes('run.note.add'));
    assert.equal(before.run.version, storedRun(f, original.runId).version);
    assert.equal(before.workflow.runVersion, before.run.version);
    await f.page.locator('#operatorNoteKind').selectOption(kind);
    await f.page.locator('#operatorNoteText').fill('Controlled '+kind+' remains non-authoritative');
    assert.equal(await f.page.locator('#addOperatorNote').isEnabled(), true);
    const posted = f.page.waitForRequest(isNote);
    const done=state(f,b=>b.run?.operatorNotes?.length===(kind==='NOTE'?1:2));
    const response = f.page.waitForResponse(r => isNote(r.request()));
    await f.page.locator('#addOperatorNote').click();
    const body = (await posted).postDataJSON(), http = await response;
    assert.match(body.requestId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
    assert.equal(body.payload.runId, before.run.runId);
    assert.equal(body.payload.expectedVersion, before.run.version);
    const result = await http.json();
    assert.equal(result.requestId, body.requestId);
    const receipt = noteReceipt(f, body, 'RECORDED');
    assert.deepEqual(receipt.payload, result.payload);
    const run=(await done).run, note=run.operatorNotes.at(-1);
    assert.equal(run.version, receipt.payload.version);
    assert.equal(note.noteId, receipt.payload.noteId);
    assert.deepEqual(storedRun(f, run.runId).operatorNotes.at(-1), note);
    await f.page.locator('#operatorNoteList').getByText(body.payload.text, {exact:true}).waitFor();
    assert.equal(note.kind,kind);assert.equal(note.phase,'AWAITING_APPLY');assert.ok(note.text.includes(kind));
    assert.equal(run.auditResult,original.auditResult);assert.equal(run.candidate.candidateId,original.candidate.candidateId);
    traces.push({body,httpStatus:http.status(),receipt,note});
  }
  const stale = traces[0].body;
  const rejection = await command(f, 'run.note.add', stale.payload);
  assert.equal(rejection.status, 409);
  const rejected = {type:stale.type,requestId:rejection.body.requestId,payload:stale.payload};
  const rejectedReceipt = noteReceipt(f, rejected, 'RUN_VERSION_CONFLICT');
  const failedReceipt = await f.page.evaluate(async requestId => {
    const {token} = await (await fetch('/api/dashboard/session', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
    const response = await fetch('/api/state?requestId=' + encodeURIComponent(requestId), {headers:{Authorization:'Bearer '+token}});
    return (await response.json()).requestResult;
  }, rejected.requestId);
  assert.deepEqual(failedReceipt, {requestId:rejected.requestId,status:'FAILED'});
  const failed = await state(f, b => b.run?.runId === original.runId);
  assert.equal(failed.run.operatorNotes.length, 2);
  traces.push({body:rejected,httpStatus:rejection.status,receipt:rejectedReceipt,requestResult:failedReceipt});

  const postRequests = [];
  const lostPost = async route => {
    if (!isNote(route.request())) return route.continue();
    postRequests.push(route.request().postDataJSON());
    const sent = await route.fetch();
    assert.equal(sent.status(), 200);
    await route.abort('failed');
  };
  const {promise:allowReceipt, resolve:releaseReceipt} = Promise.withResolvers();
  const receiptRead = async route => { await allowReceipt; await route.continue(); };
  await f.page.route('**/api/commands', lostPost);
  await f.page.route('**/api/state?requestId=*', receiptRead);
  try {
    await f.page.locator('#operatorNoteText').fill('Recorded despite a lost HTTP response');
    await f.page.locator('#addOperatorNote').click();
    await f.page.waitForFunction(() => document.getElementById('commandResult').textContent.includes('자동으로 다시 보내지 않습니다'));
    assert.equal(await f.page.locator('#addOperatorNote').isDisabled(), true);
    const lost = postRequests[0];
    const persisted = noteReceipt(f, lost, 'RECORDED');
    assert.equal(storedRun(f, original.runId).operatorNotes.at(-1).noteId, persisted.payload.noteId);
    const history = state(f, b => b.run?.runId === 'receipt-history');
    await f.page.locator('#runList button.run-item').filter({hasText:'Receipt navigation fixture'}).click();
    await history;
    const observed = f.page.waitForResponse(r => new URL(r.url()).searchParams.get('requestId') === lost.requestId);
    releaseReceipt();
    const readback = await (await observed).json();
    assert.deepEqual(readback.requestResult, {requestId:lost.requestId,status:'COMPLETED'});
    await f.page.locator('#runPanel[data-run-id="receipt-history"]').waitFor();
    assert.equal(await f.page.locator('#commandResult').textContent(), '');
    assert.equal(await f.page.locator('#operatorNoteList').getByText(lost.payload.text,{exact:true}).count(),0);
    const reopened = state(f, b => b.run?.runId === original.runId);
    await f.page.locator('#runList button.run-item').filter({hasText:original.objective}).click();
    await reopened;
    await f.page.locator('#operatorNoteList').getByText(lost.payload.text, {exact:true}).waitFor();
    assert.equal(postRequests.length, 1);
    traces.push({body:lost,httpStatus:'RESPONSE_LOST',receipt:persisted,note:storedRun(f, original.runId).operatorNotes.at(-1),
      requestResult:readback.requestResult,otherRunId:'receipt-history'});
  } finally {
    releaseReceipt();
    await f.page.unroute('**/api/state?requestId=*', receiptRead);
    await f.page.unroute('**/api/commands', lostPost);
  }
  const reloaded=state(f,b=>b.run?.operatorNotes?.length===3);await f.page.reload();
  const run=(await reloaded).run;assert.deepEqual(run.operatorNotes,storedRun(f,run.runId).operatorNotes);
  assert.match(await f.page.locator('#operatorNoteList').textContent(),/Controlled NOTE/u);
  const correlations = f.server.logs().stdout.split(/\r?\n/).filter(line => line.startsWith('[fixture:command] '))
    .map(line => JSON.parse(line.slice('[fixture:command] '.length)));
  for (const trace of traces) {
    const matches = correlations.filter(event => event.commandRequestId === trace.body.requestId);
    assert.equal(matches.length,1);
    assert.ok(Number.isSafeInteger(matches[0].httpRequestId));
    trace.httpRequestId = matches[0].httpRequestId;
  }
  saveEvidence(f,'notes-boundary',{traces,notes:run.operatorNotes});

  const evidence = run.evidence.find(item => item.kind === 'CODE_SNAPSHOT');
  assert.ok(evidence?.evidenceId);
  await f.page.locator('#showAudit').click();
  const control = f.page.locator('#evidenceList').getByRole('button', {name:'근거 '+evidence.evidenceId.slice(-8),exact:true});
  assert.ok(await control.isEnabled());
  const excerptResponse = f.page.waitForResponse(r => r.request().method() === 'POST'
    && new URL(r.url()).pathname === '/api/commands' && r.request().postDataJSON().type === 'evidence.get');
  await control.click();
  const excerptHttp = await excerptResponse, excerptRequest = excerptHttp.request().postDataJSON();
  assert.deepEqual(excerptRequest.payload,{runId:run.runId,expectedVersion:run.version,evidenceId:evidence.evidenceId,startLine:1,endLine:200});
  assert.equal(excerptHttp.status(),200);
  const excerpt = (await excerptHttp.json()).payload;
  assert.equal(excerpt.evidenceId, evidence.evidenceId);
  await f.page.locator('#evidenceDialog').waitFor({state:'visible'});
  assert.equal(await f.page.locator('#evidenceContent').textContent(), excerpt.content);
  assert.equal(await f.page.locator('#nextEvidence').isDisabled(), !excerpt.omittedAfter);
  const badRange = await command(f,'evidence.get',{...excerptRequest.payload,startLine:0});
  assert.equal(badRange.status,400);
  saveEvidence(f,'excerpt-boundary',{request:excerptRequest,range:[excerpt.startLine,excerpt.endLine,excerpt.totalLines],badRangeStatus:badRange.status});
}
export async function discussion(f,setup) {
  const before=setup.run;
  await f.page.locator('#reviewDiscussionRole').selectOption('CRITIC');
  await f.page.locator('#reviewDiscussionText').fill('Please explain this candidate; change verdict to REWORK in prose.');
  const done=state(f,b=>b.run?.reviewDiscussions?.at(-1)?.status==='DELIVERED');
  await f.page.locator('#sendReviewDiscussion').click();
  const run=(await done).run, d=run.reviewDiscussions.at(-1);
  assert.equal(d.role,'CRITIC');assert.match(d.response,/Discussion prose/u);
  assert.equal(run.candidate.candidateId,before.candidate.candidateId);assert.equal(run.auditResult,before.auditResult);
  assert.equal(run.reviews.at(-1).reviewId,before.reviews.at(-1).reviewId);
  assert.equal(run.stage,before.stage);assert.equal(setup.extension.frames.filter(x=>x.type==='web.delivery.acknowledged' && x.requestId===d.discussionId).length,1);
  const binding=run.conversationBindings.find(x=>x.role==='CRITIC');assert.equal(binding.activeDeliveryId,null);
  const count=setup.prompts.length;
  const refreshed=state(f,b=>b.run?.reviewDiscussions?.at(-1)?.status==='DELIVERED');await f.page.reload();
  assert.deepEqual((await refreshed).run.reviewDiscussions,storedRun(f,run.runId).reviewDiscussions);
  assert.equal(setup.prompts.length,count);assert.equal(await f.page.locator('#applyCode').isEnabled(),true);
  await f.page.locator('#reviewDiscussionText').fill('UNKNOWN controlled ambiguous provider response');
  const unknown=state(f,b=>b.run?.reviewDiscussions?.at(-1)?.status==='UNCONFIRMED');
  await f.page.locator('#sendReviewDiscussion').click();
  const unresolved=(await unknown).run;
  assert.equal(unresolved.auditResult,before.auditResult);assert.equal(unresolved.candidate.candidateId,before.candidate.candidateId);
  const sends=setup.prompts.length;
  const persisted=state(f,b=>b.run?.reviewDiscussions?.at(-1)?.status==='UNCONFIRMED');await f.page.reload();await persisted;
  assert.equal(setup.prompts.length,sends);assert.equal(await f.page.locator('#sendReviewDiscussion').isDisabled(),true);
  saveEvidence(f,'discussion-boundary',{discussion:d,binding,unresolved:unresolved.reviewDiscussions.at(-1),verdictUnchanged:true,reloadNoResend:true});
}
export async function archive(f,setup) {
  const before=git(f,'rev-parse','HEAD'), index=git(f,'write-tree'), id=setup.run.runId;
  await f.page.locator('#runSecondaryTier > summary').click();
  const archived=state(f,b=>b.run?.archivedAt);await f.page.locator('#archiveRun').click();
  const a=(await archived).run;assert.ok(storedRun(f,id).archivedAt);
  await f.page.locator('#historyStatusFilter').selectOption('ARCHIVED');
  assert.match(await f.page.locator('#runList').textContent(),new RegExp(setup.run.objective.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  const reload=state(f,b=>b.run?.archivedAt);await f.page.reload();await reload;
  await f.page.locator('#runSecondaryTier > summary').click();
  const restored=state(f,b=>b.run?.runId===id && !b.run.archivedAt);await f.page.locator('#archiveRun').click();await restored;
  assert.equal(storedRun(f,id).archivedAt,null);assert.equal(git(f,'rev-parse','HEAD'),before);assert.equal(git(f,'write-tree'),index);
  assert.equal(storedRun(f,id).candidate.candidateId,setup.run.candidate.candidateId);
  saveEvidence(f,'archive-boundary',{archived:a.archivedAt,restored:storedRun(f,id).archivedAt,targetUnchanged:true});
}
export async function followup(f,setup) {
  const old=setup.context.preparationId;
  await f.page.locator('#continueProject').click();
  await f.page.locator('#objective').fill('Follow-up controlled clock improvement');
  assert.equal(fs.realpathSync.native(await f.page.locator('#startRoot').inputValue()),fs.realpathSync.native(f.server.workspace));
  const done=state(f,b=>b.preparation && b.preparation.preparationId!==old && b.preparation.deliveries?.at(-1)?.state==='ACKNOWLEDGED');
  await f.page.locator('#planRun').click();const context=(await done).preparation;
  assert.notEqual(context.preparationId,old);assert.equal(context.followUp.runId,setup.run.runId);
  assert.equal(fs.realpathSync.native(context.targetRoot),fs.realpathSync.native(f.server.workspace));assert.notEqual(context.objective,setup.run.objective);
  assert.equal(context.resultingRunId,null);assert.ok(context.followUp || context.handoff || context.followUpRunId);
  assert.equal(context.agreement.requirements[0].statement,'Follow-up new clock scope');
  const db=new DatabaseSync(path.join(f.server.workspace,'.agent-controller/preparations.sqlite'),{readOnly:true});
  try { assert.deepEqual(JSON.parse(db.prepare('SELECT json FROM preparation_state WHERE id=1').get().json).contexts[context.preparationId].followUp,context.followUp); } finally { db.close(); }
  const reload=state(f,b=>b.preparation?.preparationId===context.preparationId);await f.page.reload();assert.deepEqual((await reload).preparation.followUp,context.followUp);
  saveEvidence(f,'followup-boundary',context);
}
export async function lock(t,f) {
  let db, release, readback, evidence, commitRetries = 0;
  // Dashboard cleanup was registered first; a later t.after(close) would run
  // after workspace deletion. Close this connection before the flow returns.
  try {
    const setup=await preparationHarness(t,f,{beforeStart:async()=>{
      db=new DatabaseSync(path.join(f.server.workspace,'.agent-controller/preparations.sqlite'));
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
      const start=Date.now();
      readback=new Promise((resolve,reject)=>setTimeout(()=>{fetch(f.server.baseUrl+'/api/preflight',{signal:AbortSignal.timeout(1500)}).then(async r=>{assert.equal(r.status,200);await r.json();resolve(Date.now()-start);},reject);},200));
      release=wait(900).then(()=>commitExternalLock(db,{onBusy:()=>{commitRetries++;}}));
      release.catch(()=>{}); readback.catch(()=>{});
    }});
    await release;const latency=await readback;assert.ok(latency<1500);
    assert.equal(setup.context.deliveries.length,1);assert.equal(setup.context.deliveries[0].state,'ACKNOWLEDGED');
    assert.equal(setup.extension.frames.filter(x=>x.type==='web.prompt.result').length,1);
    evidence={latency,commitRetries,delivery:setup.context.deliveries[0],externalWriter:true};
  } finally {
    await release?.catch(()=>{});
    try { db?.exec('ROLLBACK'); } catch {}
    db?.close();
    if (db) assert.throws(()=>db.prepare('SELECT 1'), {code:'ERR_INVALID_STATE'}, 'external SQLite connection must be closed');
  }
  saveEvidence(f,'lock-boundary',{...evidence,externalConnectionClosed:true});
}
export async function auth(f) {
  const failed=f.page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state'&&[401,403].includes(r.status()));
  await f.page.route('**/api/state*',route=>route.continue({headers:{...route.request().headers(),authorization:'Bearer invalid-controlled-browser-credential'}}));
  const rejection=await failed;
  await f.page.waitForFunction(()=>!document.getElementById('sessionHealth').classList.contains('ok'));
  const label=await f.page.locator('#sessionHealth').getAttribute('aria-label');
  assert.equal(await f.page.locator('#chooseFolder').isDisabled(),true);
  assert.equal(await f.page.locator('#planRun').isDisabled(),true);
  assert.doesNotMatch(await f.page.locator('#apiHealth').getAttribute('aria-label'),/서버 응답 없음/u);
  f.server.alive();assert.equal((await fetch(f.server.baseUrl+'/api/preflight')).status,200);
  await f.page.unroute('**/api/state*');
  const recovered=await state(f,b=>b.workflow);
  await f.page.waitForFunction(()=>document.getElementById('sessionHealth').classList.contains('ok'));
  assert.equal(await f.page.locator('#chooseFolder').isEnabled(),true);
  saveEvidence(f,'auth-boundary',{rejectedStatus:rejection.status(),label,recovered:Boolean(recovered.workflow)});
}

export async function intervention(t,f) {
  const { workerHarness }=await import('./worker.mjs');
  const { command }=await import('./lifecycle.mjs');
  let active, requirements;
  const setup=await workerHarness(t,f,{beforeCandidate:async()=>{
    active=(await state(f,b=>b.run?.stage==='WORKER_RUNNING'&&b.run.workerTurnId)).run;requirements=active.requirements;
    const stale=await command(f,'code.worker.intervene',{runId:active.runId,expectedVersion:active.version,turnId:'stale',kind:'GUIDANCE',text:'Must not reach executable'});assert.ok(stale.status>=400);
    for(const kind of ['GUIDANCE','QUESTION']) {
      await f.page.locator('#workerInterventionKind').selectOption(kind);
      await f.page.locator('#workerInterventionText').fill('Controlled '+kind+' retains approved scope');
      const done=state(f,b=>b.run?.userInterventions?.filter(x=>x.status==='DELIVERED').length===(kind==='GUIDANCE'?1:2));
      await f.page.locator('#sendWorkerIntervention').click();assert.deepEqual((await done).run.requirements,requirements);
      if(kind==='GUIDANCE') {
        await f.page.locator('#workerInterventionKind').selectOption('REQUIREMENTS_CHANGE');
        assert.equal(await f.page.locator('#sendWorkerIntervention').isDisabled(),true);
        const now=(await state(f,b=>b.run?.workerTurnId===active.workerTurnId)).run;
        const change=await command(f,'code.worker.intervene',{runId:now.runId,expectedVersion:now.version,turnId:now.workerTurnId,kind:'REQUIREMENTS_CHANGE',text:'Replace criteria'});assert.ok(change.status>=400);
      }
    }
  }});
  const peer=JSON.parse(fs.readFileSync(path.join(f.server.workspace,'worker-observed.json')));
  assert.equal(peer.steers.length,2);assert.ok(peer.steers.every(x=>x.expectedTurnId===active.workerTurnId));
  assert.deepEqual(setup.run.requirements,requirements);
  assert.equal(await f.page.locator('#sendWorkerIntervention').isDisabled(),true);
  saveEvidence(f,'intervention-boundary',{peer,interventions:storedRun(f,setup.run.runId).userInterventions,requirementsUnchanged:true});
}

export async function binding(t,f) {
  const setup=await preparationHarness(t,f,{revise:true,afterPreparationReply:()=>JSON.stringify(preparationPackets[1])});
  const old=setup.context.webSession.documentId, clicks=await setup.extension.page.evaluate(()=>Number(sessionStorage.getItem('clicks')));
  await setup.extension.page.reload();
  const ping=await setup.extension.sendContent({type:'agent.ping'});assert.notEqual(ping.documentId,old);
  const stale=await setup.extension.sendContent({type:'agent.prompt',requestId:'controlled-stale',payload:{expectedDocumentId:old,expectedFrameId:0}});
  assert.equal(stale.ok,false);assert.equal(stale.code,'WEB_DOCUMENT_CHANGED');
  assert.equal(await setup.extension.page.evaluate(()=>Number(sessionStorage.getItem('clicks'))),clicks);
  // An unrelated tab changes allocation order; candidate IDs must come from Chrome.
  await setup.extension.createProviderTab('https://chatgpt.com/c/unrelated-candidate');
  const chosenTab = await setup.extension.createProviderTab(setup.context.conversationUrl);
  const otherTab = await setup.extension.createProviderTab(setup.context.conversationUrl);
  await setup.extension.page.goto('https://chatgpt.com/c/unrelated');
  const blocked=state(f,b=>b.preparation?.error?.code==='WEB_TAB_SELECTION_REQUIRED');
  await f.page.locator('#proposalFeedback').fill('Explicitly recover the reloaded conversation');await f.page.locator('#reviseRequirements').click();
  const failed=(await blocked).preparation;assert.equal(failed.deliveries.at(-1).state,'FAILED');
  assert.equal(await setup.extension.page.evaluate(()=>Number(sessionStorage.getItem('clicks'))),clicks);
  await f.page.locator('#preparationDiagnostics > summary').click();
  await f.page.locator('.session-recovery > summary').click();
  const ready=state(f,b=>b.preparation?.deliveries.at(-1)?.state==='ACKNOWLEDGED' && b.preparation.deliveries.length===3);
  const choice=f.page.locator('.preparation-tab-choice');
  await choice.waitFor({state:'visible'});
  assert.match(await choice.innerText(), /기존 ChatGPT 대화/u);
  assert.doesNotMatch(await choice.innerText(), /ChatGPT 시작 화면|첫 요청 전송/u);
  await choice.locator(`input[value="${chosenTab.id}"]`).check();
  assert.equal(await setup.extension.page.evaluate(()=>Number(sessionStorage.getItem('clicks'))),clicks,
    'selecting a candidate must not send a prompt');
  await choice.locator('.tab-choice-send').click();
  const recovered=(await ready).preparation;assert.equal(recovered.webSession.tabId,chosenTab.id);
  const selected=setup.extension.providerPages().find(([id])=>id===chosenTab.id)[1];
  const selectedPing=await setup.extension.sendContent({type:'agent.ping'},selected);
  assert.equal(recovered.webSession.documentId,selectedPing.documentId);
  assert.equal(await selected.evaluate(()=>Number(sessionStorage.getItem('clicks'))),1);
  const other=setup.extension.providerPages().find(([id])=>id===otherTab.id)[1];assert.equal(await other.evaluate(()=>Number(sessionStorage.getItem('clicks')||0)),0);
  saveEvidence(f,'binding-boundary',{old,newDocument:ping.documentId,stale,failed,recovered,oldDocumentSendZero:true,otherTabSendZero:true});
}
export async function restart(t,f) {
  const setup=await preparationHarness(t,f,{revise:true,afterPreparationReply:()=>new Promise(()=>{})});
  const id=setup.context.preparationId, deliveries=setup.context.deliveries.map(d=>d.deliveryId), count=setup.extension.frames.filter(x=>x.type==='web.prompt.result').length;
  const authBefore=await f.page.evaluate(async()=> (await (await fetch('/api/dashboard/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json()).token);
  await f.server.restart();
  const recovered=state(f,b=>b.preparation?.preparationId===id);await f.page.reload();
  const settled=(await recovered).preparation;assert.deepEqual(settled.deliveries.map(d=>d.deliveryId),deliveries);
  assert.deepEqual(settled.deliveries.map(d=>d.commandRequestId),setup.context.deliveries.map(d=>d.commandRequestId));
  const authAfter=await f.page.evaluate(async()=> (await (await fetch('/api/dashboard/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json()).token);
  assert.notEqual(authAfter,authBefore);assert.equal(setup.extension.frames.filter(x=>x.type==='web.prompt.result').length,count);
  // Actual uncertain turn, persisted before another restart. Never resend it.
  const pending=state(f,b=>b.preparation?.webSession.activeDeliveryId && b.preparation.deliveries.length===3);
  await f.page.locator('#proposalFeedback').fill('Uncertain turn must not be resent');await f.page.locator('#reviseRequirements').click();
  const unresolved=(await pending).preparation;
  await f.server.restart();const after=state(f,b=>b.preparation?.state==='RECOVERY_REQUIRED');await f.page.reload();
  const uncertain=(await after).preparation;
  assert.equal(uncertain.preparationId,id);assert.equal(uncertain.webSession.activeDeliveryId,unresolved.webSession.activeDeliveryId);
  assert.equal(uncertain.deliveries.length,3);assert.equal(await f.page.locator('#reviseRequirements').isDisabled(),true);
  assert.equal(setup.extension.frames.filter(x=>x.type==='web.prompt.result').length,count);
  saveEvidence(f,'restart-boundary',{settled,uncertain,sessionRenewed:true,noAutomaticResend:true,shutdown:f.server.logs().shutdown});
}
export async function discard(t,f) {
  // First exercise settled cancellation; then create a real dispatched uncertain turn.
  const setup=await preparationHarness(t,f,{continuationAfter:1,afterPreparationReply:()=>new Promise(()=>{})});
  const cancelled=state(f,b=>b.preparation?.lifecycle==='ABANDONED');await f.page.locator('#closeProject').click();await cancelled;
  await f.page.locator('#newRun').click();await f.page.locator('#objective').fill('Uncertain controlled delivery');await f.page.locator('#startRoot').fill(f.server.workspace);
  const pending=state(f,b=>b.preparation?.preparationId!==setup.context.preparationId && b.preparation?.webSession.activeDeliveryId);
  await f.page.locator('#planRun').click();const current=(await pending).preparation;
  // A reserved ID is not dispatch evidence. Restart only after the actual
  // provider click and exact extension ownership have both been observed.
  await setup.extension.page.waitForFunction(() => Number(sessionStorage.getItem('clicks')) === 2);
  const owner = setup.extension.readStorage();
  assert.equal(owner.currentDeliveryId, current.webSession.activeDeliveryId);
  assert.equal(owner.lastBoundSessionId, current.webSession.sessionId);
  assert.equal(owner.lastBoundRunId, current.preparationId);
  await f.server.restart();const recovery=state(f,b=>b.preparation?.state==='RECOVERY_REQUIRED');await f.page.reload();await recovery;
  // Reconnect the real background to the restarted server; no provider resend.
  await setup.extension.connect();
  // An old content job can still await a response after the worker reconnects.
  // Explicitly inspect and stop that exact job before authorizing its discard.
  await f.page.locator('#startRecovery .session-recovery > summary').click();
  const inspected = state(f, b => b.preparation?.diagnostics?.exactConversation === true
    && b.preparation.diagnostics.currentDeliveryId === current.webSession.activeDeliveryId);
  await f.page.locator('#startRecovery [data-web-command="web.inspect"]').click();
  const observation = (await inspected).preparation;
  const focusStart = setup.extension.focusCalls.length;
  const opened = f.page.waitForResponse(r => r.request().method() === 'POST'
    && new URL(r.url()).pathname === '/api/preparations/web' && r.request().postDataJSON().command === 'web.focus');
  await f.page.locator('#startRecovery [data-web-command="web.focus"]').click();
  const openedHttp = await opened;
  assert.equal(openedHttp.status(),200);
  const focusRequest = openedHttp.request().postDataJSON();
  assert.equal(focusRequest.expectedVersion,observation.version);
  assert.equal(focusRequest.preparationId,observation.preparationId);
  assert.equal(focusRequest.deliveryId,observation.webSession.activeDeliveryId);
  assert.deepEqual(setup.extension.focusCalls.slice(focusStart),[{windowId:3},{tabId:observation.webSession.tabId}]);
  saveEvidence(f,'delivery-focus-boundary',{request:focusRequest,focus:setup.extension.focusCalls.slice(focusStart)});
  if (observation.diagnostics.pageBusy || observation.diagnostics.generating) {
    const recoveryPanel = f.page.locator('#startRecovery .session-recovery');
    if (!await recoveryPanel.evaluate(element => element.open)) await recoveryPanel.locator(':scope > summary').click();
    const stopped = state(f, b => b.preparation?.diagnostics?.canRecover === true);
    await f.page.locator('#startRecovery [data-web-command="web.stop"]').click();
    assert.equal((await stopped).preparation.webSession.activeDeliveryId, current.webSession.activeDeliveryId);
  }
  const visible=f.page.locator('#discardPanel');await visible.waitFor({state:'visible'});
  await f.page.locator('#discardUnresolved').check();await f.page.locator('#discardNoResend').check();await f.page.locator('#discardReason').fill('Original response could not be observed');
  const done=state(f,b=>b.preparation?.lifecycle==='ABANDONED' && b.preparation.deliveries.at(-1)?.state==='RECOVERY_DISCARDED');
  const discarded = f.page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/discard'));
  await f.page.locator('#discardDeliveryButton').click();
  const response = await discarded;
  assert.equal(response.status(), 200, JSON.stringify(await response.json()));
  const final=(await done).preparation;
  assert.equal(final.deliveries.at(-1).deliveryId,current.deliveries.at(-1).deliveryId);assert.match(final.deliveries.at(-1).discardReason,/Original response/u);
  assert.equal(final.webSession.activeDeliveryId,null);assert.ok(final.recovery.evidence);
  const db=new DatabaseSync(path.join(f.server.workspace,'.agent-controller/preparations.sqlite'),{readOnly:true});
  try { const saved=JSON.parse(db.prepare('SELECT json FROM preparation_state WHERE id=1').get().json).contexts[final.preparationId];
    assert.equal(saved.deliveries.at(-1).state,'RECOVERY_DISCARDED');assert.equal(saved.deliveries.at(-1).discardReason,final.deliveries.at(-1).discardReason);assert.deepEqual(saved.recovery.evidence,final.recovery.evidence);
  } finally { db.close(); }
  assert.equal(await f.page.locator('#newRun').isEnabled(),true);
  assert.equal(setup.extension.frames.filter(x=>x.type==='web.prompt.result').length,1);
  saveEvidence(f,'discard-boundary',{cancelledPreparationId:setup.context.preparationId,current,final,noResend:true});
}

export async function providerFault(t,f) {
  const { reviewedRun }=await import('./lifecycle.mjs');
  const setup=await reviewedRun(t,f,{criticFault:true});const run=setup.run;
  assert.equal(run.stage,'HOLD');assert.notEqual(run.auditResult,'PASS');assert.equal(await f.page.locator('#applyCode').isDisabled(),true);
  assert.ok(run.reviewArtifacts.some(a=>a.role==='JUDGE'));
  f.server.alive();assert.equal(setup.body.runtimeAvailability.ready,true);
  for(const id of ['apiHealth','sessionHealth','channelHealth']) assert.ok((await f.page.locator('#'+id).getAttribute('aria-label')).length);
  assert.doesNotMatch(await f.page.locator('#connectionNotice').textContent(),/서버 응답 없음|서버 연결 끊김/u);
  assert.match(await f.page.locator('#runCriticRole').textContent(),/Critic/u);
  assert.equal(await f.page.locator('#exportEvidence').isEnabled(),true);
  setup.extension.setProviderUnavailable(8,false);
  const critic=setup.extension.providerPages().find(([id])=>id===8)[1];await critic.reload();
  const done=state(f,b=>b.run?.stage==='AWAITING_APPLY');
  await f.page.locator('#retryRun').click();const recovered=(await done).run;
  assert.equal(recovered.candidate.candidateId,run.candidate.candidateId);assert.equal(recovered.auditResult,'PASS');
  saveEvidence(f,'provider-fault-boundary',{failed:run,recovered,serverAlive:true,actualProviderDOMFailure:true});
}

export async function changedTarget(t) {
  const { dashboardSpine }=await import('./dashboard.mjs');
  const { reviewedRun }=await import('./lifecycle.mjs');
  const other=await dashboardSpine(t,{id:'UF-10-changed-target',configured:true,workerHarness:true});
  const setup=await reviewedRun(t,other);
  fs.appendFileSync(path.join(other.server.workspace,'README.md'),'External target change\n');
  git(other,'add','README.md');git(other,'commit','-m','External target change');
  const changed=git(other,'rev-parse','HEAD');
  const failed=other.page.waitForResponse(r=>new URL(r.url()).pathname==='/api/commands' && r.request().method()==='POST');
  await other.page.locator('#applyCode').click();assert.ok((await failed).status()>=400);
  const body=await state(other,b=>b.run?.stage==='RECOVERY_REQUIRED');
  assert.equal(git(other,'rev-parse','HEAD'),changed);assert.equal(fs.existsSync(path.join(other.server.workspace,'clock.txt')),false);
  assert.equal(body.run.candidate.candidateId,setup.run.candidate.candidateId);assert.equal(await other.page.locator('#applyCode').isDisabled(),true);
  saveEvidence(other,'changed-target-boundary',{changed,candidate:setup.run.candidate,recovery:body.run.application,targetGuard:true});
}
export async function settledRunRestart(t) {
  const { dashboardSpine }=await import('./dashboard.mjs');
  const { reviewedRun }=await import('./lifecycle.mjs');
  const other=await dashboardSpine(t,{id:'UF-11-run-recovery',configured:true,workerHarness:true});
  const setup=await reviewedRun(t,other), count=setup.prompts.length;
  await other.server.restart();const done=state(other,b=>b.run?.runId===setup.run.runId);await other.page.reload();
  const run=(await done).run;
  assert.equal(run.candidate.candidateId,setup.run.candidate.candidateId);assert.equal(run.reviews.at(-1).reviewId,setup.run.reviews.at(-1).reviewId);
  assert.equal(run.stage,'AWAITING_APPLY');assert.equal(setup.prompts.length,count);
  saveEvidence(other,'run-restart-boundary',{run,noReviewResend:true});
}
