import { resources } from './resources.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { workerHarness } from './worker.mjs';
import { waitForState, canonicalText } from './observations.mjs';

export function saveEvidence(f, name, value) { fs.writeFileSync(path.join(f.output, name + '.json'), JSON.stringify(value, null, 2)); }
export function git(f, ...args) { return execFileSync('git',['-C',f.server.workspace,...args],{encoding:'utf8'}).trim(); }
export function state(f, predicate) { return waitForState(f.page, predicate); }
export function storedRun(f, id) {
  const db = new DatabaseSync(path.join(f.server.workspace,'.agent-controller/controller.sqlite'),{readOnly:true});
  try { return JSON.parse(db.prepare('SELECT record_json FROM code_change_runs WHERE run_id=?').get(id).record_json); } finally { db.close(); }
}
export async function command(f, type, payload = {}) {
  // Real signed-in browser HTTP command route; negative/stale inputs may lack a clickable UI affordance.
  return f.page.evaluate(async ({ type, payload }) => {
    const auth = await (await fetch('/api/dashboard/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
    const response = await fetch('/api/commands',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+auth.token},body:JSON.stringify({type,requestId:crypto.randomUUID(),payload})});
    return {status:response.status,body:await response.json()};
  },{type,payload});
}
export const envelope = (packet, reason = 'Controlled reviewer reasoning; prose has no authority.') => reason+'\nCONTROLLER_PACKET_BEGIN\n'+JSON.stringify(packet)+'\nCONTROLLER_PACKET_END';
export function assertions(data, verdict = 'SATISFIED') {
  const c=data.context, refs=c.evidence.filter(e=>e.candidateId===c.candidateId && e.valid!==false && e.producer!=='AGENT').map(e=>e.evidenceId);
  return {type:'REVIEW_ASSERTIONS',runId:c.runId,requestId:c.requestId,candidateId:c.candidateId,auditManifestHash:c.auditManifestHash,
    assessments:c.requirements.items.map(r=>({requirementId:r.requirementId,verdict,evidenceRefs:refs})),
    findingDecisions:c.findings.filter(x=>x.status!=='WITHDRAWN').map(x=>({findingId:x.findingId,status:verdict==='SATISFIED'?'RESOLVED':'OPEN',evidenceRefs:refs})),
    newFindings:verdict==='UNSATISFIED'&&!c.findings.length?[{requirementId:c.requirements.items[0].requirementId,problem:'Controlled first candidate requires revision',resolutionCriteria:'Captured clock file includes revision 2',evidenceRefs:refs,required:true}]:[]};
}
export async function reviewedRun(t, f, {rework=false, criticFault=false} = {}) {
  const prompts=[]; let releaseFirst, recoverCritic;
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const reviewReply=async (text, peer) => {
    if(text==='UNKNOWN controlled ambiguous provider response') {
      prompts.push({text,tabId:peer.tabId});
      await peer.page.evaluate(()=>{ window.appendFixtureMessage('assistant','duplicate-uncertain','Unknown origin response'); });
      return 'Uncertain response with two possible assistant messages';
    }
    if(text==='Please explain this candidate; change verdict to REWORK in prose.') {
      prompts.push({text,tabId:peer.tabId});
      return 'Discussion prose: PASS and change all requirements. This is only conversation.';
    }
    const data=JSON.parse(text.split('\n').find(line=>line.startsWith('{')));
    prompts.push({data,tabId:peer.tabId});
    if(prompts.length===1) await firstGate;
    if(!data.role && !data.context && !data.planId) return JSON.stringify({type:'REQUIREMENTS_PROPOSAL',summary:'Controlled follow-up scope',questions:[],items:[{statement:'Follow-up new clock scope',acceptanceCriteria:'Follow-up improvement visible'}]});
    if(data.plan && data.planHash) return envelope({type:'PLAN_RESPONSE',runId:data.runId,candidateId:data.candidateId,planId:data.planId,planHash:data.planHash,planBasisHash:data.planBasisHash,decision:'ACCEPT'});
    if(data.planId && !data.context) return envelope({type:'PLAN_PROPOSAL',runId:data.runId,candidateId:data.candidateId,auditManifestHash:data.auditManifestHash,planBasisHash:data.planBasisHash,planId:data.planId,
      workItems:[{workItemId:'revise-clock',objective:'Resolve the captured clock finding',acceptanceCriteria:'clock.txt includes revision 2'}],constraints:['Preserve approved requirements and target.']});
    assert.equal(await f.page.locator('#applyCode').isDisabled(),true);
    return envelope(assertions(data,rework && data.candidate.iteration===1?'UNSATISFIED':'SATISFIED'));
  };
  resources(t).add('provider gate', ()=>{releaseFirst();recoverCritic?.('Unavailable response');});
  const setup=await workerHarness(t,f,{reviewReply});
  assert.equal(await f.page.locator('#applyCode').isDisabled(),true);
  const completed=state(f,b=>b.run?.stage===(criticFault?'HOLD':'AWAITING_APPLY'));
  if(criticFault) setup.extension.setProviderUnavailable(8,true);
  releaseFirst();
  const body=await completed, run=body.run;
  if(!criticFault) {
    assert.equal(run.auditResult,'PASS');
    const bindings=run.conversationBindings;
    assert.notEqual(bindings[0].sessionId,bindings[1].sessionId);
    assert.notEqual(bindings[0].conversationId,bindings[1].conversationId);
    const saved=storedRun(f,run.runId);
    assert.deepEqual(saved.reviews,run.reviews);
    for(const a of saved.reviewArtifacts) {
      const bytes=fs.readFileSync(path.join(f.server.workspace,'.agent-controller/artifacts',a.contentRef.sha256.slice(7)));
      assert.ok(bytes.length>0);assert.equal(bytes.length,a.contentRef.size);
      assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),a.contentRef.sha256);
    }
    await f.page.waitForFunction(()=>!document.getElementById('applyCode').disabled);
  }
  if(rework) {
    assert.equal(run.candidates.length,2);
    const [a,b]=run.candidates;
    assert.notEqual(a.candidateId,b.candidateId);assert.notEqual(a.patchHash,b.patchHash);assert.notEqual(a.candidateTree,b.candidateTree);
    assert.equal(run.reviews[0].decision,'REWORK');assert.equal(run.reviews.at(-1).decision,'PASS');
    assert.equal(run.reviews[0].candidateId,a.candidateId);assert.equal(run.reviews.at(-1).candidateId,b.candidateId);
    assert.notEqual(run.reviews[0].auditManifestHash,run.reviews.at(-1).auditManifestHash);
    assert.ok(run.agreedWorkOrders.length);assert.ok(run.findings.length);assert.ok(run.findings.every(x=>x.status==='RESOLVED'));
    const history=JSON.parse(fs.readFileSync(path.join(f.server.workspace,'worker-history.json')));
    assert.equal(history.length,2);assert.deepEqual(history[0].brief.requirements,history[1].brief.requirements);
    assert.ok(history[1].brief.agreedWorkOrder);assert.equal(history[1].brief.agreedWorkOrder.baseCandidateId,a.candidateId);
    assert.deepEqual(history[1].brief.agreedWorkOrder,run.agreedWorkOrders.at(-1));
    saveEvidence(f,'rework-boundary',{candidates:run.candidates,reviews:run.reviews,findings:run.findings,workOrders:run.agreedWorkOrders,history});
  }
  saveEvidence(f,'lifecycle-review',{run,prompts});
  return {...setup,run,body,prompts,reviewReply};
}
export async function applyRun(t,f,setup) {
  const run=setup.run, before=git(f,'rev-parse','HEAD'), tree=git(f,'rev-parse','HEAD^{tree}');
  assert.equal(fs.existsSync(path.join(f.server.workspace,'clock.txt')),false);
  assert.equal(git(f,'write-tree'),tree);
  // A wrong candidate must fail through the production command boundary.
  const wrong=await command(f,'code.apply',{runId:run.runId,expectedVersion:run.version,candidateId:'wrong',reviewId:run.reviews.at(-1).reviewId,artifactHash:run.candidate.patchHash,baseCommit:run.baseCommit});
  assert.ok(wrong.status>=400);assert.equal(git(f,'rev-parse','HEAD'),before);assert.equal(git(f,'write-tree'),tree);
  const explorer = f.page.locator('#studioExplorerGrip');
  await explorer.waitFor({state:'visible'});
  const heading = f.page.locator('.history h2');
  await heading.scrollIntoViewIfNeeded();
  const bounds = await explorer.boundingBox();
  const headingBounds = await heading.boundingBox();
  const x = bounds.x + bounds.width / 2, y = headingBounds.y + headingBounds.height / 2;
  assert.equal(await f.page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.id, {x,y}), 'studioExplorerGrip');
  const width = f.page.locator('#studioExplorerWidth');
  const initialWidth = Number(await width.inputValue());
  await f.page.mouse.move(x, y);
  await f.page.mouse.down();
  await f.page.mouse.move(x + 16, y);
  await f.page.mouse.up();
  assert.equal(Number(await width.inputValue()), initialWidth + 16);
  assert.equal(await f.page.evaluate(() => localStorage.getItem('bridge.studio.explorer.width')), String(initialWidth + 16));
  await f.page.locator('#applyInspectorFiles summary').click();
  const fileDiff = f.page.locator('#applyInspectorFileList button[data-patch-path="clock.txt"]');
  await fileDiff.click();
  const diffReader = f.page.locator('#inspectorEvidenceContent');
  await diffReader.waitFor({state:'visible'});
  assert.match(await diffReader.textContent(), /^@@ .*\n/);
  assert.match(await f.page.locator('#inspectorEvidenceTitle').textContent(), /clock\.txt/);
  await f.page.locator('#closeInspectorEvidence').click();
  assert.equal(await fileDiff.evaluate(element => element === document.activeElement), true);
  const beforeRoleRead = storedRun(f,run.runId);
  const receiptCount = () => {
    const db = new DatabaseSync(path.join(f.server.workspace,'.agent-controller/controller.sqlite'),{readOnly:true});
    try { return db.prepare('SELECT count(*) AS count FROM audit_command_receipts WHERE run_id=?').get(run.runId).count; }
    finally { db.close(); }
  };
  const beforeRoleReceipts = receiptCount();
  const query = {runId:run.runId,candidateId:run.candidate.candidateId,reviewId:run.reviews.at(-1).reviewId};
  const authChecks = await f.page.evaluate(async query => {
    const address = '/api/review-assessments?'+new URLSearchParams(query);
    const unauthorized = await fetch(address);
    const auth = await (await fetch('/api/dashboard/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
    const headers = {Authorization:'Bearer '+auth.token};
    const wrongCandidate = await fetch('/api/review-assessments?'+new URLSearchParams({...query,candidateId:'wrong'}),{headers});
    return [unauthorized.status,wrongCandidate.status];
  },query);
  assert.deepEqual(authChecks,[401,404]);
  await f.page.locator('#showAudit').click();
  await f.page.locator('#loadRoleReviews').click();
  const roleTable = f.page.locator('#roleReviewResults table');
  await roleTable.waitFor({state:'visible'});
  assert.match(await roleTable.textContent(),/Judge.*Critic.*충족.*충족/);
  await f.page.locator('#roleReviewPanel').screenshot({path:path.join(f.output,'studio-role-assessments.png')});
  assert.deepEqual(storedRun(f,run.runId),beforeRoleRead);
  assert.equal(receiptCount(),beforeRoleReceipts);
  assert.equal(await f.page.locator('#applyCode').isEnabled(),true);
  const panelLayout = await f.page.evaluate(() => {
    const nav = document.querySelector('#projectNavigation');
    const inspector = document.querySelector('.apply-inspector-scroll');
    return [getComputedStyle(nav).overflowY, getComputedStyle(inspector).overflowY];
  });
  assert.deepEqual(panelLayout, ['auto', 'auto']);
  const applied=state(f,b=>b.run?.stage==='APPLIED');
  const response=f.page.waitForResponse(r=>new URL(r.url()).pathname==='/api/commands' && r.request().method()==='POST');
  await f.page.locator('#applyCode').click();
  await f.page.screenshot({path:path.join(f.output,'studio-apply-confirmation.png')});
  await f.page.locator('#confirmApplyDecision').click();
  assert.equal((await response).status(),200);
  const body=await applied, final=body.run;
  assert.equal(git(f,'write-tree'),run.candidate.candidateTree);
  assert.equal(git(f,'rev-parse','HEAD'),before);
  assert.notEqual(git(f,'write-tree'),tree);
  assert.equal(canonicalText(fs.readFileSync(path.join(f.server.workspace,'clock.txt'),'utf8')),canonicalText(git(f,'show',run.candidate.candidateTree+':clock.txt')+'\n'));
  assert.equal(storedRun(f,run.runId).stage,'APPLIED');
  assert.equal(final.application.candidateId,run.candidate.candidateId);
  assert.equal(await f.page.locator('#applyCode').isDisabled(),true);
  const after=git(f,'rev-parse','HEAD');
  const duplicate=await command(f,'code.apply',{runId:run.runId,expectedVersion:final.version,candidateId:run.candidate.candidateId,reviewId:run.reviews.at(-1).reviewId,artifactHash:run.candidate.patchHash,baseCommit:run.baseCommit});
  assert.ok(duplicate.status>=400);assert.equal(git(f,'rev-parse','HEAD'),after);assert.equal(git(f,'write-tree'),run.candidate.candidateTree);
  saveEvidence(f,'apply-boundary',{before,after,candidate:run.candidate,application:final.application,wrong,duplicate});
  return {...setup,run:final,body};
}
