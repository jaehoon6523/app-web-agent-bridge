import test from 'node:test';
import assert from 'node:assert/strict';
import { productionProcess } from '../../scripts/e2e/helpers/process.mjs';
import { launchBrowser } from '../../scripts/e2e/helpers/browser.mjs';
import { waitForState } from '../../scripts/e2e/helpers/observations.mjs';
import { resources } from '../../scripts/e2e/helpers/resources.mjs';

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
