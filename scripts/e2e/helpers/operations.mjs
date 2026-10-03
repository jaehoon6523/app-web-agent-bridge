import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { preparationHarness, preparationPackets } from './preparation.mjs';
import { state, storedRun, saveEvidence, git, envelope } from './lifecycle.mjs';

export async function notes(f, setup) {
  const original=setup.run;
  await f.page.locator('#runSecondaryTier > summary').click();
  for(const kind of ['NOTE','DECISION']) {
    await f.page.locator('#operatorNoteKind').selectOption(kind);
    await f.page.locator('#operatorNoteText').fill('Controlled '+kind+' remains non-authoritative');
    const done=state(f,b=>b.run?.operatorNotes?.length===(kind==='NOTE'?1:2));
    await f.page.locator('#addOperatorNote').click();
    const run=(await done).run, note=run.operatorNotes.at(-1);
    assert.equal(note.kind,kind);assert.equal(note.phase,'AWAITING_APPLY');assert.ok(note.text.includes(kind));
    assert.equal(run.auditResult,original.auditResult);assert.equal(run.candidate.candidateId,original.candidate.candidateId);
  }
  const reloaded=state(f,b=>b.run?.operatorNotes?.length===2);await f.page.reload();
  const run=(await reloaded).run;assert.deepEqual(run.operatorNotes,storedRun(f,run.runId).operatorNotes);
  assert.match(await f.page.locator('#operatorNoteList').textContent(),/Controlled NOTE/u);
  saveEvidence(f,'notes-boundary',run.operatorNotes);
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
  assert.equal(await f.page.locator('#startRoot').inputValue(),f.server.workspace);
  const done=state(f,b=>b.preparation && b.preparation.preparationId!==old && b.preparation.deliveries?.at(-1)?.state==='ACKNOWLEDGED');
  await f.page.locator('#planRun').click();const context=(await done).preparation;
  assert.notEqual(context.preparationId,old);assert.equal(context.followUp.runId,setup.run.runId);
  assert.equal(context.targetRoot,f.server.workspace);assert.notEqual(context.objective,setup.run.objective);
  assert.equal(context.resultingRunId,null);assert.ok(context.followUp || context.handoff || context.followUpRunId);
  assert.equal(context.agreement.requirements[0].statement,'Follow-up new clock scope');
  const db=new DatabaseSync(path.join(f.server.workspace,'.agent-controller/preparations.sqlite'),{readOnly:true});
  try { assert.deepEqual(JSON.parse(db.prepare('SELECT json FROM preparation_state WHERE id=1').get().json).contexts[context.preparationId].followUp,context.followUp); } finally { db.close(); }
  const reload=state(f,b=>b.preparation?.preparationId===context.preparationId);await f.page.reload();assert.deepEqual((await reload).preparation.followUp,context.followUp);
  saveEvidence(f,'followup-boundary',context);
}
export async function lock(t,f) {
  let db, timer, readback;
  t.after(()=>{clearTimeout(timer);try{db?.exec('ROLLBACK');}catch{}db?.close();});
  const setup=await preparationHarness(t,f,{beforeStart:async()=>{
    db=new DatabaseSync(path.join(f.server.workspace,'.agent-controller/preparations.sqlite'));
    db.exec('BEGIN IMMEDIATE');
    const start=Date.now();
    readback=new Promise((resolve,reject)=>setTimeout(()=>{fetch(f.server.baseUrl+'/api/preflight',{signal:AbortSignal.timeout(1500)}).then(async r=>{assert.equal(r.status,200);await r.json();resolve(Date.now()-start);},reject);},200));
    timer=setTimeout(()=>db.exec('COMMIT'),900);
  }});
  const latency=await readback;assert.ok(latency<1500);
  assert.equal(setup.context.deliveries.length,1);assert.equal(setup.context.deliveries[0].state,'ACKNOWLEDGED');
  assert.equal(setup.extension.frames.filter(x=>x.type==='web.prompt.result').length,1);
  saveEvidence(f,'lock-boundary',{latency,delivery:setup.context.deliveries[0],externalWriter:true});
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
  const setup=await preparationHarness(t,f,{revise:true,afterPreparationReply:()=>envelope(preparationPackets[1])});
  const old=setup.context.webSession.documentId, clicks=await setup.extension.page.evaluate(()=>Number(sessionStorage.getItem('clicks')));
  await setup.extension.page.reload();
  const ping=await setup.extension.sendContent({type:'agent.ping'});assert.notEqual(ping.documentId,old);
  const stale=await setup.extension.sendContent({type:'agent.prompt',requestId:'controlled-stale',payload:{expectedDocumentId:old,expectedFrameId:0}});
  assert.equal(stale.ok,false);assert.equal(stale.code,'WEB_DOCUMENT_CHANGED');
  assert.equal(await setup.extension.page.evaluate(()=>Number(sessionStorage.getItem('clicks'))),clicks);
  await setup.extension.createProviderTab(setup.context.conversationUrl);
  await setup.extension.createProviderTab(setup.context.conversationUrl);
  await setup.extension.page.goto('https://chatgpt.com/c/unrelated');
  const blocked=state(f,b=>b.preparation?.error?.code==='WEB_TAB_SELECTION_REQUIRED');
  await f.page.locator('#proposalFeedback').fill('Explicitly recover the reloaded conversation');await f.page.locator('#reviseRequirements').click();
  const failed=(await blocked).preparation;assert.equal(failed.deliveries.at(-1).state,'FAILED');
  assert.equal(await setup.extension.page.evaluate(()=>Number(sessionStorage.getItem('clicks'))),clicks);
  await f.page.locator('#preparationDiagnostics > summary').click();
  await f.page.locator('.session-recovery > summary').click();
  const ready=state(f,b=>b.preparation?.deliveries.at(-1)?.state==='ACKNOWLEDGED' && b.preparation.deliveries.length===3);
  await f.page.locator('[data-web-command="web.rebind"]').first().click();
  const recovered=(await ready).preparation;assert.equal(recovered.webSession.tabId,8);
  const selected=setup.extension.providerPages().find(([id])=>id===8)[1];
  const selectedPing=await setup.extension.sendContent({type:'agent.ping'},selected);
  assert.equal(recovered.webSession.documentId,selectedPing.documentId);
  assert.equal(await selected.evaluate(()=>Number(sessionStorage.getItem('clicks'))),1);
  const other=setup.extension.providerPages().find(([id])=>id===9)[1];assert.equal(await other.evaluate(()=>Number(sessionStorage.getItem('clicks')||0)),0);
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
  await f.server.restart();const recovery=state(f,b=>b.preparation?.state==='RECOVERY_REQUIRED');await f.page.reload();await recovery;
  // Reconnect the real background to the restarted server; no provider resend.
  await setup.extension.connect();
  const visible=f.page.locator('#discardPanel');await visible.waitFor({state:'visible'});
  await f.page.locator('#discardUnresolved').check();await f.page.locator('#discardNoResend').check();await f.page.locator('#discardReason').fill('Original response could not be observed');
  const done=state(f,b=>b.preparation?.lifecycle==='ABANDONED' && b.preparation.deliveries.at(-1)?.state==='RECOVERY_DISCARDED');
  await f.page.locator('#discardDeliveryButton').click();const final=(await done).preparation;
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
