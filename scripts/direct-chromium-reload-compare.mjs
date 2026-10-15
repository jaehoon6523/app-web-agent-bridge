// Module E: wire A (owned processes), B/C (collection) and D (pure verdicts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {beginDiagnostics} from './latest-run.mjs';
import { superviseTrial } from './mv3-reload-core.mjs';
import { sourceRecord, environmentRecord } from './diagnostics/environment.mjs';
import { runCase } from './diagnostics/reload-observer.mjs';
import { classifyReload, classifyComparison, writeReceipt, RELOAD_SCOPE } from './diagnostics/reload-result.mjs';

const ownPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(ownPath), '..');
const specs = [{ id: 'A', unsafe: false }, { id: 'B', unsafe: true }];

export async function runComparison({ outputDir = process.env.BRIDGE_VERIFICATION_OUTPUT || path.join(root, '.agent-controller'),
  verificationRunId = process.env.BRIDGE_VERIFICATION_RUN_ID || crypto.randomUUID() } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(verificationRunId)) throw Error('INVALID_RUN_ID');
  outputDir = path.resolve(outputDir);
  const lease = beginDiagnostics(outputDir,verificationRunId,process.env.BRIDGE_DIAGNOSTIC_LEASE);
  try {
  const runDirectory = path.join(outputDir, 'latest-diagnostics', 'reload');
  fs.rmSync(runDirectory,{recursive:true,force:true});
  fs.mkdirSync(runDirectory, { recursive: true });
  const receiptPath = path.join(outputDir, 'latest-direct-chromium-reload.json');
  const context = { verificationRunId, source: sourceRecord(root), environment: environmentRecord(), rawDirectory: runDirectory };
  const contextPath = path.join(runDirectory, 'context.json');
  const result = { ...context, scope: RELOAD_SCOPE, terminal: false, startedAt: new Date().toISOString(),
    requestedConditions: specs, execution: 'INCOMPLETE', bridgeFunction: 'UNVERIFIED',
    cleanupStatus: 'UNCONFIRMED', childExecutionStatus: 'UNCONFIRMED', browserExecutionStatus: 'UNCONFIRMED',
    comparisonValidity: 'UNVERIFIED', priorComparisonValidity: 'UNVERIFIED', cases: [] };
  const save = () => { writeReceipt(path.join(runDirectory, 'result.json'), result); writeReceipt(receiptPath, result); };
  save(); writeReceipt(contextPath, { ...context, scope: RELOAD_SCOPE, startedAt: result.startedAt });
  try {
    if (context.environment.browser.status !== 'OBSERVED') throw Error(context.environment.browser.error);
    const previous = ['latest-minimal-native-reload-matrix-headed.json', 'latest-minimal-native-reload-matrix-v2.json']
      .map(name => path.join(outputDir, name)).find(fs.existsSync);
    if (previous) {
      try {
        const prior = JSON.parse(fs.readFileSync(previous, 'utf8')), ref = prior.cases?.[0];
        const pinned = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
        result.previousPlaywright = { receiptPath: previous, runId: prior.verificationRunId ?? null,
          gitHead: prior.gitHead ?? null, executablePath: ref?.launch?.executablePath ?? null,
          executableSha256: ref?.launch?.executableSha256 ?? null,
          executableMatch: ref?.launch?.executableSha256 ? ref.launch.executableSha256 === pinned.environment.browser.sha256 : null,
          headlessMatch: typeof ref?.launch?.headless === 'boolean' ? ref.launch.headless === (process.env.DIRECT_HEADLESS === '1') : null,
          fixtureMatch: null, fixtureHashes: ref?.extensionSourceHashes ?? null,
          topologyDifference: 'Prior Playwright launcher; current Node spawn + external CDP. DevTools UI is not inferred.' };
      } catch (error) { result.previousReceiptError = error.message; }
    }
    for (const spec of specs) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `direct-mv3-${spec.id}-`));
      const collected = await superviseTrial({ command: process.execPath,
        args: [ownPath, '--child', spec.id, scratch, contextPath], cwd: root,
        env: { ...process.env, BRIDGE_VERIFICATION_RUN_ID: verificationRunId },
        snapshotFile: path.join(scratch, 'observation.json'), profile: path.join(scratch, 'profile'), scratch,
        expectedRunId: verificationRunId, expectedScope: RELOAD_SCOPE, limitMs: 45_000,
        stdoutFile: path.join(runDirectory, `child-${spec.id}.log`) });
      const trial = { ...collected, id: spec.id, verificationRunId, scope: RELOAD_SCOPE, ...classifyReload(collected) };
      result.cases.push(trial);
      if (result.previousPlaywright?.fixtureHashes && trial.extensionSourceHashes) {
        result.previousPlaywright.fixtureMatch = Object.entries(trial.extensionSourceHashes)
          .every(([file, hash]) => result.previousPlaywright.fixtureHashes[file] === hash);
      }
      save();
      console.log('DIRECT_MV3_TRIAL ' + JSON.stringify({ verificationRunId, id: spec.id, execution: trial.execution,
        functionalRecovery: trial.functionalRecovery, reloadResult: trial.reloadResult,
        childExecution: trial.childExecution.status, cleanup: trial.cleanup.status, comparisonValidity: trial.comparisonValidity }));
      if (trial.cleanup.status !== 'PASS') { result.stoppedReason = 'OWNED_PROCESS_CLEANUP_NOT_NORMAL'; break; }
    }
    Object.assign(result, classifyComparison(result.cases, result.previousPlaywright));
  } catch (error) { result.error = error.message; result.exitCode = 2; }
  result.finishedAt = new Date().toISOString(); result.terminal = true; save();
  console.log('DIRECT_MV3_RESULT ' + JSON.stringify({ verificationRunId, execution: result.execution,
    exitCode: result.exitCode, receiptPath, bridgeFunction: result.bridgeFunction }));
  return result;
  } finally { lease.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === ownPath) {
  if (process.argv[2] === '--child') {
    const spec = specs.find(x => x.id === process.argv[3]);
    if (!spec || !process.argv[4] || !process.argv[5]) throw Error('Invalid direct-child arguments');
    const context = JSON.parse(fs.readFileSync(process.argv[5], 'utf8'));
    if (context.verificationRunId !== process.env.BRIDGE_VERIFICATION_RUN_ID) throw Error('CHILD_RUN_ID_MISMATCH');
    await runCase(spec, process.argv[4], context);
  } else {
    const result = await runComparison();
    process.exitCode = result.exitCode;
  }
}
