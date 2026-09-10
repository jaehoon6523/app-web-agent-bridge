import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const output = path.resolve('.agent-controller/ui-qa/planning-recovery');
await fs.mkdir(output, { recursive: true });
const assets = new Map(await Promise.all(['index.html', 'app.js', 'dashboard-model.js', 'styles.css'].map(async name => [name, await fs.readFile(path.join('public', name))])));
const server = http.createServer((req, res) => {
  const name = req.url === '/' ? 'index.html' : req.url.slice(1);
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
  res.end(assets.get(name) || '');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [], actions = []; let prepared = false;
  page.on('pageerror', error => errors.push(error.message));
  let details = { currentDeliveryId: 'delivery-045cc91f-7060-42e2-a497-067b252a405c', runId: 'run-old', sessionId: 'session-old',
    runObjective: '\uCC44\uD305\uC2DC\uC2A4\uD15C', title: 'ChatGPT', conversationUrl: 'https://chatgpt.com/c/old', observedConversationUrl: 'https://chatgpt.com/c/old',
    pageReachable: true, pageBusy: true, generating: true, extensionBusy: true, activeRequestId: 'delivery-045cc91f-7060-42e2-a497-067b252a405c', pageStatus: 'READY', tabId: 7, bindingStatus: 'BOUND', runPhase: 'CANCELLED' };
  const input = { objective: '\uC544\uBB34\uAC70\uB098', conversationUrl: 'https://chatgpt.com/c/new' };
  const draft = () => ({ draftId: 'draft-test', ...input, status: prepared ? 'READY' : 'FAILED',
    error: 'Previous delivery requires inspection.', errorCode: 'REBIND_DURING_ACTIVE_DELIVERY', errorDetails: details,
    proposal: prepared ? { summary: 'Planning request received.', questions: [], items: [{ statement: 'Feature', acceptanceCriteria: 'Visible behavior' }] } : null });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()); let body;
    if (url.pathname === '/api/dashboard/session') body = { token: 'test-only' };
    else if (url.pathname === '/api/state') body = { runs: [], commandCapabilities: [], preflight: { checks: {}, missing: [], readyForProvisioning: false } };
    else if (url.pathname === '/api/project') body = { version: 'test', project: null, defaults: { targetRoot: 'C:/project', executable: 'node.exe' } };
    else if (url.pathname === '/api/project/proposal/session') {
      const action = route.request().postDataJSON().action; actions.push(action);
      if (action === 'stop') details = { ...details, generating: false, pageBusy: false, extensionBusy: false };
      if (action === 'recover') { details = { ...details, currentDeliveryId: null }; prepared = true; }
      body = draft();
    } else if (url.pathname === '/api/project/proposal') { actions.push('proposal'); body = draft(); }
    else throw new Error('Unexpected API: ' + url.pathname);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#objective').fill(input.objective);
  await page.locator('#startRoot').fill('C:/project');
  await page.locator('#conversationUrl').fill(input.conversationUrl);
  await page.locator('#planRun').click();
  const card = page.locator('.session-recovery'); await card.waitFor();
  assert.equal(await card.locator('a').getAttribute('href'), 'https://chatgpt.com/c/old');
  await card.locator('a').click();
  await page.waitForFunction(() => document.querySelector('.session-recovery .actions button')?.disabled === false);
  assert.equal(page.context().pages().length, 1);
  const buttons = card.locator('.actions button');
  assert.equal(await buttons.nth(1).isEnabled(), true);
  assert.equal(await buttons.nth(2).isEnabled(), false);
  await page.screenshot({ path: path.join(output, 'desktop-active.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await card.locator('summary').click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, 'mobile-active.png'), fullPage: true });
  await buttons.nth(1).click();
  await page.waitForFunction(() => document.querySelector('.session-recovery .actions button:last-child')?.disabled === false);
  assert.equal(await buttons.nth(1).isDisabled(), true);
  await page.screenshot({ path: path.join(output, 'mobile-stopped.png'), fullPage: true });
  await buttons.nth(2).click();
  await page.locator('#proposalSummary').getByText('Planning request received.').waitFor();
  assert.deepEqual(actions, ['proposal', 'focus', 'stop', 'recover', 'proposal']);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, viewportWidths: [1280, 390], actions, screenshots: output }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
