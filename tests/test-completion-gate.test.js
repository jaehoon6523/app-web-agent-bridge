import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {ChildProcess, execFileSync} from 'node:child_process';
import {runFile, runFiles, reporter} from '../scripts/run-tests.mjs';
import {executeVerification} from '../scripts/verification-engine.mjs';
import {verificationSource} from '../scripts/verification-source.mjs';
import {runOwnedNode} from '../scripts/e2e/platform/process.mjs';

function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bridge-gate-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const filename = path.join(root,'case.mjs');
  fs.writeFileSync(filename,source);
  return filename;
}
const quiet = {output:()=>{}};

function failReceiptClose(t) {
  const open = fs.openSync, close = fs.closeSync;
  let descriptor;
  t.mock.method(fs,'openSync',(file,...args)=>{
    const fd = open(file,...args);
    if (path.basename(String(file))==='completion.json') descriptor=fd;
    return fd;
  });
  t.mock.method(fs,'closeSync',fd=>{
    close(fd);
    if (fd===descriptor) {descriptor=undefined;throw Error('Synthetic receipt descriptor close failure');}
  });
}

test('completion receipt survives its directory moving before the reporter finishes', async t => {
  const filename = fixture(t, `import test from 'node:test'; import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict'; import {fileURLToPath} from 'node:url';
    test('finished after move', () => {
      const root=path.dirname(fileURLToPath(import.meta.url));
      const physical=path.dirname(process.env.BRIDGE_TEST_RECEIPT);
      // Windows cannot rename a physical directory containing an open file.
      // Rename its junction namespace instead: the advertised receipt path still disappears.
      if(process.platform==='win32') {
        const alias=path.join(root,'receipt-alias');fs.symlinkSync(physical,alias,'junction');
        process.env.BRIDGE_TEST_RECEIPT=path.join(alias,'completion.json');
      }
      const advertised=process.env.BRIDGE_TEST_RECEIPT, moved=path.join(root,'moved-receipt');
      fs.renameSync(path.dirname(advertised),moved);
      assert.equal(fs.existsSync(advertised),false);
      assert.equal(fs.statSync(path.join(moved,'completion.json')).ino,fs.fstatSync(3).ino);
    });`);
  let transcript = '';
  const result = await runFile(filename, {output:chunk=>{transcript+=chunk;}});
  assert.equal(result.pass, true, transcript);
  assert.equal(result.summaryStatus, 'COMPLETE');
  assert.equal(result.summary.passed, 1);
  assert.deepEqual(result.closure, {code:0,signal:null});
});

test('completion descriptors remain isolated when a test runs another file', async t => {
  const inner = fixture(t, "import test from 'node:test'; test('inner',()=>{});");
  const outer = fixture(t, `import test from 'node:test'; import assert from 'node:assert/strict';
    import {runFile} from ${JSON.stringify(new URL('../scripts/run-tests.mjs',import.meta.url).href)};
    test('nested', async()=>assert.equal((await runFile(${JSON.stringify(inner)},{output:()=>{}})).pass,true));
    test('outer second',()=>{});`);
  const result = await runFile(outer, quiet);
  assert.equal(result.pass,true); assert.equal(result.summary.passed,2);
  assert.equal(result.summary.plan,2); assert.deepEqual(result.closure,{code:0,signal:null});
});

test('the completion reporter retains standalone path-based receipt support', t => {
  const filename = fixture(t, "import test from 'node:test'; test('standalone',()=>{});");
  const receipt = path.join(path.dirname(filename),'completion.json');
  const env = {...process.env,BRIDGE_TEST_RECEIPT:receipt,BRIDGE_TEST_FILE:filename};
  delete env.BRIDGE_TEST_RECEIPT_FD; delete env.NODE_TEST_CONTEXT;
  execFileSync(process.execPath,['--test','--experimental-test-isolation=none','--test-reporter='+reporter,filename],{env,windowsHide:true});
  const summary = JSON.parse(fs.readFileSync(receipt,'utf8'));
  assert.equal(summary.completed,true); assert.equal(summary.passed,1); assert.equal(summary.failed,0);
});

test('a completion descriptor closes if child creation throws', async t => {
  const filename = fixture(t, "import test from 'node:test'; test('unstarted',()=>{});");
  const open = fs.openSync, fault = Error('Synthetic child creation failure');
  let descriptor, directory;
  t.mock.method(fs,'openSync',(file,...args)=>{
    const fd = open(file,...args);
    if (path.basename(String(file))==='completion.json') {descriptor=fd;directory=path.dirname(file);}
    return fd;
  });
  t.mock.method(ChildProcess.prototype,'spawn',()=>{throw fault;});
  await assert.rejects(runFile(filename,quiet),error=>error===fault);
  assert.throws(()=>fs.fstatSync(descriptor),{code:'EBADF'});
  assert.equal(fs.existsSync(directory),false);
  const remove = fs.rmSync;
  t.mock.method(fs,'rmSync',(target,options)=>{
    remove(target,options);
    if (path.basename(String(target)).startsWith('bridge-test-receipt-')) throw Error('Synthetic launch cleanup failure');
  });
  const output = path.join(path.dirname(filename),'launch-result');
  await assert.rejects(runFiles([filename],{...quiet,directory:output}),error=>error===fault);
  const saved = JSON.parse(fs.readFileSync(path.join(output,'latest-test-result.json'),'utf8'));
  assert.equal(saved.status,'FAIL'); assert.equal(saved.cleanupError,'Synthetic launch cleanup failure');
});

test('completion descriptor close failure cannot leave a passing result', async t => {
  failReceiptClose(t);
  for (const failed of [false,true]) {
    const filename = fixture(t, `import test from 'node:test'; test('finished',()=>{if(${failed})throw Error('original failure');});`);
    const result = await runFile(filename,quiet);
    assert.equal(result.summary.completed,true); assert.equal(result.summary.failed,failed?1:0);
    assert.equal(result.pass,false); assert.equal(result.reason,failed?'TEST_FAILURE':'CLEANUP_FAILURE');
    assert.equal(result.receiptCleanupError,'Synthetic receipt descriptor close failure');
  }
});

test('unconfirmed descriptor closure blocks later files and verification stages', async t => {
  const first = fixture(t, "import test from 'node:test'; test('finished',()=>{});");
  const root = path.dirname(first), directory = path.join(root,'.agent-controller'), marker = path.join(root,'must-not-run');
  const second = fixture(t, `import test from 'node:test'; import fs from 'node:fs'; test('later',()=>fs.writeFileSync(${JSON.stringify(marker)},'ran'));`);
  const files = [first,second], source = verificationSource(process.cwd());
  const entry = path.join(root,'gate.mjs');
  fs.writeFileSync(entry, `import fs from 'node:fs'; import path from 'node:path';
    import {runFiles} from ${JSON.stringify(new URL('../scripts/run-tests.mjs',import.meta.url).href)};
    const open=fs.openSync,close=fs.closeSync; let descriptor;
    fs.openSync=(file,...args)=>{const fd=open(file,...args);if(path.basename(String(file))==='completion.json')descriptor=fd;return fd;};
    fs.closeSync=fd=>{close(fd);if(fd===descriptor){descriptor=undefined;throw Error('Synthetic receipt descriptor close failure');}};
    const result=await runFiles(${JSON.stringify(files)},{directory:${JSON.stringify(directory)},output:()=>{}});
    process.exitCode=result.status==='PASS'?0:1;`);
  let laterStage = false;
  const result = await executeVerification({root,directory,source,readSource:()=>source,
    plan:[{id:'gate',applicable:true,needs:[],required:true,receipt:'gate',expectedFiles:files.map(file=>path.relative(process.cwd(),file).split(path.sep).join('/'))},
      {id:'later',applicable:true,needs:[],required:true,status:'NOT_RUN'}],
    async run(stage,{stageRunId}) {
      if (stage.id==='later') {laterStage=true;return {code:0,signal:null,forced:false};}
      const env={...process.env,BRIDGE_VERIFICATION_RUN_ID:stageRunId}; delete env.NODE_TEST_CONTEXT;
      return runOwnedNode([entry],{cwd:process.cwd(),env,timeoutMs:10000});
    }});
  const receipt=result.stages[0].receipt;
  assert.equal(receipt.status,'FAIL'); assert.equal(receipt.results.length,1);
  assert.equal(fs.existsSync(marker),false); assert.equal(laterStage,false);
  assert.deepEqual(result.stages[0].closure,{code:1,signal:null,forced:false});
  assert.equal(result.stages[0].status,'FAIL');
  assert.equal(result.stages[1].reason,'RESOURCE_CLOSURE_UNCONFIRMED');
});

test('completion gate rejects exit zero before or during registered tests', async t => {
  for (const source of ['process.exit(0);',
    "import test from 'node:test'; test('early',()=>process.exit(0)); test('missing',()=>{});"]) {
    const result = await runFile(fixture(t,source),quiet);
    assert.equal(result.closure.code,0);
    assert.equal(result.pass,false);
    assert.equal(result.reason,'MISSING_RECEIPT');
    assert.equal(result.summaryStatus,'MISSING');
  }
});

test('completion gate rejects failures, unexpected skip, zero tests and hanging work', async t => {
  for (const source of ["import test from 'node:test'; test('bad',()=>{throw Error('failure');});",
    "import test from 'node:test'; test.skip('omitted',()=>{});", 'void 0;', 'setInterval(()=>{},1000);']) {
    const result = await runFile(fixture(t,source),{...quiet,timeoutMs:1000});
    assert.equal(result.pass,false);
  }
});

test('completion gate completes every selected file and replaces previous results', async t => {
  const good = fixture(t,"import test from 'node:test'; test('done',()=>{});");
  const bad = fixture(t,'process.exit(0);');
  const directory = path.dirname(good);
  const failed = await runFiles([bad,good],{...quiet,directory});
  assert.equal(failed.status,'FAIL');
  assert.equal(failed.results.length,2);
  assert.equal(failed.results[1].pass,true);
  const passed = await runFiles([good],{...quiet,directory});
  assert.equal(passed.status,'PASS');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'latest-test-result.json'))).results.length,1);
  assert.equal(fs.readFileSync(path.join(directory,'latest-test.log'),'utf8').includes('INCOMPLETE_TEST_RUN'),false);
});

test('receipt cleanup failure retains the original verification result and a separate cleanup error', async t => {
  const filename = fixture(t,"import test from 'node:test'; test('original failure',()=>{throw Error('original evidence');});");
  const original = fs.rmSync;
  let rejectedDirectory;
  t.after(() => { if (rejectedDirectory) fs.rmSync(rejectedDirectory,{recursive:true,force:true}); });
  fs.rmSync = (target,options) => {
    if (path.basename(String(target)).startsWith('bridge-test-receipt-')) {
      rejectedDirectory = target; throw Error('Synthetic receipt cleanup failure');
    }
    return original(target,options);
  };
  let result;
  try { result = await runFile(filename,quiet); }
  finally { fs.rmSync = original; }
  assert.equal(result.closure.code,1); assert.equal(result.summary.failed,1);
  assert.equal(result.reason,'TEST_FAILURE'); assert.equal(result.pass,false);
  assert.equal(result.receiptCleanupError,'Synthetic receipt cleanup failure');
});
