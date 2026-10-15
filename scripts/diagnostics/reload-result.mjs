// Module D: pure verdicts and durable receipts. Never launch/observe a browser here.
import fs from 'node:fs';
import { atomicWrite, assessMatrix } from '../mv3-reload-core.mjs';
import { assessDirectReload, targetReloadEvents, verifyExecutionContext } from '../direct-mv3-identity.mjs';

export const RELOAD_SCOPE = 'minimal-mv3-runtime.reload/direct-cdp/fresh-A-B';
export const WINDOWS_SCOPE = 'windows-diagnostics/regression+ack+minimal-reload';

export function classifyReload(trial) {
  const observation = trial.observations ?? {};
  const identity = trial.verifiedExtension;
  const browser = trial.browserProcessLifecycle;
  const browserExecution = { status: browser?.exitedAt ? browser.code === 0 && browser.signal === null ? 'PASS' : 'FAIL' : 'UNCONFIRMED',
    exit: browser ?? null, ready: trial.browserReady === true };
  const none = { execution: 'INCOMPLETE', functionalRecovery: 'UNVERIFIED', reloadResult: 'UNVERIFIED', browserExecution,
    reloadBoundaryEvidence: 'NOT_OBSERVED', reloadInvocationConfirmed: false, reloadTeardownObserved: false,
    evidenceUsed: [], childExecution: trial.childExecution ?? { status: 'UNCONFIRMED' },
    cleanup: trial.cleanup ?? trial.childCleanup ?? { status: 'UNCONFIRMED' } };
  const args = trial.actualArgsEvidence;
  const sourceObserved = /^[a-f0-9]{40}$/u.test(trial.source?.commit ?? '') && !trial.source?.error
    && Object.keys(trial.source?.hashErrors ?? {}).length === 0;
  const comparisonValidity = args?.matchesRequested === false || args?.browserExecutableMatches === false ? 'INVALID' :
    !sourceObserved || args?.status !== 'OBSERVED' || args?.browserExecutableMatches !== true ? 'UNVERIFIED' :
      args.matchesRequested === true && trial.fixtureHashesVerified === true ? 'VALID' : 'UNVERIFIED';
  if (!identity?.setupVerified) return { ...none, comparisonValidity, reason: 'SETUP_NOT_VERIFIED' };
  const owned = targetReloadEvents(observation, identity);
  const ended = observation.window?.completed === true;
  const call = observation.reloadInvocation ?? {};
  const contextValid = verifyExecutionContext(identity.extensionId, call.context);
  const invocationConfirmed = call.attempted === true && contextValid && call.evaluate === 'returned';
  const registrationDeleted = owned.registrations.some(event => event.isDeleted === true);
  const invocationOrBoundary = call.attempted === true && contextValid && (invocationConfirmed || registrationDeleted);
  const after = observation.successfulPopup ?? observation.popupAfter ?? {};
  const afterValid = verifyExecutionContext(identity.extensionId, after.context);
  const assessed = assessDirectReload({ ...observation,
    popupAfter: afterValid ? after : { popupAccessible: false },
    reloadInvocation: { ...call, evaluate: invocationConfirmed ? 'returned' : 'interrupted' } }, identity,
  { windowCompleted: ended });
  const execution = ended && invocationOrBoundary ? 'COMPLETE' : 'INCOMPLETE';
  const evidenceUsed = ['source.commit', 'source.files', 'actualArgsEvidence', 'fixtureHashesVerified',
    'childExecution', 'cleanup', 'verifiedExtension.initialProbe', 'observations.reloadInvocation', 'observations.window',
    ...(afterValid ? [observation.successfulPopup ? 'observations.successfulPopup' : 'observations.popupAfter'] : []),
    ...owned.workers.map(event => `observations.workerEventsAfterReload[sequence=${event.sequence}]`),
    ...owned.registrations.map(event => `observations.registrationEventsAfterReload[sequence=${event.sequence}]`)];
  return { ...assessed, execution, browserExecution, reloadInvocationConfirmed: invocationConfirmed,
    reloadResult: execution === 'COMPLETE' ? assessed.reloadResult : 'UNVERIFIED',
    comparisonValidity, evidenceUsed, childExecution: none.childExecution, cleanup: none.cleanup };
}

export function classifyComparison(cases, prior = null) {
  const aggregate = assessMatrix(cases, 2);
  const comparisonValidity = cases.some(x => x.comparisonValidity === 'INVALID') || prior?.executableMatch === false
    || prior?.fixtureMatch === false ? 'INVALID' : cases.length !== 2
    || cases.some(x => x.comparisonValidity !== 'VALID') ? 'UNVERIFIED' : 'VALID';
  const priorComparisonValidity = !prior ? 'UNVERIFIED' : prior.executableMatch === true && prior.fixtureMatch === true
    && prior.headlessMatch === true ? 'VALID' : prior.executableMatch === false || prior.fixtureMatch === false
    || prior.headlessMatch === false ? 'INVALID' : 'UNVERIFIED';
  const browserExecutionStatus = cases.length === 2 && cases.every(x => x.browserExecution?.status === 'PASS') ? 'PASS' :
    cases.some(x => x.browserExecution?.status === 'FAIL') ? 'FAIL' : 'UNCONFIRMED';
  return { ...aggregate, comparisonValidity, priorComparisonValidity, browserExecutionStatus,
    exitCode: comparisonValidity === 'INVALID' ? 5 : aggregate.cleanupStatus !== 'PASS' ? 3 :
      aggregate.childExecutionStatus === 'FAIL' || browserExecutionStatus === 'FAIL' ? 4 :
        aggregate.exitCode !== 0 ? aggregate.exitCode : browserExecutionStatus !== 'PASS' ? 2 : 0 };
}

export function writeReceipt(file, record) {
  if (!record.verificationRunId || !record.scope || !record.startedAt) throw Error('RESULT_METADATA_REQUIRED');
  atomicWrite(file, { ...record, generatedAt: new Date().toISOString() });
}

export function readReceipt(file, { runId, scope, startedMs, exitCode }) {
  const base = { status: 'FAIL', receiptFresh: false, reason: null };
  let result;
  try { result = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return { ...base, reason: error.code === 'ENOENT' ? 'RESULT_NOT_CREATED' : 'INVALID_RESULT_JSON', error: error.message }; }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { ...base, reason: 'INVALID_RESULT_JSON' };
  if (result.verificationRunId !== runId) return { ...base, reason: 'RESULT_RUN_MISMATCH' };
  if (result.scope !== scope) return { ...base, reason: 'RESULT_SCOPE_MISMATCH' };
  if (scope === RELOAD_SCOPE) {
    const expected = [{ id: 'A', unsafe: false }, { id: 'B', unsafe: true }];
    if (!Array.isArray(result.requestedConditions) || result.requestedConditions.length !== 2
      || !expected.every((spec, i) => result.requestedConditions[i]?.id === spec.id
        && result.requestedConditions[i]?.unsafe === spec.unsafe)
      || !Array.isArray(result.cases) || result.cases.some((trial, i) => trial.id !== expected[i]?.id
        || trial.verificationRunId !== runId || trial.scope !== scope)
      || (result.execution === 'COMPLETE' && result.cases.length !== 2))
      return { ...base, reason: 'RESULT_SCOPE_MISMATCH' };
  }
  const start = Date.parse(result.startedAt), generated = Date.parse(result.generatedAt), end = Date.parse(result.finishedAt);
  if (![start, generated, end].every(Number.isFinite) || start < startedMs || end < start || generated < end)
    return { ...base, reason: 'RESULT_NOT_CURRENT_TERMINAL' };
  if (result.terminal !== true || result.exitCode !== exitCode || !Number.isInteger(exitCode))
    return { ...base, reason: 'RESULT_TERMINATION_MISMATCH' };
  return { status: 'OBSERVED', receiptFresh: true, reason: null, result };
}
