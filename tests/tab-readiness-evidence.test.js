import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDeliveryPage, readDeliveryPage, pageDiagnosticMetadata } from '../extension/runtime/delivery-page.js';
import { inspectChatGptTabs } from '../extension/runtime/tab-diagnostics.js';
import { createDeliveryReview } from '../extension/runtime/delivery-review.js';

const url = 'https://chatgpt.com/';
const owner = { currentDeliveryId:'delivery', lastBoundSessionId:'session', lastBoundRunId:'run',
  conversationUrl:url, tabId:7, documentId:'old-doc', frameId:0, bindingStatus:'AMBIGUOUS' };
const page = { ok:true, ready:true, busy:false, generating:false, composerPresent:true,
  documentId:'old-doc', frameId:0, pageUrl:url, url, runtimeVersion:'0.2.5' };

for (const [failureMessage, expected] of [
  ['Could not establish connection. Receiving end does not exist.', 'RECEIVER_MISSING'],
  ['The message port closed before a response was received.', 'PORT_CLOSED'],
  ['Extension context invalidated.', 'CONTEXT_INVALIDATED'],
  ['Cannot access contents of the page.', 'PERMISSION_DENIED'],
  ['Unexpected PRIVATE prompt and response', 'MESSAGE_FAILED'],
]) {
  test('inspection classifies ' + expected + ' without echoing raw errors or changing ownership', async () => {
    const calls = [], before = structuredClone(owner);
    const review = createDeliveryReview({store:{read:async () => owner}, turnGate:{active:false},
      tabs:{get:async () => ({id:7, url, status:'complete'}), sendMessage:async (_id, command) => {
        calls.push(command); throw new Error(command.type === 'agent.ping' ? failureMessage : 'Unexpected command');
      }}, inspectServer:async () => ({status:'UNAVAILABLE', records:[]})});
    const result = await review.inspect();
    assert.equal(result.page.transport.status, expected); assert.equal(result.page.transport.tabStatus, 'FOUND');
    assert.equal(result.page.reachable, false); assert.equal(result.page.documentMatches, null);
    assert.equal(result.phase, 'UNRESOLVED'); assert.equal(result.server.status, 'UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/u);
    assert.deepEqual(owner, before); assert.ok(calls.every(item => item.type === 'agent.ping'));
  });
}

test('closed tab is distinguished from an existing tab without a receiver', async () => {
  let sends = 0;
  const result = await inspectDeliveryPage({get:async () => {throw new Error('No tab with id: 7.');},
    sendMessage:async () => {sends++;}}, 7);
  assert.equal(result.transport.status, 'TAB_NOT_FOUND'); assert.equal(result.page, null); assert.equal(sends, 0);
  assert.equal((await inspectDeliveryPage({}, null)).transport.status, 'TAB_ID_UNAVAILABLE');
});

test('lookup failure remains distinct and a responding receiver can still be inspected', async () => {
  const result = await inspectDeliveryPage({get:async () => {throw new Error('PRIVATE lookup error');},
    sendMessage:async () => page}, 7);
  assert.equal(result.transport.tabStatus, 'TAB_LOOKUP_FAILED'); assert.equal(result.transport.status, 'RESPONDED');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/u);
});

test('tab lookup timeout is reported separately from a content message timeout', async () => {
  const result = await inspectDeliveryPage({get:() => new Promise(() => {}), sendMessage:async () => page}, 7, {timeoutMs:20});
  assert.equal(result.transport.tabStatus, 'TAB_LOOKUP_TIMEOUT'); assert.equal(result.transport.status, 'RESPONDED');
});

test('message timeout and invalid reply are distinguished and late replies do not replace a snapshot', async () => {
  let resolve;
  const result = await inspectDeliveryPage({sendMessage:() => new Promise(done => {resolve = done;})}, 7, {timeoutMs:20});
  assert.equal(result.transport.status, 'MESSAGE_TIMEOUT');
  resolve(page); await Promise.resolve(); assert.equal(result.page, null);
  const invalid = await inspectDeliveryPage({sendMessage:async () => undefined}, 7);
  assert.equal(invalid.transport.status, 'INVALID_RESPONSE');
  assert.equal(await readDeliveryPage({sendMessage:async () => {throw Error('No receiver');}}, 7), null);
});

test('navigation observed between tab query and inspection does not claim readiness', async () => {
  const [result] = await inspectChatGptTabs({query:async () => [{id:7, url}],
    get:async () => ({id:7, url:url+'c/changed'}), sendMessage:async () => page});
  assert.equal(result.reachable, true); assert.equal(result.ready, false);
  assert.equal(result.observedTabUrl, url+'c/changed');
});

test('diagnostic metadata removes private extra fields at every supported nesting level', () => {
  const privateFields = {prompt:'PRIVATE prompt', response:'PRIVATE response', body:'PRIVATE body', sharedSecret:'PRIVATE secret'};
  const sample = {tagName:'TEXTAREA', width:300, height:80, ...privateFields};
  const selector = {selector:'#prompt-textarea', matched:1, visible:0, samples:[sample], ...privateFields};
  const result = pageDiagnosticMetadata({pageState:{readyState:'complete', ...privateFields},
    diagnostics:{selectorVersion:'version', composerSelectors:[selector], editableCandidates:[selector], ...privateFields},
    inspectionError:{code:'UI_CONTRACT_CHANGED', message:'Inspection failed', stack:'PRIVATE stack', ...privateFields}, ...privateFields});
  assert.equal(result.diagnostics.composerSelectors[0].samples[0].width, 300);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/u);
});

test('inspection reports observed and stored document identities without clearing a mismatched owner', async () => {
  const before = structuredClone(owner);
  const review = createDeliveryReview({store:{read:async () => owner}, turnGate:{active:false},
    tabs:{sendMessage:async () => ({...page, documentId:'new-doc', activeRequestId:'delivery'})},
    inspectServer:async () => ({status:'MATCHED', records:[{processingState:'RESERVED', responseStored:false}]})});
  const result = await review.inspect();
  assert.equal(result.page.expectedDocumentId, 'old-doc'); assert.equal(result.page.documentId, 'new-doc');
  assert.equal(result.page.documentMatches, false); assert.equal(result.phase, 'UNRESOLVED');
  assert.deepEqual(owner, before);
});
