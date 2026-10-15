// Bind the latest Windows ACK receipt to this invocation, not to a leftover
// result from an earlier successful run. Product protocol is not modified.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const expectedAckFiles = [
  'tests/delivery-ack-restart.test.js',
  'tests/delivery-terminal-reconciliation.test.js',
  'tests/discussion-response-atomicity.test.js',
];
export function evaluateAckReceipt({ runId, startedMs, endedMs = Date.now(), exitCode,
  resultFile, expectedFiles = expectedAckFiles }) {
  if (!runId || !Number.isFinite(startedMs) || !Number.isInteger(exitCode)) throw Error('ACK_RUN_METADATA_INVALID');
  const base = { verificationRunId:runId, startedAt:new Date(startedMs).toISOString(),
    finishedAt:new Date(endedMs).toISOString(), runnerExitCode:exitCode, status:'FAIL',
    receiptFresh:false, reason:null };
  let stats;
  try { stats = fs.statSync(resultFile); }
  catch (error) { return { ...base, reason:'RESULT_NOT_CREATED', errorCode:error.code ?? null }; }
  if (!stats.isFile() || stats.mtimeMs < startedMs) {
    return { ...base, reason:'STALE_RESULT_REJECTED', resultMtimeMs:stats.mtimeMs };
  }
  let result;
  try { result = JSON.parse(fs.readFileSync(resultFile,'utf8')); }
  catch (error) { return { ...base, reason:'INVALID_RESULT_JSON', error:error.message }; }
  const scopeOk = Array.isArray(result.scheduled) && result.scheduled.length === expectedFiles.length
    && expectedFiles.every((file,i)=>result.scheduled[i] === file)
    && Array.isArray(result.results) && result.results.length === expectedFiles.length
    && result.results.every((item,i)=>item.file === expectedFiles[i]);
  const passed = scopeOk && exitCode === 0 && result.status === 'PASS'
    && result.results.every(item=>item.pass === true && item.summaryStatus === 'COMPLETE');
  return { ...base, status:passed?'PASS':'FAIL', receiptFresh:true,
    reason:!scopeOk?'RESULT_SCOPE_MISMATCH':exitCode!==0?'RUNNER_EXIT_NONZERO':!passed?'TEST_FAILURE':null,
    resultMtimeMs:stats.mtimeMs, result };
}
export function writeAckReceipt(args, outputFile) {
  const result=evaluateAckReceipt(args);
  fs.mkdirSync(path.dirname(outputFile),{recursive:true});
  const tmp=`${outputFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(result,null,2)+'\n');
  fs.renameSync(tmp,outputFile);
  return result;
}
const own=fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1])===own) {
  const [runId,startedStr,exitStr,resultFile,outputFile]=process.argv.slice(2);
  try {
    if (!resultFile || !outputFile) throw Error('Usage: node ack-windows-result.mjs RUN_ID START_MS EXIT_CODE RESULT_FILE OUTPUT_FILE');
    const report=writeAckReceipt({runId,startedMs:Number(startedStr),exitCode:Number(exitStr),resultFile},outputFile);
    console.log('ACK_WINDOWS_RESULT '+JSON.stringify({runId:report.verificationRunId,status:report.status,
      reason:report.reason,receiptFresh:report.receiptFresh,runnerExitCode:report.runnerExitCode}));
    process.exitCode=report.status==='PASS'?0:1;
  } catch(error) {console.error(error);process.exitCode=2;}
}
