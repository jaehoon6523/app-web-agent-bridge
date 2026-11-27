import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionBrowser } from '../tests/helpers/extension-browser.mjs';
import { buildSendOnlyCommand } from './chatgpt-send-only.mjs';

test('send-only uses the provider and returns before the assistant reply', async t => {
  const reply = Promise.withResolvers();
  const fixture = await extensionBrowser(t, { autoConnect: false, reply: () => reply.promise });
  const { page } = fixture;
  const text = 'Send-only fixture\nSecond line';
  let state = { currentDeliveryId: 'active-delivery', tabId: 7 };
  const chrome = {
    tabs: { get: async () => ({ url: page.url() }) },
    storage: { local: { get: async () => state } },
    scripting: {
      executeScript: async ({ func, args }) => [{ result: await page.evaluate(
        ({ source, args }) => (0, eval)('(' + source + ')')(...args),
        { source: func.toString(), args },
      ) }],
    },
  };
  const execute = new Function('chrome', 'return ' + buildSendOnlyCommand(7, text));
  try {
    await assert.rejects(execute(chrome), /active delivery/);
    state = {};
    await page.locator('textarea').fill('Existing draft');
    await assert.rejects(execute(chrome), /empty, idle/);
    assert.equal(await page.locator('textarea').inputValue(), 'Existing draft');
    await page.locator('textarea').fill('');
    assert.deepEqual(await execute(chrome), { status: 'SEND_CLICK_RETURNED' });
    assert.deepEqual(await page.evaluate(() => [
      sessionStorage.getItem('clicks'), sessionStorage.getItem('submitted'),
    ]), ['1', text]);
    assert.equal(await page.locator('#a1').count(), 0);
    assert.deepEqual(fixture.frames, []);
    assert.equal(fixture.readStorage().completedDelivery, undefined);
    await assert.rejects(execute(chrome), /regular ChatGPT start tab/);
    reply.resolve('Delayed fixture reply');
    await page.locator('#a1').waitFor();
    assert.deepEqual(fixture.frames, []);
    assert.equal(fixture.readStorage().completedDelivery, undefined);
  } finally {
    reply.resolve('');
  }
});
