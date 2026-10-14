// Independent MV3 reload comparator, with one OS process and one browser profile per case.
// This is NOT a substitute for the bridge's native extension/ownership contract.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MATRIX_CASES, assessReload, assessMatrix, atomicWrite, superviseTrial } from './mv3-reload-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ownPath = fileURLToPath(import.meta.url);
const resultsDir = path.resolve(process.env.BRIDGE_VERIFICATION_OUTPUT ?? path.join(root, '.agent-controller'));
const outputFile = path.join(resultsDir, 'latest-minimal-native-reload-matrix-v2.json');
const fileHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sourceFiles = [ownPath, fileURLToPath(new URL('./mv3-reload-core.mjs', import.meta.url))];
const sourceHashes = Object.fromEntries(sourceFiles.map(f => [path.relative(root, f).replaceAll('\\', '/'), fileHash(f)]));
const specById = Object.fromEntries(MATRIX_CASES.map(x => [x.id, x]));

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
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return Object.fromEntries(Object.keys(files).map(name => [name, fileHash(path.join(dir, name))]));
}

async function runChild(spec, scratch) {
  const snapshotFile = path.join(scratch, 'observation.json');
  const extension = path.join(scratch, 'extension');
  const profile = path.join(scratch, 'profile');
  const trial = {
    id: spec.id, precondition: spec.precondition, unsafeDebugging: spec.unsafeDebugging,
    execution: 'INCOMPLETE', stage: 'BOOT', functionalRecovery: 'UNVERIFIED',
    reloadBoundaryEvidence: 'NOT_OBSERVED', reloadResult: 'UNVERIFIED',
    cleanup: { status: 'PENDING' }, stageHistory: [{ stage: 'BOOT', at: new Date().toISOString() }], observations: { workerEvents: [], registrationEvents: [], popupFailures: [] },
    sourceHashes, startedAt: new Date().toISOString(),
  };
  const save = () => atomicWrite(snapshotFile, trial);
  const setStage = stage => { trial.stage = stage; trial.stageHistory.push({ stage, at: new Date().toISOString() }); save(); };
  save();
  let context, cdp, fixtureServer;
  let eventSequence = 0;
  try {
    setStage('SETUP');
    trial.extensionSourceHashes = createExtension(extension);
    const { chromium } = await import('playwright-core');
    // Always pass an explicit executablePath so the executable used is unambiguous.
    const executablePath = path.resolve(process.env.UI_BROWSER_EXECUTABLE ?? chromium.executablePath());
    const args = [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      ...(spec.unsafeDebugging ? ['--enable-unsafe-extension-debugging'] : [])];
    trial.launch = { executablePath, executableSha256: fs.existsSync(executablePath) ? fileHash(executablePath) : null,
      headless: true, ignoreDefaultArgs: ['--disable-extensions'], args, profilePath: profile };
    save();
    context = await chromium.launchPersistentContext(profile, {
      executablePath, headless: true, viewport: null, ignoreDefaultArgs: ['--disable-extensions'],
      args, timeout: 12_000,
    });
    trial.browserVersion = context.browser()?.version() ?? null;
    const observer = await context.newPage();
    observer.setDefaultTimeout(1800);
    cdp = await context.newCDPSession(observer);
    const record = (value) => ({ sequence: ++eventSequence, at: new Date().toISOString(), ...value });
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      for (const v of versions) if (v.scriptURL?.startsWith('chrome-extension://')) {
        trial.observations.workerEvents.push(record({ versionId: v.versionId, scriptURL: v.scriptURL,
          runningStatus: v.runningStatus, status: v.status }));
      }
    });
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      for (const r of registrations) if (r.scopeURL?.startsWith('chrome-extension://')) {
        trial.observations.registrationEvents.push(record({ registrationId: r.registrationId,
          scopeURL: r.scopeURL, isDeleted: r.isDeleted }));
      }
    });
    await cdp.send('ServiceWorker.enable');
    try { trial.observations.actualBrowserCommandLine = (await cdp.send('Browser.getBrowserCommandLine')).arguments; }
    catch (error) { trial.observations.browserCommandLineError = error.message; }
    trial.observations.browserVersionCDP = await cdp.send('Browser.getVersion');
    if (trial.observations.actualBrowserCommandLine) {
      const actualBinary = trial.observations.actualBrowserCommandLine[0];
      trial.observations.actualExecutablePath = actualBinary;
      trial.observations.actualExecutableSha256 = fs.existsSync(actualBinary) ? fileHash(actualBinary) : null;
      const observedFlag = trial.observations.actualBrowserCommandLine.includes('--enable-unsafe-extension-debugging');
      trial.observations.unsafeFlagObserved = observedFlag;
      if (observedFlag !== spec.unsafeDebugging) throw new Error('Observed Chromium options differ from requested matrix condition');
    }
    save();
    // Give both existing worker targets and CDP registration announcements a chance to appear.
    const until = async (check, deadlineMs, reason) => {
      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline) {
        if (await check()) return;
        await sleep(100);
      }
      throw new Error(reason);
    };
    let extensionId;
    await until(() => {
      const sw = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
      const reg = trial.observations.registrationEvents.find(e => e.scopeURL?.startsWith('chrome-extension://'));
      const ver = trial.observations.workerEvents.find(e => e.scriptURL?.startsWith('chrome-extension://'));
      const url = sw?.url() ?? reg?.scopeURL ?? ver?.scriptURL;
      extensionId = url ? new URL(url).hostname : null;
      return Boolean(extensionId);
    }, 8000, 'Extension identity not observed during setup');
    trial.extensionId = extensionId;
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    const popup = await context.newPage();
    popup.setDefaultTimeout(1600);
    await popup.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 1600 });
    const label = await popup.locator('#matrix').textContent();
    if (label !== 'MV3_MATRIX_READY') throw new Error('Minimal popup contract mismatch');
    const ping = async page => page.evaluate(() => Promise.race([
      chrome.runtime.sendMessage({ type: 'matrix.ping' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('matrix.ping timeout')), 1200)),
    ]));
    const first = await ping(popup);
    if (!first?.ok || !first.instanceId) throw new Error('Initial module worker ping failed');
    await popup.evaluate(() => chrome.storage.local.set({ matrixSentinel: 'retained' }));
    trial.observations.firstWorkerInstance = first.instanceId;
    setStage('PRECONDITION');

    if (spec.precondition === 'stop-start-navigation') {
      fixtureServer = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        response.end('<script>window.matrixDocumentToken=crypto.randomUUID()</script>fixture');
      });
      await new Promise((resolve, reject) => {
        fixtureServer.once('error', reject);
        fixtureServer.listen(0, '127.0.0.1', resolve);
      });
      const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/fixture`;
      const fixture = await context.newPage();
      await fixture.goto(fixtureUrl, { timeout: 1800 });
      const priorToken = await fixture.evaluate(() => window.matrixDocumentToken);
      const versions = trial.observations.workerEvents;
      const active = [...versions].reverse().find(e => e.runningStatus === 'running');
      if (!active) throw new Error('Cannot identify running worker to stop');
      const stoppedAfter = eventSequence;
      await cdp.send('ServiceWorker.stopWorker', { versionId: active.versionId });
      await until(() => versions.some(e => e.sequence > stoppedAfter && e.runningStatus === 'stopped'),
        6500, 'Worker stopped transition not observed');
      const restartAfter = eventSequence;
      let woke;
      await until(async () => {
        woke = await ping(popup).catch(() => null);
        return woke?.ok && versions.some(e => e.sequence > restartAfter && e.runningStatus === 'running');
      }, 6500, 'Worker running transition with ping not observed');
      if (woke.instanceId === first.instanceId) throw new Error('Worker instance unchanged after forced restart');
      await fixture.reload({ timeout: 1800 });
      const newToken = await fixture.evaluate(() => window.matrixDocumentToken);
      if (!priorToken || !newToken || priorToken === newToken) throw new Error('Document identity unchanged after navigation');
      trial.observations.precondition = { stopStart: 'PASS', navigation: 'PASS', tokenChanged: true,
        workerInstanceChanged: true };
      await fixture.close();
    } else trial.observations.precondition = { stopStart: 'SKIPPED', navigation: 'SKIPPED' };

    const before = await ping(popup);
    if (!before?.ok) throw new Error('Worker unresponsive before reload');
    trial.observations.beforeReloadWorkerInstance = before.instanceId;
    setStage('RELOAD');
    trial.observations.reloadInvocation = { at: new Date().toISOString(), method: 'chrome.runtime.reload' };
    save();
    const reloadSequence = eventSequence;
    try {
      await popup.evaluate(() => { chrome.runtime.reload(); return 'invoked'; });
      trial.observations.reloadInvocation.evaluate = 'returned';
    } catch (error) {
      trial.observations.reloadInvocation.evaluate = 'interrupted';
      trial.observations.reloadInvocation.error = error.message;
      if (!/execution context was destroyed|target.*closed|page.*closed|navigation/i.test(error.message)) throw error;
    }
    setStage('OBSERVE');
    const end = Date.now() + 8_000;
    let popupAfter = null;
    while (Date.now() < end) {
      const candidate = await context.newPage();
      candidate.setDefaultTimeout(1200);
      try {
        await candidate.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 1200 });
        const isExpected = await candidate.locator('#matrix').textContent({ timeout: 800 });
        if (isExpected !== 'MV3_MATRIX_READY') throw new Error('Unexpected popup content');
        const value = await candidate.evaluate(async () => {
          const timeout = p => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Error('response timeout')), 1200))]);
          const stored = await timeout(chrome.storage.local.get('matrixSentinel'));
          const reply = await timeout(chrome.runtime.sendMessage({ type: 'matrix.ping' }));
          return { stored: stored.matrixSentinel, reply };
        });
        popupAfter = { popupAccessible: true, sentinelPreserved: value.stored === 'retained',
          backgroundResponded: value.reply?.ok === true, instanceId: value.reply?.instanceId ?? null };
      } catch (error) {
        if (trial.observations.popupFailures.length < 8) trial.observations.popupFailures.push(error.message);
      } finally { await candidate.close().catch(() => {}); }
      trial.observations.popupAfter = popupAfter ?? { popupAccessible: false };
      trial.observations.workerEventsAfterReload = trial.observations.workerEvents.filter(e => e.sequence > reloadSequence);
      trial.observations.registrationEventsAfterReload = trial.observations.registrationEvents.filter(e => e.sequence > reloadSequence);
      Object.assign(trial, assessReload(trial.observations, false));
      save();
      if (trial.reloadResult === 'PASS') break;
      await sleep(150);
    }
    trial.observations.popupAfter = popupAfter ?? { popupAccessible: false };
    trial.observations.workerEventsAfterReload = trial.observations.workerEvents.filter(e => e.sequence > reloadSequence);
    trial.observations.registrationEventsAfterReload = trial.observations.registrationEvents.filter(e => e.sequence > reloadSequence);
    Object.assign(trial, assessReload(trial.observations, true));
    try {
      trial.observations.extensionTargets = (await cdp.send('Target.getTargets')).targetInfos
        .filter(t => t.url?.startsWith(`chrome-extension://${extensionId}/`))
        .map(t => ({ type: t.type, url: t.url, attached: t.attached }));
    } catch (error) { trial.observations.targetQueryError = error.message; }
    trial.execution = 'COMPLETE'; setStage('DONE');
  } catch (error) {
    trial.error = { stage: trial.stage, message: error.message, code: error.code ?? null };
    // Preserve any earlier functionalRecovery/reloadResult; do not report setup failures as reload failures.
    save();
  } finally {
    trial.childCleanup = { status: 'PENDING' };
    try { if (context) await context.close(); trial.childCleanup.browserClose = 'PASS'; }
    catch (error) { trial.childCleanup.browserClose = 'FAIL'; trial.childCleanup.error = error.message; }
    try {
      if (fixtureServer) {
        fixtureServer.closeAllConnections();
        await new Promise((resolve, reject) => fixtureServer.close(err => err ? reject(err) : resolve()));
      }
      trial.childCleanup.fixtureClose = 'PASS';
    } catch (error) { trial.childCleanup.fixtureClose = 'FAIL'; trial.childCleanup.fixtureError = error.message; }
    trial.childCleanup.status = trial.childCleanup.browserClose === 'PASS' && trial.childCleanup.fixtureClose === 'PASS' ? 'PASS' : 'FAIL';
    trial.finishedAt = new Date().toISOString(); save();
    console.log('MV3_MATRIX_TRIAL ' + JSON.stringify({ id: trial.id, execution: trial.execution,
      functionalRecovery: trial.functionalRecovery, reloadBoundaryEvidence: trial.reloadBoundaryEvidence,
      reloadResult: trial.reloadResult, childCleanup: trial.childCleanup.status }));
  }
}

async function runParent() {
  const receipt = { kind: 'MINIMAL_MV3_RELOAD_MATRIX', schemaVersion: 2,
    sourceHashes, platform: process.platform, node: process.version, executable: process.execPath,
    startedAt: new Date().toISOString(), execution: 'INCOMPLETE', cases: [],
    scope: 'Four independent minimal module workers. No bridge delivery ownership, reinjection, ACK, or native contract.' };
  try { receipt.gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { receipt.gitHead = null; }
  const save = () => atomicWrite(outputFile, receipt);
  save();
  const limitMs = Number(process.env.MV3_TRIAL_DEADLINE_MS ?? 35_000);
  if (!Number.isFinite(limitMs) || limitMs < 1000 || limitMs > 300_000) throw new Error('Invalid MV3_TRIAL_DEADLINE_MS');
  for (const spec of MATRIX_CASES) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `mv3-matrix-v2-${spec.id}-`));
    const result = await superviseTrial({ command: process.execPath, args: [ownPath, '--child', spec.id, scratch],
      cwd: root, snapshotFile: path.join(scratch, 'observation.json'),
      profile: path.join(scratch, 'profile'), scratch, limitMs });
    result.id = spec.id;
    receipt.cases.push(result); save();
    console.log('MV3_MATRIX_CASE ' + JSON.stringify({ id: spec.id, execution: result.execution,
      functionalRecovery: result.functionalRecovery, reloadBoundaryEvidence: result.reloadBoundaryEvidence,
      reloadResult: result.reloadResult, cleanup: result.cleanup.status, watchdog: result.watchdog }));
    if (!['PASS', 'FORCED_TERMINATED'].includes(result.cleanup.status)) {
      receipt.stoppedReason = `Unconfirmed cleanup in condition ${spec.id}; remaining conditions withheld to prevent contamination`;
      break;
    }
  }
  Object.assign(receipt, assessMatrix(receipt.cases));
  receipt.finishedAt = new Date().toISOString(); save();
  console.log('MV3_MATRIX_RESULT ' + JSON.stringify({ execution: receipt.execution,
    cleanupStatus: receipt.cleanupStatus, childExecutionStatus: receipt.childExecutionStatus,
    exitCode: receipt.exitCode, results: receipt.cases.map(x => [x.id, x.reloadResult]), outputFile }));
  process.exitCode = receipt.exitCode;
}

if (process.argv[2] === '--child') {
  const spec = specById[process.argv[3]], scratch = process.argv[4];
  if (!spec || !scratch) throw new Error('Invalid child arguments');
  await runChild(spec, scratch);
} else {
  await runParent();
}
