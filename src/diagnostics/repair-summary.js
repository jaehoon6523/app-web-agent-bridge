import fs from 'node:fs';
import path from 'node:path';
import { diagnosticId, diagnosticToken, diagnosticFlag } from './diagnostic-schema.js';
const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : null;
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value) ? value : null;
export function repairDiagnosticSummary(root, jobId) {
  if (!diagnosticId(jobId) || jobId.includes('_')) return {status:'NOT_CHECKED',reason:'REPAIR_JOB_UNAVAILABLE'};
  const directory = path.join(root,'.agent-controller','selector-repair',jobId);
  try {
    const statePath = path.join(directory,'state.json');
    if (fs.statSync(statePath).size > 262144) throw new Error('State size limit.');
    const state = JSON.parse(fs.readFileSync(statePath,'utf8'));
    if (state.jobId !== jobId) throw new Error('Job changed.');
    const patchHash = hash(state.capture?.artifact?.sha256);
    const filename = path.join(directory,'events.jsonl');
    const fd = fs.openSync(filename,'r');let text;
    try {
      const size = fs.fstatSync(fd).size, start = Math.max(0,size-65536), buffer = Buffer.alloc(size-start);
      fs.readSync(fd,buffer,0,buffer.length,start);text = buffer.toString('utf8');
      if (start) text = text.slice(text.indexOf('\n')+1);
    } finally {fs.closeSync(fd);}
    const events = text.trim().split('\n').slice(-128).filter(Boolean).map(line => JSON.parse(line));
    const verification = events.filter(e => e.phase === 'VERIFICATION_RESULT' && e.jobId === jobId && e.patchHash === patchHash)
      .slice(-16).map(e => ({verificationId:['lint','architecture','typecheck','regression'].includes(e.verificationId) ? e.verificationId : null,
        exitCode:Number.isSafeInteger(e.exitCode) ? e.exitCode : null,timedOut:diagnosticFlag(e.timedOut),
        aborted:diagnosticFlag(e.aborted),terminationConfirmed:diagnosticFlag(e.terminationConfirmed),
        candidateUnchanged:diagnosticFlag(e.candidateUnchanged),failed:diagnosticFlag(e.failed)}));
    return {status:'OBSERVED',jobId,jobStage:diagnosticToken(state.stage),baseCommit:commit(state.baseCommit),
      diagnosticHash:hash(state.diagnosticHash),patchHash,verification,
      verificationStatus:verification.length === 4 && new Set(verification.map(v => v.verificationId)).size === 4
        && verification.every(v => v.exitCode === 0 && v.timedOut === false && v.aborted === false
          && v.terminationConfirmed === true && v.candidateUnchanged === true && v.failed === false) ? 'PASSED' : verification.some(v => v.exitCode !== null && v.exitCode !== 0 || v.timedOut === true
          || v.aborted === true || v.failed === true || v.terminationConfirmed === false || v.candidateUnchanged === false) ? 'FAILED' : 'UNVERIFIED',
      approval:state.stage === 'AWAITING_APPROVAL' ? 'REQUIRED' : events.some(e => e.phase === 'APPLY_STARTED' && e.patchHash === patchHash) ? 'HASH_APPROVAL_RECORDED' : 'NOT_OBSERVED',
      application:state.stage === 'APPLIED' ? 'RECORDED_APPLIED' : state.stage === 'APPLY_FAILED' ? 'UNCONFIRMED' : 'NOT_APPLIED',
      liveValidation:'NOT_CHECKED'};
  } catch {return {status:'UNAVAILABLE',jobId,reason:'REPAIR_JOURNAL_UNAVAILABLE'};}
}
