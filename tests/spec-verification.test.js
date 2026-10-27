import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {validateRegistryAgainstSpecs, validateBoundaryRun} from '../scripts/spec-validation.mjs';
import {checkGeneratedFiles,verifySpec} from '../scripts/verify-spec.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const registry = JSON.parse(fs.readFileSync(path.join(root, 'docs/spec/registry.json'), 'utf8'));

test('verifySpec defaults to fresh standalone IDs and honors an explicit managed directory',async t=>{
  const read=fs.readFileSync;
  t.mock.method(fs,'readFileSync',(file,...args)=>path.resolve(String(file))===path.join(root,'docs/spec/registry.json')
    ? '{"schemaVersion":1,"boundaries":[]}' : read(file,...args));
  const first=await verifySpec(), second=await verifySpec();
  for(const result of [first,second]) {
    const directory=path.join(root,'.agent-controller/spec-runs',result.runId);
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    assert.match(result.runId,/^[a-f0-9-]{36}$/u);assert.equal(result.status,'FAIL');
    assert.equal(JSON.parse(read(path.join(directory,'spec-result.json'),'utf8')).runId,result.runId);
    assert.equal(fs.existsSync(path.join(directory,'latest-test-result.json')),false);
  }
  assert.notEqual(first.runId,second.runId);
  const outputDir=fs.mkdtempSync(path.join(os.tmpdir(),'spec-managed-'));
  t.after(()=>fs.rmSync(outputDir,{recursive:true,force:true}));
  const managed=await verifySpec({runId:'managed-spec-test',outputDir});
  assert.equal(managed.runId,'managed-spec-test');
  assert.equal(JSON.parse(read(path.join(outputDir,'spec-result.json'),'utf8')).runId,managed.runId);
  assert.equal(fs.existsSync(path.join(root,'.agent-controller/spec-runs',managed.runId)),false);
  await assert.rejects(verifySpec({runId:'../escape',outputDir}),/INVALID_RUN_ID/u);
});
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-validation-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  for (const entry of registry.boundaries) for (const key of ['specPath','setupPath','testPath']) {
    const file = path.join(directory, entry[key]);
    fs.mkdirSync(path.dirname(file), {recursive:true});
    fs.copyFileSync(path.join(root, entry[key]), file);
  }
  return {directory, data:structuredClone(registry)};
}

test('registry validates the actual two boundaries and rejects mismatches before execution', t => {
  assert.deepEqual(validateRegistryAgainstSpecs(root, registry).errors, []);
  const {directory, data} = fixture(t);
  const codes = () => validateRegistryAgainstSpecs(directory, data).errors.map(e => e.code);
  data.boundaries[0].specRevision++;
  assert.ok(codes().includes('SPEC_REVISION_MISMATCH'));
  data.boundaries[0].specRevision--;
  data.boundaries[0].transitionIds.pop();
  assert.ok(codes().includes('PRERUN_TRANSITION_MISMATCH'));
  data.boundaries[0].transitionIds.push('B-REVIEW');
  assert.ok(codes().includes('PRERUN_RETIRED_IN_REGISTRY'));
  data.boundaries[0].specPath = '../outside.json';
  assert.ok(codes().includes('PRERUN_FILE_INVALID'));
});

test('pre-run rejects duplicate IDs, unknown expectations and discovery specs', t => {
  const {directory, data} = fixture(t);
  const file = path.join(directory, data.boundaries[0].specPath);
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const check = (spec, code) => {
    fs.writeFileSync(file, JSON.stringify(spec));
    assert.ok(validateRegistryAgainstSpecs(directory, data).errors.some(e => e.code === code));
  };
  const duplicate = structuredClone(original);
  duplicate.transitions.push(duplicate.transitions[0]);
  check(duplicate, 'DUPLICATE_TRANSITION');
  const unknown = structuredClone(original);
  unknown.transitions[0].expected.unchecked = true;
  check(unknown, 'SPEC_SCHEMA_INVALID');
  check({...original, status:'DISCOVERY'}, 'SPEC_SCHEMA_INVALID');
});

function passingRun(entries) {
  const source = {head:'fixture-head', sourceSha256:'fixture-hash'};
  return {verificationRunId:'fixture-run', source, sourceAfter:{...source}, candidateUnchanged:true,
    status:'PASS', terminal:true, scheduled:entries.map(({entry}) => entry.testPath),
    results:entries.map(({entry, spec}) => ({file:entry.testPath, pass:true, summaryStatus:'COMPLETE',
      closure:{code:0, signal:null}, summary:{completed:true, plan:spec.transitions.length,
        topLevel:spec.transitions.length, passed:spec.transitions.length, failed:0, skipped:[], todo:[],
        boundaryReceiptSchemaVersion:1, boundaryReceiptErrors:[], boundaryReceipts:spec.transitions.map(transition => ({
          receiptSchemaVersion:1, testId:`T-${entry.boundaryId}-${transition.transitionId}`,
          boundaryId:entry.boundaryId, transitionId:transition.transitionId, boundaryRevision:spec.boundaryRevision,
          evidenceType:entry.evidenceType, observation:{fixture:true}, expectation:structuredClone(transition.expected), result:'PASS', note:null,
        }))}}))};
}

test('boundary gate rejects missing, duplicate, foreign, stale and unsuccessful receipts', () => {
  const {entries, errors} = validateRegistryAgainstSpecs(root, registry);
  assert.deepEqual(errors, []);
  const baseline = passingRun(entries);
  const context = {runId:baseline.verificationRunId, source:baseline.source};
  assert.deepEqual(validateBoundaryRun(entries, baseline, context), {errors:[], expectedCount:16, observedCount:16});
  const scenarios = [
    ['MISSING_BOUNDARY_RECEIPT', run => run.results[0].summary.boundaryReceipts.pop()],
    ['DUPLICATE_BOUNDARY_RECEIPT', run => run.results[0].summary.boundaryReceipts.push(run.results[0].summary.boundaryReceipts[0])],
    ['UNREGISTERED_BOUNDARY_RECEIPT', run => {run.results[0].summary.boundaryReceipts[0].testId = 'T-B-APPLY-INPUT-B-REVIEW';}],
    ['BOUNDARY_RECEIPT_IDENTITY_MISMATCH', run => {
      const a = run.results[0].summary.boundaryReceipts, b = run.results[1].summary.boundaryReceipts;
      [a[0], b[0]] = [b[0], a[0]];
    }],
    ['BOUNDARY_RECEIPT_IDENTITY_MISMATCH', run => {run.results[0].summary.boundaryReceipts[0].boundaryId = 'OTHER';}],
    ['SPEC_REVISION_MISMATCH', run => {run.results[0].summary.boundaryReceipts[0].boundaryRevision++;}],
    ['RECEIPT_EXPECTATION_MISMATCH', run => {run.results[0].summary.boundaryReceipts[0].expectation = {throws:false};}],
    ['BOUNDARY_NOT_PASS', run => {run.results[0].summary.boundaryReceipts[0].result = 'FAIL';}],
    ['BOUNDARY_NOT_PASS', run => {run.results[0].summary.boundaryReceipts[0].result = 'SPEC_TODO';}],
    ['SPEC_FILE_INCOMPLETE', run => {run.results[0].summary.completed = false;}],
    ['SPEC_FILE_INCOMPLETE', run => {run.results[0].summary.boundaryReceiptErrors = [{code:'BOUNDARY_RECEIPT_JSON_INVALID'}];}],
    ['BOUNDARY_RECEIPT_SCHEMA_INVALID', run => {delete run.results[0].summary.boundaryReceipts[0].observation;}],
    ['SPEC_FILE_SET_MISMATCH', run => {run.scheduled.pop();}],
    ['SPEC_RUN_INCOMPLETE_OR_SOURCE_CHANGED', run => {run.verificationRunId = 'old-run';}],
    ['SPEC_RUN_INCOMPLETE_OR_SOURCE_CHANGED', run => {run.sourceAfter.sourceSha256 = 'changed';}],
  ];
  for (const [code, mutate] of scenarios) {
    const run = structuredClone(baseline); mutate(run);
    assert.ok(validateBoundaryRun(entries, run, context).errors.some(error => error.code === code), code);
  }
});

test('generated freshness comparison detects stale files without rewriting them', t => {
  const {directory, data} = fixture(t);
  const {entries, errors} = validateRegistryAgainstSpecs(directory, data);
  assert.deepEqual(errors, []);
  assert.deepEqual(checkGeneratedFiles(directory, entries), []);
  const filename = path.join(directory, entries[0].entry.testPath);
  fs.appendFileSync(filename, '// stale edit\n');
  const before = fs.readFileSync(filename, 'utf8');
  assert.deepEqual(checkGeneratedFiles(directory, entries), [{code:'GENERATED_OUT_OF_DATE', file:entries[0].entry.testPath}]);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
});
