import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { extensionCredentials } from './process.mjs';
import { extensionBrowser } from '../../../tests/helpers/extension-browser.mjs';

// Server owns the production transport. Only Chrome APIs and provider DOM are controlled.
export async function connectedExtension(t, f, { reply, probeReload = true, objective = 'Production extension connection request' } = {}) {
  const extension = await extensionBrowser(t, {
    autoConnect:false,
    ...(reply ? { reply } : {}),
    production:{
      baseUrl:f.server.baseUrl,
      ...extensionCredentials,
      async waitAuthenticated() {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          f.server.alive();
          const response = await fetch(`${f.server.baseUrl}/api/preflight`, { signal:AbortSignal.timeout(2000) });
          const body = await response.json();
          if (body.checks.extensionAuthenticated) return;
          await delay(100);
        }
        throw new Error('Production preflight did not observe authenticated extension');
      },
    },
  });
  await extension.connect();
  if (path.basename(f.output) === 'UF-01C') await f.page.reload();
  await f.page.waitForFunction(() => document.getElementById('channelHealth').getAttribute('aria-label').includes('확장 인증됨'));
  assert.match(await f.page.locator('#apiHealth').getAttribute('aria-label'), /서버 응답 확인됨/u);
  assert.match(await f.page.locator('#sessionHealth').getAttribute('aria-label'), /인증됨/u);
  assert.equal(await f.page.locator('#chooseFolder').isDisabled(), false);
  assert.equal(await f.page.locator('#applyCode').isVisible(), false);
  // Required HTML fields prevent submission while the form is empty.
  assert.equal(await f.page.locator('#startForm').evaluate(form => form.checkValidity()), false);
  await f.page.locator('#objective').fill(objective);
  await f.page.locator('#startRoot').fill(f.server.workspace);
  await f.page.waitForFunction(() => !document.getElementById('planRun').disabled);
  assert.deepEqual(extension.errors, []);
  const types = extension.frames.map(frame => frame.type);
  assert.ok(types.includes('controller.auth.challenge'));
  assert.ok(types.includes('extension.auth.response'));
  assert.ok(types.includes('controller.auth.accepted'));
  assert.ok(types.includes('extension.hello'));
  assert.ok(extension.commands.some(command => command.type === 'agent.ping'));
  assert.ok(extension.contentResults.some(item => item.request.type === 'agent.ping' && item.result?.ok));
  let documentLifecycle = null;
  if (probeReload && path.basename(f.output) === 'UF-12') {
    const before = await extension.sendContent({ type:'agent.ping' });
    await extension.page.reload();
    const after = await extension.sendContent({ type:'agent.ping' });
    assert.equal(before.ready, true);
    assert.equal(after.ready, true);
    assert.notEqual(after.documentId, before.documentId);
    assert.equal(await extension.page.evaluate(() => Number(sessionStorage.getItem('clicks') || 0)), 0);
    documentLifecycle = { reloaded:true, documentChanged:true, sendClicks:0, scope:'unbound provider document; full stale binding/rebind NOT VERIFIED' };
  }
  fs.writeFileSync(path.join(f.output, 'extension-boundary.json'), JSON.stringify({
    transportOwner:'production src/server.js', dashboardApi:'production',
    controlled:['Chrome API shim','provider DOM'], frames:extension.frames,
    documentLifecycle,
    contentCommandTypes:extension.commands.map(command => command.type),
    errors:extension.errors, capabilityAfterValidForm:'ENABLED',
    fullContinuationVerified:['UF-01C','UF-04'].includes(path.basename(f.output)),
  }, null, 2));
  return extension;
}
