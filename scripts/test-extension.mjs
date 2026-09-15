import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionBrowser } from '../tests/helpers/extension-browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { setupAudit, reportFor } from '../tests/helpers/audit-fixtures.js';
import { createFixtureCodexWorker } from '../tests/helpers/codex-worker-fixture.js';

for (const variant of ['roles', 'classes', 'headings']) {
  test(`browser fixture: full extension + Web adapter sends once and reads ${variant} DOM`, { timeout: 25_000 }, async t => {
    const f = await extensionBrowser(t, { variant });
    await f.prepare();
    assert.equal(f.readStorage().bindingStatus, 'ROOT_READY');
    assert.equal(await f.page.evaluate(() => sessionStorage.getItem('clicks')), null);
    const result = await f.submit();
    assert.equal(result.rawText, 'Observed fixture reply');
    assert.equal(result.binding.conversationId, 'created');
    assert.equal(result.evidence.userMessageId, variant === 'roles' ? 'u1' : 'conversation-turn-u1');
    assert.equal(result.evidence.assistantMessageId, variant === 'roles' ? 'a1' : 'conversation-turn-a1');
    assert.equal(await f.page.evaluate(() => sessionStorage.getItem('clicks')), '1');
    assert.equal(f.readStorage().currentDeliveryId, 'd1');
    await f.adapter.acknowledgeDelivery({ turnId: 'd1' });
    await f.adapter.confirmDeliveryAcknowledgement({ turnId: 'd1', sessionId: 's1', runId: 'r1', conversationUrl: result.binding.conversationUrl });
    assert.equal(f.readStorage().currentDeliveryId, null);
    assert.deepEqual(f.errors, []);
  });
}

test('browser fixture: temporary WEB ID settles to the durable conversation without manual intervention', { timeout: 25_000 }, async t => {
  const f = await extensionBrowser(t, { navigation: 'temporary-web', variant: 'roles' });
  await f.prepare();
  assert.equal(f.readStorage().bindingStatus, 'ROOT_READY');

  const result = await f.submit();

  assert.equal(
    await f.page.evaluate(() => sessionStorage.getItem('temporaryConversationUrl')),
    'https://chatgpt.com/c/WEB:temporary',
  );
  assert.equal(f.page.url(), 'https://chatgpt.com/c/created');
  assert.equal(result.binding.conversationUrl, 'https://chatgpt.com/c/created');
  assert.equal(result.binding.conversationId, 'created');
  assert.equal(result.binding.bindingStatus, 'BOUND');
  assert.equal(result.evidence.userMessageId, 'u1');
  assert.equal(f.readStorage().conversationId, 'created');
  assert.equal(f.readStorage().bindingStatus, 'BOUND');
  assert.equal(f.commands.filter(message => message.type === 'agent.prompt').length, 1);
  assert.equal(f.frames.some(frame => frame.type === 'web.manual-intervention'), false);
  assert.deepEqual(f.errors, []);
});

test('browser fixture: new document is observed without resending the submitted prompt', { timeout: 25_000 }, async t => {
  const f = await extensionBrowser(t, { navigation: 'document', variant: 'classes' });
  await f.prepare();
  const before = f.readStorage().documentId;
  const result = await f.submit();
  assert.equal(result.rawText, 'Observed fixture reply');
  assert.equal(result.binding.conversationUrl, 'https://chatgpt.com/uc/created');
  assert.notEqual(result.binding.documentId, before);
  assert.equal(result.trace.documentId, result.binding.documentId);
  assert.equal(f.commands.filter(m => m.type === 'agent.prompt').length, 1);
  assert.equal(f.commands.filter(m => m.type === 'agent.observeSubmittedPrompt').length, 1);
  assert.equal(await f.page.evaluate(() => sessionStorage.getItem('clicks')), '1');
  await f.adapter.acknowledgeDelivery({ turnId: 'd1' });
  await f.adapter.confirmDeliveryAcknowledgement({ turnId: 'd1', sessionId: 's1', runId: 'r1', conversationUrl: result.binding.conversationUrl });
  assert.equal(f.readStorage().currentDeliveryId, null);
  assert.deepEqual(f.errors, []);
});

test('browser fixture: stale document cannot click send', { timeout: 15_000 }, async t => {
  const f = await extensionBrowser(t);
  const result = await f.sendContent({ type: 'agent.prompt', requestId: 'stale', payload: { expectedDocumentId: 'old-document', expectedFrameId: 0 } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'WEB_DOCUMENT_CHANGED');
  assert.equal(await f.page.evaluate(() => sessionStorage.getItem('clicks')), null);
});

test('fixture integration: real adapters, subprocess, Git capture and browser review drive REWORK then PASS', { timeout: 60_000 }, async t => {
  const reviewed = [];
  const web = await extensionBrowser(t, { initialUrl: 'https://chatgpt.com/c/test', reply(text) {
    const data = JSON.parse(text.slice(text.indexOf('\n{') + 1));
    const patch = data.evidence.find(e => e.kind === 'PATCH')?.excerpt?.content;
    assert.equal(typeof patch, 'string');
    // This reviewer fixture reads captured bytes. It does not choose PASS by call count.
    const verdict = patch.includes('+revision 2') ? 'SATISFIED' : 'UNSATISFIED';
    reviewed.push({ candidateId: data.context.candidateId, patch, verdict });
    return `<controller_packet>\n${JSON.stringify(reportFor(data.context, verdict))}\n</controller_packet>`;
  } });
  const f = setupAudit(t, { createWorker: createFixtureCodexWorker, webSession: web.adapter,
    configure(project) { project.policy.turnTimeoutMs = 15_000; } });
  const run = await f.run();
  assert.equal(run.stage, 'AWAITING_APPLY', run.error);
  assert.deepEqual(run.reviews.map(review => review.decision), ['REWORK', 'PASS']);
  assert.equal(run.workerTurns.length, 2);
  assert.notEqual(run.workerTurns[0].sessionId, run.workerTurns[1].sessionId);
  assert.notEqual(run.workerTurns[0].turnId, run.workerTurns[1].turnId);
  assert.notEqual(reviewed[0].candidateId, reviewed[1].candidateId);
  assert.ok(reviewed[0].patch.includes('+revision 1'));
  assert.ok(reviewed[1].patch.includes('+revision 2'));
  assert.equal(run.findings[0].status, 'RESOLVED');
  assert.equal(fs.readFileSync(path.join(f.target, 'file.txt'), 'utf8'), 'base\n');
  assert.equal(run.application, null);
  assert.equal(web.commands.filter(m => m.type === 'agent.prompt').length, 2);
  assert.ok(run.requests.every(request => request.status === 'PROCESSED' && request.promptRef && request.responseRef));
  await f.reopen();
  assert.equal(f.service.get(run.runId).stage, 'AWAITING_APPLY');
  assert.equal(f.service.get(run.runId).workerTurns.length, 2);
  assert.deepEqual(web.errors, []);
});
