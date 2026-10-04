import { bounded } from './deadline.mjs';

const owners = new WeakMap();
// One hook owns every E2E resource: a failed close cannot skip a later disposer.
export function createResourceOwner() {
  const entries = [];
  let finalizing = false;
  let closing;
  return {
    add(name, dispose, phase = 20, timeout = 10000) {
      if (finalizing) throw new Error('Resource registered during finalization');
      entries.push({ name, dispose, phase, timeout });
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
    finalizing = true;
    const errors = [];
    for (const entry of entries.sort((a,b) => a.phase-b.phase)) {
      try { await bounded(Promise.resolve().then(() => entry.dispose(errors)), entry.timeout); }
      catch (cause) { errors.push(new Error(`E2E cleanup failed: ${entry.name}`, { cause })); }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(e => `${e.message}: ${e.cause?.message}`).join('\n'));
      })();
      return closing;
    },
  };
}

export function resources(t) {
  if (owners.has(t)) return owners.get(t);
  const owner = createResourceOwner();
  owners.set(t, owner);
  t.after(() => owner.close());
  return owner;
}
