import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dashboardSpine } from './helpers/dashboard.mjs';
import { startWorker, workerHarness } from './helpers/worker.mjs';
import { waitForState } from './helpers/observations.mjs';
import { command } from './helpers/lifecycle.mjs';

test('ST-11 and ST-12 through an isolated running Worker and dashboard', {timeout:240000}, async t => {
  const f = await dashboardSpine(t, {id:'ST-11-12-worker-recovery', configured:true, workerMode:'active'});
  const state = predicate => waitForState(f.page, predicate, {timeout:45000});
  const refresh = () => f.page.locator('#refreshDashboard').click();
  const retry = f.page.locator('#retryRun');
  const consoleText = f.page.locator('#runWorkerConsoleState');
  const error = f.page.locator('#runWorkerConsoleFailure');
  const signal = event => fs.writeFileSync(path.join(f.server.workspace, '.agent-controller', 'worker-test-signal'), JSON.stringify(event));
  let initial, next;
  const setup = await workerHarness(t, f, {beforeCandidate:async () => {
    const initialState = await state(b => b.run?.stage === 'WORKER_RUNNING' && b.run.workerTurnId && b.workerRuntime?.threadId);
    initial = initialState.run;
    await consoleText.waitFor({state:'visible'});
    assert.match(await consoleText.textContent(), /실행|작업/u);
    assert.ok(!(await retry.isVisible()) || !(await retry.isEnabled()));
    const stateRoute = '**/api/state*';
    await f.page.route(stateRoute, async route => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.run?.workerTurnId === initial.workerTurnId) body.workerRuntime = null;
      await route.fulfill({response, json:body});
    });
    await refresh();
    await f.page.waitForFunction(() => document.getElementById('runWorkerConsoleState').textContent.includes('최신 활동은 확인되지 않았습니다'));
    await f.page.unroute(stateRoute);
    const approval = state(b => b.workerRuntime?.activity === 'APPROVAL_WAIT' && b.workerRuntime.turnId === initial.workerTurnId);
    signal({kind:'approval'});
    await approval;
    await f.page.waitForFunction(() => document.getElementById('runWorkerConsoleState').textContent.includes('Codex 승인 대기'));

    const failure = state(b => b.run?.stage === 'RECOVERY_REQUIRED' && b.run.workerTurnId === initial.workerTurnId
      && b.commandCapabilities?.includes('run.retry'));
    fs.writeFileSync(path.join(f.server.workspace, '.agent-controller', 'worker-fail-turn'), initial.workerTurnId);
    const failed = (await failure).run;
    assert.equal(failed.workerTurns.at(-1).status, 'failed');
    assert.match(failed.workerTurns.at(-1).metadata.error, /External turn timed out/u);
    await error.waitFor({state:'visible'});
    assert.match(await error.textContent(), /Worker 응답 시간이 초과됐습니다/u);
    assert.match(await f.page.locator('#runWorkerConsoleCandidate').textContent(), /고정 후보 없음/u);

    const reloaded = state(b => b.run?.runId === initial.runId);
    await f.page.reload();
    assert.equal((await reloaded).run.workerTurnId, initial.workerTurnId);
    const refreshed = state(b => b.run?.runId === initial.runId);
    await refresh();
    assert.equal((await refreshed).run.stage, 'RECOVERY_REQUIRED');

    const newTurn = state(b => b.run?.stage === 'WORKER_RUNNING' && b.run.workerTurnId
      && b.run.workerTurnId !== initial.workerTurnId);
    const sentRetries = [];
    f.page.on('request', req => {
      if (new URL(req.url()).pathname === '/api/commands' && req.method() === 'POST'
        && req.postDataJSON()?.type === 'run.retry') sentRetries.push(req);
    });
    const retryResponse = f.page.waitForResponse(res => new URL(res.url()).pathname === '/api/commands'
      && res.request().method() === 'POST' && res.request().postDataJSON()?.type === 'run.retry');
    await retry.click();
    const response = await retryResponse;
    assert.equal(response.status(), 200, await response.text());
    next = (await newTurn).run;
    assert.equal(sentRetries.length, 1);
    assert.deepEqual(next.requirementsRef, initial.requirementsRef);
    assert.equal(next.recoveryAttempts.at(-1).previousTurnId, initial.workerTurnId);
    await error.waitFor({state:'hidden'});
    const afterLateEvent = state(b => b.workerRuntime?.activity === 'TOOL_RUNNING' && b.workerRuntime.turnId === next.workerTurnId);
    signal({kind:'late-failure', turnId:initial.workerTurnId});
    const afterLate = (await afterLateEvent).run;
    assert.equal(afterLate.stage, 'WORKER_RUNNING');
    assert.equal(afterLate.workerTurnId, next.workerTurnId);
    assert.equal(afterLate.recoveryAttempts.length, 1);
    assert.equal(sentRetries.length, 1);
    assert.equal(await error.isVisible(), false);
    signal({kind:'stale-approval', threadId:initialState.workerRuntime.threadId, turnId:initial.workerTurnId});
    const receiptPath = path.join(f.server.workspace, '.agent-controller', 'worker-stale-approval-result');
    const approvalChecked = state(() => fs.existsSync(receiptPath));
    await refresh();
    const afterApproval = await approvalChecked;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    assert.match(receipt.error?.message ?? '', /active turn/u);
    assert.equal(receipt.result, undefined);
    assert.equal(afterApproval.run.workerTurnId, next.workerTurnId);
    assert.equal(afterApproval.run.recoveryAttempts.length, 1);
    assert.notEqual(afterApproval.workerRuntime.activity, 'APPROVAL_WAIT');
    assert.ok(!(afterApproval.events ?? []).some(event => event.payload?.itemId === 'stale-approval-item'));
    for (const kind of ['GUIDANCE', 'QUESTION']) {
      await f.page.locator('#workerInterventionKind').selectOption(kind);
      await f.page.locator('#workerInterventionText').fill('Controlled ' + kind);
      const delivered = state(b => b.run?.userInterventions?.filter(x => x.status === 'DELIVERED')
        .length === (kind === 'GUIDANCE' ? 1 : 2));
      await f.page.locator('#sendWorkerIntervention').click();
      await delivered;
    }
  }});
  assert.equal(setup.run.workerTurnId, next.workerTurnId);
  assert.ok(!(await retry.isVisible()) || !(await retry.isEnabled()));
  const blocked = await command(f, 'run.retry', {runId:setup.run.runId, expectedVersion:setup.run.version});
  assert.ok(blocked.status >= 400);
  const fixed = state(b => b.run?.candidate?.candidateId === setup.run.candidate.candidateId);
  await refresh();
  assert.equal((await fixed).run.workerTurnId, next.workerTurnId);
});

test('ST-12 rejects Worker retry after a candidate is captured', {timeout:150000}, async t => {
  const f = await dashboardSpine(t, {id:'ST-12-fixed-candidate', configured:true, workerHarness:true});
  const {run} = await workerHarness(t, f);
  const retry = f.page.locator('#retryRun');
  assert.ok(!(await retry.isVisible()) || !(await retry.isEnabled()));
  const denied = await command(f, 'run.retry', {runId:run.runId, expectedVersion:run.version});
  assert.ok(denied.status >= 400);
  const selected = waitForState(f.page, b => b.run?.runId === run.runId);
  await f.page.reload();
  const after = (await selected).run;
  assert.equal(after.candidate.candidateId, run.candidate.candidateId);
  assert.equal(after.workerTurnId, run.workerTurnId);
});

test('ST-12 blocks Worker retry when external termination cannot be confirmed', {timeout:150000}, async t => {
  const f = await dashboardSpine(t, {id:'ST-12-unconfirmed-termination', configured:true, workerMode:'active'});
  await startWorker(t, f);
  const active = (await waitForState(f.page, b => b.run?.stage === 'WORKER_RUNNING' && b.run.workerTurnId)).run;
  const failed = waitForState(f.page, b => b.run?.stage === 'RECOVERY_REQUIRED'
    && b.commandCapabilities?.includes('run.retry'));
  fs.writeFileSync(path.join(f.server.workspace, '.agent-controller', 'worker-fail-turn'), active.workerTurnId);
  const {run} = await failed;
  const uncertain = waitForState(f.page, b => b.run?.terminationReason === 'STOP_UNCERTAIN');
  const stopped = await command(f, 'run.stop', {runId:run.runId, expectedVersion:run.version});
  assert.equal(stopped.status, 200, stopped.body);
  const blocked = (await uncertain).run;
  assert.ok(blocked.stopResults.some(result => result.actor === 'EXTERNAL' && !result.confirmed));
  const retry = f.page.locator('#retryRun');
  assert.ok(!(await retry.isVisible()) || !(await retry.isEnabled()));
  const denied = await command(f, 'run.retry', {runId:run.runId, expectedVersion:blocked.version});
  assert.ok(denied.status >= 400);
  const reloaded = waitForState(f.page, b => b.run?.runId === run.runId);
  await f.page.reload();
  const after = (await reloaded).run;
  assert.equal(after.terminationReason, 'STOP_UNCERTAIN');
  assert.equal(after.workerTurnId, active.workerTurnId);
  assert.equal(after.recoveryAttempts?.length ?? 0, 0);
});
