import {randomUUID} from 'node:crypto';
import {verificationSource} from './verification-source.mjs';
const compact=source=>({head:source.head,sourceSha256:source.sourceSha256});
export function beginVerificationIdentity(root) {
  return {verificationRunId:process.env.BRIDGE_VERIFICATION_RUN_ID || randomUUID(),source:compact(verificationSource(root))};
}
export function finishVerificationIdentity(root,identity) {
  const sourceAfter=compact(verificationSource(root));
  return {...identity,sourceAfter,candidateUnchanged:sourceAfter.head===identity.source.head
    && sourceAfter.sourceSha256===identity.source.sourceSha256};
}
export function identityMatches(receipt,{runId,source}) {
  return receipt?.verificationRunId===runId && receipt?.source?.head===source.head
    && receipt?.source?.sourceSha256===source.sourceSha256 && receipt?.candidateUnchanged===true
    && receipt?.sourceAfter?.head===source.head && receipt?.sourceAfter?.sourceSha256===source.sourceSha256;
}
export function sameUniqueMembers(actual,expected) {
  return Array.isArray(actual) && Array.isArray(expected) && expected.length>0
    && actual.every(item=>typeof item==='string') && expected.every(item=>typeof item==='string')
    && new Set(actual).size===actual.length && new Set(expected).size===expected.length
    && actual.length===expected.length && expected.every(item=>actual.includes(item));
}
export function resourceClosureUnconfirmed(receipt) {
  if(!receipt || typeof receipt!=='object') return false;
  if(receipt.cleanupError || receipt.cleanupFailure || receipt.receiptCleanupError || receipt.cleanupErrors?.length || receipt.closureConfirmed===false || receipt.forced===true
    || receipt.deadline===true && !receipt.closure) return true;
  return Object.entries(receipt).some(([key,value])=>!['source','sourceAfter','manifest'].includes(key)
    && value && typeof value==='object' && resourceClosureUnconfirmed(value));
}
