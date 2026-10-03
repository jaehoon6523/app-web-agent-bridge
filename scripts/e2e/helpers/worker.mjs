import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { preparationHarness } from './preparation.mjs';

export async function workerHarness(t, f, { reviewReply = () => new Promise(() => {}), beforeCandidate = null } = {}) {
  // Approval performs all production workspace setup/capture. Only initialize the disposable input Git target.
  const git = (...args) => execFileSync('git', ['-C', f.server.workspace, ...args], { encoding:'utf8' }).trim();
  git('init','--quiet'); git('config','user.name','E2E'); git('config','user.email','e2e@example.invalid');
  fs.writeFileSync(path.join(f.server.workspace, 'README.md'), 'Disposable target\n');
  fs.writeFileSync(path.join(f.server.workspace, '.gitignore'), '.agent-controller/\nworker-observed.json\nworker-history.json\n');
  git('add','README.md','.gitignore'); git('commit','-m','Initial target');
  const before = git('rev-parse','HEAD');
  const prepared = await preparationHarness(t, f, { revise:true, afterPreparationReply:reviewReply });
  assert.equal(fs.existsSync(path.join(f.server.workspace, 'worker-observed.json')), false);
  const approve = f.page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/approve'));
  const captured = f.page.waitForResponse(async r => new URL(r.url()).pathname === '/api/state' && r.status() === 200 && Boolean((await r.json()).run?.candidate), { timeout:90000 });
  await f.page.locator('#saveProject').click();
  const approvalResponse = await approve;
  assert.equal(approvalResponse.status(), 200, JSON.stringify(await approvalResponse.json()));
  await beforeCandidate?.(prepared);
  const body = await (await captured).json(), run = body.run;
  assert.ok(run.candidate.candidateId);
  assert.equal(run.candidate.runId, run.runId);
  assert.equal(run.candidate.baseCommit, before);
  assert.ok(run.candidate.changedFiles.includes('clock.txt'));
  assert.equal(body.preparation.resultingRunId, run.runId);
  assert.equal(body.preparation.agreement.status, 'APPROVED');
  assert.deepEqual(run.requirements.items.map(({ statement, acceptanceCriteria }) => ({ statement, acceptanceCriteria })), prepared.context.agreement.requirements);
  const peer = JSON.parse(fs.readFileSync(path.join(f.server.workspace, 'worker-observed.json')));
  const expectedWorktree = path.join(path.dirname(f.server.workspace), '.bridge-worktrees', run.runId);
  assert.equal(peer.workspaceRoot, expectedWorktree);
  t.after(() => fs.rmSync(expectedWorktree, { recursive:true, force:true }));
  assert.notEqual(peer.workspaceRoot, f.server.workspace);
  assert.deepEqual(peer.requirementIds, run.requirements.items.map(item => item.requirementId));
  assert.equal(fs.readFileSync(path.join(peer.workspaceRoot, 'clock.txt'), 'utf8'), 'Controlled worker candidate: hours minutes seconds\n');
  assert.equal(fs.existsSync(path.join(f.server.workspace, 'clock.txt')), false);
  assert.equal(git('rev-parse','HEAD'), before);
  const db = new DatabaseSync(path.join(f.server.workspace, '.agent-controller/controller.sqlite'), { readOnly:true });
  let saved;
  try { saved = JSON.parse(db.prepare('SELECT record_json FROM code_change_runs WHERE run_id=?').get(run.runId).record_json); }
  finally { db.close(); }
  assert.equal(saved.candidate.candidateId, run.candidate.candidateId);
  assert.equal(saved.candidate.patchHash, run.candidate.patchHash);
  assert.equal(saved.workerThread?.threadId ?? saved.workerThread, peer.sessionId);
  assert.equal(saved.workerTurnId, peer.turnId);
  const patch = fs.readFileSync(path.join(f.server.workspace, '.agent-controller/artifacts', run.candidate.patchHash.slice(7)));
  assert.equal('sha256:' + createHash('sha256').update(patch).digest('hex'), run.candidate.patchHash);
  assert.ok(patch.toString().includes('clock.txt'));
  assert.equal(git('show', run.candidate.candidateTree + ':clock.txt'), 'Controlled worker candidate: hours minutes seconds');
  fs.writeFileSync(path.join(f.output, 'candidate.patch'), patch);
  await f.page.locator('#runPanel').waitFor({ state:'visible' });
  assert.ok((await f.page.locator('#runObjective').textContent()).includes(prepared.context.objective));
  assert.equal(await f.page.locator('#applyCode').isEnabled(), false);
  assert.equal(await f.page.locator('#saveProject').isVisible(), false);
  assert.match(await f.page.locator('#workerProvenance').textContent(), /qwen|codex/u);
  await f.page.locator('#showAudit').click();
  assert.ok((await f.page.locator('#candidateDetails').textContent()).includes(run.candidate.candidateId));
  fs.writeFileSync(path.join(f.output, 'worker-boundary.json'), JSON.stringify({ runId:run.runId, preparationId:prepared.context.preparationId, peer, candidate:run.candidate, savedCandidate:saved.candidate, targetUnapplied:true, review:'CONTROLLED pending; NOT VERIFIED', provider:'qwen JSONL route with external Node fixture; not real Qwen/Codex' }, null, 2));
  return { ...prepared, run };
}
