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
