import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('persistent active Worker exits on parent stdin EOF and drains its pipes', {timeout:10000}, async t => {
  const child=spawn(process.execPath,[fileURLToPath(new URL('../../scripts/e2e/fixtures/active-worker.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');});
  const closed=once(child,'close');
  child.stderr.resume();
  const response=once(child.stdout,'data');
  child.stdin.write(JSON.stringify({id:1,method:'initialize'})+'\n');
  assert.equal(JSON.parse(String((await response)[0])).result.userAgent,'controlled-active-worker');
  assert.equal(child.exitCode,null,'app-server stays alive after a protocol response');
  child.stdout.resume();
  child.stdin.end();
  assert.deepEqual(await closed,[0,null]);
});
