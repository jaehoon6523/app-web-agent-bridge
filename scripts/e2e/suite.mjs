import fs from 'node:fs';
import path from 'node:path';
import { runOwnedNode } from './platform/process.mjs';
import { repository } from './helpers/process.mjs';
import { skippedTests, summarizeRun } from './summary.mjs';
import { createProgress } from './progress.mjs';

const waveOnly = process.argv.includes('--wave-only');
const requested = process.argv.filter(arg => arg.startsWith('--flow=')).flatMap(arg => arg.slice(7).split(','));
const allFlows = JSON.parse(fs.readFileSync(new URL('./flows.json', import.meta.url), 'utf8'));
for (const id of requested) if (!allFlows.some(flow => flow.id === id)) throw new Error(`Unknown E2E flow: ${id}`);
const flows = allFlows.filter(f => (!waveOnly || f.id !== 'UF-01A') && (!requested.length || requested.includes(f.id)));
if (!flows.length) throw new Error('No E2E profiles selected');
const includeStartup = flows.some(flow => flow.id === 'UF-01A');
const waveIds = flows.filter(flow => flow.id !== 'UF-01A').map(flow => flow.id);
const output = path.join(repository, '.agent-controller/ui-qa');
// Delete only artifacts belonging to this invocation's scope; no stale PASS reuse.
if (!requested.length) fs.rmSync(path.join(output, 'e2e-wave'), { recursive:true, force:true });
else for (const id of waveIds) fs.rmSync(path.join(output, 'e2e-wave', id), { recursive:true, force:true });
if (includeStartup) fs.rmSync(path.join(output, 'e2e-startup'), { recursive:true, force:true });
let gateFailed = false;
const progress = createProgress(flows.map(flow => flow.id), text => process.stdout.write(text));
async function execute(args, { startup = false, tap = false } = {}) {
  let log = '';
  const started = Date.now();
  let lastOutput = started;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    console.log(`[E2E heartbeat] ${startup ? 'UF-01A running' : progress.status()} | elapsed ${Math.floor((now-started)/1000)}s | no child output ${Math.floor((now-lastOutput)/1000)}s`);
  }, 5000);
  heartbeat.unref();
  let code = 1;
  try {
    const result = await runOwnedNode(args, { cwd:repository, env:{...process.env,E2E_FLOW_IDS:waveIds.join(',')},
      timeoutMs:startup ? 120000 : waveIds.length === 1 ? 260000 : 20 * 60 * 1000, isComplete:() => tap && progress.finished,
      onStdout:chunk => { lastOutput = Date.now(); log += chunk; process.stdout.write(chunk); if (tap) progress.consume(chunk); },
      onStderr:chunk => { lastOutput = Date.now(); log += chunk; process.stderr.write(chunk); },
      onDeadline:detail => console.error('[E2E watchdog]', JSON.stringify(detail)),
    });
    code = result.code ?? 1;
  } catch (error) {
    console.error(error.message, error.cleanupError ?? '');
    fs.mkdirSync(output, { recursive:true });
    fs.writeFileSync(path.join(output, startup ? 'startup-runner-failure.json' : 'wave-runner-failure.json'),
      JSON.stringify({code:error.code ?? 'E2E_RUNNER_ERROR',message:error.message,cleanupError:error.cleanupError ?? null},null,2));
  } finally { clearInterval(heartbeat); }
  if (tap) progress.flush();
  if (startup) progress.complete('UF-01A', code === 0 ? 'PASS' : 'FAIL');
  if (code !== 0) gateFailed = true;
  return log;
}
if (includeStartup) await execute(['scripts/e2e/startup.mjs'], { startup:true });
const tap = waveIds.length ? await execute(['--test','--test-reporter=tap','scripts/e2e/wave-suite.mjs'], { tap:true }) : '';
const results = new Map();
for (const flow of flows) {
  const filename = flow.id === 'UF-01A' ? path.join(output, 'e2e-startup/result.json')
    : path.join(output, 'e2e-wave', flow.id, 'result.json');
  try { results.set(flow.id, JSON.parse(fs.readFileSync(filename, 'utf8'))); }
  catch { /* Missing/malformed artifacts are failures, never a skip or PASS. */ }
}
const summary = { environment:{node:process.version,platform:process.platform,arch:process.arch}, scope:requested.length ? `SELECTED PROFILES (${flows.map(flow => flow.id).join(', ')})` : waveOnly ? 'WAVE ONLY (UF-01A not executed)' : 'FULL SUITE',
  ...summarizeRun(flows, results, skippedTests(tap), gateFailed) };
fs.mkdirSync(output, { recursive:true });
fs.writeFileSync(path.join(output, requested.length ? 'e2e-selected-summary.json' : waveOnly ? 'e2e-wave-summary.json' : 'e2e-summary.json'), JSON.stringify(summary, null, 2));
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
