import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { launchBrowser } from '../../scripts/e2e/helpers/browser.mjs';
import { productionProcess } from '../../scripts/e2e/helpers/process.mjs';
import { resources } from '../../scripts/e2e/helpers/resources.mjs';

export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const digest = value => createHash('sha256').update(value).digest('hex');
export const credentialDigest = token => digest(`Bearer ${token}`);

// A new production process, browser context and workspace belong to each case.
// Only selected HTTP boundaries are controlled; app.js and its timers are intact.
export async function firstLoadBrowser(t, { intercept, init, expectedCommands = [] } = {}) {
  const owner = resources(t);
  const server = await productionProcess();
  owner.add('first-load production shutdown', async () => server.assertShutdown(await server.stop()), 30, 15000);
  owner.add('first-load workspace', () => server.dispose(), 40);
  await server.ready();
  const browser = await launchBrowser();
  owner.add('first-load browser', () => browser.close(), 20);
  const context = await browser.newContext();
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const requests = [], pageErrors = [], routeErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) return;
    const authorization = request.headers().authorization;
    requests.push({ pathname, method:request.method(), at:performance.now(),
      ...(pathname === '/api/commands' ? {command:request.postDataJSON()?.type} : {}),
      credential:authorization ? digest(authorization) : null });
  });
  if (intercept) await context.route('**/api/**', async route => {
    try {
      const pathname = new URL(route.request().url()).pathname;
      if (!await intercept({ route, pathname, requests, page })) await route.continue();
    } catch (error) {
      if (page.isClosed()) return;
      routeErrors.push(error.message);
      await route.abort().catch(() => {});
    }
  });
  owner.add('first-load negative assertions', async () => {
    if (!page.isClosed()) t.diagnostic(JSON.stringify({
      phase:await page.locator('#dashboardPhase').textContent().catch(() => null),
      code:await page.locator('#dashboardErrorCode').textContent().catch(() => null),
      requests:requests.map(({pathname,method}) => ({pathname,method})), routeErrors,
    }));
    assert.deepEqual(pageErrors, [], 'the production page must not raise an uncaught error');
    assert.deepEqual(routeErrors, [], 'an interception failure must not masquerade as a product failure');
    assert.deepEqual(requests.filter(r => !['GET', 'HEAD'].includes(r.method)
      && r.pathname !== '/api/dashboard/session' && !(r.pathname === '/api/commands' && expectedCommands.includes(r.command))), [], 'startup/recovery must not send an unexpected product mutation');
    assert.deepEqual(requests.filter(r => r.pathname === '/api/commands').map(r => r.command), expectedCommands);
  }, 10);
  t.diagnostic(JSON.stringify({ node:process.version, platform:process.platform, browser:browser.version(),
    boundary:'production process + unmodified page; selected HTTP faults', timeoutAcceleration:false }));
  return { server, browser, context, page, requests, owner,
    count:pathname => requests.filter(r => r.pathname === pathname).length,
    async open() { assert.equal((await page.goto(server.baseUrl)).status(), 200); },
    async ready() {
      await page.waitForFunction(() => document.getElementById('dashboardPhase').textContent === '최신 상태 확인 완료');
      assert.equal(await page.locator('#apiHealth').evaluate(el => el.classList.contains('ok')), true);
      assert.equal(await page.locator('#sessionHealth').evaluate(el => el.classList.contains('ok')), true);
      assert.equal(await page.locator('#dashboardErrorCode').textContent(), '없음');
    },
  };
}

export async function expectBlocked(page, { folder = true } = {}) {
  for (const id of ['planRun', 'newRun', 'applyCode', ...(folder ? ['chooseFolder'] : [])])
    assert.equal(await page.locator('#'+id).isDisabled(), true, `${id} must remain disabled`);
}

export async function expectCode(page, code) {
  await page.waitForFunction(expected => document.getElementById('dashboardErrorCode').textContent.includes(expected), code);
}

export async function expectReachable(page) {
  assert.equal(await page.locator('#apiHealth').evaluate(el => el.classList.contains('ok')), true);
  assert.doesNotMatch(await page.locator('#connectionNotice').textContent(), /서버 응답 없음|UNKNOWN_RESULT/u);
}

// A genuine HTTP peer can send headers and an incomplete body, or withhold all
// headers. Playwright fulfill() alone cannot reproduce these transport phases.
export async function faultPeer(f, handle) {
  const sockets = new Set(), errors = [];
  const server = http.createServer((request, response) => {
    Promise.resolve().then(() => handle(request, response)).catch(error => {
      errors.push(error.message); response.destroy();
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  f.owner.add('first-load fault peer', async () => {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      for (const socket of sockets) socket.destroy();
    });
    assert.deepEqual(errors, []);
  }, 5);
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
