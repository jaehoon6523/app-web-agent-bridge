// Identify the test-owned MV3 extension without assuming the first Chrome
// extension worker belongs to the fixture. Chromium may load its own workers.
import { assessReload } from './mv3-reload-core.mjs';

function backgroundId(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'chrome-extension:' || parsed.pathname !== '/background.js') return null;
    return /^[a-p]{32}$/.test(parsed.hostname) ? parsed.hostname : null;
  } catch { return null; }
}
export function backgroundCandidates(targetInfos = [], workerEvents = []) {
  return [...new Set([...targetInfos.map(x => x?.url), ...workerEvents.map(x => x?.scriptURL)]
    .map(backgroundId).filter(Boolean))];
}

function eligible(x) {
  return x?.popupAccessible === true && x.sentinelPreserved === true
    && x.backgroundResponded === true && typeof x.instanceId === 'string' && x.instanceId.length > 0;
}
export async function verifyMinimalExtension(candidates, probe) {
  const attempts = [], matches = [];
  for (const id of candidates) {
    try {
      const observation = await probe(id);
      const match = eligible(observation);
      attempts.push({ id, verdict: match ? 'MATCHED' : 'REJECTED',
        ...(match ? {} : { reason: 'POPUP_OR_WORKER_CONTRACT_MISMATCH' }) });
      if (match) matches.push({ id, observation });
    } catch (error) { attempts.push({ id, verdict: 'REJECTED', reason: String(error?.message ?? error) }); }
  }
  if (matches.length !== 1) {
    const error = new Error(matches.length ? 'AMBIGUOUS_MINIMAL_EXTENSION_ID' : 'EXPECTED_MINIMAL_EXTENSION_NOT_FOUND');
    error.attempted = attempts;
    throw error;
  }
  return { ...matches[0], attempted: attempts };
}

// The *complete* SETUP discovery window covers both candidate enumeration and
// the popup/storage/worker check. A first unrelated background.js must not
// prematurely terminate discovery. Continue even after one match so a later
// second matching extension fails closed as ambiguous.
export async function discoverMinimalExtension({ collect, probe, timeoutMs = 9000,
  pollMs = 150, retryMs = 1500, clock = Date.now,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), onProgress = () => {} }) {
  const start = clock(), end = start + timeoutMs;
  const seen = new Set(), matches = new Map(), lastTried = new Map();
  const attempted = [], enumerationErrors = [];
  while (clock() < end) {
    let ids = [];
    try { ids = await collect(); }
    catch (error) { enumerationErrors.push({ elapsedMs: clock() - start, reason: String(error?.message ?? error) }); }
    for (const id of ids) seen.add(id);
    for (const id of seen) {
      if (clock() >= end) break;
      if (matches.has(id) || (lastTried.has(id) && clock() - lastTried.get(id) < retryMs)) continue;
      lastTried.set(id, clock());
      const entry = { id, elapsedMs: clock() - start };
      try {
        const observation = await probe(id, { remainingMs: Math.max(1, end - clock()) });
        if (eligible(observation)) { entry.verdict = 'MATCHED'; matches.set(id, observation); }
        else { entry.verdict = 'REJECTED'; entry.reason = 'POPUP_OR_WORKER_CONTRACT_MISMATCH'; }
      } catch (error) { entry.verdict = 'REJECTED'; entry.reason = String(error?.message ?? error); }
      attempted.push(entry);
      onProgress({ candidates: [...seen], attempted: [...attempted], enumerationErrors: [...enumerationErrors] });
      if (matches.size > 1) break;
    }
    if (matches.size > 1) break;
    const remaining = end - clock();
    if (remaining > 0) await pause(Math.min(pollMs, remaining));
  }
  const evidence = { candidates: [...seen], attempted, enumerationErrors,
    elapsedMs: clock() - start, budgetMs: timeoutMs };
  if (matches.size !== 1) {
    const error = new Error(matches.size > 1 ? 'AMBIGUOUS_MINIMAL_EXTENSION_ID' : 'EXPECTED_MINIMAL_EXTENSION_NOT_FOUND');
    error.identityEvidence = evidence;
    throw error;
  }
  const [id, observation] = matches.entries().next().value;
  return { id, observation, ...evidence };
}

// The selected ID has already passed the popup marker, storage sentinel, and
// worker ping checks. Capture the exact URLs used to scope subsequent CDP
// events; versionId / registrationId may change after a legitimate reload.
export function verifiedReloadIdentity(extensionId, workerEvents = [], registrationEvents = []) {
  if (typeof extensionId !== 'string' || !/^[a-p]{32}$/u.test(extensionId))
    throw new Error('VERIFIED_EXTENSION_ID_REQUIRED');
  const workerScriptURL = `chrome-extension://${extensionId}/background.js`;
  const registrationScopeURL = `chrome-extension://${extensionId}/`;
  return {
    extensionId, workerScriptURL, registrationScopeURL,
    initialWorkerVersionIds: [...new Set(workerEvents.filter(x => x.scriptURL === workerScriptURL).map(x => x.versionId))],
    initialRegistrationIds: [...new Set(registrationEvents.filter(x => x.scopeURL === registrationScopeURL).map(x => x.registrationId))],
  };
}

// Raw CDP events can contain Chromium built-ins and other unpacked extensions.
// An absent/ambiguous owner is never interpreted as evidence for this trial.
// Compare exact script/scope URLs, not an event sequence or an unscoped status.
export function targetReloadEvents(observation, identity) {
  if (!identity || typeof identity.extensionId !== 'string' ||
    identity.workerScriptURL !== `chrome-extension://${identity.extensionId}/background.js` ||
    identity.registrationScopeURL !== `chrome-extension://${identity.extensionId}/` ||
    !/^[a-p]{32}$/u.test(identity.extensionId))
    throw new Error('VERIFIED_EXTENSION_ID_REQUIRED');
  return {
    workers: (observation.workerEventsAfterReload ?? []).filter(x => x.scriptURL === identity.workerScriptURL),
    registrations: (observation.registrationEventsAfterReload ?? []).filter(x => x.scopeURL === identity.registrationScopeURL),
  };
}

// Functional failure alone does not prove that reload was actually invoked.
// Assess boundary and post-boundary execution exclusively with target-owned
// events; retain all raw unrelated events separately in the receipt.
export function assessDirectReload(observation, identity, { windowCompleted = true } = {}) {
  const owned = targetReloadEvents(observation, identity);
  const scoped = { ...observation,
    workerEventsAfterReload: owned.workers,
    registrationEventsAfterReload: owned.registrations };
  const functional = assessReload(scoped, windowCompleted);
  const invoked = observation.reloadInvocation?.evaluate === 'returned';
  const teardown = owned.workers.some(x => x.runningStatus === 'stopped')
    || owned.registrations.some(x => x.isDeleted === true);
  // A verified invocation does not mean that the observation window completed.
  const execution = windowCompleted && (invoked || teardown) ? 'COMPLETE' : 'INCOMPLETE';
  return { ...functional, execution,
    reloadResult: execution === 'COMPLETE' ? functional.reloadResult : 'UNVERIFIED',
    reloadInvocationConfirmed: invoked, reloadTeardownObserved: teardown,
    targetWorkerEventsAfterReload: owned.workers,
    targetRegistrationEventsAfterReload: owned.registrations };
}
