import { reviewedRun, applyRun } from './lifecycle.mjs';
import { notes, discussion, archive, followup, lock, auth, intervention, binding, restart, discard, providerFault, changedTarget, settledRunRestart } from './operations.mjs';
export async function closureFlow(t,f,id) {
  if(id==='UF-16') return providerFault(t,f);
  if(id==='UF-11') { await restart(t,f); return settledRunRestart(t); }
  if(id==='UF-12') return binding(t,f);
  if(id==='UF-22') return discard(t,f);
  if(id==='UF-23') return intervention(t,f);
  if(id==='UF-15') return lock(t,f);
  if(id==='UF-17') return auth(f);
  const setup=await reviewedRun(t,f,{rework:['UF-09','UF-10'].includes(id)});
  if(id==='UF-10') { await applyRun(t,f,setup); await changedTarget(t); }
  if(id==='UF-18') await discussion(f,setup);
  if(id==='UF-19') await notes(f,setup);
  if(['UF-20','UF-21'].includes(id)) { const applied=await applyRun(t,f,setup);
    if(id==='UF-20') await followup(f,applied); else await archive(f,applied); }
}
