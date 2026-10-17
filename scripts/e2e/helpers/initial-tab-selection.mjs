import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connectedExtension } from './extension.mjs';
import { waitForState } from './observations.mjs';
import { preparationPackets } from './preparation.mjs';
import { resources } from './resources.mjs';
import { saveEvidence } from './lifecycle.mjs';

const objective = 'Choose a tab for the first clock requirements request';
const packet = preparationPackets[0];
const responseText = `<controller_packet>\n${JSON.stringify(packet)}\n</controller_packet>`;
const observe = (f, predicate) => waitForState(f.page, predicate, { timeout:20000 });
function readStore(f) {
  const db = new DatabaseSync(path.join(f.server.workspace, '.agent-controller/preparations.sqlite'), { readOnly:true });
  try { return JSON.parse(db.prepare('SELECT json FROM preparation_state WHERE id=1').get().json); }
  finally { db.close(); }
}
function identity(context) {
  return { preparationId:context.preparationId, sessionId:context.webSession.sessionId,
    deliveryId:context.deliveries[0].deliveryId, commandRequestId:context.deliveries[0].commandRequestId };
}
function sameRequest(context, expected) {
  assert.equal(context.deliveries.length, 1, 'tab selection must resume the original delivery');
  assert.deepEqual(identity(context), expected);
}
async function clickCounts(extension) {
  return Object.fromEntries(await Promise.all(extension.providerPages().map(async ([id, page]) =>
    [id, await page.evaluate(() => Number(sessionStorage.getItem('clicks') || 0))])));
}
async function assertNoSend(extension) {
  assert.equal(extension.commands.filter(c => c.type === 'agent.prompt').length, 0);
  assert.ok(Object.values(await clickCounts(extension)).every(count => count === 0));
}
async function visibleChoice(f, count) {
  // Real browser visibility includes hidden ancestors and production CSS.
  // This is the mutation oracle: the unfixed START page fails here.
  await f.page.locator('.preparation-tab-choice').waitFor({ state:'visible', timeout:5000 });
  const choice = f.page.locator('#startRecovery .preparation-tab-choice');
  await choice.locator('input[type=radio]:enabled').first().waitFor({ state:'visible', timeout:5000 });
  assert.equal(await f.page.locator('.preparation-tab-choice').count(), 1);
  assert.equal(await f.page.locator('#startPanel').isVisible(), true);
  assert.equal(await f.page.locator('#projectPanel').isVisible(), false);
  assert.equal(await f.page.locator('.session-recovery').count(), 1);
  assert.equal(await f.page.locator('#discardPanel').isVisible(), false, 'an unsent request must not offer uncertain-delivery discard');
  assert.equal(await f.page.locator('#planRun').isDisabled(), true);
  assert.match(await f.page.locator('#startProgressTitle').innerText(), /탭.*선택/u);
  assert.equal(await choice.locator('input[type=radio]').count(), count);
  for (const radio of await choice.locator('input[type=radio]').all()) {
    assert.equal(await radio.isVisible(), true);
    assert.equal(await radio.isEnabled(), true);
  }
  assert.equal(await choice.locator('.tab-choice-send').isVisible(), true);
  assert.equal(await choice.locator('.tab-choice-send').isDisabled(), true);
  return choice;
}

// Actual Dashboard HTML/CSS/modules, HTTP projection, preparation service,
// SQLite, WebSocket and extension code. Chrome APIs and provider DOM are controlled.
export async function initialTabSelection(t, f, { stale = false, recovery = false } = {}) {
  const prompts = [], mutations = [], ackReadbacks = [], acknowledgements = [];
  let releaseReply;
  const replyGate = new Promise(resolve => { releaseReply = resolve; });
  resources(t).add('initial tab provider gate', () => releaseReply(), 5);
  f.page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/preparations/web') {
      mutations.push(request.postDataJSON());
    }
  });
  const extension = await connectedExtension(t, f, {
    objective, probeReload:false,
    async reply(text, peer) {
      prompts.push({ tabId:peer.tabId, text });
      await replyGate;
      return responseText;
    },
    observeFrame(frame) {
      if (frame.type === 'web.delivery.ack' && frame.direction === 'framereceived') {
        const data = readStore(f), context = data.contexts[data.currentId];
        const delivery = context.deliveries.find(d => d.deliveryId === frame.requestId);
        ackReadbacks.push({ ...identity(context), delivery, activeDeliveryId:context.webSession.activeDeliveryId });
      }
      if (frame.type === 'web.delivery.acknowledged') acknowledgements.push({ requestId:frame.requestId, ...frame.payload });
    },
  });
  const second = await extension.createProviderTab('https://chatgpt.com/');
  const chosen = await extension.createProviderTab('https://chatgpt.com/');
  await f.page.locator('#conversationUrl').fill('');
  await f.page.locator('#autoApprovePreparation').uncheck();
  assert.equal(await f.page.locator('#conversationUrl').inputValue(), '');
  await assertNoSend(extension);
  const blocked = observe(f, body => body.preparation?.error?.code === 'WEB_TAB_SELECTION_REQUIRED'
    && body.commandCapabilities.includes('web.rebind'));
  const startResponse = f.page.waitForResponse(r => r.request().method() === 'POST'
    && new URL(r.url()).pathname === '/api/preparations');
  await f.page.locator('#planRun').click();
  assert.equal((await startResponse).status(), 202);
  const body = await blocked, initial = body.preparation, ids = identity(initial);
  assert.equal(body.workflow.stage, 'START');
  assert.equal(initial.deliveries[0].unsent, true);
  assert.equal(initial.error.details.browserDispatchStarted, false);
  assert.equal(initial.webSession.activeDeliveryId, ids.deliveryId);
  assert.deepEqual(initial.error.details.candidates.map(c => c.tabId).sort((a,b) => a-b),
    extension.providerPages().map(([id]) => id).sort((a,b) => a-b));
  saveEvidence(f, 'initial-tab-blocked', { workflow:body.workflow, preparation:initial, clicks:await clickCounts(extension) });
  await visibleChoice(f, 3);
  await assertNoSend(extension);

  const reloaded = observe(f, value => value.preparation?.preparationId === ids.preparationId);
  await f.page.reload();
  sameRequest((await reloaded).preparation, ids);
  let choice = await visibleChoice(f, 3);
  const refreshed = observe(f, value => value.preparation?.preparationId === ids.preparationId);
  await choice.getByRole('button', { name:'최신 상태 조회', exact:true }).click();
  sameRequest((await refreshed).preparation, ids);
  choice = await visibleChoice(f, 3);
  await assertNoSend(extension);

  const rejected = [];
  if (stale) {
    for (const candidate of [second, chosen]) {
      await choice.locator(`input[value="${candidate.id}"]`).check();
      const target = extension.providerPages().find(([id]) => id === candidate.id)[1];
      if (candidate === second) await target.close();
      else await target.goto('https://chatgpt.com/c/different-conversation');
      const result = f.page.waitForResponse(r => r.request().method() === 'POST'
        && new URL(r.url()).pathname === '/api/preparations/web');
      await choice.locator('.tab-choice-send').click();
      const response = await result;
      assert.ok(response.status() >= 400);
      const error = await response.json();
      await choice.locator('.tab-choice-note.rejected').waitFor({ state:'visible' });
      assert.ok((await choice.locator('.tab-choice-note.rejected').innerText()).trim());
      assert.equal(await choice.locator('.tab-choice-send').isVisible(), false);
      await assertNoSend(extension);
      sameRequest(readStore(f).contexts[ids.preparationId], ids);
      rejected.push({ tabId:candidate.id, cause:candidate === second ? 'CLOSED' : 'URL_CHANGED', status:response.status(), error });
      await choice.getByRole('button', { name:'후보 다시 보기', exact:true }).click();
      choice = await visibleChoice(f, 3);
    }
    // Cancellation is tested only on this isolated test request.
    const cancelled = observe(f, value => value.preparation?.lifecycle === 'ABANDONED');
    await f.page.locator('#cancelInitialPreparation').click();
    sameRequest((await cancelled).preparation, ids);
    await f.page.locator('#startRecovery').waitFor({ state:'hidden' });
    assert.equal(await f.page.locator('#startRecovery .preparation-tab-choice').count(), 0);
    await assertNoSend(extension);
    saveEvidence(f, 'initial-tab-stale', { ids, rejected, mutations, prompts, clicks:await clickCounts(extension), cancelled:true });
    assert.deepEqual(extension.errors, []);
    return;
  }

  await choice.locator(`input[value="${chosen.id}"]`).check();
  sameRequest((await observe(f, value => value.preparation?.preparationId === ids.preparationId)).preparation, ids);
  await assertNoSend(extension);
  assert.equal(mutations.length, 0, 'candidate selection alone must not submit a command');
  assert.equal(await choice.locator('.tab-choice-send').isEnabled(), true);
  const pending = observe(f, value => value.preparation?.state === 'WAITING_WEB_RESPONSE');
  const continued = f.page.waitForResponse(r => r.request().method() === 'POST'
    && new URL(r.url()).pathname === '/api/preparations/web');
  await choice.locator('.tab-choice-send').click();
  assert.equal((await continued).status(), 200);
  sameRequest((await pending).preparation, ids);
  const selectedPage = extension.providerPages().find(([id]) => id === chosen.id)[1];
  await selectedPage.waitForFunction(() => Number(sessionStorage.getItem('clicks')) === 1);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].tabId, chosen.id);
  assert.ok(prompts[0].text.includes(objective));
  assert.equal(await f.page.locator('#startRecovery .tab-choice-send').isVisible(), false);
  if (recovery) {
    await f.server.restart();
    const recovered = observe(f, value => value.preparation?.state === 'RECOVERY_REQUIRED');
    await f.page.reload();
    const unresolved = (await recovered).preparation;
    sameRequest(unresolved, ids);
    assert.equal(unresolved.webSession.activeDeliveryId, ids.deliveryId);
    await f.page.locator('#discardPanel').waitFor({ state:'visible' });
    assert.equal(await f.page.locator('#startRecovery .tab-choice-send').count(), 0);
    assert.equal(await f.page.locator('.session-recovery').count(), 1);
    assert.equal(await f.page.locator('#planRun').isDisabled(), true);
    assert.deepEqual(await clickCounts(extension), { 7:0, [second.id]:0, [chosen.id]:1 });
    assert.equal(mutations.length, 1);
    assert.equal(prompts.length, 1);
    saveEvidence(f, 'initial-tab-interrupted', { ids, unresolved, clicks:await clickCounts(extension),
      recoveryVisible:true, noAutomaticResend:true });
    return;
  }
  const complete = observe(f, value => value.preparation?.deliveries[0]?.state === 'ACKNOWLEDGED');
  releaseReply();
  const completed = await complete, context = completed.preparation, delivery = context.deliveries[0];
  sameRequest(context, ids);
  assert.equal(completed.workflow.stage, 'PREPARE');
  assert.equal(context.webSession.tabId, chosen.id);
  assert.equal(context.webSession.activeDeliveryId, null);
  assert.equal(delivery.validation.status, 'CONFIRMED');
  assert.equal(delivery.validation.format, 'CONFIRMED');
  assert.equal(delivery.processingState, 'COMPLETE');
  assert.equal(delivery.response.rawText, responseText);
  assert.equal(delivery.response.binding.sessionId, ids.sessionId);
  assert.equal(delivery.response.binding.runId, ids.preparationId);
  assert.equal(delivery.trace.tabId, chosen.id);
  assert.equal(delivery.trace.requestId, ids.deliveryId);
  assert.deepEqual(context.agreement.requirements, packet.items);
  const saved = readStore(f), durable = saved.contexts[ids.preparationId];
  sameRequest(durable, ids);
  assert.deepEqual(durable.deliveries[0], delivery);
  assert.equal(saved.receipts[ids.commandRequestId].status, 'COMPLETED');
  assert.equal(ackReadbacks.length, 1);
  assert.equal(ackReadbacks[0].delivery.response.rawText, responseText);
  assert.equal(ackReadbacks[0].delivery.validation.status, 'CONFIRMED');
  assert.equal(ackReadbacks[0].delivery.validation.format, 'CONFIRMED');
  assert.ok(['ACK_PENDING', 'COMPLETE'].includes(ackReadbacks[0].delivery.processingState));
  assert.equal(acknowledgements.length, 1);
  assert.equal(acknowledgements[0].requestId, ids.deliveryId);
  assert.equal(acknowledgements[0].sessionId, ids.sessionId);
  assert.equal(acknowledgements[0].runId, ids.preparationId);
  assert.equal(acknowledgements[0].currentDeliveryId, null);
  assert.equal(extension.readStorage().currentDeliveryId, null);
  await f.page.locator('#projectPanel').waitFor({ state:'visible' });
  assert.equal(await f.page.locator('#startRecovery').isVisible(), false);
  assert.equal(await f.page.locator('#startRecovery .preparation-tab-choice').count(), 0);
  assert.equal(await f.page.locator('#projectPanel .tab-choice-send').count(), 0);
  assert.equal(await f.page.locator('.session-recovery').count(), 1);
  const afterReload = observe(f, value => value.preparation?.preparationId === ids.preparationId);
  await f.page.reload();
  sameRequest((await afterReload).preparation, ids);
  await f.page.locator('#projectPanel').waitFor({ state:'visible' });
  await observe(f, value => value.preparation?.deliveries[0]?.state === 'ACKNOWLEDGED');
  assert.equal(prompts.length, 1);
  assert.equal(extension.commands.filter(c => c.type === 'agent.prompt').length, 1);
  assert.equal(extension.frames.filter(frame => frame.type === 'web.prompt.result' && frame.requestId === ids.deliveryId).length, 1);
  assert.equal(acknowledgements.length, 1);
  assert.deepEqual(await clickCounts(extension), { 7:0, [second.id]:0, [chosen.id]:1 });
  assert.equal(mutations.length, 1);
  for (const key of ['preparationId', 'sessionId', 'deliveryId']) assert.equal(mutations[0][key], ids[key]);
  assert.equal(mutations[0].command, 'web.rebind');
  assert.equal(mutations[0].selectedTabId, chosen.id);
  assert.equal(f.boundary.filter(r => r.method === 'POST' && r.route === '/api/preparations').length, 1);
  assert.deepEqual(extension.errors, []);
  saveEvidence(f, 'initial-tab-complete', { ids, selectedTabId:chosen.id, clicks:await clickCounts(extension),
    mutation:mutations[0], frames:extension.frames, ackReadbacks, acknowledgements, persisted:durable,
    reloadNoResend:true, controlled:['Chrome API shim', 'provider DOM and response'] });
}
