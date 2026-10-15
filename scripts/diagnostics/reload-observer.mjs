// Module C: v3 CDP transport and evidence collection. No functional/final verdicts.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicWrite, wait } from '../mv3-reload-core.mjs';
import { backgroundCandidates, discoverMinimalExtension, verifiedReloadIdentity,
  verifyExecutionContext, targetReloadEvents } from '../direct-mv3-identity.mjs';
import { launchBrowser } from './environment.mjs';

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

export class Cdp {
  constructor(url, onPacket = () => {}) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    this.rawEvents = [];
    this.ws.addEventListener('error', () => {});
    this.ws.addEventListener('message', event => {
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      this.rawEvents?.push({ at: new Date().toISOString(), packet });
      onPacket({ at: new Date().toISOString(), packet });
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
  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
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
  const budget = () => options.deadline ? Math.max(1, options.deadline - Date.now()) : 3000;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }, undefined, budget());
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, undefined, budget());
  await cdp.send('Page.enable', {}, sessionId, budget());
  await cdp.send('Runtime.enable', {}, sessionId, budget());
  const { errorText } = await cdp.send('Page.navigate', { url }, sessionId, budget());
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
export async function browserShutdown(cdp, child) {
  try { await cdp?.send('Browser.close', {}, undefined, 1800); } catch { /* supervisor verifies and kills survivors */ }
  try { cdp?.close(); } catch { /* best effort */ }
  if (!child) return { status: 'PASS' };
  if (child.exitCode !== null || child.signalCode !== null) return { status: 'PASS', alreadyExited: true, exitCode: child.exitCode, signal: child.signalCode };
  const closed = await wait(new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))), 1800, null);
  return closed ? { status: 'PASS', closed } : { status: 'UNCONFIRMED', reason: 'CHROME_CLOSE_NOT_OBSERVED' };
}


export async function popupProbe(cdp, id, { saveSentinel = false, budgetMs = 3500 } = {}) {
  let page, lastObservation;
  const deadline = Date.now() + budgetMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  try {
    page = await openPage(cdp, `chrome-extension://${id}/popup.html`, { deadline });
    const expr = `(async () => {
      const context = { url: location.href, runtimeId: globalThis.chrome?.runtime?.id ?? null,
        apis: { sendMessage: typeof globalThis.chrome?.runtime?.sendMessage === 'function',
          reload: typeof globalThis.chrome?.runtime?.reload === 'function',
          storageGet: typeof globalThis.chrome?.storage?.local?.get === 'function',
          storageSet: typeof globalThis.chrome?.storage?.local?.set === 'function' } };
      if (context.url !== ${JSON.stringify(`chrome-extension://${id}/popup.html`)} || context.runtimeId !== ${JSON.stringify(id)}
        || !Object.values(context.apis).every(Boolean)) return {popupAccessible:false,context,reason:'WRONG_CONTEXT_OR_API'};
      if (document.querySelector('#matrix')?.textContent !== 'MV3_MATRIX_READY')
        return {popupAccessible:false,context,reason:'BAD_POPUP_MARKER'};
      const limited = p => new Promise((resolve,reject) => {
        const timer=setTimeout(()=>reject(new Error('OP_TIMEOUT')),1000);
        Promise.resolve(p).then(v=>{clearTimeout(timer);resolve(v)},e=>{clearTimeout(timer);reject(e)});
      });
      ${saveSentinel ? "await limited(chrome.storage.local.set({matrixSentinel:'retained'}));" : ''}
      const stored = await limited(chrome.storage.local.get('matrixSentinel'));
      const pong = await limited(chrome.runtime.sendMessage({type:'matrix.ping'}));
      return {popupAccessible:true,context,stored,pong,sentinelPreserved:stored.matrixSentinel==='retained',
        backgroundResponded:pong?.ok===true,instanceId:pong?.instanceId||null};
    })()`;
    try { return await until(async () => {
      const value = await evaluate(cdp, page, expr, remaining());
      if (value) lastObservation = value;
      return value?.popupAccessible && value.backgroundResponded ? value : null;
    }, remaining(), 'POPUP_PROBE_FAILED'); }
    catch (error) {
      if (lastObservation) return { ...lastObservation, probeError: error.message };
      throw error;
    }
  } finally { await closePage(cdp, page); }
}

export async function observeReload({ cdp, identity, observations, save = () => {}, budgetMs = 8000,
  probe = popupProbe, inspect = extensionUi, clock = Date.now, pause = sleep }) {
  if (!identity?.setupVerified || !verifyExecutionContext(identity.extensionId, identity.initialProbe?.context))
    throw Error('VERIFIED_SETUP_REQUIRED');
  let startSequence = Math.max(0, ...(observations.workerEvents ?? []).map(e => e.sequence),
    ...(observations.registrationEvents ?? []).map(e => e.sequence));
  observations.window = { startedAt: new Date(clock()).toISOString(), budgetMs, completed: false, stopReason: null };
  let popup;
  const scope = () => {
    observations.workerEventsAfterReload = (observations.workerEvents ?? []).filter(e => e.sequence > startSequence);
    observations.registrationEventsAfterReload = (observations.registrationEvents ?? []).filter(e => e.sequence > startSequence);
    observations.targetEvents = targetReloadEvents(observations, identity);
  };
  try {
    observations.beforeReload = await probe(cdp, identity.extensionId);
    if (!verifyExecutionContext(identity.extensionId, observations.beforeReload?.context)
      || observations.beforeReload.backgroundResponded !== true || observations.beforeReload.sentinelPreserved !== true
      || typeof observations.beforeReload.instanceId !== 'string' || !observations.beforeReload.instanceId)
      throw Error('INITIAL_MESSAGE_OR_CONTEXT_UNVERIFIED');
    observations.beforeReloadWorkerInstance = observations.beforeReload.instanceId;
    observations.beforeUi = await inspect(cdp, identity.extensionId);
    popup = await openPage(cdp, `chrome-extension://${identity.extensionId}/popup.html`);
    startSequence = Math.max(0, ...(observations.workerEvents ?? []).map(e => e.sequence),
      ...(observations.registrationEvents ?? []).map(e => e.sequence));
    observations.reloadInvocation = { method: 'chrome.runtime.reload', attempted: true,
      at: new Date(clock()).toISOString(), context: observations.beforeReload.context };
    save();
    try {
      const result = await evaluate(cdp, popup, `(() => {
        if(location.href!==${JSON.stringify(`chrome-extension://${identity.extensionId}/popup.html`)}
          || chrome.runtime.id!==${JSON.stringify(identity.extensionId)} || typeof chrome.runtime.reload!=='function')
          return {invoked:false};
        chrome.runtime.reload(); return {invoked:true};
      })()`);
      observations.reloadInvocation.evaluate = result?.invoked === true ? 'returned' : 'not-invoked';
    } catch (error) {
      observations.reloadInvocation.evaluate = 'interrupted';
      observations.reloadInvocation.error = error.message;
    }
    observations.reloadInvocation.finishedAt = new Date(clock()).toISOString();
    save();
    const deadline = clock() + budgetMs;
    while (clock() < deadline) {
      if (cdp.closed) throw Error('CDP_SOCKET_CLOSED');
      const at = new Date(clock()).toISOString();
      try {
        const after = await probe(cdp, identity.extensionId, { budgetMs: Math.min(2000, deadline - clock()) });
        observations.popupAttempts.push({ at, result: after });
        observations.popupAfter = after;
        if (after?.popupAccessible && after.backgroundResponded && after.sentinelPreserved
          && verifyExecutionContext(identity.extensionId, after.context)) observations.successfulPopup = after;
      } catch (error) {
        observations.popupAttempts.push({ at, error: error.message });
        observations.popupFailures.push({ at, error: error.message });
        // Keep a previously observed successful response if the observer later disconnects.
        observations.popupAfter ??= { popupAccessible: false };
      }
      scope(); save();
      if (cdp.closed) throw Error('CDP_SOCKET_CLOSED');
      if (clock() < deadline) await pause(Math.min(150, deadline - clock()));
    }
    observations.afterUi = await inspect(cdp, identity.extensionId);
    const infos = await cdp.send('Target.getTargets');
    observations.extensionTargetsAfter = (infos.targetInfos ?? []).filter(x => x.url?.startsWith(`chrome-extension://${identity.extensionId}/`));
    if (cdp.closed) throw Error('CDP_SOCKET_CLOSED');
    observations.window.completed = true;
    observations.window.stopReason = 'OBSERVATION_BUDGET_COMPLETED';
  } catch (error) {
    observations.window.stopReason = error.message;
    throw error;
  } finally {
    scope(); observations.window.finishedAt = new Date(clock()).toISOString(); save();
    await closePage(cdp, popup);
  }
  return observations;
}

export async function runCase(spec, scratch, { verificationRunId, source, environment, rawDirectory }) {
  const trial = { id: spec.id, verificationRunId, scope: 'minimal-mv3-runtime.reload/direct-cdp/fresh-A-B',
    source, environment, requestedConditions: spec, stage: 'INIT', startedAt: new Date().toISOString(), stages: [],
    observations: { workerEvents: [], registrationEvents: [], popupAttempts: [], popupFailures: [] } };
  const save = () => atomicWrite(path.join(scratch, 'observation.json'), trial);
  const stage = name => {
    if (trial.stages.length) trial.stages.at(-1).finishedAt = new Date().toISOString();
    trial.stage = name; trial.stages.push({ name, startedAt: new Date().toISOString(), finishedAt: null }); save();
  };
  let cdp, browser, sequence = 0;
  const browserLog = path.join(rawDirectory, `browser-${spec.id}.log`);
  fs.mkdirSync(rawDirectory, { recursive: true });
  fs.writeFileSync(browserLog, '');
  save();
  try {
    stage('LAUNCH');
    const launched = await launchBrowser(spec, scratch);
    browser = launched.child;
    const { child: _child, ...evidence } = launched;
    Object.assign(trial, evidence, { browserProcessPid: browser.pid, browserReady: false });
    const push = chunk => fs.appendFileSync(browserLog, chunk);
    browser.stdout?.on('data', push); browser.stderr?.on('data', push);
    save();
    const [port, endpoint] = await waitForFile(path.join(launched.launch.profilePath, 'DevToolsActivePort'), 9500);
    trial.rawProtocolStream = path.join(rawDirectory, `protocol-${spec.id}.jsonl`);
    fs.writeFileSync(trial.rawProtocolStream, '');
    cdp = new Cdp(`ws://127.0.0.1:${port}${endpoint}`,
      packet => fs.appendFileSync(trial.rawProtocolStream, JSON.stringify(packet) + '\n'));
    await cdp.ready();
    trial.browserVersionCDP = await cdp.send('Browser.getVersion');
    trial.browserReady = true; trial.launch.externalCdp = 'CONNECTED';
    const launchTargets = await cdp.send('Target.getTargets');
    trial.launch.devToolsUi.observed = (launchTargets.targetInfos ?? []).some(target => target.url?.startsWith('devtools://'))
      ? 'OBSERVED' : 'NOT_OBSERVED';
    trial.launch.devToolsUi.coverage = 'Target.getTargets snapshot after CDP attach; absence does not prove no UI was used';
    stage('SETUP');
    const observer = await openPage(cdp, 'about:blank');
    cdp.onEvent(msg => {
      if (msg.sessionId !== observer.sessionId) return;
      for (const v of msg.method === 'ServiceWorker.workerVersionUpdated' ? msg.params?.versions ?? [] : [])
        trial.observations.workerEvents.push({ ...v, sequence: ++sequence, at: new Date().toISOString() });
      for (const r of msg.method === 'ServiceWorker.workerRegistrationUpdated' ? msg.params?.registrations ?? [] : [])
        trial.observations.registrationEvents.push({ ...r, sequence: ++sequence, at: new Date().toISOString() });
      save();
    });
    await cdp.send('ServiceWorker.enable', {}, observer.sessionId);
    const identified = await discoverMinimalExtension({ timeoutMs: 9000, requireContext: true,
      collect: async () => {
        const info = await cdp.send('Target.getTargets', {}, undefined, 1000);
        return backgroundCandidates(info.targetInfos ?? [], trial.observations.workerEvents);
      },
      probe: (id, { remainingMs }) => popupProbe(cdp, id, { saveSentinel: true, budgetMs: Math.min(remainingMs, 3500) }),
      onProgress: progress => { trial.observations.extensionDiscovery = progress; save(); } });
    trial.observations.extensionDiscovery = identified;
    trial.extensionId = identified.id;
    trial.verifiedExtension = verifiedReloadIdentity(identified.id, trial.observations.workerEvents,
      trial.observations.registrationEvents, identified.observation);
    stage('RELOAD_AND_OBSERVE');
    await observeReload({ cdp, identity: trial.verifiedExtension, observations: trial.observations, save });
    stage('DONE');
  } catch (error) {
    trial.error = { stage: trial.stage, code: error.code ?? null, message: error.message };
    if (error.identityEvidence) trial.observations.extensionDiscovery = error.identityEvidence;
    save();
  } finally {
    stage('CLEANUP');
    trial.childCleanup = await browserShutdown(cdp, browser);
    trial.rawProtocolFile = path.join(rawDirectory, `protocol-${spec.id}.json`);
    atomicWrite(trial.rawProtocolFile, cdp?.rawEvents ?? []);
    trial.browserLog = browserLog;
    trial.finishedAt = new Date().toISOString(); trial.stages.at(-1).finishedAt = trial.finishedAt;
    save();
  }
  return trial;
}
