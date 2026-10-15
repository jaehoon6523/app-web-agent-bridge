import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

export const git = (root, args) => execFileSync('git', args, {
  cwd:root, encoding:'utf8', maxBuffer:32*1024*1024, stdio:['ignore','pipe','pipe'],
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const excluded = /^(?:\.git|node_modules|\.agent-controller|diagnostic-runs|test-results|playwright-report|coverage|browser-profiles?|profiles?|\.bridge-selector-worktrees|\.runtime-cleanup-(?:contract|store)-.*|\.history-http-closure-.*)$/u;

// Git selects tracked and nonignored new paths; only current working-tree bytes
// are read. No index writes, checkout, stash or commit touches the source.
export function sourceManifest(root) {
  const names = [...new Set(git(root, ['ls-files','-z','--cached','--others','--exclude-standard'])
    .split('\0').filter(Boolean))].sort();
  const files = [], deleted = [], excludedLinks = [];
  for (const name of names) {
    const parts = name.split('/');
    if (path.isAbsolute(name) || parts.some(part => !part || part === '..' || part === '.')) throw Error('UNSAFE_SOURCE_PATH');
    if (parts.some(part => excluded.test(part)) || /(?:^|\/)latest-[^/]+\.(?:log|json)$/u.test(name)) continue;
    let stat, linked = false, current = root;
    try {
      for (const part of parts) {
        current = path.join(current, part); stat = fs.lstatSync(current);
        // This includes Windows junctions. Never read through a directory link.
        if (stat.isSymbolicLink()) { linked = true; break; }
      }
    } catch (error) {
      if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error;
      deleted.push(name); continue;
    }
    if (linked) { excludedLinks.push(name); continue; }
    if (!stat.isFile()) throw Error('UNSUPPORTED_SOURCE_ENTRY: '+name);
    files.push({path:name, sha256:sha256(fs.readFileSync(path.join(root,name)))});
  }
  return {files, deleted, excludedLinks, sha256:sha256(JSON.stringify(files))};
}

export function assertSourceManifest(root, expected) {
  const actual = sourceManifest(root);
  if (actual.sha256 !== expected.sha256 || JSON.stringify(actual.files) !== JSON.stringify(expected.files))
    throw Error('SOURCE_MANIFEST_MISMATCH');
  for (const name of expected.deleted) if (fs.existsSync(path.join(root,name))) throw Error('DELETED_SOURCE_REAPPEARED: '+name);
  return actual;
}

export function verificationSource(root) {
  const manifest = sourceManifest(root);
  return {head:git(root,['rev-parse','HEAD']).trim(), headTree:git(root,['rev-parse','HEAD^{tree}']).trim(),
    sourceSha256:manifest.sha256, manifest};
}
