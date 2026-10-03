import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connectedExtension } from './extension.mjs';

const preparationObjective = 'Build a clock page; clarify seconds before approval';
export const preparationPackets = [
  { type:'REQUIREMENTS_PROPOSAL', summary:'H-PREP initial scope', questions:['Should the display include seconds?'], items:[{ statement:'Display a clock', acceptanceCriteria:'A clock is visible on the page' }] },
  { type:'REQUIREMENTS_PROPOSAL', summary:'H-PREP agreed scope with seconds', questions:[], items:[{ statement:'Display a clock including seconds', acceptanceCriteria:'Hours, minutes and seconds are visible' }] },
];
const raw = packet => `<controller_packet>\n${JSON.stringify(packet)}\n</controller_packet>`;

async function observedPreparation(f, predicate) {
  const response = await f.page.waitForResponse(async r => {
    if (new URL(r.url()).pathname !== '/api/state' || r.status() !== 200) return false;
    const body = await r.json();
    return body.preparation && predicate(body.preparation);
  }, { timeout:20000 });
  return (await response.json()).preparation;
}
function persisted(f, context) {
  const db = new DatabaseSync(path.join(f.server.workspace, '.agent-controller/preparations.sqlite'), { readOnly:true });
  let data;
  try { data = JSON.parse(db.prepare('SELECT json FROM preparation_state WHERE id=1').get().json); }
  finally { db.close(); }
  const saved = data.contexts[context.preparationId];
  assert.equal(data.currentId, context.preparationId);
  for (const delivery of context.deliveries) assert.ok(data.receipts[delivery.commandRequestId]);
  assert.deepEqual(saved.agreement, context.agreement);
  assert.equal(saved.webSession.activeDeliveryId, null);
  for (const delivery of context.deliveries) {
    const durable = saved.deliveries.find(d => d.deliveryId === delivery.deliveryId);
    assert.equal(durable.state, 'ACKNOWLEDGED');
    assert.equal(durable.processingState, 'COMPLETE');
    assert.equal(durable.response.rawText, delivery.response.rawText);
    assert.equal(data.receipts[delivery.commandRequestId].status, 'COMPLETED');
  }
  fs.writeFileSync(path.join(f.output, 'sqlite-readback.json'), JSON.stringify({
    source:'separate read-only SQLite connection',
    preparationId:saved.preparationId, state:saved.state, agreement:saved.agreement,
    objective:saved.objective, targetRoot:saved.targetRoot,
    webSession:{ sessionId:saved.webSession.sessionId, conversationUrl:saved.webSession.conversationUrl,
      tabId:saved.webSession.tabId, documentId:saved.webSession.documentId, activeDeliveryId:saved.webSession.activeDeliveryId },
    deliveries:saved.deliveries.map(delivery => ({ deliveryId:delivery.deliveryId, commandRequestId:delivery.commandRequestId,
      state:delivery.state, processingState:delivery.processingState, rawText:delivery.response.rawText,
      trace:delivery.trace, validation:delivery.validation,
      receiptStatus:data.receipts[delivery.commandRequestId].status })),
  }, null, 2));
  return saved;
}
async function assertProposal(f, extension, context, turn) {
  const packet = preparationPackets[turn - 1];
  assert.equal(context.lifecycle, 'ACTIVE');
  assert.equal(context.state, turn === 1 ? 'DISCUSSING' : 'AGREEMENT_READY');
  assert.equal(context.agreement.status, turn === 1 ? 'DISCUSSING' : 'READY');
  assert.deepEqual(context.agreement.requirements, packet.items);
  assert.deepEqual(context.agreement.unresolvedQuestions, packet.questions);
  assert.equal(context.autoApproveOnReady, false);
  assert.equal(context.resultingRunId, null);
  assert.equal(context.webSession.bindingState, 'BOUND');
  assert.equal(context.webSession.activeDeliveryId, null);
  const delivery = context.deliveries.at(-1);
  assert.equal(delivery.response.rawText, raw(packet));
  assert.equal(delivery.validation.status, 'CONFIRMED');
  assert.equal(delivery.validation.format, 'CONFIRMED');
  assert.equal(delivery.trace.requestId, delivery.deliveryId);
  assert.equal(delivery.trace.documentId, context.webSession.documentId);
  assert.equal(delivery.response.binding.sessionId, context.webSession.sessionId);
  assert.equal(delivery.response.binding.runId, context.preparationId);
  const prompts = extension.commands.filter(c => c.type === 'agent.prompt');
  assert.equal(prompts.length, turn);
  assert.equal(prompts.at(-1).requestId, delivery.deliveryId);
  assert.equal(extension.frames.filter(frame => frame.type === 'web.prompt.result' && frame.requestId === delivery.deliveryId).length, 1);
  assert.equal(extension.frames.filter(frame => frame.type === 'web.delivery.acknowledged' && frame.requestId === delivery.deliveryId).length, 1);
  assert.equal(extension.readStorage().currentDeliveryId, null);
  assert.equal(await extension.page.evaluate(() => Number(sessionStorage.getItem('clicks') || 0)), turn);
  await f.page.waitForFunction(summary => document.getElementById('proposalSummary').textContent.includes(summary), packet.summary);
  assert.ok((await f.page.locator('#projectRequirements').textContent()).includes(packet.items[0].statement));
  assert.ok((await f.page.locator('#projectRequirements').textContent()).includes(packet.items[0].acceptanceCriteria));
  assert.equal(await f.page.locator('#applyCode').isVisible(), false);
  assert.equal(await f.page.locator('#reloadProject').isDisabled(), false);
  assert.equal(await f.page.locator('#saveProject').isDisabled(), turn === 1);
  assert.equal(await f.page.locator('#proposalStatus').textContent(), turn === 1 ? '질문에 답해 작업 범위를 정하세요.' : '완료 기준을 확인하고 승인하세요.');
  assert.equal(await f.page.locator('#planningObjective').inputValue(), context.objective);
  assert.equal(await f.page.locator('#projectRoot').inputValue(), context.targetRoot);
  assert.equal(await f.page.locator('#planningUrl').inputValue(), context.conversationUrl);
  assert.doesNotMatch(await f.page.locator('#connectionNotice').textContent(), /서버 응답 없음|서버 연결 끊김/u);
  if (turn === 1) assert.ok((await f.page.locator('#proposalSummary').textContent()).includes(packet.questions[0]));
  persisted(f, context);
  return context;
}

// All mutations originate in the actual Dashboard. Provider response alone is controlled.
export async function preparationHarness(t, f, { revise = false, afterPreparationReply = null, beforeStart = null, continuationAfter = 2 } = {}) {
  let responseCount = 0, releaseSecond, receivedSecond;
  const secondArrived = new Promise(resolve => { receivedSecond = resolve; });
  const secondReleased = new Promise(resolve => { releaseSecond = resolve; });
  t.after(() => releaseSecond());
  const extension = await connectedExtension(t, f, {
    probeReload:false,
    objective:preparationObjective,
    async reply(text, peer) {
      if (responseCount === continuationAfter && afterPreparationReply) return afterPreparationReply(text, peer);
      responseCount++;
      assert.ok(responseCount <= preparationPackets.length, 'Unexpected provider submission');
      assert.ok(text.includes(preparationObjective));
      assert.ok(text.includes(f.server.workspace));
      if (responseCount === 2) { receivedSecond(); await secondReleased; }
      return raw(preparationPackets[responseCount - 1]);
    },
  });
  await f.page.locator('#autoApprovePreparation').uncheck();
  const firstObserved = observedPreparation(f, context => context.deliveries.length === 1 && context.deliveries[0].state === 'ACKNOWLEDGED');
  const startResponse = f.page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/preparations');
  await beforeStart?.();
  await f.page.locator('#planRun').click();
  assert.equal((await startResponse).status(), 202);
  const first = await assertProposal(f, extension, await firstObserved, 1);
  const firstSaved = persisted(f, first);
  // Browser reload causes a fresh real HTTP projection; never a fixture snapshot.
  const reloaded = observedPreparation(f, context => context.preparationId === first.preparationId && context.deliveries.at(-1).state === 'ACKNOWLEDGED');
  await f.page.reload();
  const restored = await reloaded;
  assert.deepEqual(restored.agreement, firstSaved.agreement);
  assert.equal(extension.commands.filter(c => c.type === 'agent.prompt').length, 1);
  await f.page.locator('#projectPanel').waitFor({ state:'visible' });
  await f.page.waitForFunction(summary => document.getElementById('proposalSummary').textContent.includes(summary), first.agreement.summary);
  let final = restored;
  if (revise) {
    const feedback = 'Include seconds in the same clock';
    await f.page.locator('#proposalFeedback').fill(feedback);
    const secondObserved = observedPreparation(f, context => context.deliveries.length === 2 && context.deliveries.at(-1).state === 'ACKNOWLEDGED');
    const replyRoute = `/api/preparations/${first.preparationId}/reply`;
    const replyResponse = f.page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === replyRoute);
    await f.page.locator('#reviseRequirements').click();
    assert.equal((await replyResponse).status(), 202);
    await Promise.race([secondArrived, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Second provider turn did not arrive')), 15000); timer.unref(); })]);
    assert.equal(await f.page.locator('#reviseRequirements').isDisabled(), true);
    const before = f.boundary.filter(entry => entry.route === replyRoute && entry.method === 'POST').length;
    assert.equal(before, 1);
    // Attempt a second click on the disabled UI control while the provider is held.
    await f.page.locator('#reviseRequirements').evaluate(button => button.click());
    assert.equal(f.boundary.filter(entry => entry.route === replyRoute && entry.method === 'POST').length, before);
    assert.equal(extension.commands.filter(c => c.type === 'agent.prompt').length, 2);
    const prompt = extension.commands.filter(c => c.type === 'agent.prompt').at(-1).payload.text;
    assert.ok(prompt.includes(feedback));
    assert.ok(prompt.includes(first.agreement.summary));
    releaseSecond();
    final = await assertProposal(f, extension, await secondObserved, 2);
    for (const key of ['preparationId','objective','targetRoot','conversationUrl']) assert.equal(final[key], first[key]);
    for (const key of ['sessionId','tabId','documentId','conversationId']) assert.equal(final.webSession[key], first.webSession[key]);
    assert.notEqual(final.deliveries[0].deliveryId, final.deliveries[1].deliveryId);
    assert.equal(f.boundary.filter(entry => entry.route === replyRoute && entry.method === 'POST').length, 1);
  }
  let boundReload = null;
  if (path.basename(f.output) === 'UF-12') {
    const documentId = final.webSession.documentId;
    await extension.page.reload();
    const pageState = await extension.sendContent({ type:'agent.ping' });
    assert.equal(pageState.ready, true);
    assert.notEqual(pageState.documentId, documentId);
    assert.equal(await extension.page.locator("[data-message-author-role='user']").count(), 2);
    assert.equal(await extension.page.locator("[data-message-author-role='assistant'] [data-message-content]").last().innerText(), raw(preparationPackets[1]));
    assert.equal(await extension.page.evaluate(() => Number(sessionStorage.getItem('clicks') || 0)), 2);
    assert.equal(extension.commands.filter(c => c.type === 'agent.prompt').length, 2);
    boundReload = { boundPreparationCreated:true, documentChanged:true, sendsBefore:2, sendsAfter:2, staleRejectionAndRebind:'NOT VERIFIED' };
  }
  assert.equal(responseCount, revise ? 2 : 1);
  assert.deepEqual(extension.errors, []);
  assert.equal(f.boundary.filter(entry => entry.method === 'POST' && entry.route.endsWith('/approve')).length, 0);
  fs.writeFileSync(path.join(f.output, 'preparation-boundary.json'), JSON.stringify({
    preparationId:final.preparationId, state:final.state, responseCount,
    deliveryIds:final.deliveries.map(delivery => delivery.deliveryId),
    deliveries:final.deliveries.map(delivery => ({ state:delivery.state, processingState:delivery.processingState, validation:delivery.validation.status })),
    actualDashboardMutation:true, ackObserved:true, sqliteReadback:true, browserReloadReadback:true,
    boundReload, frames:extension.frames,
    sameContextAcrossTurns:revise, workerLaunched:false, controlled:['Chrome API shim','provider DOM and reply'],
  }, null, 2));
  return { extension, context:final };
}
