import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { productionProcess, repository } from './process.mjs';
import { launchBrowser } from './browser.mjs';
import { bounded } from './deadline.mjs';

export async function dashboardSpine(t, flow) {
  const output = path.join(repository, '.agent-controller/ui-qa/e2e-wave', flow.id);
  fs.rmSync(output, { recursive:true, force:true }); fs.mkdirSync(output, { recursive:true });
  const server = await productionProcess({ configured:flow.configured, fault:flow.fault, worker:flow.workerMode ?? flow.workerHarness });
  let browser, page;
  const boundary = [], errors = [];
  // Register cleanup before readiness/browser launch can fail.
  t.after(async () => {
    try {
      if (page && !page.isClosed()) {
        await page.screenshot({ path:path.join(output, 'screen.png'), fullPage:true }).catch(() => {});
        const dom = await page.locator('body').evaluate(body => {
          const copy = body.cloneNode(true);
          copy.querySelectorAll('script,input,textarea').forEach(el => el.remove());
          return copy.outerHTML;
        }).catch(() => 'DOM unavailable');
        fs.writeFileSync(path.join(output, 'dom.html'), dom);
      }
    } finally {
      try { await browser?.close(); } finally {
        try { await server.dispose(); } finally {
          const logs = server.logs();
          fs.writeFileSync(path.join(output, 'server.stdout.log'), logs.stdout);
          fs.writeFileSync(path.join(output, 'server.stderr.log'), logs.stderr);
          fs.writeFileSync(path.join(output, 'boundary.json'), JSON.stringify({ id:flow.id, execution:flow.execution, specWave:flow.specWave, boundary, errors, shutdown:logs.shutdown, shutdownSendError:logs.shutdownSendError }, null, 2));
        }
      }
    }
  });
  try {
    const { preflight } = await server.ready();
    assert.equal(preflight.checks.extensionConfigured, Boolean(flow.configured));
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport:{ width:1280,height:960 } });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    // Do not record token/header/body/query or arbitrary external URL.
    page.on('response', r => boundary.push({ route:new URL(r.url()).pathname, method:r.request().method(), status:r.status() }));
    page.on('requestfailed', r => boundary.push({ route:new URL(r.url()).pathname, failed:true }));
    const session = page.waitForResponse(r => new URL(r.url()).pathname === '/api/dashboard/session');
    const state = page.waitForResponse(r => new URL(r.url()).pathname === '/api/state');
    assert.equal((await page.goto(server.baseUrl)).status(), 200);
    const auth = await bounded(session);
    assert.equal(auth.status(), 200);
    // Full bodies are bounded by browser request timeout; token never leaves memory.
    assert.equal(typeof (await bounded(auth.json())).token, 'string');
    const response = await bounded(state);
    const body = await bounded(response.json());
    assert.equal(response.status(), flow.fault === 'state-database' ? 503 : 200);
    await page.waitForFunction(() => document.getElementById('apiHealth').classList.contains('ok')
      && document.getElementById('sessionHealth').classList.contains('ok'));
    assert.match(await page.locator('#apiHealth').getAttribute('aria-label'), /서버 응답 확인됨/u);
    assert.match(await page.locator('#sessionHealth').getAttribute('aria-label'), /인증됨/u);
    assert.deepEqual(errors, []);
    server.alive();
    return { server, page, body, boundary, errors, output };
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.txt'), error.stack || String(error));
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ id:flow.id, outcome:'SPINE_FAIL', execution:flow.execution, specWave:flow.specWave }, null, 2));
    throw error;
  }
}

export async function healthyLocalActions(page) {
  await page.waitForFunction(() => !document.getElementById('chooseFolder').disabled);
  assert.equal(await page.locator('#planRun').isDisabled(), true);
  assert.equal(await page.locator('#applyCode').isVisible(), false);
  assert.doesNotMatch(await page.locator('#connectionNotice').textContent(), /서버 응답 없음|서버 연결 끊김/u);
}
