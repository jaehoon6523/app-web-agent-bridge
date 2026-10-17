// Module E: Windows-friendly workflow. ACK and browser observations are independent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {beginDiagnostics} from './latest-run.mjs';
import { runOwnedNode } from './e2e/platform/process.mjs';
import { expectedAckFiles, evaluateAckReceipt } from './ack-windows-result.mjs';
import { environmentRecord, sourceRecord, createExtension } from './diagnostics/environment.mjs';
import { writeReceipt, readReceipt, RELOAD_SCOPE, WINDOWS_SCOPE } from './diagnostics/reload-result.mjs';

const ownPath = fileURLToPath(import.meta.url);
const checkout = path.resolve(path.dirname(ownPath), '..');
export const regressionFiles = ['tests/minimal-native-reload-matrix-v2.test.mjs',
  'tests/direct-mv3-identity.test.mjs', 'tests/ack-windows-result.test.mjs',
  'tests/diagnostic-modules.test.mjs', 'tests/windows-diagnostics.test.mjs'];

export function prepareManual(runDirectory, browser) {
  const directory = path.join(runDirectory, 'manual'), extension = path.join(directory, 'extension'), profile = path.join(directory, 'profile');
  const hashes = createExtension(extension); fs.mkdirSync(profile, { recursive: true });
  return { status: 'AWAITING_MANUAL', completed: false, profile, extension, extensionSourceHashes: hashes,
    requestedConditions: { executable: browser.executablePath ?? null, playwrightLauncher: false, externalCdp: false,
      devToolsUi: true, unsafeDebugging: false },
    launchArgs: [`--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--no-first-run', '--no-default-browser-check', 'chrome://extensions/'],
    steps: [
      `1. Launch only the recorded executable with launchArgs. In that new window, chrome://version must show profile ${profile}.`,
      `2. In that window's chrome://extensions, identify 'Isolated MV3 Reload Probe', version 0.0.1, unpacked path ${extension}; copy its exact extension ID. A missing UI card is not proof of removal.`,
      '3. Open chrome-extension://<that ID>/popup.html in the same window. Open DevTools for THIS popup page (not file://, the management page or another extension). Record location.href, chrome.runtime.id, and typeof chrome.runtime.reload/sendMessage/storage.local.get/storage.local.set.',
      "4. Before reload, await chrome.storage.local.set({matrixSentinel:'retained'}); record await chrome.runtime.sendMessage({type:'matrix.ping'}) and await chrome.storage.local.get('matrixSentinel'). Stop if any initial API/reply is missing.",
      '5. Record the invocation time, execute chrome.runtime.reload() in that verified popup context; record returned/interrupted state. Reopen the same extension popup and record its new ping instanceId and retained storage value.',
      '6. Keep before/after output and errors with this run ID. Preparation alone is AWAITING_MANUAL; this workflow does not import or certify manual results. Close only this isolated window after saving evidence.' ] };
}

export async function runWorkflow({ root = checkout, invocationDirectory = process.cwd(),
  outputDir = process.env.BRIDGE_VERIFICATION_OUTPUT || path.join(root, '.agent-controller'),
  runId = process.env.BRIDGE_VERIFICATION_RUN_ID || crypto.randomUUID(), manual = false,
  regressions = regressionFiles, ackFiles = expectedAckFiles, limitMs = 15 * 60_000,
  runCommand = runOwnedNode } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(runId)) throw Error('INVALID_RUN_ID');
  outputDir = path.resolve(outputDir);
  const lease = beginDiagnostics(outputDir,runId);
  try {
  const runDirectory = path.join(outputDir, 'latest-diagnostics');
  fs.mkdirSync(runDirectory, { recursive: true });
  const latest = path.join(outputDir, 'latest-windows-diagnostics.json');
  const latestLog = path.join(outputDir, 'latest-windows-diagnostics.log');
  const rawLog = path.join(runDirectory, 'workflow.log');
  fs.writeFileSync(rawLog, '');
  // Publishing RUNNING immediately prevents an old PASS being displayed for a new invocation.
  const result = { verificationRunId: runId, scope: WINDOWS_SCOPE, startedAt: new Date().toISOString(),
    terminal: false, execution: 'INCOMPLETE', bridgeFunction: 'UNVERIFIED', stages: [],
    invocationDirectory, root, runDirectory, nextAction: null };
  const save = () => {
    writeReceipt(path.join(runDirectory, 'result.json'), result); writeReceipt(latest, result);
    const temp = `${latestLog}.${process.pid}.tmp`; fs.copyFileSync(rawLog, temp); fs.renameSync(temp, latestLog);
  };
  const log = value => { const line = typeof value === 'string' ? value : JSON.stringify(value);
    fs.appendFileSync(rawLog, line + '\n'); console.log(line); };
  log({ verificationRunId: runId, scope: WINDOWS_SCOPE, startedAt: result.startedAt }); save();
  const deadline = Date.now() + limitMs;
  let browserPath = process.env.UI_BROWSER_EXECUTABLE;
  try {
    const actualRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: invocationDirectory,
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (fs.realpathSync.native(actualRoot) !== fs.realpathSync.native(root)
      || !fs.existsSync(path.join(root, 'extension', 'manifest.json'))) throw Error('WRONG_CHECKOUT');
    result.source = sourceRecord(root);
    if (!browserPath) {
      const priorFile = ['latest-minimal-native-reload-matrix-headed.json', 'latest-minimal-native-reload-matrix-v2.json']
        .map(name => path.join(outputDir, name)).find(fs.existsSync);
      if (priorFile) {
        try { browserPath = JSON.parse(fs.readFileSync(priorFile, 'utf8')).cases?.[0]?.launch?.executablePath;
          result.browserSelection = { from: priorFile }; }
        catch (error) { result.browserSelection = { error: error.message }; }
      }
    }
    result.environment = environmentRecord(browserPath);
    result.requestedConditions = { manual, regressionFiles: regressions, ackFiles,
      browserPath: browserPath ?? null, overallLimitMs: limitMs };
    result.stages.push({ name: 'preconditions', startedAt: result.startedAt, finishedAt: new Date().toISOString(),
      status: result.source.commit && !result.source.error && Object.keys(result.source.hashErrors ?? {}).length === 0 ? 'PASS' : 'UNVERIFIED',
      browserReady: false, browserExecutable: result.environment.browser.status }); save();
    const env = { ...process.env, UI_BROWSER_EXECUTABLE: browserPath ?? '',
      BRIDGE_VERIFICATION_RUN_ID: runId, BRIDGE_VERIFICATION_OUTPUT: outputDir,
      BRIDGE_DIAGNOSTIC_LEASE:lease.token };
    delete env.NODE_TEST_CONTEXT;
    const runStage = async (name, args, stageDirectory) => {
      const stage = { name, startedAt: new Date().toISOString(), status: 'RUNNING', args,
        rawLog: path.join(runDirectory, `${name}.log`) };
      result.stages.push(stage); fs.mkdirSync(stageDirectory, { recursive: true });
      fs.writeFileSync(stage.rawLog, ''); save();
      try {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw Error('OVERALL_DEADLINE');
        stage.closure = await runCommand(args, { cwd: root, env, timeoutMs: remainingMs,
          onStdout: chunk => fs.appendFileSync(stage.rawLog, chunk),
          onStderr: chunk => fs.appendFileSync(stage.rawLog, chunk) });
        stage.exitCode = stage.closure.code;
        stage.status = stage.closure.code === 0 && !stage.closure.signal && !stage.closure.forced ? 'PASS' : 'FAIL';
      } catch (error) { stage.status = 'FAIL'; stage.exitCode = 1;
        stage.error = error.message; stage.cleanupError = error.cleanupError ?? null; }
      stage.finishedAt = new Date().toISOString(); save(); return stage;
    };
    for (const [name, files] of [['regression', regressions], ['ack', ackFiles]]) {
      const stageDirectory = path.join(runDirectory, name);
      const stage = await runStage(name, [ownPath, '--tests', stageDirectory, ...files], stageDirectory);
      const receipt = evaluateAckReceipt({ runId, startedMs: Date.parse(stage.startedAt), endedMs: Date.parse(stage.finishedAt),
        exitCode: stage.exitCode, resultFile: path.join(stageDirectory, 'latest-test-result.json'), expectedFiles: files, requireRunId: true });
      stage.receipt = { ...receipt, source: result.source, environment: result.environment,
        scope: name === 'ack' ? 'bridge-ack-contract' : 'diagnostic-regression' };
      if (receipt.status !== 'PASS') stage.status = 'FAIL';
      writeReceipt(path.join(outputDir, name === 'ack' ? 'latest-ack-windows-result.json' : 'latest-diagnostic-regression.json'), stage.receipt);
      log({ stage: name, status: stage.status, exitCode: stage.exitCode, reason: receipt.reason,
        startedAt: stage.startedAt, finishedAt: stage.finishedAt, rawLog: stage.rawLog });
      save();
    }
    // A failed ACK receipt is not a dependency of the independent reload experiment.
    if (manual) {
      result.manual = prepareManual(runDirectory, result.environment.browser);
      result.stages.push({ name: 'reload', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        status: 'AWAITING_MANUAL', reason: 'PREPARATION_IS_NOT_MANUAL_COMPLETION' });
    } else if (result.environment.browser.status !== 'OBSERVED') {
      result.stages.push({ name: 'reload', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        status: 'BLOCKED', reason: result.environment.browser.error });
    } else {
      const stage = await runStage('reload', [path.join(root, 'scripts/direct-chromium-reload-compare.mjs')], runDirectory);
      stage.receipt = readReceipt(path.join(runDirectory, 'reload', 'result.json'),
        { runId, scope: RELOAD_SCOPE, startedMs: Date.parse(stage.startedAt), exitCode: stage.exitCode });
      if (!stage.receipt.receiptFresh || stage.receipt.result?.execution !== 'COMPLETE') stage.status = 'FAIL';
      log({ stage: 'reload', status: stage.status, exitCode: stage.exitCode, reason: stage.receipt.reason,
        startedAt: stage.startedAt, finishedAt: stage.finishedAt, rawLog: stage.rawLog });
      save();
    }
    result.execution = result.stages.every(stage => stage.status === 'PASS') ? 'COMPLETE' : 'INCOMPLETE';
    result.exitCode = result.execution === 'COMPLETE' ? 0 : manual ? 2 : 1;
    result.nextAction = result.manual ? result.manual.steps :
      result.stages.find(stage => stage.status !== 'PASS')?.name === 'reload' ?
        'Read this run reload receipt: check environment/setup/invocation/window separately. Reuse the recorded browser path; select UI_BROWSER_EXECUTABLE only if missing.' :
        result.execution === 'COMPLETE' ? 'Read per-case functionalRecovery/reloadResult. Native bridge send/response persistence/ACK still need a separate real Windows verification.' :
          'Read the failed stage receipt and raw log; the independent reload result remains available.';
  } catch (error) {
    result.environment ??= environmentRecord(browserPath);
    result.source ??= sourceRecord(root);
    result.error = error.message; result.exitCode = 2;
    result.stages.push({ name: 'preconditions', startedAt: result.startedAt, finishedAt: new Date().toISOString(),
      status: 'FAIL', error: error.message });
    result.nextAction = 'Run in the app-web-agent-bridge checkout containing this script; no tests or browser were launched.';
  }
  result.finishedAt = new Date().toISOString(); result.terminal = true;
  log({ verificationRunId: runId, execution: result.execution, exitCode: result.exitCode,
    bridgeFunction: result.bridgeFunction, nextAction: result.nextAction }); save();
  return result;
  } finally { lease.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === ownPath) {
  if (process.argv[2] === '--tests') {
    const { runFiles } = await import('./run-tests.mjs');
    try {
      const result = await runFiles(process.argv.slice(4).map(file => path.resolve(checkout, file)),
        { directory: process.argv[3] });
      process.exitCode = result.status === 'PASS' ? 0 : 1;
    } catch (error) { console.error(error); process.exitCode = 1; }
  } else {
    const result = await runWorkflow({ manual: process.argv.includes('--manual') });
    process.exitCode = result.exitCode;
  }
}
