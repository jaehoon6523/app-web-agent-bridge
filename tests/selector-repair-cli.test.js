import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
test('CLI collects diagnostics, runs the real registered process and verification gate, then applies only with explicit hash approval', {timeout:90000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bridge-selector-cli-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const target = path.join(root,'target'); fs.mkdirSync(target);
  const source = fileURLToPath(new URL('../',import.meta.url));
  const git = (...args) => execFileSync('git',['-C',target,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init','-q');
  git('fetch','-q',source,'HEAD'); git('checkout','-q','--detach','FETCH_HEAD');
  fs.mkdirSync(path.join(target,'node_modules'));
  for (const name of fs.readdirSync(path.join(source,'node_modules'))) {
    if(!fs.statSync(path.join(source,'node_modules',name)).isDirectory())continue;
    fs.symlinkSync(path.join(source,'node_modules',name),path.join(target,'node_modules',name),process.platform==='win32'?'junction':undefined);
  }
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
 fs.writeFileSync('tests/selector-repair-observed.test.js',${JSON.stringify(newTest)});
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
  const cli=fileURLToPath(new URL('../scripts/repair-selectors.mjs',import.meta.url));
  const env={...process.env,DASHBOARD_TOKEN:'fixture-dashboard-token-0123456789',DEMO_MODE:'false',WEB_EXTENSION_SHARED_SECRET:'',WEB_EXTENSION_EXPECTED_IDENTITY:'',
    CODE_WORKER_PROVIDER:'gemini',CODE_WORKER_EXECUTABLE:process.execPath,CODE_WORKER_ARGS:JSON.stringify([worker])};
  const generated=await run(process.execPath,[cli,'--server',`http://127.0.0.1:${server.address().port}`,'--tab','7'],{cwd:target,env,timeout:80000});
  const result=JSON.parse(generated.stdout);assert.equal(result.stage,'AWAITING_APPROVAL');
  assert.equal(git('status','--porcelain'),'');
  assert.ok(fs.readFileSync(result.logFile,'utf8').includes('VERIFICATION_STARTED'));
  await assert.rejects(run(process.execPath,[cli,'--apply',result.jobId,'--approve','wrong'],{cwd:target,env}));
  await run(process.execPath,[cli,'--apply',result.jobId,'--approve',result.patchHash],{cwd:target,env});
  const inspected=await run(process.execPath,[cli,'--inspect',result.jobId],{cwd:target,env});
  assert.equal(JSON.parse(inspected.stdout).applicationState,'APPLIED');
  assert.match(fs.readFileSync(path.join(target,'extension/selectors/send-button-selectors.js'),'utf8'),/새로운 음성 입력/u);
});
