import test from 'node:test';
import assert from 'node:assert/strict';
import { productionProcess } from '../../scripts/e2e/helpers/process.mjs';
import { launchBrowser } from '../../scripts/e2e/helpers/browser.mjs';
import { waitForState } from '../../scripts/e2e/helpers/observations.mjs';
import { resources } from '../../scripts/e2e/helpers/resources.mjs';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteStore } from '../../src/persistence/sqlite-store.js';
import { CodeChangeStore } from '../../src/persistence/code-change-store.js';
import { createDiscussionRunPolicy } from '../../src/domain/run-policy.js';
import { RunService } from '../../src/orchestration/run-service.js';

test('real Chromium reload observes production state and render then closes the production lifecycle', {timeout:45000}, async t => {
  const server=await productionProcess(), owner=resources(t);
  let browser;
  owner.add('production shutdown',async()=>server.assertShutdown(await server.stop()),10,15000);
  owner.add('browser',()=>browser?.close());
  owner.add('workspace',()=>server.dispose(),30);
  await server.ready();
  browser=await launchBrowser();
  const page=await browser.newPage();
  page.setDefaultTimeout(10000);
  for(let i=0;i<3;i++) {
    const observed=waitForState(page,body=>body.workflow?.stage==='START',{timeout:10000});
    if(i===0)await page.goto(server.baseUrl);else await page.reload();
    const snapshot=await observed;
    assert.equal(snapshot.runtimeAvailability.ready,false);
    assert.equal(snapshot.dataKnowledge.runs.status,'UNAVAILABLE');
    await page.waitForFunction(()=>!document.getElementById('chooseFolder').disabled);
    assert.equal(await page.locator('#planRun').isDisabled(),true);
  }
});

test('real Chromium keeps HTTP responsive during controller initialization contention and renders recovery', {timeout:30000}, async t => {
  const server = await productionProcess({configured:true}), owner = resources(t);
  let browser, locker, locked = false;
  owner.add('external writer', () => { if (locked) locker.exec('ROLLBACK'); locker?.close(); }, 0);
  owner.add('production shutdown', async () => server.assertShutdown(await server.stop()), 10, 15000);
  owner.add('browser', () => browser?.close());
  owner.add('workspace', () => server.dispose(), 30);
  await server.ready();
  const filename = path.join(server.workspace, '.agent-controller', 'controller.sqlite');
  fs.mkdirSync(path.dirname(filename), {recursive:true});
  new SqliteStore(filename).close();
  new CodeChangeStore(filename).close();
  locker = new DatabaseSync(filename);
  locker.exec('BEGIN IMMEDIATE'); locked = true;
  browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const unavailable = waitForState(page, body => body.runtimeAvailability?.code === 'LIVE_RUNTIME_READ_TIMEOUT', {timeout:10000});
  await page.goto(server.baseUrl);
  assert.equal((await unavailable).dataKnowledge.runs.status, 'UNAVAILABLE');
  await page.waitForFunction(() => document.getElementById('dashboardRuntimeDetail').textContent.includes('LIVE_RUNTIME_READ_TIMEOUT'));
  const statuses = await page.evaluate(async () => Promise.all(['/api/health', '/api/preflight'].map(async route => {
    const response = await fetch(route, {signal:AbortSignal.timeout(1000)});
    await response.arrayBuffer();
    return response.status;
  })));
  assert.deepEqual(statuses, [200, 200]);
  const recovered = waitForState(page, body => body.runtimeAvailability?.ready === true, {timeout:10000});
  locker.exec('COMMIT'); locked = false;
  assert.equal((await recovered).runtimeAvailability.ready, true);
  await page.waitForFunction(() => document.getElementById('dashboardRuntimeDetail').textContent === '준비됨');
  assert.equal(await page.locator('#dashboardPageError').isVisible(), false);
});

test('real Chromium renews the dashboard session after the production server restarts', {timeout:45000}, async t => {
  const server = await productionProcess({configured:true}), owner = resources(t);
  let browser;
  owner.add('production shutdown', async () => server.assertShutdown(await server.stop()), 10, 15000);
  owner.add('browser', () => browser?.close());
  owner.add('workspace', () => server.dispose(), 30);
  await server.ready();
  browser = await launchBrowser();
  const page = await browser.newPage();
  const ready = () => waitForState(page, body => body.runtimeAvailability?.ready === true, {timeout:12000});
  const initial = ready();
  await page.goto(server.baseUrl);
  await initial;

  const unauthorized = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state'
    && response.status() === 401, {timeout:12000});
  const recovered = ready();
  await server.restart();
  await Promise.all([unauthorized, recovered]);
  await page.waitForFunction(() => document.getElementById('dashboardRuntimeDetail').textContent === '준비됨');
  assert.equal(await page.locator('#dashboardPageError').isVisible(), false);
});

test('start, history and project share one preparation gate until cancellation is committed', {timeout:45000}, async t => {
  const server = await productionProcess({configured:true}), owner = resources(t);
  let browser;
  owner.add('production shutdown', async () => server.assertShutdown(await server.stop()), 10, 15000);
  owner.add('browser', () => browser?.close());
  owner.add('workspace', () => server.dispose(), 30);
  await server.ready();
  const directory = path.join(server.workspace, '.agent-controller');
  fs.mkdirSync(directory, {recursive:true});
  const store = new SqliteStore(path.join(directory, 'controller.sqlite'));
  const runService = new RunService({store});
  const run = runService.createRun({runId:'historical-run', objective:'Completed fixture', policy:createDiscussionRunPolicy()});
  const stopped = runService.stop({runId:run.runId, expectedVersion:run.version});
  store.close();

  const preparationId = 'prep-recovery-fixture';
  const prep = {preparationId, version:33, lifecycle:'ACTIVE', state:'RECOVERY_REQUIRED',
    objective:'Preparation fixture', targetRoot:server.workspace, discussion:[], deliveries:[],
    agreement:{status:'DISCUSSING'}, webSession:{sessionId:'fixture-session', activeDeliveryId:null}};
  const previous = {...prep, preparationId:'prep-history-fixture', version:17,
    lifecycle:'COMPLETED', state:'AGREEMENT_READY', resultingRunId:run.runId};
  const preparationDb = path.join(directory, 'preparations.sqlite');
  const db = new DatabaseSync(preparationDb);
  db.exec('CREATE TABLE preparation_state (id INTEGER PRIMARY KEY, json TEXT NOT NULL) STRICT');
  db.prepare('INSERT INTO preparation_state VALUES (1, ?)').run(JSON.stringify({
    currentId:preparationId, contexts:{[preparationId]:prep, [previous.preparationId]:previous}, receipts:{},
    projectConversations:{[server.workspace]:{
      conversationId:'fixture-project', conversationUrl:'https://chatgpt.com/c/fixture-project',
    }},
  }));
  db.close();
  const storedPreparation = () => {
    const reader = new DatabaseSync(preparationDb, {readOnly:true});
    try { return reader.prepare('SELECT json FROM preparation_state WHERE id = 1').get().json; }
    finally { reader.close(); }
  };

  browser = await launchBrowser();
  const page = await browser.newPage();
  const initial = waitForState(page, body => body.workflow?.preparationId === preparationId, {timeout:10000});
  await page.goto(server.baseUrl);
  assert.deepEqual((await initial).activePreparation, {preparationId, version:33});
  const beforeNavigation = storedPreparation();
  assert.equal(await page.locator('#newRun').isDisabled(), true);

  const history = waitForState(page, body => body.workflow?.runId === run.runId, {timeout:10000});
  await page.locator('#runList .run-item').getByText('Completed fixture').click();
  const historical = await history;
  assert.equal(historical.workflow.runVersion, stopped.version);
  assert.equal(historical.preparation.preparationId, previous.preparationId);
  assert.equal(historical.workflow.preparationVersion, 17);
  assert.deepEqual(historical.activePreparation, {preparationId, version:33});
  await page.locator('#runPanel').waitFor({state:'visible'});
  assert.equal(await page.locator('#newRun').isDisabled(), true);
  const recoveryRequests = [];
  page.on('request', request => {
    if (request.method() !== 'GET') recoveryRequests.push(new URL(request.url()).pathname);
  });
  const fromHistory = waitForState(page, body => body.workflow?.preparationId === preparationId, {timeout:10000});
  await page.getByRole('button', {name:'진행 중인 준비 복구'}).click({timeout:3000});
  assert.deepEqual((await fromHistory).activePreparation, {preparationId, version:33});
  await page.locator('#startRecovery .session-recovery').waitFor({state:'visible'});
  await page.locator('#runList .run-item').getByText('Completed fixture').click();
  await page.locator('#runPanel').waitFor({state:'visible'});

  await page.locator('#runList .project-open').click();
  await page.locator('#projectOverview').waitFor({state:'visible'});
  const projectState = waitForState(page, body => body.workflow?.runId === run.runId, {timeout:10000});
  await page.locator('#refreshDashboard').click();
  assert.deepEqual((await projectState).activePreparation, {preparationId, version:33});
  assert.equal(await page.locator('#newProjectTask').isDisabled(), true);
  assert.equal(await page.locator('#newRun').isDisabled(), true);
  assert.equal(await page.locator('#startRecovery').isVisible(), false);

  const reopened = waitForState(page, body => body.workflow?.preparationId === preparationId, {timeout:10000});
  await page.getByRole('button', {name:'진행 중인 준비 복구'}).click();
  assert.deepEqual((await reopened).activePreparation, {preparationId, version:33});
  await page.locator('#startRecovery .session-recovery').waitFor({state:'visible'});
  assert.equal(await page.locator('#startRecovery .session-recovery').getAttribute('data-preparation-id'), preparationId);
  assert.equal(await page.locator('#newRun').isDisabled(), true);
  assert.deepEqual(recoveryRequests, []);
  assert.equal(storedPreparation(), beforeNavigation);

  const updatedState = waitForState(page, body => body.activePreparation === null
    && body.workflow?.runId === run.runId, {timeout:10000});
  const cancellation = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/preparations/${preparationId}/cancel`, {timeout:10000});
  await page.locator('#cancelInitialPreparation').click();
  const response = await cancellation;
  assert.equal(response.status(), 200);
  const cancelled = await response.json();
  assert.equal(cancelled.preparationId, preparationId);
  assert.equal(cancelled.version, 34);
  assert.equal(cancelled.lifecycle, 'ABANDONED');
  assert.equal((await updatedState).workflow.runVersion, stopped.version);
  await page.waitForFunction(() => !document.getElementById('newRun').disabled);
});
