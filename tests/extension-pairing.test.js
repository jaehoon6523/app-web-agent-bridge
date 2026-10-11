import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtensionIdentityPairing } from '../src/runtime/web/extension-pairing.js';
import { WebExtensionAuthenticator, computeWebChallengeHmac } from '../src/runtime/web/auth.js';
import { WebExtensionTransport } from '../src/runtime/web/session-adapter.js';
import { EventEmitter } from 'node:events';

const secret='pairing-test-secret-0123456789abcdef';
const original='original-extension', candidate='candidate-extension';
function response(auth, identity, valid=true) {
  const challenge=auth.issueChallenge();
  return {type:'extension.auth.response',protocolVersion:2,challengeId:challenge.challengeId,
    extensionIdentity:identity,hmacSha256:valid?computeWebChallengeHmac(challenge.nonce,secret):'0'.repeat(64)};
}
test('only a secret-proven identity can become a pairing candidate', () => {
  const auth=new WebExtensionAuthenticator({sharedSecret:secret,expectedExtensionIdentity:original});
  assert.throws(()=>auth.verifyResponse(response(auth,candidate,false)),{code:'AUTH_HMAC_INVALID'});
  let error;try {auth.verifyResponse(response(auth,candidate));}catch(e){error=e;}
  assert.equal(error.code,'AUTH_IDENTITY_MISMATCH');
  assert.equal(auth.pendingPairing.identity,candidate);
  auth.setExpectedIdentity(candidate);
  assert.equal(auth.verifyResponse(response(auth,candidate)).extensionIdentity,candidate);
});
class Socket extends EventEmitter {
  readyState=1;sent=[];
  send(value){this.sent.push(JSON.parse(value));}
  close(){this.readyState=3;this.emit('close');}
}
test('transport holds only a recent verified candidate and accepts it after approval', () => {
  let now=1_000;
  const transport=new WebExtensionTransport({sharedSecret:secret,expectedExtensionIdentity:original,
    clock:()=>now},{now:()=>now});
  const bad=new Socket();transport.attach(bad);
  bad.emit('message',JSON.stringify({type:'extension.auth.response',protocolVersion:2,challengeId:bad.sent[0].challengeId,
    extensionIdentity:candidate,hmacSha256:'0'.repeat(64)}));
  assert.equal(transport.pendingPairing,null);
  const valid=new Socket();transport.attach(valid);
  valid.emit('message',JSON.stringify({type:'extension.auth.response',protocolVersion:2,challengeId:valid.sent[0].challengeId,
    extensionIdentity:candidate,hmacSha256:computeWebChallengeHmac(valid.sent[0].nonce,secret)}));
  assert.equal(transport.pendingPairing.identity,candidate);
  transport.acceptPairedIdentity(candidate);
  const accepted=new Socket();transport.attach(accepted);
  accepted.emit('message',JSON.stringify({type:'extension.auth.response',protocolVersion:2,challengeId:accepted.sent[0].challengeId,
    extensionIdentity:candidate,hmacSha256:computeWebChallengeHmac(accepted.sent[0].nonce,secret)}));
  assert.equal(transport.authenticated,true);
  transport.close();
  const next=new Socket();transport.attach(next);
  next.emit('message',JSON.stringify({type:'extension.auth.response',protocolVersion:2,challengeId:next.sent[0].challengeId,
    extensionIdentity:'another',hmacSha256:computeWebChallengeHmac(next.sent[0].nonce,secret)}));
  assert.equal(transport.pendingPairing.identity,'another');
  now += 300_001;assert.equal(transport.pendingPairing,null);
});
test('approved identity survives restart and a configuration change cannot reuse the approval', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'extension-pairing-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const options={directory:dir,configuredIdentity:original,sharedSecret:secret};
  const store=createExtensionIdentityPairing(options);
  assert.equal(store.identity,original);
  assert.throws(()=>store.approve(candidate,'different'),{code:'PAIRING_CHANGED'});
  assert.equal(store.approve(candidate,original).identity,candidate);
  assert.equal(createExtensionIdentityPairing(options).identity,candidate);
  assert.deepEqual(fs.readFileSync(path.join(dir,'extension-pairing','events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line).phase),['STARTED','COMPLETED']);
  assert.doesNotMatch(fs.readFileSync(path.join(dir,'extension-pairing.json'),'utf8'),/pairing-test-secret/u);
  assert.equal(createExtensionIdentityPairing({...options,sharedSecret:secret+'changed'}).identity,original);
});
