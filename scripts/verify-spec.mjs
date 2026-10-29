import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runFiles} from './run-tests.mjs';
import {verificationSource} from './verification-source.mjs';
import {atomicWrite} from './mv3-reload-core.mjs';
import {validateRegistryAgainstSpecs, validateBoundaryRun} from './spec-validation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function checkGeneratedFiles(repositoryRoot, entries) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-spec-generated-'));
  const errors = [];
  const normalize = text => text.replace(/\r\n/g, '\n');
  try {
    for (const {entry} of entries) {
      const out = path.join(directory, path.basename(entry.testPath));
      execFileSync(process.execPath, [fileURLToPath(new URL('./gen-tests.mjs', import.meta.url)),
        path.join(repositoryRoot, entry.specPath), path.join(repositoryRoot, entry.setupPath), out],
      {encoding:'utf8', timeout:10000, windowsHide:true, stdio:['ignore','pipe','pipe']});
      if (normalize(fs.readFileSync(out, 'utf8')) !== normalize(fs.readFileSync(path.join(repositoryRoot, entry.testPath), 'utf8'))) {
        errors.push({code:'GENERATED_OUT_OF_DATE', file:entry.testPath});
      }
    }
  } finally { fs.rmSync(directory, {recursive:true, force:true}); }
  return errors;
}

export async function verifySpec({runId = randomUUID(), outputDir} = {}) {
  if(typeof runId!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/u.test(runId)) throw Error('INVALID_RUN_ID');
  const directory = outputDir === undefined ? path.join(root, '.agent-controller', 'spec-runs', runId) : path.resolve(outputDir);
  fs.mkdirSync(directory, {recursive:true});
  const resultPath = path.join(directory, 'spec-result.json');
  const result = {schemaVersion:1, runId, status:'RUNNING', startedAt:new Date().toISOString(),
    finishedAt:null, node:process.version, platform:process.platform, expectedCount:null, observedCount:0, errors:[]};
  const save = () => atomicWrite(resultPath, result);
  save();
  try {
    result.source = verificationSource(root);
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'docs/spec/registry.json'), 'utf8'));
    const preflight = validateRegistryAgainstSpecs(root, registry);
    result.errors.push(...preflight.errors);
    if (!result.errors.length) {
      result.expectedCount = preflight.entries.reduce((sum, {spec}) => sum + spec.transitions.length, 0);
      result.errors.push(...checkGeneratedFiles(root, preflight.entries));
    }
    if (!result.errors.length) {
      result.testResultPath = path.join(directory, 'latest-test-result.json');
      save();
      const run = await runFiles(preflight.entries.map(({entry}) => path.join(root, entry.testPath)),
        {directory, verificationRunId:runId});
      result.sourceAfter = run.sourceAfter;
      const validation = validateBoundaryRun(preflight.entries, run, {runId, source:result.source});
      result.observedCount = validation.observedCount;
      result.errors.push(...validation.errors);
    }
    result.status = result.errors.length ? 'FAIL' : 'PASS';
  } catch (error) {
    result.status = 'FAIL';
    result.errors.push({code:error.code ?? 'SPEC_VERIFICATION_ERROR', message:error.message});
  } finally {
    result.finishedAt = new Date().toISOString();
    result.exitCode = result.status === 'PASS' ? 0 : 1;
    save();
  }
  console.log('SPEC_GATE ' + JSON.stringify({status:result.status, expectedCount:result.expectedCount,
    observedCount:result.observedCount, errors:result.errors, resultPath}));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = (await verifySpec({runId:process.env.BRIDGE_VERIFICATION_RUN_ID,
    outputDir:process.env.BRIDGE_VERIFICATION_OUTPUT})).exitCode; }
  catch (error) { console.error(error); process.exitCode = 1; }
}
