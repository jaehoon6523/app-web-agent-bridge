import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function node(args) {
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, {cwd:root, env, encoding:'utf8', timeout:30000, windowsHide:true});
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
function receipts(output) {
  return output.split(/\r?\n/u).filter(line => line.startsWith('__RECEIPT__:'))
    .map(line => JSON.parse(line.slice('__RECEIPT__:'.length)));
}
function runGenerated(out) {
  const reporter = path.join(path.dirname(out), 'reporter.mjs');
  fs.writeFileSync(reporter, `export default async function* (events) {
    for await (const event of events) {
      if (event.type === 'test:diagnostic') yield event.data.message + '\\n';
    }
  }`);
  return node(['--test', '--experimental-test-isolation=none', '--test-reporter=' + pathToFileURL(reporter).href, out]);
}

test('generated receipts cover setup failures without duplicating discovery receipts', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-generator-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const spec = path.join(dir, 'spec.json'), setups = path.join(dir, 'setups.mjs'), out = path.join(dir, 'generated.mjs');
  fs.writeFileSync(spec, JSON.stringify({boundaryId:'FIXTURE', evidenceType:'isolated-contract', transitions:[
    {transitionId:'PASS', expected:{throws:false}},
    {transitionId:'ASSERT-FAIL', expected:{throws:true}},
    {transitionId:'SETUP-FAIL', expected:{throws:false}},
    {transitionId:'DISCOVERY-FAIL', expected:{discovery:true}},
    {transitionId:'DISCOVERY', expected:{discovery:true}},
  ]}));
  fs.writeFileSync(setups, `const ok = async () => ({observed:{threw:false}});
const fail = async () => {throw new Error('CONTRACT_VIOLATION: workerStarts=3, expected 2');};
export const setups = {'PASS':ok, 'ASSERT-FAIL':ok, 'SETUP-FAIL':fail, 'DISCOVERY-FAIL':fail, 'DISCOVERY':ok};`);
  const generated = node(['scripts/gen-tests.mjs', spec, setups, out]);
  assert.equal(generated.status, 0, generated.stderr);
  const run = runGenerated(out);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const rows = receipts(run.stdout);
  assert.equal(rows.length, 5, run.stdout);
  assert.deepEqual(rows.map(row => row.result), ['PASS', 'FAIL', 'FAIL', 'FAIL', 'SPEC_TODO']);
  for (const row of rows.slice(2, 4)) {
    assert.equal(row.observation, null);
    assert.match(row.note, /CONTRACT_VIOLATION: workerStarts=3, expected 2/u);
    assert.equal(row.boundaryId, 'FIXTURE');
  }
});

test('restored Git discovery spec regenerates and captures all six API observations', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-git-discovery-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const specPath = 'docs/spec/contracts/apply/B-APPLY-GIT.discovery.json';
  const spec = JSON.parse(fs.readFileSync(path.join(root, specPath), 'utf8'));
  const out = path.join(dir, 'generated.discovery.js');
  const setups = path.join(dir, 'B-APPLY-GIT.setups.mjs');
  fs.copyFileSync(path.join(root, 'tests/generated/apply/B-APPLY-GIT.setups.mjs'), setups);
  const generated = node(['scripts/gen-tests.mjs', specPath, setups, out]);
  assert.equal(generated.status, 0, generated.stderr);
  const run = runGenerated(out);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const rows = receipts(run.stdout);
  assert.equal(rows.length, 6, run.stdout);
  assert.deepEqual(rows.map(row => row.transitionId), spec.transitions.map(item => item.transitionId));
  for (const row of rows) {
    assert.equal(row.result, 'SPEC_TODO');
    assert.equal(row.observation.discovery, 'API_SHAPE_CAPTURED');
    assert.ok(row.observation.instanceMethods.includes('apply'));
    assert.ok(row.observation.staticMethods.includes('targetApplicationState'));
  }
});
