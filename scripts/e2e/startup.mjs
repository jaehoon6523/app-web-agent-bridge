import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/browser.mjs';
import { productionProcess } from './helpers/process.mjs';
import { bounded } from './helpers/deadline.mjs';
import { waitForPreflight } from './preflight-readiness.mjs';

// UF-01A: no server factory, injected runtime, API interception, or synthetic snapshot.
const repository = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(repository, '.agent-controller/ui-qa/e2e-startup');
fs.rmSync(output, { recursive:true, force:true });
fs.mkdirSync(output, { recursive:true });
const production = await productionProcess();
const { workspace, baseUrl, alive } = production;
const boundary = [], pageErrors = [], consoleErrors = [];
let browser, page, outcome = 'FAIL', shutdown, snapshot;
async function stop() { shutdown = await production.stop(); }
try {
  const { preflight } = await waitForPreflight(`${baseUrl}/api/preflight`, { checkAlive:alive });
  assert.equal(preflight.checks.extensionConfigured, false);
  fs.writeFileSync(path.join(output, 'preflight.json'), JSON.stringify(preflight, null, 2));
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport:{ width:1280, height:960 } });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('requestfailed', request => boundary.push({ method:request.method(), route:new URL(request.url()).pathname, failed:true }));
  page.on('response', response => boundary.push({ method:response.request().method(), route:new URL(response.url()).pathname, status:response.status() }));
  // Waiting for the entire body, not just a listen log or response headers.
  const sessionPromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/dashboard/session');
  const statePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
  const started = performance.now();
  const navigation = await page.goto(baseUrl);
  assert.equal(navigation.status(), 200);
  const [session, state, sessionBody, stateBody] = await bounded((async () => {
    const [session, state] = await Promise.all([sessionPromise, statePromise]);
    const [sessionBody, stateBody] = await Promise.all([session.json(), state.json()]);
    return [session, state, sessionBody, stateBody];
  })(), Math.max(1, 5000 - (performance.now() - started)));
  assert.equal(session.request().method(), 'POST');
  assert.equal(session.status(), 200);
  assert.equal(typeof sessionBody.token, 'string');
  assert.ok(sessionBody.token.length > 0); // Never write the token to artifacts.
  assert.equal(state.status(), 200);
  snapshot = stateBody;
  assert.ok(performance.now() - started < 5000, 'first session/state body exceeded external five-second budget');
  assert.equal(snapshot.runtimeAvailability.ready, false);
  assert.equal(snapshot.preflight.checks.extensionAuthenticated, false);
  assert.equal(snapshot.workflow.stage, 'START');
  assert.equal(snapshot.dataKnowledge.runs.status, 'UNAVAILABLE');
  assert.deepEqual(snapshot.commandCapabilities, []);
  await page.waitForFunction(() => document.getElementById('apiHealth').classList.contains('ok')
    && document.getElementById('sessionHealth').classList.contains('ok')
    && !document.getElementById('chooseFolder').disabled);
  await page.locator('#startPanel').waitFor({ state:'visible' });
  assert.match(await page.locator('#apiHealth').getAttribute('aria-label'), /서버 응답 확인됨/u);
  await page.locator('#apiHealth').click();
  await page.locator('#apiHealthDetail').waitFor({ state:'visible' });
  assert.match(await page.locator('#apiHealthDetail').textContent(), /서버 응답 확인됨/u);
  await page.keyboard.press('Escape');
  assert.match(await page.locator('#sessionHealth').getAttribute('aria-label'), /인증됨/u);
  assert.match(await page.locator('#engineHealth').getAttribute('aria-label'), /런타임 준비 필요/u);
  assert.match(await page.locator('#channelHealth').getAttribute('aria-label'), /연결 대기/u);
  assert.doesNotMatch(await page.locator('#connectionNotice').textContent(), /서버 응답 없음|서버 연결 끊김|npm start/u);
  assert.equal(await page.locator('#planRun').isDisabled(), true);
  assert.equal(await page.locator('#chooseFolder').isDisabled(), false);
  assert.equal(await page.locator('#newRun').isDisabled(), true, 'unknown runs must not enable a new run');
  assert.equal(await page.locator('#applyCode').isVisible(), false);
  assert.equal(await page.locator('#applyCode').isDisabled(), true);
  assert.equal(await page.locator('#startRun').isVisible(), false);
  assert.equal(await page.locator('#saveProject').isVisible(), false);
  assert.equal(await page.locator('#saveProject').isDisabled(), true);
  // A real first interaction, without invoking an OS-specific folder picker.
  await page.locator('#objective').fill('E2E first request');
  await page.locator('#startRoot').fill(workspace);
  assert.equal(await page.locator('#planRun').isDisabled(), true, 'typing must not bypass extension prerequisites');
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  await page.screenshot({ path:path.join(output, 'first-screen.png'), fullPage:true });
  await alive();
  await browser.close(); browser = null;
  await stop();
  if (process.platform === 'win32') {
    // Node kill(SIGTERM) terminates the child on Windows; it does not deliver a POSIX signal.
    assert.equal(shutdown.signal, 'SIGTERM', 'Windows child termination failed');
  } else {
    assert.equal(shutdown.code, 0, 'production graceful shutdown failed');
  }
  outcome = 'PASS';
} catch (error) {
  fs.writeFileSync(path.join(output, 'failure.txt'), error.stack || String(error));
  if (error.lastObservation) fs.writeFileSync(path.join(output, 'preflight-failure.json'), JSON.stringify(error.lastObservation, null, 2));
  if (page && !page.isClosed()) {
    await page.screenshot({ path:path.join(output, 'failure.png'), fullPage:true }).catch(() => {});
    // Preserve UI structure/text, excluding form values and hidden auth data.
    const dom = await page.locator('body').evaluate(body => {
      const copy = body.cloneNode(true);
      copy.querySelectorAll('script,input,textarea').forEach(element => element.remove());
      return copy.outerHTML;
    }).catch(() => 'DOM unavailable');
    fs.writeFileSync(path.join(output, 'dom.html'), dom);
  }
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  await stop();
  const { stdout, stderr } = production.logs();
  fs.writeFileSync(path.join(output, 'server.stdout.log'), stdout);
  fs.writeFileSync(path.join(output, 'server.stderr.log'), stderr);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ testId:'E2E-UF01A-FRESH-STARTUP', specWave:'W1-4 COMPLETE', execution:'RUNNABLE', outcome,
    fixture:'fresh LIVE installation; no extension/provider configuration; no mocked boundary',
    boundary, pageErrors, consoleErrors, shutdown,
    state:snapshot ? { runtimeAvailability:snapshot.runtimeAvailability, workflow:snapshot.workflow,
      dataKnowledge:snapshot.dataKnowledge, commandCapabilities:snapshot.commandCapabilities } : null }, null, 2));
  await production.dispose();
}
console.log('E2E-UF01A-FRESH-STARTUP PASS: process → session → state → render → first interaction → shutdown');
