import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore } from '../src/evidence/artifact-store.js';
import { publicCodeChange } from '../src/security/public-code-change.js';
import { redactForEvidence } from '../src/security/redaction.js';

test('private response bytes are isolated from normal artifact reads and public projections', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-private-response-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const store = new ArtifactStore(root);
  const record = {rawText:'Original password=private-example\r\n', packet:{password:'private-example'}};
  const ref = store.putPrivateResponse(record);
  assert.equal(ref.redacted, false);
  assert.deepEqual(store.readPrivateResponse(ref), record);
  assert.throws(() => store.read(ref.sha256), {code:'ARTIFACT_NOT_FOUND'});
  const projected = publicCodeChange({webDeliveryReceipts:[{privateResponseRef:ref}], nested:{privateResponseRef:ref}});
  assert.doesNotMatch(JSON.stringify(projected), /privateResponseRef|private-example/u);
  if (process.platform !== 'win32') {
    const directory = path.join(root, 'private-web-responses');
    assert.equal(fs.statSync(directory).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(directory, ref.sha256.slice(7))).mode & 0o077, 0);
  }
  assert.equal(store.removePrivateResponseIfUnreferenced(ref.sha256, new Set([ref.sha256])), false);
  assert.deepEqual(store.readPrivateResponse(ref), record);
  assert.equal(store.removePrivateResponseIfUnreferenced(ref.sha256), true);
  assert.throws(() => store.readPrivateResponse(ref), {code:'ENOENT'});
});

test('private response integrity and namespace cannot fall back to public evidence', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-private-integrity-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const store = new ArtifactStore(root), ref = store.putPrivateResponse({rawText:'Original response'});
  assert.throws(() => store.readPrivateResponse({...ref, storage:'PUBLIC'}), {code:'PRIVATE_RESPONSE_REFERENCE_INVALID'});
  fs.writeFileSync(path.join(root, 'private-web-responses', ref.sha256.slice(7)), 'changed');
  assert.throws(() => store.readPrivateResponse(ref), {code:'PRIVATE_RESPONSE_HASH_MISMATCH'});
});

test('redaction preserves structural lines without exempting real next-line credentials', () => {
  for (const newline of ['\n','\r\n']) {
    for (const label of ['password=', 'api_key:  ', 'Bearer ', 'Basic\t']) {
      for (const fence of ['```','~~~']) {
        const structural = [`${fence}text`, label, fence].join(newline);
        assert.equal(redactForEvidence(structural), structural);
      }
      const masked = redactForEvidence(`${label}${newline}multiline-example`);
      assert.doesNotMatch(masked, /multiline-example/u);
      assert.equal(redactForEvidence(masked), masked);
    }
  }
  const malformed = '{"password":"quoted-example"';
  assert.doesNotMatch(redactForEvidence(malformed), /quoted-example/u);
});
