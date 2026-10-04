import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repository } from './helpers/process.mjs';
import { skippedTests, summarizeRun } from './summary.mjs';
import { createProgress } from './progress.mjs';

const waveOnly = process.argv.includes('--wave-only');
const flows = JSON.parse(fs.readFileSync(new URL('./flows.json', import.meta.url), 'utf8'))
  .filter(f => !waveOnly || f.id !== 'UF-01A');
const output = path.join(repository, '.agent-controller/ui-qa');
// Delete only artifacts belonging to this invocation's scope; no stale PASS reuse.
fs.rmSync(path.join(output, 'e2e-wave'), { recursive:true, force:true });
if (!waveOnly) fs.rmSync(path.join(output, 'e2e-startup'), { recursive:true, force:true });
let gateFailed = false;
const progress = createProgress(flows.map(flow => flow.id), text => process.stdout.write(text));
async function execute(args, { startup = false, tap = false } = {}) {
  let log = '';
  const started = Date.now();
  let lastOutput = started;
  const child = spawn(process.execPath, args, { cwd:repository, stdio:['ignore','pipe','pipe'] });
  const heartbeat = setInterval(() => {
    const now = Date.now();
    console.log(`[E2E heartbeat] ${startup ? 'UF-01A running' : progress.status()} | elapsed ${Math.floor((now-started)/1000)}s | no child output ${Math.floor((now-lastOutput)/1000)}s | child PID ${child.pid ?? 'unavailable'}`);
  }, 5000);
  heartbeat.unref();
  child.stdout.on('data', chunk => { lastOutput = Date.now(); log += chunk; process.stdout.write(chunk); if (tap) progress.consume(chunk); });
  child.stderr.on('data', chunk => { lastOutput = Date.now(); log += chunk; process.stderr.write(chunk); });
  const code = await new Promise(resolve => {
    child.once('error', error => { process.stderr.write(`${error.message}\n`); resolve(1); });
    child.once('close', code => resolve(code ?? 1));
  });
  clearInterval(heartbeat);
  if (tap) progress.flush();
  if (startup) progress.complete('UF-01A', code === 0 ? 'PASS' : 'FAIL');
  if (code !== 0) gateFailed = true;
  return log;
}
if (!waveOnly) await execute(['scripts/e2e/startup.mjs'], { startup:true });
const tap = await execute(['--test','--test-reporter=tap','scripts/e2e/wave-suite.mjs'], { tap:true });
const results = new Map();
for (const flow of flows) {
  const filename = flow.id === 'UF-01A' ? path.join(output, 'e2e-startup/result.json')
    : path.join(output, 'e2e-wave', flow.id, 'result.json');
  try { results.set(flow.id, JSON.parse(fs.readFileSync(filename, 'utf8'))); }
  catch { /* Missing/malformed artifacts are failures, never a skip or PASS. */ }
}
const summary = { scope:waveOnly ? 'WAVE ONLY (UF-01A not executed)' : 'FULL SUITE',
  ...summarizeRun(flows, results, skippedTests(tap), gateFailed) };
fs.mkdirSync(output, { recursive:true });
fs.writeFileSync(path.join(output, waveOnly ? 'e2e-wave-summary.json' : 'e2e-summary.json'), JSON.stringify(summary, null, 2));
const lines = [`Scope: ${summary.scope}`, `SPEC W1-4 COMPLETE     ${summary.specComplete}`,
  `FULL RUNNABLE          ${summary.fullRunnablePassed} (observed profile PASS)`,
  `INITIAL SPINE PASS     ${summary.initialSpinePassed} (blocked profiles only)`,
  `CONTINUATION BLOCKED   ${summary.continuationBlocked}`,
  `FAIL                   ${summary.failed}`, `UNEXPECTED SKIP        ${summary.unexpectedSkips}`,
  `Verdict: ${summary.verdict}`];
console.log('\n' + lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  '\n### E2E execution coverage\n\n```text\n'+lines.join('\n')+'\n```\n');
if (summary.failed || summary.unexpectedSkips) process.exitCode = 1;
