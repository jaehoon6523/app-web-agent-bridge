import fs from 'node:fs';
import path from 'node:path';
import {runOwnedNode} from './e2e/platform/process.mjs';

// Keep evidence collection separate from resource closure. A returned exit
// code is not an exception and cannot by itself prove descendants are gone.
export async function collectNativeReloadControl({result,root,directory,identity,
  run=runOwnedNode,save=()=>{},onStdout=chunk=>process.stdout.write(chunk),onStderr=chunk=>process.stderr.write(chunk)}) {
  if(result.status!=='FAIL' || !result.extensionReloadDiagnostics || result.cleanupError) return;
  const controlDirectory=path.join(directory,'native-reload-control');
  result.reloadControl={script:'minimal-native-reload-matrix-v2.mjs',status:'RUNNING',originalNativeStatus:'FAIL'};
  save();
  let closure,receipt,error;
  try {
    fs.rmSync(controlDirectory,{recursive:true,force:true});
    closure=await run([path.join(root,'scripts/minimal-native-reload-matrix-v2.mjs')],{
      cwd:root,env:{...process.env,BRIDGE_VERIFICATION_OUTPUT:controlDirectory,
        UI_BROWSER_EXECUTABLE:result.browserExecutable.path},timeoutMs:180000,containDescendants:true,onStdout,onStderr});
    result.reloadControl.closure=closure;
  } catch(cause) {
    error=cause;
    Object.assign(result.reloadControl,{status:'UNVERIFIED',error:cause.message,errorCode:cause.code ?? null,
      closure:cause.closure ?? null,descendantCleanup:cause.descendantCleanup ?? null});
  }
  // A watchdog can interrupt after valid partial JSON was written. Preserve it
  // even when runOwnedNode throws; the catalog archives this entire directory.
  try {
    receipt=JSON.parse(fs.readFileSync(path.join(controlDirectory,'latest-minimal-native-reload-matrix-v2.json'),'utf8'));
    const matchingCases=Array.isArray(receipt.cases)?receipt.cases.filter(item=>['B','D'].includes(item?.id)):[];
    const expectedHash=result.browserExecutable.sha256,observedHash=result.browserExecutable.observed?.sha256;
    const validHash=value=>typeof value==='string' && /^[0-9a-f]{64}$/u.test(value);
    Object.assign(result.reloadControl,{status:error?'UNVERIFIED':'RECORDED',receipt,partialReceipt:Boolean(error || !receipt.finishedAt),
      matchingCandidate:receipt.gitHead===identity.source.head,
      matchingEnvironment:receipt.platform===process.platform && receipt.node===process.version,
      matchingBrowserVersion:matchingCases.length===2 && matchingCases.every(item=>item.browserVersion===result.browser),
      matchingExecutable:validHash(expectedHash) && observedHash===expectedHash
        && matchingCases.length===2 && new Set(matchingCases.map(item=>item.id)).size===2
        && matchingCases.every(item=>item.launch?.executableSha256===expectedHash
          && item.observations?.actualExecutableSha256===observedHash)});
  } catch(cause) {
    error ??=cause;
    Object.assign(result.reloadControl,{status:'UNVERIFIED',receiptError:cause.message});
  }
  const cases=receipt?.cases;
  const casesClean=Array.isArray(cases) && cases.every(item=>item?.cleanup?.status==='PASS'
    && item.childCleanup?.status!=='FAIL' && item.cleanup.childReported?.status!=='FAIL'
    && item.cleanup.childTerminationConfirmed!==false && item.cleanup.browserTerminationConfirmed!==false
    && item.cleanup.scratchRemoval!=='FAIL' && !(item.cleanup.survivorPids?.length));
  // Matrix exit 3 explicitly means cleanup was not PASS. Exit 2/4 may reflect
  // incomplete/failed observations with normal cleanup, so inspect both axes.
  const confirmed=!error && closure && Number.isInteger(closure.code) && closure.code!==3
    && closure.signal===null && closure.forced===false
    && receipt?.exitCode!==3 && receipt?.cleanupStatus==='PASS' && casesClean;
  result.reloadControl.closureConfirmed=Boolean(confirmed);
  result.reloadControl.cleanupStatus=confirmed?'PASS':'UNCONFIRMED';
  if(!confirmed) {
    result.status='FAIL';
    result.reloadControl.status='CLEANUP_UNCONFIRMED';
    result.cleanupError=error?.cleanupError || 'NATIVE_RELOAD_CONTROL_CLEANUP_UNCONFIRMED';
  }
  save();
}
