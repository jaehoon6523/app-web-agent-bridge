import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { extensionBrowser } from '../tests/helpers/extension-browser.mjs';

async function reinject(page) {
  const manifest = JSON.parse(await fs.readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  for (const file of manifest.content_scripts[0].js) await page.addScriptTag({ content: await fs.readFile(new URL('../extension/' + file, import.meta.url), 'utf8') });
}

test('real DOM fixture: full manifest reinjection keeps one listener and the original document token', { timeout: 20_000 }, async t => {
  const f = await extensionBrowser(t, { initialUrl: 'https://chatgpt.com/c/lifecycle' });
  const before = await f.sendContent({ type: 'agent.ping' });
  await reinject(f.page); await reinject(f.page);
  assert.equal((await f.sendContent({ type: 'agent.ping' })).documentId, before.documentId);
  assert.equal(await f.page.evaluate(() => globalThis.fixtureContentRegistrations), 1);
  assert.equal(await f.page.evaluate(() => sessionStorage.getItem('clicks')), null);
  await f.page.reload();
  assert.notEqual((await f.sendContent({ type: 'agent.ping' })).documentId, before.documentId);
  assert.deepEqual(f.errors, []);
});

test('real DOM fixture: reinjection and background reconstruction preserve a pending job without resending', { timeout: 25_000 }, async t => {
  let resolveReply;
  const reply = new Promise(resolve => { resolveReply = resolve; });
  const f = await extensionBrowser(t, { reply: () => reply });
  await f.prepare();
  const completion = f.submit('lifecycle-active').then(() => 'completed', error => error.code);
  await f.page.waitForFunction(() => sessionStorage.getItem('clicks') === '1');
  const before = await f.sendContent({ type: 'agent.ping' }); assert.equal(before.busy, true);
  await reinject(f.page);
  assert.equal((await f.sendContent({ type: 'agent.ping' })).activeRequestId, 'lifecycle-active');
  await f.connect();
  const after = await f.sendContent({ type: 'agent.ping' });
  assert.equal(after.documentId, before.documentId); assert.equal(after.activeRequestId, 'lifecycle-active');
  assert.equal(f.readStorage().currentDeliveryId, 'lifecycle-active');
  assert.equal(await f.page.evaluate(() => sessionStorage.getItem('clicks')), '1');
  await f.sendContent({ type: 'agent.cancel', requestId: 'lifecycle-active' }); resolveReply('Controlled fixture reply');
  await completion;
  assert.equal(f.readStorage().currentDeliveryId, 'lifecycle-active'); assert.deepEqual(f.errors, []);
});

test('real DOM fixture: controller exposes only owner-matched ACK and explicit discard actions', { timeout: 20_000 }, async t => {
  const f = await extensionBrowser(t);
  const owner = { currentDeliveryId: 'd', sessionId: 's', runId: 'r', conversationUrl: 'https://chatgpt.com/c/test' };
  let observation = { server: { status: 'MATCHED', records: [{ kind: 'REVIEW', active: true }] },
    extension: { exact: true, phase: 'ACK_PENDING', extensionBusy: false, pageReachable: true, pageBusy: false, generating: false } };
  const actions = [];
  await f.page.context().route('**/api/delivery-review**', async route => {
    if (route.request().method() === 'POST') { actions.push(route.request().postDataJSON()); return route.fulfill({ json: { discarded: true } }); }
    return route.fulfill({ json: observation });
  });
  const dashboard = await f.page.context().newPage();
  await dashboard.goto('https://dashboard.fixture/delivery-recovery.html?' + new URLSearchParams(owner));
  await dashboard.locator('#ack').waitFor({ state: 'visible' });
  assert.equal(await dashboard.locator('#discard').isDisabled(), true);
  await dashboard.locator('#reason').fill('Reviewed the conversation');
  await dashboard.locator('#unresolved').check(); await dashboard.locator('#noResend').check();
  assert.equal(await dashboard.locator('#discard').isDisabled(), false);
  await dashboard.locator('#discard').click();
  await dashboard.waitForFunction(() => document.querySelector('#status').textContent.includes('대상 전송을 폐기했습니다'));
  assert.equal(actions.length, 1); assert.equal(actions[0].currentDeliveryId, 'd');
  assert.equal(actions[0].unresolvedResultConfirmed, true); assert.equal(actions[0].noAutomaticResendConfirmed, true);
  observation = { ...observation, server: { status: 'MISMATCH', records: [] }, extension: { ...observation.extension, exact: false } };
  await dashboard.locator('#inspect').click();
  await dashboard.waitForFunction(() => document.querySelector('#status').textContent.includes('서버 기록 불일치'));
  assert.equal(await dashboard.locator('#discardPanel').isHidden(), true); assert.equal(await dashboard.locator('#ack').isHidden(), true);
  assert.deepEqual(f.errors, []);
});
