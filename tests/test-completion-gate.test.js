import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {runFile, runFiles} from '../scripts/run-tests.mjs';

function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bridge-gate-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const filename = path.join(root,'case.mjs');
  fs.writeFileSync(filename,source);
  return filename;
}
const quiet = {output:()=>{}};

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
