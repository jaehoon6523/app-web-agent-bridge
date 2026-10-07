import assert from 'node:assert/strict';

// Logical source keys must be independent of the host filesystem separator.
export function sourceCopyKey(name) { return name.replaceAll('\\', '/'); }

export function assertSourceCopies(copies, allowed) {
  const permitted = new Set(allowed.map(sourceCopyKey));
  for (const [name, values] of Object.entries(copies)) {
    if (!permitted.has(sourceCopyKey(name))) assert.equal(values.probe, values.production, name+' source copy identity');
  }
}
