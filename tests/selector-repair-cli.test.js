import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {createSourceCheckout,linkDependencies} from './helpers/source-checkout.mjs';
import {beginTestEvidenceRun} from './helpers/failure-evidence.mjs';
const run = promisify(execFile);
const source = fileURLToPath(new URL('../',import.meta.url));
let evidenceRun;
before(() => { evidenceRun = beginTestEvidenceRun(source,'selector-repair-cli'); });
after(() => evidenceRun?.close());
async function scenario(t, evidence, failVerification) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bridge-selector-cli-'));
  const target = path.join(root,'target');
  t.after(() => {
    evidence.preserve(target);
    try { fs.rmSync(root,{recursive:true,force:true}); }
    catch (error) { evidence.record.cleanupErrors.push(error.message); throw error; }
    finally { evidence.close(); }
  });
  const snapshot = createSourceCheckout(source,target);
  evidence.record.snapshot = snapshot; evidence.save(); linkDependencies(source,target);
  const git = (...args) => execFileSync('git',['-C',target,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const version=JSON.parse(fs.readFileSync(path.join(target,'extension/manifest.json'))).version;
  const worker=path.join(root,'worker.mjs');
  const newTest = `import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
test('observed new dictation label is in the production registry', () => {
 const context=vm.createContext({});
 for (const file of ['selector-version.js','send-button-selectors.js']) vm.runInContext(fs.readFileSync(new URL('../extension/selectors/'+file,import.meta.url),'utf8'),context);
 assert.ok(context.ChatGptBridgeSelectors.groups.dictationButton.includes("button[aria-label='새로운 음성 입력']"));
});`;
  fs.writeFileSync(worker, `import fs from 'node:fs'; import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.type!=='turn')return;
 if(!m.text.includes('REPAIR_COMPOSER_DETECTION'))process.exit(2);
 const file='extension/selectors/send-button-selectors.js';
 fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('registry.groups.dictationButton = Object.freeze([', 'registry.groups.dictationButton = Object.freeze([\\n    "button[aria-label=\\\'새로운 음성 입력\\\']",'));
 fs.writeFileSync('tests/selector-repair-observed.test.js',${JSON.stringify(failVerification ? newTest.replace('assert.ok(context.', "assert.fail('SYNTHETIC_INNER_VERIFICATION'); assert.ok(context.") : newTest)});
 console.log(JSON.stringify({type:'completion',sessionId:m.sessionId,turnId:m.turnId,status:'completed',text:'{"summary":"fixture change","unverified":["live provider"]}'}));
});`);
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/dashboard/session' && req.method==='POST')return res.end(JSON.stringify({token:'fixture-token'}));
    if(req.url==='/api/selector-diagnostics' && req.headers.authorization==='Bearer fixture-dashboard-token-0123456789' )return res.end(JSON.stringify({tabs:[{
      tabId:7, runtimeVersion:version, extensionVersion:version,url:"https://chatgpt.com/",pageUrl:"https://chatgpt.com/", composerPresent:false, busy:false, generating:false, pageStatus:'UI_CONTRACT_CHANGED', diagnostics:{editableCandidates:[{
        selector:"[contenteditable='true']",visible:1,samples:[{tagName:'DIV',role:'textbox',contentEditable:'true',inForm:true,inMain:true,
          controls:[{controlLabel:'새로운 음성 입력',acceptedByVisibility:true}]}]}]}}]}));
    res.writeHead(403);res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const cli=path.join(target,'scripts/repair-selectors.mjs');
  const env={...process.env,DASHBOARD_TOKEN:'fixture-dashboard-token-0123456789',DEMO_MODE:'false',WEB_EXTENSION_SHARED_SECRET:'',WEB_EXTENSION_EXPECTED_IDENTITY:'',
    CODE_WORKER_PROVIDER:'gemini',CODE_WORKER_EXECUTABLE:process.execPath,CODE_WORKER_ARGS:JSON.stringify([worker])};
  try {
  const generated=await evidence.command(process.execPath,[cli,'--server',`http://127.0.0.1:${server.address().port}`,'--tab','7'],{cwd:target,env,timeout:80000,maxBuffer:8*1024*1024},run);
  const result=JSON.parse(generated.stdout);assert.equal(result.stage,'AWAITING_APPROVAL');
  assert.equal(git('status','--porcelain'),'');
  assert.ok(fs.readFileSync(result.logFile,'utf8').includes('VERIFICATION_STARTED'));
  await assert.rejects(evidence.command(process.execPath,[cli,'--apply',result.jobId,'--approve','wrong'],{cwd:target,env,timeout:15000},run));
  await evidence.command(process.execPath,[cli,'--apply',result.jobId,'--approve',result.patchHash],{cwd:target,env,timeout:15000},run);
  const inspected=await evidence.command(process.execPath,[cli,'--inspect',result.jobId],{cwd:target,env,timeout:15000},run);
  assert.equal(JSON.parse(inspected.stdout).applicationState,'APPLIED');
  assert.match(fs.readFileSync(path.join(target,'extension/selectors/send-button-selectors.js'),'utf8'),/새로운 음성 입력/u);
  if (failVerification) assert.fail('Expected internal verification to fail');
  } catch (error) {
    evidence.preserve(target);
    t.diagnostic('Failure evidence: '+evidence.directory);
    if (!failVerification) throw error;
    assert.match(error.stderr,/REPAIR_VERIFICATION_FAILED/u);
    fs.rmSync(root,{recursive:true,force:true});
    const jobs = path.join(evidence.directory,'internal/selector-repair');
    const job = fs.readdirSync(jobs).find(name => /^[a-f0-9-]{36}$/u.test(name));
    const rows = fs.readFileSync(path.join(jobs,job,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    const check = rows.find(row => row.phase === 'VERIFICATION_RESULT' && row.verificationId === 'regression');
    assert.equal(check.exitCode,1); assert.equal(check.signal,null); assert.equal(check.timedOut,false);
    assert.equal(typeof check.cwd,'string'); assert.ok(check.args.includes('scripts/run-tests.mjs'));
    const internal = JSON.parse(fs.readFileSync(path.join(jobs,job,'artifacts',check.executionEvidence.contentRef.sha256.slice(7)),'utf8'));
    assert.match(internal.stdout,/SYNTHETIC_INNER_VERIFICATION/u); assert.equal(typeof internal.stderr,'string');
    assert.ok(check.receipts.length >= 2); assert.equal(internal.candidateId,check.executionEvidence.candidateId);
    assert.equal(fs.existsSync(root),false);
  }
}

function repairTest(name, failVerification = false) {
  test(name,{timeout:90000},async t => {
    const evidence = evidenceRun.scenario(failVerification ? 'inner-failure' : 'repair-apply');
    try { await scenario(t,evidence,failVerification); evidence.finish(null); }
    catch (error) { evidence.finish(error); t.diagnostic('Failure evidence: '+evidence.directory); throw error; }
  });
}
repairTest('CLI collects diagnostics, runs the real registered process and verification gate, then applies only with explicit hash approval');
repairTest('CLI internal failure evidence remains readable after the temporary checkout is removed',true);
