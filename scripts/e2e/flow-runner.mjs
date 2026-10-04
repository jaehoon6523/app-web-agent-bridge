import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dashboardSpine, healthyLocalActions } from './helpers/dashboard.mjs';
import { connectedExtension } from './helpers/extension.mjs';
import { preparationHarness } from './helpers/preparation.mjs';
import { closureFlow } from './helpers/closure.mjs';
import { reviewHarness } from './helpers/review.mjs';
import { workerHarness } from './helpers/worker.mjs';
import { bounded } from './helpers/deadline.mjs';

export const flows = JSON.parse(fs.readFileSync(new URL('./flows.json', import.meta.url), 'utf8'));
export function registerFlow(id) {
  const flow = flows.find(f => f.id === id);
  if (!flow) throw new Error(`Unknown E2E flow: ${id}`);
  test(`${id} ${flow.title} [${flow.execution}]`, { timeout:240000 }, async t => {
    const f = await dashboardSpine(t, flow);
    try {
      if (flow.fault === 'state-database') {
        await f.page.waitForFunction(() => document.getElementById('connectionNotice').textContent.includes('상태 조회 실패'));
        assert.doesNotMatch(await f.page.locator('#connectionNotice').textContent(), /서버 응답 없음|서버 연결 끊김/u);
        assert.match(await f.page.locator('#sessionHealth').getAttribute('aria-label'), /인증됨/u);
        assert.equal(await f.page.locator('#planRun').isDisabled(), true);
        assert.equal(await f.page.locator('#chooseFolder').isDisabled(), false);
        const recovered = f.page.waitForResponse(r => new URL(r.url()).pathname === '/api/state' && r.status() === 200);
        fs.rmSync(path.join(f.server.workspace, '.agent-controller/preparations.sqlite'));
        const recoveredBody = await bounded((await bounded(recovered)).json());
        assert.ok(recoveredBody.workflow);
        await f.page.waitForFunction(() => !document.getElementById('connectionNotice').textContent.includes('상태 조회 실패'));
        await healthyLocalActions(f.page);
      } else if (id === 'UF-14') {
        await healthyLocalActions(f.page);
        const shutdown = await f.server.stop();
        assert.equal(shutdown.code, 0, 'production graceful shutdown failed');
        assert.equal(shutdown.signal, null, 'production shutdown must not require a kill signal');
        assert.equal(shutdown.forced, false, 'production shutdown must be cooperative');
        await f.page.waitForFunction(() => document.getElementById('apiHealth').getAttribute('aria-label').includes('서버 응답 없음'));
        assert.equal(await f.page.locator('#chooseFolder').isDisabled(), true);
        assert.equal(await f.page.locator('#planRun').isDisabled(), true);
      } else {
        await healthyLocalActions(f.page);
        if (flow.configured) {
          assert.equal(f.body.preflight.checks.extensionConfigured, true);
          assert.equal(f.body.preflight.checks.extensionAuthenticated, false);
          assert.match(await f.page.locator('#channelHealth').getAttribute('aria-label'), /연결 대기/u);
        }
        if (id === 'UF-02') {
          assert.equal(f.body.runtimeAvailability.ready, false);
          assert.match(await f.page.locator('#engineHealth').getAttribute('aria-label'), /런타임 준비 필요/u);
        }
        if (['UF-01B','UF-03'].includes(id)) {
          assert.equal(f.body.runtimeAvailability.ready, true);
          await f.page.locator('#objective').fill('Configured startup request');
          await f.page.locator('#startRoot').fill(f.server.workspace);
          assert.equal(await f.page.locator('#planRun').isDisabled(), true);
        }
      }
      if (['UF-01C','UF-04'].includes(id)) await connectedExtension(t, f);
      if (flow.closure) await closureFlow(t, f, flow.id);
      else if (flow.reviewHarness) await reviewHarness(t, f);
      else if (flow.workerHarness) await workerHarness(t, f);
      if (!flow.closure && !flow.workerHarness && ['UF-05','UF-06','UF-07','UF-12'].includes(id)) await preparationHarness(t, f, { revise:['UF-06','UF-07','UF-12'].includes(id) });
      assert.deepEqual(f.errors, []);
      if (flow.execution === 'BLOCKED') {
        t.diagnostic('Initial production spine plus recorded shared harness probes; full Given/When/Then continuation is BLOCKED.');
        await t.test(`${id} full continuation`, { skip:flow.gap }, () => {
          throw new Error('A continuation must implement its full contract before removing skip.');
        });
      }
      fs.writeFileSync(path.join(f.output, 'result.json'), JSON.stringify({ id, outcome:flow.execution === 'BLOCKED' ? 'INITIAL_SPINE_PASS' : 'PROFILE_PASS', execution:flow.execution, specWave:flow.specWave, skipReason:flow.gap }, null, 2));
    } catch (error) {
      fs.writeFileSync(path.join(f.output, 'failure.txt'), error.stack || String(error));
      fs.writeFileSync(path.join(f.output, 'result.json'), JSON.stringify({ id, outcome:'FAIL', execution:flow.execution, specWave:flow.specWave }, null, 2));
      throw error;
    }
  });
}
