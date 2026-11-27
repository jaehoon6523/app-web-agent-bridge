import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { extensionBrowser } from '../tests/helpers/extension-browser.mjs';
import { installDecisionEvidenceStorage } from '../src/evidence/decision-evidence-store.js';

const BEGIN = 'CONTROLLER_PACKET_BEGIN';
const END = 'CONTROLLER_PACKET_END';
const hash = text => createHash('sha256').update(text).digest('hex');

async function setup(t, { brokenStore = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-timeline-'));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const receipts = [];
  const fixture = await extensionBrowser(t, { reply:() => '', decisionEvidence:true });
  const storage = path.join(root, 'evidence');
  if (brokenStore) await fs.writeFile(storage, '');
  installDecisionEvidenceStorage(fixture.transport, storage, receipt => receipts.push(receipt));
  await fixture.prepare();
  const handle = await fixture.adapter.submitTurn({
    turnId:'d1', controllerMessageId:'d1', runId:'r1', preparationVersion:4,
    text:'Fixture request', timeoutMs:8_000, stableMs:1_000,
    parseResponse:raw => ({ body:raw, packetText:raw, packet:{ type:'FIXTURE' } }),
  });
  const completion = handle.completion;
  void completion.catch(() => {});
  const { page } = fixture;
  await page.locator('#a1').waitFor();
  const body = text => page.locator('#a1 [data-message-content]').evaluate((element, value) => {
    element.textContent = value;
  }, text);
  const complete = () => page.locator('#a1').evaluate(element => {
    element.setAttribute('data-talvt-turn-state', 'complete');
  });
  await body(BEGIN);
  return { ...fixture, body, complete, completion, receipts,
    restart:() => fixture.restartController(transport => installDecisionEvidenceStorage(transport, storage, receipt => receipts.push(receipt))),
    async record() {
    for (let index = 0; index < 150; index++) {
      const receipt = receipts.find(item => item.phase === 'TURN_TIMELINE');
      if (receipt) {
        const folder = path.join(storage, receipt.relativePath);
        return {
          info:JSON.parse(await fs.readFile(path.join(folder, 'decision.json'), 'utf8')),
          file:name => fs.readFile(path.join(folder, name), 'utf8'),
        };
      }
      await sleep(100);
    }
    assert.fail('Timeline receipt missing: ' + JSON.stringify(receipts));
  } };
}

for (const scenario of ['BEFORE_SIGNAL','AFTER_SIGNAL_BEFORE_COLLECTION','AFTER_COLLECTION','END_NOT_OBSERVED_WITHIN_WINDOW']) {
  test('Chromium same turn: ' + scenario, { timeout:30_000 }, async t => {
    const f = await setup(t);
    if (scenario === 'BEFORE_SIGNAL') await f.body(BEGIN + '\n' + END);
    await f.complete();
    if (scenario === 'AFTER_SIGNAL_BEFORE_COLLECTION') await f.body(BEGIN + '\n' + END);
    const result = await f.completion;
    assert.equal(result.evidence.decisionEvidence?.status, "PERSISTED", JSON.stringify(result.evidence.decisionEvidence) + JSON.stringify(f.frames.map(frame => frame.type)));
    const arrivedBeforeCollection = ['BEFORE_SIGNAL','AFTER_SIGNAL_BEFORE_COLLECTION'].includes(scenario);
    assert.equal(result.rawText, arrivedBeforeCollection ? BEGIN + '\n' + END : BEGIN);
    if (scenario === 'AFTER_COLLECTION') await f.body(BEGIN + '\n' + END);
    if (scenario === 'END_NOT_OBSERVED_WITHIN_WINDOW') {
      await f.page.evaluate(end => {
        window.appendFixtureMessage('assistant', 'earlier-assistant', '');
        const other = document.querySelector('#earlier-assistant');
        document.querySelector('#messages').prepend(other);
        other.querySelector('[data-message-content]').textContent = end;
      }, END);
    }
    const { info, file } = await f.record();
    assert.equal(info.timeline.endPosition, scenario);
    assert.equal(info.assistantMessageId, 'a1');
    assert.equal(info.userMessageId, 'u1');
    assert.equal(info.documentId, result.evidence.documentId);
    assert.equal(info.tabId, 7);
    assert.equal(info.frameId, 0);
    assert.equal(info.preparationVersion, 4);
    assert.equal(info.timeline.events.at(-1).reason, 'WINDOW_ELAPSED');
    assert.equal(info.timeline.events[0].type, 'ASSISTANT_FIRST_OBSERVED');
    assert.ok(info.timeline.events.some(event => event.type === 'BODY_CHANGED' && event.sha256));
    const times = info.timeline.events.map(event => event.monotonicMs);
    assert.deepEqual(times, times.slice().sort((a,b) => a-b));
    const frozen = info.timeline.snapshots.find(snapshot => snapshot.type === 'COLLECTION_FROZEN');
    const filename = frozen.prefix + '-extracted.txt';
    assert.equal(await file(filename), result.rawText);
    assert.equal(info.files[filename].sha256, hash(result.rawText));
    const signal = info.timeline.snapshots.find(snapshot => snapshot.type === 'COMPLETION_SIGNAL');
    assert.equal(signal.completionAttribute, 'complete');
    assert.equal(info.capturedAt <= info.persistedAt, true);
    assert.equal(await f.page.evaluate(() => sessionStorage.getItem('clicks')), '1');
    assert.equal(f.readStorage().completedDelivery.rawText, result.rawText);
    assert.deepEqual(f.errors, []);
  });
}

test('Chromium same turn: ambiguous candidate stops observation', { timeout:25_000 }, async t => {
  const f = await setup(t);
  await f.complete();
  await f.completion;
  await f.page.evaluate(() => window.appendFixtureMessage('assistant', 'a2', 'Other reply'));
  const { info } = await f.record();
  assert.equal(info.timeline.events.at(-1).reason, 'AMBIGUOUS_TURN');
  assert.equal(info.timeline.endPosition, 'END_NOT_OBSERVABLE');
  assert.equal(f.readStorage().completedDelivery.rawText, BEGIN);
});

test('Chromium same turn: changed conversation stops without adopting its DOM', { timeout:25_000 }, async t => {
  const f = await setup(t);
  await f.complete();
  await f.completion;
  await f.page.evaluate(() => history.pushState({}, '', '/c/unrelated'));
  await f.body(END);
  const { info } = await f.record();
  assert.equal(info.timeline.events.at(-1).reason, 'DOCUMENT_OR_TURN_CHANGED');
  assert.equal(info.timeline.endPosition, 'END_NOT_OBSERVABLE');
  assert.equal(f.readStorage().completedDelivery.rawText, BEGIN);
});

test('Chromium same turn: evidence storage failure keeps the collected response', { timeout:25_000 }, async t => {
  const f = await setup(t, { brokenStore:true });
  await f.complete();
  const result = await f.completion;
  assert.equal(result.rawText, BEGIN);
  assert.equal(f.readStorage().completedDelivery.rawText, BEGIN);
  assert.equal(result.evidence.decisionEvidence?.status, 'FAILED');
  assert.equal(result.evidence.decisionEvidence?.code, 'EVIDENCE_STORAGE_FAILED');
});

test('Chromium same turn: page exit is a coverage gap', { timeout:25_000 }, async t => {
  const f = await setup(t);
  await f.complete();
  await f.completion;
  // pagehide is the browser notification available before the old document is lost.
  await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  const { info } = await f.record();
  assert.equal(info.timeline.events.at(-1).reason, 'DOCUMENT_EXIT');
  assert.equal(info.timeline.endPosition, 'END_NOT_OBSERVABLE');
  await f.page.goto('https://chatgpt.com/c/replacement');
  const ping = await f.sendContent({ type:'agent.ping' });
  assert.notEqual(ping.documentId, info.documentId);
});

test('Chromium same turn: transport loss leaves a persisted anchor and no false timeline', { timeout:25_000 }, async t => {
  const f = await setup(t);
  const gap = f.page.waitForEvent('console', {
    predicate:message => message.text().includes('turn-timeline-incomplete'),
    timeout:10_000,
  });
  await f.complete();
  const result = await f.completion;
  assert.equal(result.evidence.decisionEvidence.status, 'PERSISTED');
  f.transport.close();
  await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await gap;
  assert.equal(f.receipts.some(item => item.phase === 'TURN_TIMELINE'), false);
  assert.equal(f.readStorage().completedDelivery.rawText, BEGIN);
});

test('Chromium same turn: fresh controller receives the timeline after reconnection', { timeout:30_000 }, async t => {
  const f = await setup(t);
  await f.page.evaluate(() => {
    const stop = document.createElement('button');
    stop.dataset.testid = 'stop-button';
    stop.textContent = 'Stop';
    document.body.append(stop);
  });
  await f.complete();
  await sleep(1_150);
  assert.equal(f.readStorage().completedDelivery, null);
  await f.page.locator('[data-testid=stop-button]').evaluate(element => element.remove());
  const result = await f.completion;
  await f.restart();
  await f.body(BEGIN + '\n' + END);
  const { info } = await f.record();
  assert.equal(info.observation.previousCaptureId, result.evidence.decisionEvidence.captureId);
  assert.equal(info.timeline.endPosition, 'AFTER_COLLECTION');
  assert.deepEqual(info.timeline.events.filter(event => event.type === 'STOP_BUTTON').map(event => event.visible), [false,true,false]);
  assert.equal(f.readStorage().completedDelivery.rawText, BEGIN);
});
