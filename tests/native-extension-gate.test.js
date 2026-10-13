import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeExtensionComplete, nativeExtensionSteps} from '../scripts/native-extension-contract.js';

test('native verification cannot pass with missing, duplicate, failed or unfinished boundary evidence', () => {
  const complete = {nativeExtension:true,status:'PASS',completed:true,
    steps:nativeExtensionSteps.map(id => ({id,pass:true}))};
  assert.equal(nativeExtensionComplete(complete),true);
  for (const id of nativeExtensionSteps) {
    assert.equal(nativeExtensionComplete({...complete,steps:complete.steps.filter(step => step.id !== id)}),false);
    assert.equal(nativeExtensionComplete({...complete,steps:complete.steps.map(step => step.id === id ? {...step,pass:false} : step)}),false);
  }
  assert.equal(nativeExtensionComplete({...complete,steps:complete.steps.map(() => complete.steps[0])}),false);
  assert.equal(nativeExtensionComplete({...complete,completed:false}),false);
  assert.equal(nativeExtensionComplete({...complete,status:'UNVERIFIED'}),false);
});
