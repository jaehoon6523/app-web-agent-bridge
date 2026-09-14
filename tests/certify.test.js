import assert from 'node:assert/strict';
import test from 'node:test';
import { main, run } from '../scripts/certify.js';
import { setupAudit } from './helpers/audit-fixtures.js';

function certification(snapshot) {
  const paths = [];
  return { paths, options: {
    certificationRunId: snapshot.run.runId, dashboardToken: 'test-token', requireApplied: false,
    check() {},
    async request(path, authenticated) {
      paths.push(path);
      if (path === '/api/health') return { ok: true, codexRuntimeReady: false, webRuntimeReady: false };
      assert.equal(path, `/api/state?runId=${snapshot.run.runId}`);
      assert.equal(authenticated, true);
      return snapshot;
    },
  } };
}

test('persisted audit check accepts an actual fixture run with disconnected providers', async t => {
  const f = setupAudit(t), completed = await f.run();
  const snapshot = f.service.snapshot(completed.runId, {});
  const { options, paths } = certification(snapshot);
  await main(options);
  assert.deepEqual(paths, ['/api/health', `/api/state?runId=${completed.runId}`]);
});

test('persisted audit check rejects empty proof, candidate drift, missing findings and injected authority', async t => {
  const f = setupAudit(t), completed = await f.run();
  const saved = f.service.snapshot(completed.runId, {});
  for (const [label, mutate, expected] of [
    ['audit failed', s => { s.run.auditResult = 'HOLD'; }, /auditResult PASS/],
    ['no evidence', s => { s.evidence = []; }, /no persisted evidence/],
    ['empty records', s => { s.assessments = [{}]; s.evidence = [{}]; }, /differs/],
    ['wrong capture', s => { s.run.capture.candidateTree = 'other'; }, /different candidates/],
    ['changed requirements', s => { s.run.requirements.items[0].acceptanceCriteria = 'changed'; }, /requirements/],
    ['missing findings', s => { delete s.findings; }, /differs/],
    ['authority injection', s => { s.run.reviews.at(-1).report.approved = true; }, /only/],
    ['wrong report candidate', s => { s.run.reviews.at(-1).report.candidateId = 'other'; }, /mismatch/],
  ]) {
    await t.test(label, async () => {
      const snapshot = structuredClone(saved); mutate(snapshot);
      await assert.rejects(main(certification(snapshot).options), expected);
    });
  }
  await assert.rejects(main({ ...certification(saved).options, requireApplied: true }), /must be APPLIED/);
  const shallow = { run: { runId: 'shallow', schemaVersion: 3, auditResult: 'PASS', stage: 'AWAITING_APPLY' },
    assessments: [{}], evidence: [{}], findings: [] };
  await assert.rejects(main(certification(shallow).options), /no complete candidate-bound review/);
});

test('certification command runner launches npm on Windows', { skip: process.platform !== 'win32' }, () => {
  run('npm.cmd', ['--version']);
});
