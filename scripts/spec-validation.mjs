import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import {isDeepStrictEqual} from 'node:util';
import {identityMatches, sameUniqueMembers} from './verification-identity.mjs';

const ajv = new Ajv({allErrors:true, strict:true});
const validators = Object.fromEntries(['registry', 'boundary-spec', 'boundary-receipt'].map(name =>
  [name, ajv.compile(JSON.parse(fs.readFileSync(new URL(`../docs/spec/schemas/${name}.schema.json`, import.meta.url), 'utf8')))]));

export function schemaErrors(name, value) {
  const validate = validators[name];
  return validate(value) ? [] : structuredClone(validate.errors);
}

function checkedPath(root, name) {
  if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || name.includes('\\')
      || name.split('/').some(part => !part || part === '..' || part === '.') || name.includes(':')) {
    throw Error('Unsafe repository-relative path: ' + name);
  }
  const resolved = fs.realpathSync(path.resolve(root, name));
  const relative = path.relative(fs.realpathSync(root), resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
      || !fs.statSync(resolved).isFile()) throw Error('Path escapes repository or is not a file: ' + name);
  return resolved;
}

export function validateRegistryAgainstSpecs(root, registry) {
  const errors = [], entries = [];
  const invalid = schemaErrors('registry', registry);
  if (invalid.length) return {entries, errors:[{code:'REGISTRY_SCHEMA_INVALID', details:invalid}]};
  const boundaries = new Set(), files = new Set();
  for (const entry of registry.boundaries) {
    const add = (code, details = {}) => errors.push({code, boundaryId:entry.boundaryId, ...details});
    if (boundaries.has(entry.boundaryId)) add('DUPLICATE_BOUNDARY');
    boundaries.add(entry.boundaryId);
    let spec;
    try {
      const specPath = checkedPath(root, entry.specPath);
      checkedPath(root, entry.setupPath);
      const testPath = checkedPath(root, entry.testPath);
      if (files.has(testPath)) add('DUPLICATE_TEST_PATH');
      files.add(testPath);
      if (!entry.testPath.endsWith('.gen.test.js')) add('INVALID_TEST_PATH');
      spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    } catch (error) { add('PRERUN_FILE_INVALID', {message:error.message}); continue; }
    const specErrors = schemaErrors('boundary-spec', spec);
    if (specErrors.length) { add('SPEC_SCHEMA_INVALID', {details:specErrors}); continue; }
    if (entry.boundaryId !== spec.boundaryId || entry.evidenceType !== spec.evidenceType) add('SPEC_IDENTITY_MISMATCH');
    if (entry.specRevision !== spec.boundaryRevision) add('SPEC_REVISION_MISMATCH');
    const active = spec.transitions.map(t => t.transitionId);
    const retired = (spec.retiredTransitions ?? []).map(t => t.transitionId);
    if (new Set(active).size !== active.length || new Set(retired).size !== retired.length) add('DUPLICATE_TRANSITION');
    if (active.some(id => retired.includes(id))) add('ACTIVE_RETIRED_OVERLAP');
    const retiredInRegistry = entry.transitionIds.filter(id => retired.includes(id));
    if (retiredInRegistry.length) add('PRERUN_RETIRED_IN_REGISTRY', {transitionIds:retiredInRegistry});
    const missingFromRegistry = active.filter(id => !entry.transitionIds.includes(id));
    const extraInRegistry = entry.transitionIds.filter(id => !active.includes(id));
    if (missingFromRegistry.length || extraInRegistry.length) add('PRERUN_TRANSITION_MISMATCH', {missingFromRegistry, extraInRegistry});
    entries.push({entry, spec});
  }
  return {entries, errors};
}

export function validateBoundaryRun(entries, run, {runId, source}) {
  const errors = [];
  const expected = new Map(entries.flatMap(({entry, spec}) => spec.transitions.map(transition =>
    [`T-${entry.boundaryId}-${transition.transitionId}`, {entry, spec, transition}])));
  const scheduled = entries.map(({entry}) => entry.testPath);
  if (!run || run.status !== 'PASS' || run.terminal !== true || !identityMatches(run, {runId, source})) {
    errors.push({code:'SPEC_RUN_INCOMPLETE_OR_SOURCE_CHANGED'});
  }
  if (!sameUniqueMembers(run?.scheduled, scheduled)
      || !sameUniqueMembers(run?.results?.map(item => item.file), scheduled)) errors.push({code:'SPEC_FILE_SET_MISMATCH'});
  const seen = new Set();
  let observedCount = 0;
  for (const item of run?.results ?? []) {
    const summary = item.summary;
    const boundary = entries.find(({entry}) => entry.testPath === item.file);
    const count = boundary?.spec.transitions.length;
    if (!item.pass || item.closure?.code !== 0 || item.closure?.signal !== null || item.summaryStatus !== 'COMPLETE'
        || summary?.completed !== true || summary.plan !== count || summary.topLevel !== count || summary.passed !== count
        || summary.failed !== 0 || summary.skipped?.length !== 0 || summary.todo?.length !== 0
        || summary.boundaryReceiptSchemaVersion !== 1 || summary.boundaryReceiptErrors?.length !== 0
        || !Array.isArray(summary.boundaryReceipts)) {
      errors.push({code:'SPEC_FILE_INCOMPLETE', file:item.file});
    }
    for (const receipt of Array.isArray(summary?.boundaryReceipts) ? summary.boundaryReceipts : []) {
      observedCount++;
      const invalid = schemaErrors('boundary-receipt', receipt);
      if (invalid.length) { errors.push({code:'BOUNDARY_RECEIPT_SCHEMA_INVALID', file:item.file, details:invalid}); continue; }
      const id = receipt.testId;
      if (seen.has(id)) errors.push({code:'DUPLICATE_BOUNDARY_RECEIPT', testId:id});
      seen.add(id);
      const target = expected.get(id);
      if (!target) { errors.push({code:'UNREGISTERED_BOUNDARY_RECEIPT', testId:id}); continue; }
      const {entry, spec, transition} = target;
      if (item.file !== entry.testPath || receipt.boundaryId !== entry.boundaryId
          || receipt.transitionId !== transition.transitionId || receipt.evidenceType !== entry.evidenceType) {
        errors.push({code:'BOUNDARY_RECEIPT_IDENTITY_MISMATCH', testId:id, file:item.file});
      }
      if (receipt.boundaryRevision !== spec.boundaryRevision || receipt.boundaryRevision !== entry.specRevision) {
        errors.push({code:'SPEC_REVISION_MISMATCH', testId:id});
      }
      if (!isDeepStrictEqual(receipt.expectation, transition.expected)) errors.push({code:'RECEIPT_EXPECTATION_MISMATCH', testId:id});
      if (receipt.result !== 'PASS') errors.push({code:'BOUNDARY_NOT_PASS', testId:id, result:receipt.result});
    }
  }
  for (const id of expected.keys()) if (!seen.has(id)) errors.push({code:'MISSING_BOUNDARY_RECEIPT', testId:id});
  return {errors, expectedCount:expected.size, observedCount};
}
