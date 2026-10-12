import test from 'node:test';
import assert from 'node:assert/strict';
import { choiceAvailability, preparationTransmissionStatus } from '../public/preparation-tab-choice.js';
import { createDeliveryReview } from '../extension/runtime/delivery-review.js';
const candidates = [{tabId:7,url:'https://chatgpt.com/'},{tabId:8,url:'https://chatgpt.com/'}];
test('stale hints warn but admit explicit current candidates', () => {
  for (const hint of ['9','invalid','', '-1']) assert.equal(choiceAvailability({candidates,hint,operation:'IDLE',allowed:true}).enabled,true);
  assert.equal(choiceAvailability({candidates,hint:'7',operation:'IDLE',allowed:true}).enabled,true);
});
test('unknown result, busy operation and absent capability block selection', () => {
  for (const operation of ['RUNNING','UNKNOWN_RESULT']) assert.equal(choiceAvailability({candidates,operation,allowed:true}).enabled,false);
  assert.equal(choiceAvailability({candidates,operation:'IDLE',allowed:false}).enabled,false);
});
test('completion requires COMPLETE and ACKNOWLEDGED and is not cancellation', () => {
  for (const delivery of [{state:'ACKNOWLEDGED'},{processingState:'COMPLETE'},{state:'ACKNOWLEDGED',processingState:'COMPLETE',cancelled:true},{processingState:'ACK_PENDING'}]) assert.notEqual(preparationTransmissionStatus(delivery).step,3);
  assert.equal(preparationTransmissionStatus({state:'ACKNOWLEDGED',processingState:'COMPLETE'}).step,3);
});
test('popup navigation checks live root URL and only opens a hint; storage is unchanged', async () => {
  const state = {controllerUrl:'ws://127.0.0.1:8765',currentDeliveryId:'preserve',completedDelivery:{turnId:'other',text:'preserve'}};
  const original=structuredClone(state), opened=[];
  let liveUrl='https://chatgpt.com/';
  const review=createDeliveryReview({store:{read:async()=>state}, tabs:{get:async()=>({url:liveUrl}),create:async value=>opened.push(value)}});
  await review.openPreparationTab({tabId:7});
  assert.equal(new URL(opened[0].url).search,'?prepareTab=7'); assert.deepEqual(state,original);
  liveUrl='https://chatgpt.com/c/changed';
  await assert.rejects(review.openPreparationTab({tabId:7}),{code:'TAB_CHANGED'});
  await assert.rejects(review.openPreparationTab({tabId:'7'}),{code:'INVALID_TAB'});
  assert.equal(opened.length,1);
});
