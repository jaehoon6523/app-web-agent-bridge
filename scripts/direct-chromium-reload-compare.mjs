// Independent Windows Chromium MV3 reload comparison (no Playwright).
// Diagnostic-only: does not modify product extension, delivery ownership, or ACK code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicWrite, superviseTrial } from './mv3-reload-core.mjs';
import { backgroundCandidates, discoverMinimalExtension, verifiedReloadIdentity, assessDirectReload } from './direct-mv3-identity.mjs';

const ownPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(ownPath), '..');
const outputDir = path.resolve(process.env.BRIDGE_VERIFICATION_OUTPUT || path.join(root, '.agent-controller'));
const receiptPath = path.join(outputDir, 'latest-direct-chromium-reload.json');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cases = [{ id: 'A', unsafe: false }, { id: 'B', unsafe: true }];
const ownHash = sha256(ownPath);
const coreHash = sha256(fileURLToPath(new URL('./mv3-reload-core.mjs', import.meta.url)));
const identityHash = sha256(fileURLToPath(new URL('./direct-mv3-identity.mjs', import.meta.url)));
const verificationRunId = process.env.BRIDGE_VERIFICATION_RUN_ID || crypto.randomUUID();
const extensionHashExpected = {
  'manifest.json': '414efabb73898dea10b89de5fde7505607c2812a5ae8f864f6b72c6e6bd54081',
  'background.js': '1e24fdc16b8f6d3ef3e7ae384f4309f36aae649d9fb74dc1c7002b78891be165',
  'popup.html': '4d200ad69b85c8cf33c77edbb5e2f2bed98055c7cf6f2663accdeb6e59720910',
};
// Baseline fixture bytes are pinned to the A–D experiment from e331ea8.

function createExtension(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    'manifest.json': JSON.stringify({
      manifest_version: 3, name: 'Isolated MV3 Reload Probe', version: '0.0.1',
      permissions: ['storage'],
      background: { service_worker: 'background.js', type: 'module' },
      action: { default_popup: 'popup.html' },
    }, null, 2),
    'background.js': `const instanceId=crypto.randomUUID();\nchrome.runtime.onMessage.addListener((msg,_sender,reply)=>{\nif(msg?.type!=='matrix.ping')return false;reply({ok:true,instanceId});return false;\n});\nexport {};\n`,
    'popup.html': '<!doctype html><html><head><meta charset="utf-8"><title>Matrix</title></head><body><h1 id="matrix">MV3_MATRIX_READY</h1></body></html>',
  };
  const hashes = {};
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.writeFileSync(target, value);
    hashes[name] = sha256(target);
    if (hashes[name] !== extensionHashExpected[name]) {
      throw new Error(`FIXTURE_HASH_MISMATCH ${name}: ${hashes[name]} expected ${extensionHashExpected[name]}`);
    }
  }
  return hashes;
}

function findExecutable() {
  const fromEnv = process.env.UI_BROWSER_EXECUTABLE;
  if (!fromEnv) throw new Error('UI_BROWSER_EXECUTABLE must identify the exact previously tested Chromium executable');
  const executable = path.resolve(fromEnv);
  if (!fs.existsSync(executable)) throw new Error(`Browser executable not found: ${executable}`);
  return executable;
}
function getWindowsCommandLine(pid) {
  if (process.platform !== 'win32') return { status: 'UNSUPPORTED', commandLine: null };
  const cmd = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`;
  try {
    const str = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { encoding: 'utf8', timeout: 6000, windowsHide: true }).trim();
    return { status: str ? 'OBSERVED' : 'UNVERIFIED', commandLine: str || null };
  } catch (error) { return { status: 'UNVERIFIED', error: error.message, commandLine: null }; }
}

async function until(check, budgetMs, reason) {
  const end = Date.now() + budgetMs;
  let lastError;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; }
    catch (error) { lastError = error.message; }
    await sleep(120);
  }
  throw new Error(`${reason}${lastError ? ': ' + lastError : ''}`);
}
async function waitForFile(file, budgetMs) {
  return until(() => {
    if (!fs.existsSync(file)) return null;
    const s = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/u);
    return s.length >= 2 && /^\d+$/u.test(s[0]) && s[1].startsWith('/') ? s : null;
  }, budgetMs, 'CHROME_CDP_ENDPOINT_NOT_CREATED');
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    this.ws.addEventListener('message', event => {
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (packet.id !== undefined) {
        const waiter = this.pending.get(packet.id);
        if (!waiter) return;
        this.pending.delete(packet.id);
        clearTimeout(waiter.timer);
        if (packet.error) waiter.reject(new Error(`${waiter.method}: ${packet.error.message}`));
        else waiter.resolve(packet.result ?? {});
      } else for (const fn of this.listeners) fn(packet);
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('CDP_SOCKET_CLOSED')); }
      this.pending.clear();
    });
  }
  async ready() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP_CONNECTION_TIMEOUT')), 5000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_CONNECTION_ERROR')); }, { once: true });
    });
  }
  onEvent(fn) { this.listeners.add(fn); }
  send(method, params = {}, sessionId = undefined, timeoutMs = 3000) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP_NOT_OPEN'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP_TIMEOUT ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.ws.close(); }
}

async function openPage(cdp, url, options = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  const { errorText } = await cdp.send('Page.navigate', { url }, sessionId, 4000);
  if (errorText) {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    throw new Error(`NAVIGATION_FAILED ${errorText}`);
  }
  return { targetId, sessionId, url };
}
async function evaluate(cdp, page, expression, timeoutMs = 2200) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  }, page.sessionId, timeoutMs);
  if (result.exceptionDetails) throw new Error(`RUNTIME_EXCEPTION ${result.exceptionDetails.text}`);
  return result.result?.value;
}
async function closePage(cdp, page) {
  if (page) await cdp.send('Target.closeTarget', { targetId: page.targetId }, undefined, 1500).catch(() => {});
}
async function extensionUi(cdp, id) {
  let p;
  try {
    p = await openPage(cdp, 'chrome://extensions/');
    return await until(async () => {
      const result = await evaluate(cdp, p, `(() => {
        const manager = document.querySelector('extensions-manager');
        const list = manager?.shadowRoot?.querySelector('extensions-item-list');
        const items = [...(list?.shadowRoot?.querySelectorAll('extensions-item') || [])];
        const entry = items.find(x => x.data?.id === ${JSON.stringify(id)});
        if (!manager || !list) return null;
        return { managerPresent: true, listPresent: true, id: ${JSON.stringify(id)},
          itemPresent: Boolean(entry), data: entry ? {
            id: entry.data?.id, name: entry.data?.name, state: entry.data?.state,
            disableReasons: entry.data?.disableReasons, errors: entry.data?.manifestErrors?.length,
            enabled: entry.data?.enabled, terminated: entry.data?.terminated
          } : null };
      })()`, 2500);
      return result?.managerPresent && result?.listPresent ? result : null;
    }, 3500, 'EXTENSIONS_UI_NOT_OBSERVABLE');
  } catch (error) { return { status: 'UNVERIFIED', error: error.message }; }
  finally { await closePage(cdp, p); }
}
async function popupProbe(cdp, id, { saveSentinel = false, budgetMs = 3500 } = {}) {
  let page;
  try {
    page = await openPage(cdp, `chrome-extension://${id}/popup.html`);
    const expr = `(async () => {
      if (document.querySelector('#matrix')?.textContent !== 'MV3_MATRIX_READY')
        return { popupAccessible: false, reason: 'BAD_POPUP_MARKER' };
      const limited = p => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('OP_TIMEOUT')), 1200))]);
      ${saveSentinel ? "await limited(chrome.storage.local.set({ matrixSentinel: 'retained' }));" : ''}
      const stored = await limited(chrome.storage.local.get('matrixSentinel'));
      const pong = await limited(chrome.runtime.sendMessage({ type: 'matrix.ping' }));
      return { popupAccessible: true, sentinelPreserved: stored.matrixSentinel === 'retained',
        backgroundResponded: pong?.ok === true, instanceId: pong?.instanceId || null };
    })()`;
    return await until(async () => {
      const value = await evaluate(cdp, page, expr, 2600);
      return value?.popupAccessible && value.backgroundResponded ? value : null;
    }, Math.max(1, Math.min(3500, budgetMs)), 'POPUP_PROBE_FAILED');
  } finally { await closePage(cdp, page); }
}
async function browserShutdown(cdp, child) {
  try { await cdp?.send('Browser.close', {}, undefined, 1800); } catch { /* supervisor verifies and kills survivors */ }
  try { cdp?.close(); } catch { /* best effort */ }
  if (!child) return { status: 'PASS' };
  if (child.exitCode !== null || child.signalCode !== null) return { status: 'PASS', alreadyExited: true, exitCode: child.exitCode, signal: child.signalCode };
  const closed = await Promise.race([
    new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))),
    sleep(1800).then(() => null),
  ]);
  return closed ? { status: 'PASS', closed } : { status: 'UNCONFIRMED', reason: 'CHROME_CLOSE_NOT_OBSERVED' };
}

async function runCase(spec, scratch) {
  const extensionPath = path.join(scratch, 'extension');
  const profile = path.join(scratch, 'profile');
  const snapshotPath = path.join(scratch, 'observation.json');
  const trial = {
    id: spec.id, mode: 'DIRECT_CHROMIUM_CDP', execution: 'INCOMPLETE', stage: 'INIT',
    functionalRecovery: 'UNVERIFIED', reloadBoundaryEvidence: 'NOT_OBSERVED', reloadResult: 'UNVERIFIED',
    startedAt: new Date().toISOString(), verificationRunId, sourceHashes: { 'scripts/direct-chromium-reload-compare.mjs': ownHash, 'scripts/mv3-reload-core.mjs': coreHash, 'scripts/direct-mv3-identity.mjs': identityHash },
    observations: { popupFailures: [], workerEvents: [], registrationEvents: [] },
  };
  const save = () => atomicWrite(snapshotPath, trial);
  const stage = value => { trial.stage = value; save(); };
  let cdp, browser;
  let browserOutput = '';
  let sequence = 0;
  save();
  try {
    stage('SETUP');
    trial.extensionSourceHashes = createExtension(extensionPath);
    const binary = findExecutable();
    const args = [
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      ...(spec.unsafe ? ['--enable-unsafe-extension-debugging'] : []),
      `--user-data-dir=${profile}`, '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check',
      ...(process.platform !== 'win32' ? ['--no-sandbox'] : []), // Linux container smoke only
      ...(process.env.DIRECT_HEADLESS === '1' ? ['--headless=new'] : []),
      'about:blank',
    ];
    trial.launch = { executablePath: binary, executableSha256: sha256(binary), args, profilePath: profile,
      headless: process.env.DIRECT_HEADLESS === '1', playwrightUsed: false,
      cdpUsed: true, cdpExtraArgument: '--remote-debugging-port=0',
      differencesFromPlaywright: ['No Playwright launcher or default flags', 'CDP observer attached to Chromium browser without Playwright', 'DevToolsActivePort CDP connection',
        '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check'] };
    save();
    browser = spawn(binary, args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    browser.on('error', error => { trial.browserSpawnError = error.message; save(); });
    trial.browserProcessPid = browser.pid;
    const push = chunk => { browserOutput = (browserOutput + chunk.toString('utf8')).slice(-3500); };
    browser.stdout?.on('data', push);
    browser.stderr?.on('data', push);
    trial.actualProcessCommandLine = getWindowsCommandLine(browser.pid);
    const actual = trial.actualProcessCommandLine.commandLine;
    trial.actualArgsEvidence = actual ? { status: 'OBSERVED', matchesRequested: args.filter(x => x !== 'about:blank').every(x => actual.includes(x)),
      unsafePresent: actual.includes('--enable-unsafe-extension-debugging'),
      unsafeExpected: spec.unsafe, launchMethod: 'node:child_process.spawn', playwrightApiUsed: false } : { status: 'UNVERIFIED' };
    save();
    const [port, endpoint] = await waitForFile(path.join(profile, 'DevToolsActivePort'), 9500);
    cdp = new Cdp(`ws://127.0.0.1:${port}${endpoint}`);
    await cdp.ready();
    trial.browserVersionCDP = await cdp.send('Browser.getVersion');
    const observer = await openPage(cdp, 'about:blank');
    cdp.onEvent(msg => {
      if (msg.sessionId !== observer.sessionId) return;
      if (msg.method === 'ServiceWorker.workerVersionUpdated') {
        for (const v of msg.params?.versions || []) if (v.scriptURL?.startsWith('chrome-extension://'))
          trial.observations.workerEvents.push({ sequence: ++sequence, runningStatus: v.runningStatus,
            versionId: v.versionId, status: v.status, scriptURL: v.scriptURL });
      }
      if (msg.method === 'ServiceWorker.workerRegistrationUpdated') {
        for (const r of msg.params?.registrations || []) if (r.scopeURL?.startsWith('chrome-extension://'))
          trial.observations.registrationEvents.push({ sequence: ++sequence, registrationId: r.registrationId,
            scopeURL: r.scopeURL, isDeleted: r.isDeleted });
      }
    });
    await cdp.send('ServiceWorker.enable', {}, observer.sessionId);
    // Enumerate for the full SETUP window. Do not stop at the first unrelated
    // background.js; verify marker + storage + worker ping and reject multiple
    // positive matches, including a second extension that appears late.
    let identified;
    try {
      identified = await discoverMinimalExtension({
        timeoutMs: 9000,
        collect: async () => {
          const info = await cdp.send('Target.getTargets', {}, undefined, 1000);
          return backgroundCandidates(info.targetInfos ?? [], trial.observations.workerEvents);
        },
        probe: async (id, { remainingMs }) => popupProbe(cdp, id,
          { saveSentinel: true, budgetMs: Math.min(remainingMs, 3500) }),
        onProgress: progress => { trial.observations.extensionDiscovery = progress; save(); },
      });
    } catch (error) {
      trial.observations.extensionDiscovery = error.identityEvidence ?? trial.observations.extensionDiscovery;
      save();
      throw error;
    }
    const extensionId = identified.id;
    const first = identified.observation;
    trial.observations.extensionDiscovery = {
      candidates: identified.candidates, attempted: identified.attempted,
      enumerationErrors: identified.enumerationErrors,
      elapsedMs: identified.elapsedMs, budgetMs: identified.budgetMs,
      selected: extensionId,
    };
    trial.extensionId = extensionId;
    trial.verifiedExtension = verifiedReloadIdentity(extensionId,
      trial.observations.workerEvents, trial.observations.registrationEvents);
    trial.observations.beforeUi = await extensionUi(cdp, extensionId);
    save();
    trial.observations.beforeReloadWorkerInstance = first.instanceId;
    stage('RELOAD');
    const popup = await openPage(cdp, `chrome-extension://${extensionId}/popup.html`);
    const reloadSequence = sequence;
    trial.observations.reloadInvocation = { method: 'chrome.runtime.reload', at: new Date().toISOString() };
    save();
    try {
      await evaluate(cdp, popup, '(() => { chrome.runtime.reload(); return "invoked"; })()', 2600);
      trial.observations.reloadInvocation.evaluate = 'returned';
    } catch (error) {
      trial.observations.reloadInvocation.evaluate = 'interrupted';
      trial.observations.reloadInvocation.error = error.message;
      if (!/CDP_SOCKET_CLOSED|Execution context|session|Target closed|context destroyed|CDP_TIMEOUT Runtime.evaluate/iu.test(error.message)) throw error;
    }
    stage('OBSERVE');
    const deadline = Date.now() + 8000;
    let after = null;
    while (Date.now() < deadline) {
      try {
        after = await popupProbe(cdp, extensionId);
      } catch (error) { if (trial.observations.popupFailures.length < 8) trial.observations.popupFailures.push(error.message); }
      trial.observations.popupAfter = after ?? { popupAccessible: false };
      trial.observations.workerEventsAfterReload = trial.observations.workerEvents.filter(e => e.sequence > reloadSequence);
      trial.observations.registrationEventsAfterReload = trial.observations.registrationEvents.filter(e => e.sequence > reloadSequence);
      // Raw cross-extension events remain for diagnostics, but cannot prove
      // the selected extension's reload boundary or post-boundary running.
      Object.assign(trial, assessDirectReload(trial.observations,
        trial.verifiedExtension, { windowCompleted: false }));
      save();
      if (trial.functionalRecovery === 'PASS' && trial.reloadBoundaryEvidence === 'CONFIRMED') break;
      await sleep(150);
    }
    trial.observations.popupAfter = after ?? { popupAccessible: false };
    trial.observations.workerEventsAfterReload = trial.observations.workerEvents.filter(e => e.sequence > reloadSequence);
    trial.observations.registrationEventsAfterReload = trial.observations.registrationEvents.filter(e => e.sequence > reloadSequence);
    // An inaccessible popup is a functional observation, not proof that
    // chrome.runtime.reload was invoked. Establish the invocation/boundary
    // first, then finalize the reload verdict.
    trial.observations.afterUi = await extensionUi(cdp, extensionId);
    const infos = await cdp.send('Target.getTargets');
    trial.observations.extensionTargetsAfter = infos.targetInfos?.filter(x => x.url?.startsWith(`chrome-extension://${extensionId}`))
      .map(x => ({ type: x.type, url: x.url, attached: x.attached })) || [];
    Object.assign(trial, assessDirectReload(trial.observations, trial.verifiedExtension));
    if (trial.execution === 'INCOMPLETE') trial.error = { stage: 'RELOAD', message: 'RELOAD_INVOCATION_UNVERIFIED' };
    stage('DONE');
  } catch (error) { trial.error = { stage: trial.stage, code: error.code || null, message: error.message }; save(); }
  finally {
    trial.childCleanup = await browserShutdown(cdp, browser);
    trial.browserDiagnosticTail = browserOutput;
    trial.finishedAt = new Date().toISOString();
    save();
    console.log('DIRECT_MV3_CASE ' + JSON.stringify({ verificationRunId, id: trial.id, stage: trial.stage, execution: trial.execution,
      functionalRecovery: trial.functionalRecovery, reloadBoundaryEvidence: trial.reloadBoundaryEvidence,
      reloadResult: trial.reloadResult, childCleanup: trial.childCleanup.status,
      error: trial.error || null }));
  }
}

async function runParent() {
  const result = { kind: 'DIRECT_MV3_RELOAD_COMPARISON', baselineHead: 'e331ea8ee971ac70febaea3dd04a5de021f2ca18',
    sourceHashes: { 'scripts/direct-chromium-reload-compare.mjs': ownHash, 'scripts/mv3-reload-core.mjs': coreHash, 'scripts/direct-mv3-identity.mjs': identityHash }, platform: process.platform, node: process.version, verificationRunId, startedAt: new Date().toISOString(),
    scope: 'Fresh A/B direct Chromium + CDP, no Playwright. Not a native bridge delivery/ACK proof.',
    execution: 'INCOMPLETE', cases: [] };
  try { result.gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch { result.gitHead = null; }
  const save = () => atomicWrite(receiptPath, result);
  const priorFile = ['latest-minimal-native-reload-matrix-headed.json',
    'latest-minimal-native-reload-matrix-v2.json'].map(name => path.join(outputDir, name)).find(fs.existsSync);
  const browserExe = findExecutable();
  result.requestedExecutable = browserExe;
  result.requestedExecutableSha256 = sha256(browserExe);
  if (priorFile) {
    try {
      const prior = JSON.parse(fs.readFileSync(priorFile, 'utf8'));
      const ref = prior.cases?.[0];
      const expected = ref?.launch?.executableSha256;
      result.previousPlaywright = {
        receiptPath: priorFile, gitHead: prior.gitHead, chromiumVersion: ref?.browserVersion,
        executable: ref?.launch?.executablePath, executableSha256: expected,
        headless: ref?.launch?.headless, requestedArgs: ref?.launch?.args,
        moduleExtensionHashes: ref?.extensionSourceHashes,
        executableMatch: expected ? expected === result.requestedExecutableSha256 : null,
      };
      if (expected && expected !== result.requestedExecutableSha256) {
        result.error = 'CHROMIUM_BINARY_HASH_CHANGED_FROM_PRIOR_MATRIX';
        result.exitCode = 5; save(); process.exitCode = 5; return;
      }
    } catch (error) { result.previousPlaywrightReadError = error.message; }
  }
  save();
  for (const spec of cases) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `direct-mv3-${spec.id}-`));
    const observation = await superviseTrial({ command: process.execPath, args: [ownPath, '--child', spec.id, scratch],
      cwd: root, env: { ...process.env, BRIDGE_VERIFICATION_RUN_ID: verificationRunId },
      snapshotFile: path.join(scratch, 'observation.json'), profile: path.join(scratch, 'profile'),
      scratch, limitMs: 45_000 });
    result.cases.push(observation); save();
    console.log('DIRECT_MV3_TRIAL ' + JSON.stringify({ verificationRunId, id: spec.id, stage: observation.stage,
      execution: observation.execution, functionalRecovery: observation.functionalRecovery,
      reloadResult: observation.reloadResult, cleanup: observation.cleanup.status,
      childExecution: observation.childExecution.status }));
    if (observation.cleanup.status !== 'PASS') { result.stoppedReason = 'Cleanup not confirmed; withholding next case'; break; }
  }
  result.execution = result.cases.length === cases.length && result.cases.every(x => x.execution === 'COMPLETE') ? 'COMPLETE' : 'INCOMPLETE';
  result.cleanupStatus = result.cases.every(x => x.cleanup.status === 'PASS') ? 'PASS' : 'UNCONFIRMED';
  result.childExecutionStatus = result.cases.every(x => x.childExecution.status === 'PASS') ? 'PASS' : 'FAIL';
  result.exitCode = result.cleanupStatus !== 'PASS' ? 3 : result.childExecutionStatus !== 'PASS' ? 4 : result.execution !== 'COMPLETE' ? 2 : 0;
  result.finishedAt = new Date().toISOString(); save();
  console.log('DIRECT_MV3_RESULT ' + JSON.stringify({ verificationRunId, execution: result.execution,
    cleanupStatus: result.cleanupStatus, childExecutionStatus: result.childExecutionStatus,
    exitCode: result.exitCode, results: result.cases.map(x => [x.id, x.reloadResult]), receiptPath }));
  process.exitCode = result.exitCode;
}
if (process.argv[2] === '--child') {
  const spec = cases.find(x => x.id === process.argv[3]);
  if (!spec || !process.argv[4]) throw new Error('Invalid direct-child arguments');
  await runCase(spec, process.argv[4]);
} else await runParent();
