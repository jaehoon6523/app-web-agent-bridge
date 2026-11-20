import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionBrowser } from '../tests/helpers/extension-browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { setupAudit, assertionsFor } from '../tests/helpers/audit-fixtures.js';
import { createFixtureCodexWorker } from '../tests/helpers/codex-worker-fixture.js';
import { inspectMessageDom } from '../extension/runtime/message-dom-inspection.js';

// Observed DOM structure with synthetic text and IDs. The sibling span and buttons are UI chrome.
const keyedUserBubbleHtml = `<!doctype html><main></main>
    <textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button>
    <script>
    document.querySelector('button').onclick = () => {
      const composer = document.querySelector('textarea');
      history.pushState({}, '', '/c/created');
      document.querySelector('main').innerHTML = \`
        <div><h4 class="sr-only">You said:</h4>
          <div data-chatgpt-search-unit-key="turn:0:user" data-chatgpt-search-message-ids="u1">
            <div data-content-search-unit-key="turn:0:user"><div>
              <div data-user-message-bubble="true" data-user-message-has-prompt="true"><div><div>
                <div data-search-result-target><div><div dir="auto" style="white-space:pre-wrap"></div></div></div>
                <span>UI status</span>
              </div><button data-markdown-copy="exclude">Show more</button></div></div>
              <div><button>Copy</button></div>
            </div></div>
          </div>
        </div>
        <div data-talvt-turn-state="complete"><h4 class="sr-only">ChatGPT said:</h4>
          <div data-chatgpt-search-unit-key="turn:1:assistant" data-chatgpt-search-message-ids="a1 a1">
            <div data-markdown-text-style="assistant-message">Fixture reply</div>
          </div>
        </div>\`;
      const body = document.querySelector('[dir="auto"]');
      body.textContent = window.keyedBubbleCase === 'wrong-marker'
        ? composer.value.replace('[run_id:r1]', '[run_id:other-run]')
        : composer.value;
      if (window.keyedBubbleCase === 'duplicate') {
        const first = document.querySelector('main').firstElementChild;
        const duplicate = first.cloneNode(true);
        const unit = duplicate.querySelector('[data-chatgpt-search-unit-key]');
        unit.setAttribute('data-chatgpt-search-message-ids', 'u2');
        unit.setAttribute('data-chatgpt-search-unit-key', 'turn:2:user');
        unit.firstElementChild.setAttribute('data-content-search-unit-key', 'turn:2:user');
        first.after(duplicate);
      }
      sessionStorage.setItem('submitted', composer.value);
      sessionStorage.setItem('clicks', String(Number(sessionStorage.getItem('clicks') || 0) + 1));
      composer.value = '';
    };
    </script>`;
test('browser fixture: keyed user bubble binds the delivered prompt and its assistant', { timeout:25_000 }, async t => {
  const f = await extensionBrowser(t, { providerHtml:keyedUserBubbleHtml });
  await f.prepare();
  const result = await f.submit();
  const messages = await f.page.evaluate(() => WebBridgePageProviders.provider('CHATGPT_WEB').readMessages()
    .map(({ id, role, text }) => ({ id, role, text })));
  const submitted = await f.page.evaluate(() => sessionStorage.getItem('submitted'));
  assert.deepEqual(messages, [
    { id:'u1', role:'user', text:submitted },
    { id:'a1', role:'assistant', text:'Fixture reply' },
  ]);
  assert.equal(result.evidence.userMessageId, 'u1');
  assert.equal(result.evidence.assistantMessageId, 'a1');
  assert.equal(result.rawText, 'Fixture reply');
  assert.equal(await f.page.evaluate(() => sessionStorage.getItem('clicks')), '1');

  const inspection = await f.page.evaluate(({ source, request }) => (0, eval)('(' + source + ')')(request), {
    source:inspectMessageDom.toString(),
    request:{ conversationUrl:'https://chatgpt.com/c/created', controllerMessageId:'d1', runId:'r1' },
  });
  assert.equal(inspection.result, 'FOUND');
  assert.equal(inspection.matches[0].exactMarkers, true);
  assert.equal(inspection.matches[0].node.attributes['data-chatgpt-search-message-ids'].value, 'u1');

  const page = await f.sendContent({ type:'agent.ping' });
  const recovery = { recoverSubmitted:true, controllerMessageId:'d1', runId:'r1',
    expectedConversationUrl:page.url, expectedConversationId:page.conversationId,
    expectedDocumentId:page.documentId, expectedFrameId:0, userMessageId:'u1', assistantMessageId:'a1' };
  const rejected = await f.sendContent({ type:'agent.recheck', payload:{ ...recovery, assistantMessageId:'other' } });
  assert.equal(rejected.code, 'AMBIGUOUS_COMPLETION');
  const recovered = await f.sendContent({ type:'agent.recheck', payload:recovery });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.text, 'Fixture reply');
  assert.equal(recovered.evidence.userMessageId, 'u1');
  assert.equal(recovered.evidence.assistantMessageId, 'a1');
  assert.equal(await f.page.evaluate(() => sessionStorage.getItem('clicks')), '1');
});

for (const [variant, code] of [
  ['wrong-marker', 'MANUAL_INTERVENTION_DETECTED'],
  ['duplicate', 'AMBIGUOUS_PROMPT_BINDING'],
]) {
  test(`browser fixture: keyed user bubble rejects ${variant}`, { timeout:25_000 }, async t => {
    const f = await extensionBrowser(t, { providerHtml:keyedUserBubbleHtml });
    await f.page.evaluate(value => { window.keyedBubbleCase = value; }, variant);
    await f.prepare();
    await assert.rejects(f.submit(), { code });
    assert.equal(await f.page.evaluate(() => sessionStorage.getItem('clicks')), '1');
    assert.equal(f.readStorage().completedDelivery, null);
  });
}

test('identity rejection stays visible through an open socket until matching authentication is accepted', {timeout:25000}, async t=>{
  const f=await extensionBrowser(t,{autoConnect:false});
  f.transport.acceptPairedIdentity('different-controller-identity');
  await f.background.addInitScript(()=>{
    const Socket=globalThis.WebSocket;
    globalThis.WebSocket=class extends Socket {
      constructor(...args){super(...args);globalThis.identityTestSocket=this;}
      addEventListener(type,listener,options){
        if(type!=='message')return super.addEventListener(type,listener,options);
        return super.addEventListener(type,event=>{
          if(globalThis.holdAuthentication && JSON.parse(event.data).type==='controller.auth.challenge'){
            globalThis.releaseAuthentication=()=>listener(event);return;
          }
          listener(event);
        },options);
      }
    };
  });
  const url=new URL(f.readStorage().controllerUrl);url.protocol='http:';url.pathname='/';
  await f.background.goto(url.href);
  await f.background.waitForFunction(()=>globalThis.fixturePopupState?.lastError?.includes('AUTH_IDENTITY_MISMATCH'));
  f.transport.acceptPairedIdentity(f.readStorage().extensionIdentity);
  await f.background.evaluate(async()=>{
    globalThis.holdAuthentication=true;
    await new Promise(resolve=>globalThis.fixtureBackgroundListener({type:'bridge.reconnect'},{},resolve));
  });
  await f.background.waitForFunction(()=>typeof globalThis.releaseAuthentication==='function');
  await f.background.waitForFunction(()=>globalThis.fixturePopupState?.transportConnected===true);
  const pending=await f.background.evaluate(async()=>
    (await new Promise(resolve=>globalThis.fixtureBackgroundListener({type:'bridge.getState'},{},resolve))).state);
  assert.equal(pending.connected,false);
  assert.equal(pending.transportConnected,true);
  assert.match(pending.lastError,/AUTH_IDENTITY_MISMATCH/u);
  await f.background.evaluate(()=>globalThis.identityTestSocket.dispatchEvent(new Event('error')));
  const afterTransportError=await f.background.evaluate(async()=>
    (await new Promise(resolve=>globalThis.fixtureBackgroundListener({type:'bridge.getState'},{},resolve))).state);
  assert.match(afterTransportError.lastError,/AUTH_IDENTITY_MISMATCH/u);
  await f.background.evaluate(()=>{globalThis.holdAuthentication=false;globalThis.releaseAuthentication();});
  await f.background.waitForFunction(()=>globalThis.fixturePopupState?.connected===true);
  assert.equal(await f.background.evaluate(()=>globalThis.fixturePopupState.lastError),null);
  assert.deepEqual(f.errors,[]);
});

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

test('fixture integration: real adapters, subprocess, Git capture and browser review drive REWORK then PASS', { timeout: process.platform === 'win32' ? 120_000 : 60_000 }, async t => {
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
