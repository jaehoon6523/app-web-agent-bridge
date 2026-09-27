import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionBrowser } from '../tests/helpers/extension-browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { setupAudit, assertionsFor } from '../tests/helpers/audit-fixtures.js';
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

test('browser fixture: one extension transport switches from ChatGPT to Claude without duplicate sends', { timeout: 35_000 }, async t => {
  const f = await extensionBrowser(t);
  await f.prepare();
  const chatResult = await f.submit('chat-d1');
  await f.adapter.acknowledgeDelivery({ turnId: 'chat-d1' });
  await f.adapter.confirmDeliveryAcknowledgement({
    turnId:'chat-d1', sessionId:'s1', runId:'r1', conversationUrl:chatResult.binding.conversationUrl,
  });
  assert.equal(chatResult.binding.conversationUrl, 'https://chatgpt.com/c/created');

  const claude = f.createAdapter('CLAUDE_WEB');
  const claudeReady = await claude.resume({
    binding:{
      sessionId:'s2', runId:'r2', tabId:null, windowId:null, documentId:null, frameId:null,
      conversationUrl:null, conversationId:null, title:null,
      lastObservedUserMessageId:null, lastObservedAssistantMessageId:null, bindingStatus:'NEEDS_REBIND',
    },
    createNewConversation:true,
  });
  assert.equal(claude.runtimeIdentity.provider, 'CLAUDE_WEB');
  assert.equal(claudeReady.conversationUrl, 'https://claude.ai/new');
  assert.equal(claudeReady.bindingStatus, 'ROOT_READY');

  const handle = await claude.submitTurn({
    turnId:'claude-d1',
    controllerMessageId:'claude-d1',
    runId:'r2',
    text:'Read this controlled prompt',
    timeoutMs:8_000,
    stableMs:1_000,
    parseResponse:raw => ({ body:raw, packetText:raw, packet:{ type:'FIXTURE_REPLY' } }),
  });
  const claudeResult = await handle.completion;
  assert.equal(claudeResult.rawText, 'Observed fixture reply');
  assert.equal(claudeResult.binding.conversationUrl, 'https://claude.ai/chat/created');
  assert.equal(claudeResult.binding.conversationId, 'created');
  assert.equal(f.readStorage().conversationUrl, 'https://claude.ai/chat/created');
  assert.deepEqual(
    f.commands.filter(message => message.type === 'agent.prompt').map(message => message.requestId),
    ['chat-d1', 'claude-d1'],
  );
  assert.equal(f.contentResults.filter(entry => entry.request.type === 'agent.prompt').length, 2);
  assert.deepEqual(f.errors, []);
});

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
    // The extension prepends controller/run markers before the prompt's
    // instruction line. The JSON context occupies one line after those markers.
    const jsonStart = text.indexOf('\n{') + 1;
    const jsonEnd = text.indexOf('\n', jsonStart);
    assert.ok(jsonStart > 0 && jsonEnd > jsonStart, 'Prompt must contain its JSON data line');
    const data = JSON.parse(text.slice(jsonStart, jsonEnd));
    let response;
    if (data.plan && data.planHash) {
      response = { type: 'PLAN_RESPONSE', runId: data.runId, candidateId: data.candidateId,
        planId: data.planId, planHash: data.planHash, planBasisHash: data.planBasisHash, decision: 'ACCEPT' };
    } else if (data.planId && data.auditManifestHash && !data.context) {
      response = { type: 'PLAN_PROPOSAL', runId: data.runId, candidateId: data.candidateId,
        auditManifestHash: data.auditManifestHash, planBasisHash: data.planBasisHash, planId: data.planId,
        workItems: [{ workItemId: 'wi-1', objective: 'Resolve all blocking findings without weakening acceptance.',
          acceptanceCriteria: 'All blocking findings satisfy their recorded resolution criteria.' }],
        constraints: ['Preserve requirements and tests.'] };
    } else {
      assert.ok(data.context?.auditManifestHash, 'Unexpected audit fixture prompt');
      const patch = data.evidence.find(e => e.kind === 'PATCH')?.excerpt?.content;
      assert.equal(typeof patch, 'string');
      // Both reviewer roles decide from captured bytes, independent of invocation order.
      const verdict = patch.includes('+revision 2') ? 'SATISFIED' : 'UNSATISFIED';
      if (data.role === 'JUDGE' && data.phase === 'ROUND0') {
        reviewed.push({ candidateId: data.context.candidateId, patch, verdict });
      }
      response = assertionsFor(data.context, verdict);
    }
    return `Fixture response.\nCONTROLLER_PACKET_BEGIN\n${JSON.stringify(response)}\nCONTROLLER_PACKET_END`;
  } });
  const f = setupAudit(t, { createWorker: createFixtureCodexWorker, webSession: web.adapter,
    configure(project) { project.policy.turnTimeoutMs = 15_000; } });
  const run = await f.run();
  assert.equal(run.stage, 'AWAITING_APPLY', JSON.stringify({
    error: run.error, terminationReason: run.terminationReason, iteration: run.iteration,
    workerTurns: run.workerTurns?.map(turn => ({ turnId: turn.turnId, status: turn.status,
      error: turn.metadata?.error ?? null })),
    requests: run.requests?.map(request => ({ requestId: request.requestId,
      status: request.status, phase: request.phase, role: request.role })),
    events: run.events?.slice(-8).map(event => event.type),
    browserCommands: web.commands.map(command => ({ type: command.type, requestId: command.requestId })),
    browserFrames: web.frames.map(frame => ({ type: frame.type, requestId: frame.requestId,
      code: frame.payload?.code ?? null })),
    browserErrors: web.errors,
    reviewed: reviewed.map(review => ({ candidateId: review.candidateId, verdict: review.verdict })),
  }));
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
  const prompts = web.commands.filter(command => command.type === 'agent.prompt');
  const promptIds = prompts.map(command => command.requestId);
  const trackedTurnIds = [
    ...run.requests.map(request => request.requestId),
    ...(run.coordinationEvents ?? []).map(event => event.turnId),
  ];
  assert.equal(prompts.length, trackedTurnIds.length);
  assert.equal(new Set(promptIds).size, prompts.length);
  assert.deepEqual(new Set(promptIds), new Set(trackedTurnIds));
  assert.ok(run.requests.every(request => request.status === 'PROCESSED' && request.promptRef && request.responseRef));
  assert.ok((run.coordinationEvents ?? []).every(event =>
    event.turnId && event.packetRef?.sha256 && event.reasoningRef?.sha256));
  await f.reopen();
  assert.equal(f.service.get(run.runId).stage, 'AWAITING_APPLY');
  assert.equal(f.service.get(run.runId).workerTurns.length, 2);
  assert.deepEqual(web.errors, []);
});


test('browser fixture: mixed-provider audit uses ChatGPT Judge and Claude Critic on one extension transport', { timeout: 45_000 }, async t => {
  const web = await extensionBrowser(t, { initialUrl: 'https://chatgpt.com/c/test', reply(text) {
    const jsonStart = text.indexOf('\n{') + 1;
    const jsonEnd = text.indexOf('\n', jsonStart);
    assert.ok(jsonStart > 0 && jsonEnd > jsonStart, 'Prompt must contain its JSON data line');
    const data = JSON.parse(text.slice(jsonStart, jsonEnd));
    assert.ok(data.context?.auditManifestHash, 'Unexpected mixed-provider audit prompt');
    const response = assertionsFor(data.context, 'SATISFIED');
    return `Fixture response.\nCONTROLLER_PACKET_BEGIN\n${JSON.stringify(response)}\nCONTROLLER_PACKET_END`;
  } });
  const f = setupAudit(t, {
    webSession:web.adapter,
    reviewerWebProviderFactory(chatGpt) {
      return {
        CHATGPT_WEB:chatGpt,
        CLAUDE_WEB:web.createAdapter('CLAUDE_WEB'),
      };
    },
    configure(project) {
      project.policy.turnTimeoutMs = 15_000;
      project.reviewers = {
        JUDGE:{ provider:'CHATGPT_WEB' },
        CRITIC:{ provider:'CLAUDE_WEB' },
      };
    },
  });

  const run = await f.run();
  assert.equal(run.stage, 'AWAITING_APPLY', JSON.stringify({
    error:run.error,
    terminationReason:run.terminationReason,
    coordination:run.coordination,
    requests:run.requests?.map(request => ({
      requestId:request.requestId,
      role:request.role,
      status:request.status,
    })),
    browserCommands:web.commands.map(command => ({
      type:command.type,
      requestId:command.requestId,
      expectedConversationUrl:command.payload?.expectedConversationUrl ?? null,
    })),
    browserErrors:web.errors,
  }));

  const bindings = Object.fromEntries(
    run.conversationBindings.map(binding => [binding.role, binding]),
  );
  assert.equal(bindings.JUDGE.provider, 'CHATGPT_WEB');
  assert.equal(bindings.JUDGE.conversationUrl, 'https://chatgpt.com/c/test');
  assert.equal(bindings.CRITIC.provider, 'CLAUDE_WEB');
  assert.equal(bindings.CRITIC.conversationUrl, 'https://claude.ai/chat/created');

  const independence = run.reviews.at(-1).reviewerIndependence;
  assert.equal(independence.roleSeparation, 'VERIFIED');
  assert.equal(independence.sessionSeparation, 'VERIFIED');
  assert.equal(independence.conversationSeparation, 'VERIFIED');
  assert.equal(independence.providerSeparation, 'VERIFIED');

  const prompts = web.commands.filter(command => command.type === 'agent.prompt');
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts.map(command => command.payload.expectedConversationUrl), [
    'https://chatgpt.com/c/test',
    'https://claude.ai/new',
  ]);
  assert.equal(new Set(prompts.map(command => command.requestId)).size, 2);
  assert.equal(web.contentResults.filter(entry => entry.request.type === 'agent.prompt').length, 2);
  assert.deepEqual(web.errors, []);
});
