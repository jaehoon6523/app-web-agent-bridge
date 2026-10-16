import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runWorkflow, prepareManual } from '../scripts/windows-diagnostics.mjs';
import { writeReceipt, RELOAD_SCOPE } from '../scripts/diagnostics/reload-result.mjs';
import { evaluateAckReceipt } from '../scripts/ack-windows-result.mjs';
import { runOwnedNode } from '../scripts/e2e/platform/process.mjs';

const root = path.resolve('.');
function temp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-diagnostics-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function withBrowser(t) {
  const old = process.env.UI_BROWSER_EXECUTABLE; process.env.UI_BROWSER_EXECUTABLE = process.execPath;
  t.after(() => { if (old === undefined) delete process.env.UI_BROWSER_EXECUTABLE; else process.env.UI_BROWSER_EXECUTABLE = old; });
}
function writeTestReceipt(file, record) {
  fs.writeFileSync(file, JSON.stringify(record));
  // The fake process owns both its declared timestamps and its filesystem timestamp.
  // Keep them in the same clock domain without relaxing production freshness checks.
  const finished = new Date(record.finishedAt);
  fs.utimesSync(file, finished, finished);
}
function testBoundary({ ackFails = false, omitAck = false, omitReload = false, wrongScope = false, incompleteReload = false } = {}) {
  const calls = [];
  return { calls, run: async (args, options) => {
    if (args[1] === '--tests') {
      const directory = args[2], files = args.slice(3), ack = path.basename(directory) === 'ack';
      calls.push(ack ? 'ack' : 'regression');
      const code = ack && ackFails ? 1 : 0;
      if (!(ack && omitAck)) {
        fs.mkdirSync(directory, { recursive: true });
        writeTestReceipt(path.join(directory, 'latest-test-result.json'), {
          verificationRunId: options.env.BRIDGE_VERIFICATION_RUN_ID, startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(), terminal: true, exitCode: code, status: code ? 'FAIL' : 'PASS',
          scheduled: files, results: files.map(file => ({ file, pass: !code, summaryStatus: 'COMPLETE' })) });
      }
      return { code, signal: null, forced: false };
    }
    calls.push('reload');
    if (!omitReload) writeReceipt(path.join(options.env.BRIDGE_VERIFICATION_OUTPUT, 'latest-diagnostics', 'reload', 'result.json'), {
      verificationRunId: options.env.BRIDGE_VERIFICATION_RUN_ID, scope: wrongScope ? 'wrong' : RELOAD_SCOPE,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), terminal: true, exitCode: 0,
      execution: incompleteReload ? 'INCOMPLETE' : 'COMPLETE',
      requestedConditions: [{id:'A',unsafe:false},{id:'B',unsafe:true}],
      cases:['A','B'].map(id=>({id,verificationRunId:options.env.BRIDGE_VERIFICATION_RUN_ID,scope:RELOAD_SCOPE})) });
    return { code: 0, signal: null, forced: false };
  } };
}

test('E: ACK failure does not suppress the independent reload stage; separate receipts survive', async t => {
  withBrowser(t); const outputDir = temp(t), io = testBoundary({ ackFails: true });
  const result = await runWorkflow({ outputDir, runId: crypto.randomUUID(), runCommand: io.run });
  assert.deepEqual(io.calls, ['regression', 'ack', 'reload']);
  assert.equal(result.stages.find(x => x.name === 'ack').status, 'FAIL');
  assert.equal(result.stages.find(x => x.name === 'reload').status, 'PASS');
  assert.equal(result.bridgeFunction, 'UNVERIFIED'); assert.equal(result.exitCode, 1);
});
test('E: missing ACK result explicitly fails while independent reload proceeds', async t => {
  withBrowser(t); const io = testBoundary({ omitAck: true });
  const result = await runWorkflow({ outputDir: temp(t), runId: crypto.randomUUID(), runCommand: io.run });
  assert.equal(result.stages.find(x => x.name === 'ack').receipt.reason, 'RESULT_NOT_CREATED');
  assert.ok(io.calls.includes('reload'));
});
for (const [name, config, reason] of [['missing', { omitReload: true }, 'RESULT_NOT_CREATED'],
  ['wrong scope', { wrongScope: true }, 'RESULT_SCOPE_MISMATCH']]) {
  test(`E: ${name} reload receipt cannot pass on exit 0`, async t => {
    withBrowser(t); const outputDir = temp(t), io = testBoundary(config);
    const result = await runWorkflow({ outputDir, runId: crypto.randomUUID(), runCommand: io.run });
    const stage = result.stages.find(x => x.name === 'reload');
    assert.equal(stage.status, 'FAIL'); assert.equal(stage.receipt.reason, reason);
  });
}
test('E: a prior PASS cannot be reused when new browser result was never generated', async t => {
  withBrowser(t); const outputDir = temp(t), io = testBoundary({ omitReload: true });
  writeReceipt(path.join(outputDir, 'latest-diagnostics', 'reload', 'result.json'), { verificationRunId: 'old-run', scope: RELOAD_SCOPE,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), terminal: true, exitCode: 0, execution: 'COMPLETE' });
  const result = await runWorkflow({ outputDir, runId: 'new-run', runCommand: io.run });
  assert.equal(result.stages.find(x => x.name === 'reload').receipt.reason, 'RESULT_NOT_CREATED');
  assert.equal(fs.existsSync(path.join(outputDir,'diagnostic-runs')),false);
  const latest = JSON.parse(fs.readFileSync(path.join(outputDir, 'latest-windows-diagnostics.json')));
  assert.equal(latest.verificationRunId, 'new-run'); assert.equal(latest.execution, 'INCOMPLETE');
});
test('E: wrong execution location produces this run precondition failure and launches nothing', async t => {
  const location = temp(t); let calls = 0;
  const result = await runWorkflow({ invocationDirectory: location, outputDir: temp(t), runId: crypto.randomUUID(),
    runCommand: async () => { calls++; } });
  assert.equal(result.exitCode, 2); assert.equal(calls, 0);
  assert.equal(result.stages[0].name, 'preconditions'); assert.equal(result.stages[0].status, 'FAIL');
  assert.equal(result.terminal, true);
});
test('E: manual preparation provides exact isolated profile/page instructions, never manual completion', async t => {
  withBrowser(t); const outputDir = temp(t), io = testBoundary();
  const result = await runWorkflow({ outputDir, runId: crypto.randomUUID(), manual: true, runCommand: io.run });
  assert.deepEqual(io.calls, ['regression', 'ack']);
  assert.equal(result.manual.status, 'AWAITING_MANUAL'); assert.equal(result.manual.completed, false);
  assert.equal(result.execution, 'INCOMPLETE'); assert.equal(result.exitCode, 2);
  assert.ok(result.manual.steps.some(x => x.includes(result.manual.profile)));
  assert.ok(result.manual.steps.some(x => x.includes('chrome.runtime.id')));
  assert.equal(result.manual.requestedConditions.externalCdp, false);
  assert.equal(result.manual.requestedConditions.devToolsUi, true);
  const second = prepareManual(temp(t), { executablePath: process.execPath });
  assert.notEqual(result.manual.profile, second.profile);
});
test('E: overall deadline failure remains explicit and does not fabricate completed stages', async t => {
  withBrowser(t); let calls = 0;
  const result = await runWorkflow({ outputDir: temp(t), runId: crypto.randomUUID(), limitMs: 0,
    runCommand: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(result.execution, 'INCOMPLETE');
  assert.equal(result.stages.find(x => x.name === 'ack').error, 'OVERALL_DEADLINE');
  assert.equal(result.stages.find(x => x.name === 'reload').error, 'OVERALL_DEADLINE');
});
test('E: actual nested test runner emits a run-bound, terminal exact-scope ACK receipt', async t => {
  const d = temp(t), runId = crypto.randomUUID();
  // A real runFile/reporter/process-close path, independent of fake command boundaries above.
  const filename = path.join(d, 'contract.test.mjs');
  fs.writeFileSync(filename, "import test from 'node:test';import assert from 'node:assert/strict';test('actual fixture',()=>assert.equal(1+1,2));\n");
  const start = Date.now(); const env = { ...process.env, BRIDGE_VERIFICATION_RUN_ID: runId }; delete env.NODE_TEST_CONTEXT;
  const closed = await runOwnedNode([path.join(root, 'scripts/windows-diagnostics.mjs'), '--tests', d, filename],
    { cwd: root, env, timeoutMs: 15000 });
  assert.equal(closed.code, 0);
  const resultFile = path.join(d, 'latest-test-result.json');
  const expectedFiles = [path.relative(root, filename).split(path.sep).join('/')];
  const receipt = evaluateAckReceipt({ runId, startedMs: start, exitCode: 0, resultFile, expectedFiles, requireRunId: true });
  assert.equal(receipt.status, 'PASS', JSON.stringify(receipt));
  assert.equal(evaluateAckReceipt({ runId: 'other', startedMs: start, exitCode: 0, resultFile, expectedFiles,
    requireRunId: true }).reason, 'RESULT_RUN_MISMATCH');
});

// On Windows use its actual Windows PowerShell; a Linux pwsh run is separately
// attributable via PWSH_EXECUTABLE and does not certify Windows execution.
if (process.platform === 'win32' || process.env.PWSH_EXECUTABLE) {
  test('E: real PowerShell control flow rejects missing/stale/scope/termination results and opens current log/JSON', async () => {
    const { spawnSync } = await import('node:child_process');
    const executable = process.env.PWSH_EXECUTABLE || 'powershell.exe';
    // Override the inherited process policy only for this isolated harness, never the registry.
    const run = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(root, 'tests/diagnostics/windows-workflow.ps1'), '-TargetScript',
      path.join(root, 'scripts/run-windows-direct-reload.ps1'), '-Root', root],
    { cwd: root, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, PSExecutionPolicyPreference: 'Restricted', POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
    assert.equal(run.error, undefined); assert.equal(run.status, 0, run.stdout + run.stderr);
    for (const name of ['normal', 'missing', 'stale', 'scope', 'nonterminal', 'exitMismatch', 'generation', 'manual', 'wrongLocation'])
      assert.match(run.stdout, new RegExp(`PS_WORKFLOW_CASE ${name} PASS`));
  });
}

test('E: exit 0 with an incomplete observation receipt is not workflow completion', async t => {
  withBrowser(t); const io = testBoundary({ incompleteReload: true });
  const result = await runWorkflow({ outputDir: temp(t), runId: crypto.randomUUID(), runCommand: io.run });
  assert.equal(result.stages.find(x => x.name === 'reload').status, 'FAIL');
  assert.equal(result.execution, 'INCOMPLETE');
});

test('E: malformed ACK JSON is a failed receipt, not an exception suppressing browser diagnosis', async t => {
  withBrowser(t); const outputDir = temp(t), io = testBoundary();
  const runCommand = async (args, options) => {
    const outcome = await io.run(args, options);
    if (args[1] === '--tests' && path.basename(args[2]) === 'ack')
      fs.writeFileSync(path.join(args[2], 'latest-test-result.json'), 'null');
    return outcome;
  };
  const result = await runWorkflow({ outputDir, runId: crypto.randomUUID(), runCommand });
  assert.equal(result.stages.find(x => x.name === 'ack').receipt.reason, 'INVALID_RESULT_JSON');
  assert.ok(io.calls.includes('reload'));
});

test('E: sequential invocations retain only current logs and cannot reuse the previous PASS', async t => {
  withBrowser(t); const outputDir = temp(t), firstIO = testBoundary();
  const first = await runWorkflow({outputDir,runId:'first',runCommand:firstIO.run});
  assert.equal(first.execution,'COMPLETE');
  const marker = path.join(outputDir,'latest-diagnostics/previous-only.log'); fs.writeFileSync(marker,'old');
  const io = testBoundary({omitReload:true});
  const second = await runWorkflow({outputDir,runId:'second',runCommand:async (args,options) => {
    const current = JSON.parse(fs.readFileSync(path.join(outputDir,'latest-windows-diagnostics.json'),'utf8'));
    assert.equal(current.verificationRunId,'second'); assert.equal(current.terminal,false);
    assert.equal(fs.existsSync(marker),false); return io.run(args,options);
  }});
  assert.equal(second.execution,'INCOMPLETE');
  assert.equal(second.stages.find(stage => stage.name === 'reload').receipt.reason,'RESULT_NOT_CREATED');
  assert.equal(fs.existsSync(path.join(outputDir,'diagnostic-runs')),false);
  assert.equal(fs.readFileSync(path.join(outputDir,'latest-windows-diagnostics.log'),'utf8').includes('"verificationRunId":"first"'),false);
});

test('E: overlapping workflows are rejected without deleting the active run evidence', async t => {
  withBrowser(t); const outputDir = temp(t), io = testBoundary(); let unblock, entered;
  const waiting = new Promise(resolve => { unblock = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const first = runWorkflow({outputDir,runId:'owner',runCommand:async (args,options) => {
    entered(); await waiting; return io.run(args,options);
  }});
  await started;
  const before = fs.readFileSync(path.join(outputDir,'latest-windows-diagnostics.json'),'utf8');
  try {
    await assert.rejects(runWorkflow({outputDir,runId:'other',runCommand:io.run}),{code:'LATEST_RUN_BUSY'});
    assert.equal(fs.readFileSync(path.join(outputDir,'latest-windows-diagnostics.json'),'utf8'),before);
  } finally { unblock(); await first; }
});

test('E: fixture timestamps stay current when the filesystem initial timestamp lags behind the stage', async t => {
  withBrowser(t);
  const old = new Date(Date.now() - 60_000), write = fs.writeFileSync;
  let lagged = 0;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    const result = write(file, ...args);
    if (typeof file === 'string' && path.basename(file) === 'latest-test-result.json') {
      fs.utimesSync(file, old, old); lagged++;
    }
    return result;
  });
  const io = testBoundary();
  const result = await runWorkflow({outputDir:temp(t),runId:crypto.randomUUID(),runCommand:io.run});
  assert.equal(lagged, 2);
  assert.equal(result.execution, 'COMPLETE', JSON.stringify(result.stages));
  for (const name of ['regression', 'ack']) {
    const stage = result.stages.find(item => item.name === name);
    assert.equal(stage.status, 'PASS');
    assert.ok(stage.receipt.resultMtimeMs >= Date.parse(stage.startedAt));
  }
});

test('E: a matching receipt made stale after creation is still rejected while reload proceeds', async t => {
  withBrowser(t); const io = testBoundary(), old = new Date(Date.now() - 60_000);
  const runCommand = async (args, options) => {
    const result = await io.run(args, options);
    if (args[1] === '--tests' && path.basename(args[2]) === 'ack') {
      const file = path.join(args[2], 'latest-test-result.json');
      fs.utimesSync(file, old, old);
    }
    return result;
  };
  const result = await runWorkflow({outputDir:temp(t),runId:crypto.randomUUID(),runCommand});
  const ack = result.stages.find(item => item.name === 'ack');
  assert.equal(ack.receipt.reason, 'STALE_RESULT_REJECTED');
  assert.equal(ack.receipt.receiptFresh, false);
  assert.equal(result.execution, 'INCOMPLETE');
  assert.ok(io.calls.includes('reload'));
});
