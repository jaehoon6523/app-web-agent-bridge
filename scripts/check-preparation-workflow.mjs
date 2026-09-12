import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const output = path.resolve('.agent-controller/ui-qa/preparation-workflow');
await fs.mkdir(output, { recursive: true });
const assets = new Map(await Promise.all(['index.html', 'app.js', 'dashboard-model.js', 'styles.css'].map(async name => [name, await fs.readFile(path.join('public', name))])));
const server = http.createServer((req, res) => {
  const name = req.url === '/' ? 'index.html' : req.url.slice(1);
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
  res.end(assets.get(name) ?? '');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = [], actions = [];
  page.on('pageerror', error => errors.push(error.message));
  let connected = false, phase = 'START_IDLE';
  const prep = { preparationId: 'p1', version: 4, lifecycle: 'ACTIVE', objective: '화면 검증', targetRoot: 'C:/test',
    state: 'WAITING_WEB_RESPONSE',
    discussion: [{ preparationId: 'p1', turnId: 't1', sequence: 1, actor: 'USER', content: '화면 검증' }],
    agreement: { status: 'DISCUSSING', summary: '', unresolvedQuestions: [], requirements: [] },
    webSession: { sessionId: 's1', conversationId: 'c1', conversationUrl: 'https://chatgpt.com/c/c1', activeDeliveryId: 'd1' },
    deliveries: [{ deliveryId: 'd1', state: 'SUBMITTED' }] };
  function snapshot() {
    const preparing = ['DISCUSSING', 'APPROVING'].includes(phase);
    return { runs: [], run: null, preflight: { checks: { extensionAuthenticated: connected } },
      workflow: { stage: preparing ? 'PREPARE' : 'START', state: phase, preparationId: phase === 'START_IDLE' ? null : 'p1', preparationVersion: 4 },
      preparation: phase === 'START_IDLE' ? null : { ...prep, state: phase },
      commandCapabilities: phase === 'START_IDLE' ? connected ? ['preparation.start'] : []
        : phase === 'RECOVERY_REQUIRED' ? ['web.inspect', 'web.reconcile', 'preparation.cancel'] : preparing ? ['preparation.reply'] : [] };
  }
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === '/api/dashboard/session') body = { token: 'test-only' };
    else if (url.pathname === '/api/state') body = snapshot();
    else {
      const input = route.request().postDataJSON(); actions.push(input);
      if (url.pathname === '/api/preparations') phase = 'WAITING_WEB_RESPONSE';
      body = prep;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('#newRun').disabled === false);
  assert.equal(await page.locator('#planRun').isDisabled(), true);
  connected = true;
  await page.waitForFunction(() => document.querySelector('#planRun').disabled === false);
  await page.locator('#objective').fill('화면 검증');
  await page.locator('#startRoot').fill('C:/test');
  await page.locator('#conversationUrl').fill('https://chatgpt.com/c/c1');
  await page.locator('#planRun').click();
  await page.locator('#startProgressTitle').getByText('ChatGPT 응답을 기다리고 있습니다').waitFor();
  assert.equal(await page.locator('#projectPanel').isVisible(), false);
  assert.equal(await page.locator('#planRun').isDisabled(), true);
  await page.reload();
  await page.locator('#startProgress').waitFor();
  assert.equal(await page.locator('#projectPanel').isVisible(), false);
  await page.screenshot({ path: path.join(output, 'waiting-desktop.png'), fullPage: true });
  phase = 'RECOVERY_REQUIRED';
  prep.error = { code: 'COMPLETION_EVIDENCE_MISMATCH', message: '응답 확인 실패: 응답 신뢰도' };
  prep.deliveries[0] = { deliveryId: 'd1', state: 'RESPONSE_COMPLETED', validation: { checks: [{ name: '응답 신뢰도', expected: 'CONFIRMED_BY_UI_STATE', actual: 'HEURISTIC', passed: false }] } };
  await page.locator('#startProgressTitle').getByText('요청 상태 확인이 필요합니다').waitFor();
  assert.equal(await page.locator('.session-recovery').count(), 1);
  await page.locator('#startRecovery').getByRole('button', { name: '응답 다시 확인', exact: true }).click();
  assert.equal(actions.at(-1).expectedVersion, 4);
  assert.equal(actions.at(-1).command, 'web.reconcile');
  assert.equal(actions.filter(x => x.objective).length, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'recovery-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  phase = 'DISCUSSING'; prep.error = null;
  prep.discussion.push({ preparationId: 'p1', turnId: 't2', sequence: 2, actor: 'WEB_DESIGNER', deliveryId: 'd1', content: 'どの機能ですか？' });
  prep.agreement.summary = '어떤 기능을 원하시나요?';
  await page.locator('#projectPanel').waitFor();
  assert.equal(await page.locator('#startPanel').isVisible(), false);
  assert.equal(await page.locator('.session-recovery').count(), 1);
  await page.screenshot({ path: path.join(output, 'prepared-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: output, scenarios: ['disconnected', 'waiting', 'reload', 'recovery', 'no-duplicate-send', 'prepared', 'mobile'] }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
