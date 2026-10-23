import fs from 'node:fs';
import {fixture as baseFixture} from './audit-recovery-fixtures.js';

export function fixture(t, hooks) {
  const started = performance.now();
  // Synchronous stderr survives a later synchronous Git/SQLite stall.
  const trace = phase => fs.writeSync(2, 'ACK_RECOVERY_PHASE ' + JSON.stringify({test:t.name,
    phase,elapsedMs:Math.round(performance.now()-started)}) + '\n');
  trace('fixture.start');
  t.after(() => trace('cleanup.start'));
  const f = baseFixture(t, hooks);
  t.after(() => trace('cleanup.after'));
  trace('fixture.ready');
  for (const phase of ['start','run','reopen']) {
    const original = f[phase];
    f[phase] = async function(...args) {
      trace(phase+'.start');
      try { const result = await original.apply(this,args); trace(phase+'.done'); return result; }
      catch (error) { trace(phase+'.failed'); throw error; }
    };
  }
  return f;
}
