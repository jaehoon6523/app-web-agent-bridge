import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { productionProcess, extensionCredentials, repository } from './e2e/helpers/process.mjs';
import { parsePreparationResponse } from '../src/orchestration/preparation-response-format.js';
import { isValidRequirementsProposal } from '../src/orchestration/invalid-preparation-abandonment.js';

const provider = 'https://chatgpt.com/';
const tls = JSON.parse(fs.readFileSync(new URL('./e2e/fixtures/unattended-provider-tls.json', import.meta.url)));
const providerPin = createHash('sha256')
  .update(new X509Certificate(tls.certificate).publicKey.export({ type:'spki', format:'der' })).digest('base64');
const packet = { type:'REQUIREMENTS_PROPOSAL', summary:'Automatic preparation fixture', questions:[],
  items:[{ statement:'Show the clock', acceptanceCriteria:'The clock is visible' }] };
const reply = JSON.stringify(packet, null, 2);
const hash = text => createHash('sha256').update(text).digest('hex');
const objective = 'Propose a single requirement for showing the clock.';

function providerFixture(changeComposer) {
  return `<!doctype html><main></main><textarea id="prompt-textarea"></textarea>
    <button data-testid="send-button">Send</button><script>
    const composer = document.querySelector('textarea');
    const record = window.providerSteps = [];
    composer.addEventListener('input', event => {
      if (event.isTrusted) record.push({ stage:'MANUAL_INTERVENTION', at:Date.now() });
      record.push({ stage:'COMPOSER_INPUT', at:Date.now(), text:composer.value });
      if (${changeComposer}) {
        const replacement = composer.cloneNode();
        replacement.value = composer.value;
        composer.replaceWith(replacement);
      }
    });
    function turn(role, id, text) {
      const node = document.createElement('article');
      node.setAttribute('data-message-author-role', role);
      node.setAttribute('data-message-id', id);
      const heading = document.createElement('h4');
      heading.className = 'sr-only';
      heading.textContent = role === 'user' ? 'You said:' : 'ChatGPT said:';
      const content = document.createElement('div');
      content.setAttribute('data-message-content', '');
      content.style.whiteSpace = 'pre-wrap';
      content.textContent = text;
      node.append(heading, content);
      document.querySelector('main').append(node);
      return node;
    }
    document.querySelector('button').addEventListener('click', event => {
      if (event.isTrusted) {
        record.push({stage:'MANUAL_INTERVENTION', at:Date.now()});
        return;
      }
      const text = document.querySelector('textarea').value;
      record.push({stage:'SEND_ATTEMPTED', at:Date.now()});
      history.pushState({}, '', '/c/unattended-fixture');
      turn('user', 'fixture-user', text);
      record.push({stage:'SUBMISSION_CONFIRMED', at:Date.now()});
      document.querySelector('textarea').value = '';
      const answer = turn('assistant', 'fixture-assistant', ${JSON.stringify(reply)});
      answer.setAttribute('data-talvt-turn-state', 'complete');
      record.push({stage:'RESPONSE_COMPLETED', at:Date.now()});
    });
    </script>`;
}

async function until(label, predicate, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const value = await predicate();
    if (value) return value;
    await wait(100);
  } while (performance.now() < deadline);
  assert.fail(label);
}

function durable(workspace, id) {
  const file = path.join(workspace, '.agent-controller', 'preparations.sqlite');
  const db = new DatabaseSync(file, { readOnly:true });
  try {
    const root = JSON.parse(db.prepare('SELECT json FROM preparation_state WHERE id=1').get().json);
    const preparation = root.contexts[id];
    return { preparation, delivery:preparation.deliveries.at(-1), receipts:root.receipts };
  } finally {
    db.close();
  }
}

for (const scenario of [
  { id:'A', roots:0, success:true },
  { id:'B', roots:1, success:true },
  { id:'C', roots:2, code:'WEB_TAB_SELECTION_REQUIRED' },
  { id:'D', roots:1, changeComposer:true, code:'UI_CONTRACT_CHANGED' },
]) {
  test(`unattended Preparation ${scenario.id}`, { timeout:45_000 }, async t => {
    const server = await productionProcess({ configured:true });
    let browser, fixture;
    t.after(async () => {
      try { await browser?.close(); }
      finally {
        if (fixture?.listening) await new Promise(resolve => fixture.close(resolve));
        await server.dispose();
      }
    });
    await server.ready();
    let rootHits = 0;
    // Native chrome.tabs.create can start navigating before Playwright has
    // attached to the target. Use a pinned loopback origin from the first byte.
    fixture = https.createServer({ key:tls.testKey, cert:tls.certificate }, (req, res) => {
      if (req.url !== '/' || req.headers.host !== 'chatgpt.com') { res.writeHead(404).end(); return; }
      rootHits++;
      res.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' })
        .end(providerFixture(scenario.changeComposer === true));
    });
    fixture.listen(0,'127.0.0.1');
    await once(fixture,'listening');
    const extension = path.join(repository, 'extension');
    browser = await chromium.launchPersistentContext(path.join(server.workspace, 'profile'), {
      executablePath:process.env.UI_BROWSER_EXECUTABLE || chromium.executablePath(),
      headless:true, ignoreDefaultArgs:['--disable-extensions'],
      args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-proxy-server',
        `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${fixture.address().port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
        `--ignore-certificate-errors-spki-list=${providerPin}`],
      timeout:15_000,
    });
    const worker = browser.serviceWorkers().find(w => w.url().endsWith('/background.js'))
      ?? await browser.waitForEvent('serviceworker', { predicate:w => w.url().endsWith('/background.js'), timeout:8_000 });
    // Scenario setup ends here. The provider document acts only in response to DOM events.
    for (let i = 0; i < scenario.roots; i++) await (await browser.newPage()).goto(provider);
    const inspectTabs = () => worker.evaluate(() => chrome.tabs.query({ url:'https://chatgpt.com/*' }));
    const before = await inspectTabs();
    assert.equal(before.length, scenario.roots);
    assert.equal(rootHits,scenario.roots);
    await worker.evaluate(async extensionIdentity => {
      // Only the pairing identity is seeded. Chrome storage has no session or delivery yet.
      await chrome.storage.local.set({ extensionIdentity });
      globalThis.bootstrapTabs = [];
      globalThis.deliveryEvents = [];
      chrome.tabs.onCreated.addListener(tab => bootstrapTabs.push({ id:tab.id, at:Date.now() }));
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const completed = changes.completedDelivery?.newValue;
        if (completed) deliveryEvents.push({ stage:'EXTENSION_PERSISTED', id:completed.turnId, at:Date.now(),
          rawText:completed.rawText, binding:completed.binding });
        const acknowledged = changes.lastAcknowledgedDelivery?.newValue;
        if (acknowledged) deliveryEvents.push({ stage:'ACK_CONFIRMED', id:acknowledged.deliveryId, at:Date.now() });
      });
    }, extensionCredentials.extensionIdentity);
    const popup = await browser.newPage();
    await popup.goto(new URL('popup.html',worker.url()).href);
    const paired = await popup.evaluate(async ({ url, sharedSecret }) => chrome.runtime.sendMessage({
      type:'bridge.saveConfig', payload:{ controllerUrl:url, sharedSecret },
    }), { url:server.baseUrl.replace(/^http/u,'ws') + '/ws/extension', sharedSecret:extensionCredentials.sharedSecret });
    assert.equal(paired?.ok, true, JSON.stringify(paired));
    const dashboard = await browser.newPage();
    const session = dashboard.waitForResponse(r => new URL(r.url()).pathname === '/api/dashboard/session');
    await dashboard.goto(server.baseUrl);
    const auth = await session;
    assert.equal(auth.status(), 200);
    const { token } = await auth.json();
    const api = () => dashboard.evaluate(async token => {
      const r = await fetch('/api/state?view=start', { headers:{ authorization:'Bearer ' + token } });
      return { status:r.status, data:await r.json() };
    }, token);
    await until('Extension authentication and preparation.start', async () => {
      const { data } = await api();
      return data.preflight?.checks?.extensionAuthenticated && data.commandCapabilities?.includes('preparation.start');
    }).catch(async error => {
      const { status, data } = await api();
      const popupStatus = await popup.evaluate(() => chrome.runtime.sendMessage({ type:'bridge.getState' }));
      t.diagnostic(JSON.stringify({ stage:'AUTHENTICATION', status, runtime:data.runtimeAvailability,
        extensionAuthenticated:data.preflight?.checks?.extensionAuthenticated,
        capabilities:data.commandCapabilities, connected:popupStatus?.state?.connected,
        lastError:popupStatus?.state?.lastError, error:data.code }));
      throw error;
    });
    await dashboard.locator('#objective').fill(objective);
    await dashboard.locator('#startRoot').fill(server.workspace);
    await dashboard.locator('#autoApprovePreparation').uncheck();
    const firstRequest = dashboard.waitForResponse(r => r.request().method() === 'POST'
      && new URL(r.url()).pathname === '/api/preparations');
    const submissionAt = Date.now();
    await dashboard.locator('#planRun').click();
    const started = await firstRequest;
    const requestId = started.request().postDataJSON().requestId;
    const start = { status:started.status(), data:await started.json() };
    assert.equal(start.status, 202, JSON.stringify(start.data));
    const id = start.data.preparationId;
    const deliveryId = start.data.webSession.activeDeliveryId;
    const settled = await until('Preparation did not reach a terminal turn stage', async () => {
      const { data } = await api();
      const current = data.preparation;
      return current?.preparationId === id && ['AGREEMENT_READY','RECOVERY_REQUIRED','WEB_BLOCKED'].includes(current.state) ? current : null;
    }).catch(async error => {
      const { preparation:c } = (await api()).data;
      t.diagnostic(JSON.stringify({ observation:'timeout', scenario:scenario.id, state:c?.state, error:c?.error,
        delivery:c?.deliveries?.at(-1)?.state, nativeTabs:(await inspectTabs()).map(tab=>({ id:tab.id,url:tab.url,status:tab.status })),
        lastServerEvents:server.logs().stdout.split(/\r?\n/u).filter(line=>line.includes('[bridge:')).slice(-14) }));
      throw error;
    });
    const saved = durable(server.workspace, id), delivery = saved.delivery;
    const tabs = await inspectTabs(), nativeCreated = await worker.evaluate(() => globalThis.bootstrapTabs);
    const extensionEvents = await worker.evaluate(id => globalThis.deliveryEvents.filter(event => event.id===id), deliveryId);
    const observations = [];
    for (const page of browser.pages().filter(p => p.url().startsWith(provider))) {
      observations.push(await page.evaluate(() => ({
        events:window.providerSteps, urls:location.href, messages:[...document.querySelectorAll('[data-message-id]')].map(node =>
          ({ id:node.getAttribute('data-message-id'), role:node.getAttribute('data-message-author-role'), body:node.querySelector('[data-message-content]').textContent })),
        draft:document.querySelector('textarea').value,
      })));
    }
    assert.ok(observations.every(o => o.events.every(e => e.stage !== 'MANUAL_INTERVENTION')), 'MANUAL_INTERVENTION / AUTOMATION_E2E_INVALID');
    const storage = await worker.evaluate(() => chrome.storage.local.get([
      'currentDeliveryId','lastAcknowledgedDelivery','lastBoundSessionId','lastBoundRunId','documentId','tabId',
    ]));
    assert.equal(saved.preparation.preparationId,id);
    assert.equal(delivery.deliveryId,deliveryId);
    assert.equal(delivery.commandRequestId,requestId);
    const report = { scenario:scenario.id, requestId, preparationId:id, deliveryId, beginAt:submissionAt,
      before:before.map(t => t.id), after:tabs.map(t => t.id), state:settled.state, error:settled.error?.code,
      failureStage:settled.error?.details?.stage, endAt:Date.now() };
    t.diagnostic(JSON.stringify(report));

    if (scenario.id === 'C') {
      t.diagnostic(JSON.stringify({ ...report, expected:'one uniquely selectable root', observedRootIds:tabs.map(tab=>tab.id), dispatch:'NOT_DISPATCHED', followOn:'NOT_EXECUTED' }));
      assert.equal(settled.error?.code, scenario.code);
      assert.equal(settled.error?.details?.originalCode, 'AMBIGUOUS');
      assert.equal(settled.error?.details?.browserDispatchStarted, false);
      assert.deepEqual(tabs.map(t=>t.id).sort(), before.map(t=>t.id).sort());
      assert.ok(observations.every(o => o.events.length === 0 && o.messages.length === 0));
      assert.equal(delivery.response, null);
      assert.equal(storage.currentDeliveryId ?? null, null);
      assert.deepEqual(extensionEvents,[]);
      return;
    }

    const wasCreated = scenario.roots === 0;
    assert.equal(rootHits,1,'the only root navigation must reach the isolated fixture');
    assert.equal(tabs.length,1);
    assert.equal(observations.length,1);
    const [tab] = tabs, [observed] = observations;
    const bound = saved.preparation.webSession;
    assert.equal(wasCreated ? nativeCreated.some(t => t.id===tab.id && t.at>=submissionAt) : tab.id===before[0].id, true);
    assert.equal(bound.tabId,tab.id);
    assert.equal(bound.documentId,storage.documentId);
    assert.equal(bound.sessionId,storage.lastBoundSessionId);
    assert.equal(id,storage.lastBoundRunId);
    const [input] = observed.events;
    assert.equal(input?.stage,'COMPOSER_INPUT');
    assert.match(input.text,new RegExp('^\\[controller_message_id:' + deliveryId + '\\]\\n\\[run_id:' + id + '\\]\\n'));
    assert.ok(input.text.includes(objective));
    if (!scenario.success) {
      assert.equal(settled.error?.code, scenario.code);
      assert.equal(settled.error?.details?.browserDispatchStarted,true);
      assert.equal(settled.error?.details?.stage,'SEND_CONTROL');
      assert.equal(settled.error?.details?.sendAttempted,false);
      assert.ok(settled.error.details.stageEndedAt >= settled.error.details.stageStartedAt);
      t.diagnostic(JSON.stringify({ ...report, expected:'same composer at send', observed:'composer replaced after extension input',
        documentId:bound.documentId, enteredAt:settled.error.details.stageStartedAt, leftAt:settled.error.details.stageEndedAt,
        dispatch:'STARTED', sendAttempted:false, followOn:'NOT_EXECUTED' }));
      assert.equal(observed.draft,input.text);
      assert.deepEqual(observed.events.map(e=>e.stage),['COMPOSER_INPUT']);
      assert.deepEqual(observed.messages,[]);
      assert.equal(delivery.response,null);
      assert.equal(storage.currentDeliveryId,deliveryId);
      assert.equal(storage.lastAcknowledgedDelivery ?? null,null);
      assert.deepEqual(extensionEvents,[]);
      return;
    }
    assert.equal(settled.state,'AGREEMENT_READY');
    assert.deepEqual(observed.events.map(e=>e.stage),['COMPOSER_INPUT','SEND_ATTEMPTED','SUBMISSION_CONFIRMED','RESPONSE_COMPLETED']);
    assert.deepEqual(observed.messages.map(m=>[m.role,m.id]),[['user','fixture-user'],['assistant','fixture-assistant']]);
    assert.equal(observed.messages[0].body,input.text);
    const response=delivery.response;
    assert.equal(response.evidence.userMessageId,observed.messages[0].id);
    assert.equal(response.evidence.assistantMessageId,observed.messages[1].id);
    assert.equal(response.evidence.documentId,bound.documentId);
    assert.equal(response.evidence.completionSignal,'ASSISTANT_TURN_COMPLETE');
    assert.equal(response.turnId,deliveryId);
    assert.equal(response.binding.conversationUrl,observed.urls);
    assert.equal(response.binding.sessionId,bound.sessionId);
    assert.equal(response.binding.runId,id);
    assert.equal(response.rawText,observed.messages[1].body);
    const [storedResponse, ack] = extensionEvents;
    assert.deepEqual(extensionEvents.map(e=>e.stage),['EXTENSION_PERSISTED','ACK_CONFIRMED']);
    assert.equal(hash(storedResponse.rawText),hash(response.rawText));
    assert.equal(storedResponse.binding.documentId,bound.documentId);
    assert.equal(storedResponse.binding.sessionId,bound.sessionId);
    assert.ok(ack.at>=storedResponse.at);
    assert.equal(response.evidence.decisionEvidence?.status,'PERSISTED');
    assert.equal(response.evidence.decisionEvidence.response.sha256,hash(response.rawText));
    assert.ok(response.evidence.decisionEvidence.persistedAt >= observed.events.at(-1).at);
    assert.deepEqual(parsePreparationResponse(response.rawText, delivery.responseFormat).parsed,packet);
    assert.equal(isValidRequirementsProposal(response.packet),true);
    assert.equal(delivery.validation.format,'CONFIRMED');
    assert.equal(delivery.state,'ACKNOWLEDGED');
    assert.equal(delivery.processingState,'COMPLETE');
    assert.equal(saved.receipts[requestId].status,'COMPLETED');
    assert.equal(storage.lastAcknowledgedDelivery?.deliveryId,deliveryId);
    assert.equal(storage.lastAcknowledgedDelivery?.sessionId,bound.sessionId);
    assert.equal(storage.lastAcknowledgedDelivery?.runId,id);
    assert.equal(storage.lastAcknowledgedDelivery?.conversationUrl,bound.conversationUrl);
    assert.equal(storage.currentDeliveryId,null);
    assert.equal(bound.activeDeliveryId,null);
    t.diagnostic(JSON.stringify({ tabSource:wasCreated?'BRIDGE_CREATED':'BRIDGE_REUSED', tabId:tab.id,
      documentId:bound.documentId,userMessageId:response.evidence.userMessageId,assistantMessageId:response.evidence.assistantMessageId,
      events:[...observed.events,...extensionEvents].map(e=>[e.stage,e.at]),sha256:hash(response.rawText),packetValidated:true,ackConfirmed:true }));
  });
}
