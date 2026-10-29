import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { skippedTests, summarizeRun } from '../../scripts/e2e/summary.mjs';
import { productionProcess } from '../../scripts/e2e/helpers/process.mjs';
import { removeOwnedFixture } from '../../scripts/e2e/helpers/owned-fixture.mjs';
import { observeChildClose, waitChildClose } from '../../src/runtime/child-close.js';
const profiles = [
  { id:'UF-01A', specWave:'W1-4 COMPLETE', execution:'RUNNABLE' },
  { id:'UF-05', specWave:'W1-4 COMPLETE', execution:'BLOCKED', gap:'H-EXT + H-PREP: missing transport' },
];
const results = () => new Map([['UF-01A',{outcome:'PASS'}],['UF-05',{outcome:'INITIAL_SPINE_PASS'}]]);
const skips = [{ name:'UF-05 full continuation', reason:profiles[1].gap }];

test('E2E summary separates observed full profiles, initial spine and blocked continuation', () => {
  const summary = summarizeRun(profiles, results(), skips);
  assert.equal(summary.specComplete, 2);
  assert.equal(summary.fullRunnablePassed, 1);
  assert.equal(summary.initialSpinePassed, 1);
  assert.equal(summary.continuationBlocked, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.unexpectedSkips, 0);
  assert.equal(summary.verdict, 'SPINE_GATE_PASS_WITH_BLOCKED_CONTINUATIONS');
});
test('a declared runnable profile with no observed result never contributes a PASS', () => {
  const observed = results(); observed.delete('UF-01A');
  const summary = summarizeRun(profiles, observed, skips);
  assert.equal(summary.fullRunnablePassed, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.verdict, 'FAIL');
});
test('unplanned, duplicate and changed-reason skips are gate failures', () => {
  for (const extra of [skips[0], {name:'unexpected test',reason:'skip'}, {name:skips[0].name,reason:'changed reason'}]) {
    const summary = summarizeRun(profiles, results(), [...skips, extra]);
    assert.equal(summary.unexpectedSkips, 1);
    assert.equal(summary.verdict, 'FAIL');
  }
});
test('blocked initial spine requires its continuation skip to be actually observed', () => {
  const summary = summarizeRun(profiles, results(), []);
  assert.equal(summary.initialSpinePassed, 0);
  assert.equal(summary.failed, 1);
});
test('a child gate failure cannot be hidden by apparently passing artifacts', () => {
  const summary = summarizeRun(profiles, results(), skips, true);
  assert.equal(summary.failed, 1);
  assert.equal(summary.verdict, 'FAIL');
});
test('TAP parser preserves exact continuation reasons and observes reasonless skips', () => {
  assert.deepEqual(skippedTests('    ok 1 - UF-05 full continuation # SKIP H-EXT + H-PREP: missing transport\nok 2 - unknown # SKIP\n# skipped 2\n'),
    [...skips, {name:'unknown',reason:''}]);
});


test('full observed closure has a bounded full-profile verdict without blocked continuations', () => {
  const summary=summarizeRun([profiles[0]],new Map([['UF-01A',{outcome:'PASS'}]]),[]);
  assert.equal(summary.continuationBlocked,0);
  assert.equal(summary.verdict,'FULL_PROFILE_PASS_CONTROLLED_EXTERNAL_BOUNDARIES');
});

test('production disposal preserves its workspace while an observed active Worker is still alive', {timeout:20000}, async t => {
  const fixture = await productionProcess({worker:'active'});
  const observed = path.join(fixture.workspace,'worker-observed.json');
  t.after(async () => {
    fs.rmSync(observed,{force:true});
    await fixture.dispose();
  });
  await fixture.ready();
  // This liveness marker is the test process; disposal must observe it without killing it.
  fs.writeFileSync(observed,JSON.stringify({pid:process.pid}));
  await assert.rejects(fixture.dispose(),error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some(cause => /active Worker child must exit/u.test(cause.message)));
    return true;
  });
  assert.ok(fs.existsSync(observed),'unconfirmed Worker ownership keeps the entire fixture');
  fixture.assertShutdown(fixture.logs().shutdown);
});

test('production disposal preserves closure errors and its workspace after a child shutdown deadline', {timeout:20000}, async t => {
  const spawn = ChildProcess.prototype.spawn;
  let child, observation;
  t.mock.method(ChildProcess.prototype,'spawn',function(...args) {
    const result=spawn.apply(this,args);
    if(this.connected) {
      child=this;observation=observeChildClose(child);
      const send=child.send;
      t.mock.method(child,'send',function(message,...rest) {
        if(message?.type==='bridge.shutdown')return true;
        return send.call(this,message,...rest);
      });
    }
    return result;
  });
  const fixture = await productionProcess();
  t.after(async () => {
    if(child && !observation.result) {
      child.kill('SIGKILL');
      await waitChildClose(child,observation,{timeoutMs:3000});
    }
    if(observation?.result)await removeOwnedFixture(fixture.workspace);
  });
  await fixture.ready();
  await assert.rejects(fixture.dispose(),error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some(cause => cause.code==='CHILD_CLOSE_DEADLINE'));
    return true;
  });
  assert.equal(fixture.logs().shutdown.closureError,'CHILD_CLOSE_DEADLINE');
  assert.ok(fs.existsSync(fixture.workspace),'a closure failure preserves the owned workspace');
  assert.ok(observation.result,'containment must close the real child before test cleanup');
});
