import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgress } from '../../scripts/e2e/progress.mjs';
test('progress counts completed top-level profiles, including failures, across split TAP chunks', () => {
  const output=[];
  const progress=createProgress(['UF-01A','UF-05','UF-23'],line=>output.push(line));
  progress.complete('UF-01A','PASS');
  progress.consume('# Subtest: UF-05 preparation\r\n    ok 1 - UF-05 nested\nnot o');
  assert.equal(progress.status(),'UF-05 running');
  progress.consume('k 1 - UF-05 preparation\nok 2 - UF-23 intervention');
  progress.flush();
  progress.complete('UF-23','PASS');
  assert.match(progress.status(),/waiting for summary\/process exit/u);
  assert.equal(output.length,5);
  assert.match(output[2],/33%.*1\/3 UF-05 running/u);
  assert.match(output[3],/66%.*2\/3 UF-05 FAIL/u);
  assert.match(output[4],/100%.*3\/3 UF-23 PASS.*process exit pending/u);
});
