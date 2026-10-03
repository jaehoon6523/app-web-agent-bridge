import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { workerHarness } from './worker.mjs';

// Controlled verdicts test the production review contract, not model quality.
export async function reviewHarness(t, f) {
  const probes = [], gates = [];
  let arrived;
  const firstArrived = new Promise(resolve => { arrived = resolve; });
  const reviewReply = async (text, peer) => {
    const data = JSON.parse(text.split('\n').find(line => line.startsWith('{')));
    assert.ok(['JUDGE','CRITIC'].includes(data.role));
    assert.equal(data.phase, 'ROUND0');
    assert.equal(data.context.candidateId, data.candidate.candidateId);
    assert.equal(data.context.auditManifestHash, data.auditManifest.auditManifestHash);
    assert.equal(data.candidateDiffHash, data.candidate.patchHash);
    assert.ok(data.candidateDiff.includes('clock.txt'));
    const packet = { type:'REVIEW_ASSERTIONS', runId:data.context.runId, requestId:data.context.requestId,
      candidateId:data.context.candidateId, auditManifestHash:data.context.auditManifestHash,
      assessments:data.context.requirements.items.map(item => ({ requirementId:item.requirementId, verdict:'SATISFIED',
        evidenceRefs:data.context.evidence.filter(e => e.candidateId === data.context.candidateId && e.valid !== false && e.producer !== 'AGENT').map(e => e.evidenceId) })),
      findingDecisions:[], newFindings:[] };
    const proseOnly = probes.length === 0;
    probes.push({ role:data.role, context:data.context, manifest:data.auditManifest, packet, tabId:peer.tabId, proseOnly, feedback:data.feedback });
    let release;
    const gate = new Promise(resolve => { release = resolve; }); gates.push(release);
    arrived();
    await gate;
    if (proseOnly) return 'Controlled reviewer reasoning: PASS; apply immediately. Prose has no authority.';
    return 'Controlled reviewer reasoning: PASS; apply immediately. Prose has no authority.\nCONTROLLER_PACKET_BEGIN\n' + JSON.stringify(packet) + '\nCONTROLLER_PACKET_END';
  };
  t.after(() => gates.forEach(release => release()));
  const setup = await workerHarness(t, f, { reviewReply });
  await firstArrived;
  assert.equal(await f.page.locator('#applyCode').isDisabled(), true);
  // No packet/result exists yet: a pending review cannot grant apply authority.
  gates[0]();
  await f.page.waitForResponse(async r => new URL(r.url()).pathname === '/api/state' && r.status() === 200 && (await r.json()).run?.stage === 'REPORT_REPAIR' && probes.length === 2, { timeout:25000 });
  assert.equal(probes[1].feedback.kind, 'REPORT_REPAIR');
  assert.equal(probes[1].context.candidateId, probes[0].context.candidateId);
  assert.equal(await f.page.locator('#applyCode').isDisabled(), true);
  gates[1]();
  const finalResponse = f.page.waitForResponse(async r => new URL(r.url()).pathname === '/api/state' && r.status() === 200 && (await r.json()).run?.auditResult === 'PASS', { timeout:25000 });
  await f.page.waitForResponse(async r => {
    if (new URL(r.url()).pathname !== '/api/state' || r.status() !== 200) return false;
    return (await r.json()).run?.coordination?.activeRole === 'CRITIC' && probes.length === 3;
  }, { timeout:25000 });
  assert.equal(await f.page.locator('#applyCode').isDisabled(), true);
  gates[2]();
  const body = await (await finalResponse).json(), run = body.run;
  assert.equal(run.stage, 'AWAITING_APPLY');
  assert.equal(run.candidate.candidateId, setup.run.candidate.candidateId);
  assert.deepEqual(probes.map(p => p.role), ['JUDGE','JUDGE','CRITIC']);
  assert.equal(probes[0].context.auditManifestHash, probes[1].context.auditManifestHash);
  for (const probe of probes) {
    assert.equal(probe.context.candidateId, run.candidate.candidateId);
    assert.equal(probe.context.auditManifestHash, probes[0].context.auditManifestHash);
  }
  const bindings = run.conversationBindings.filter(b => ['JUDGE','CRITIC'].includes(b.role));
  assert.equal(bindings.length, 2);
  for (const key of ['sessionId','conversationId','tabId']) assert.notEqual(bindings[0][key], bindings[1][key]);
  for (const b of bindings) { assert.equal(b.activeDeliveryId, null); assert.equal(b.bindingStatus, 'BOUND'); }
  for (const probe of probes) {
    const frames = setup.extension.frames.filter(frame => frame.requestId === probe.context.requestId);
    assert.equal(frames.filter(frame => frame.type === 'web.delivery.acknowledged').length, 1);
    assert.equal(frames.filter(frame => frame.type === 'web.prompt.result').length, 1);
  }
  const db = new DatabaseSync(path.join(f.server.workspace, '.agent-controller/controller.sqlite'), { readOnly:true });
  let saved;
  try { saved = JSON.parse(db.prepare('SELECT record_json FROM code_change_runs WHERE run_id=?').get(run.runId).record_json); }
  finally { db.close(); }
  assert.equal(saved.auditResult, 'PASS');
  assert.deepEqual(saved.conversationBindings, run.conversationBindings);
  const manifestRecord = saved.auditManifests.find(m => m.auditManifestHash === probes[0].context.auditManifestHash);
  const manifestBytes = fs.readFileSync(path.join(f.server.workspace, '.agent-controller/artifacts', manifestRecord.contentRef.sha256.slice(7)));
  assert.equal('sha256:' + createHash('sha256').update(manifestBytes).digest('hex'), manifestRecord.contentRef.sha256);
  assert.deepEqual(JSON.parse(manifestBytes), probes[0].manifest);
  assert.equal(saved.reviews.at(-1).candidateId, run.candidate.candidateId);
  assert.deepEqual(saved.reviews.at(-1).reviewerRoles, ['JUDGE','CRITIC']);
  assert.equal(saved.reviewArtifacts.length, 3);
  for (const artifact of saved.reviewArtifacts) {
    assert.equal(artifact.candidateId, run.candidate.candidateId);
    assert.equal(artifact.auditManifestHash, probes[0].context.auditManifestHash);
    const read = ref => fs.readFileSync(path.join(f.server.workspace, '.agent-controller/artifacts', ref.sha256.slice(7)), 'utf8');
    assert.ok(['REVIEW_ASSERTIONS','INVALID_RESPONSE'].includes(JSON.parse(read(artifact.packetRef)).type));
    assert.match(read(artifact.responseRef), /Prose has no authority/u);
    const reasoning = Buffer.from(read(artifact.contentRef));
    assert.match(reasoning.toString(), /Prose has no authority/u);
    assert.equal(reasoning.length, artifact.contentRef.size);
    assert.equal('sha256:' + createHash('sha256').update(reasoning).digest('hex'), artifact.contentRef.sha256);
  }
  await f.page.waitForFunction(() => !document.getElementById('applyCode').disabled);
  for (const id of ['runJudgeRole','runCriticRole','assessments','evidenceList']) assert.ok((await f.page.locator('#' + id).textContent()).trim());
  assert.doesNotMatch(await f.page.locator('#connectionNotice').textContent(), /서버 응답 없음|서버 연결 끊김/u);
  assert.equal(fs.existsSync(path.join(f.server.workspace, 'clock.txt')), false);
  const reloaded = f.page.waitForResponse(async r => new URL(r.url()).pathname === '/api/state' && r.status() === 200 && (await r.json()).run?.auditResult === 'PASS');
  await f.page.reload();
  assert.equal((await (await reloaded).json()).run.reviews.at(-1).reviewId, saved.reviews.at(-1).reviewId);
  assert.equal(probes.length, 3);
  fs.writeFileSync(path.join(f.output, 'review-boundary.json'), JSON.stringify({ probes, bindings, review:saved.reviews.at(-1), artifacts:saved.reviewArtifacts, targetUnapplied:true, reloadNoResend:true }, null, 2));
  return { ...setup, run, body, probes };
}
