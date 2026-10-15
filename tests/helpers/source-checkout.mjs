import fs from 'node:fs';
import path from 'node:path';
import {git, sourceManifest, assertSourceManifest} from '../../scripts/verification-source.mjs';

export function linkDependencies(source, checkout) {
  const dependencies = fs.realpathSync(path.join(source,'node_modules'));
  fs.symlinkSync(dependencies, path.join(checkout,'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // Git's directory-only ignore may not match a dependency symlink on POSIX.
  // Local excludes belong to this disposable repository, not the source index.
  fs.appendFileSync(path.join(checkout,'.git/info/exclude'),'\n/node_modules\n');
}

export function createSourceCheckout(source, checkout) {
  const manifest = sourceManifest(source), sourceHead = git(source,['rev-parse','HEAD']).trim();
  if (fs.existsSync(checkout)) throw Error('SNAPSHOT_DESTINATION_EXISTS');
  fs.mkdirSync(checkout,{recursive:true});
  // An independent repository prevents worktree commands from touching source Git metadata.
  git(checkout,['init','-q']); git(checkout,['config','core.autocrlf','false']);
  git(checkout,['config','core.hooksPath',path.join(checkout,'.git','no-hooks')]);
  for (const entry of manifest.files) {
    const from = path.join(source,entry.path), to = path.join(checkout,entry.path);
    fs.mkdirSync(path.dirname(to),{recursive:true}); fs.copyFileSync(from,to);
    fs.chmodSync(to,fs.lstatSync(from).mode & 0o777);
  }
  git(checkout,['add','--all','--force']);
  git(checkout,['-c','user.name=Bridge fixture','-c','user.email=fixture@localhost',
    '-c','commit.gpgsign=false','commit','-qm','Current verification source snapshot','--allow-empty']);
  assertSourceManifest(source,manifest); assertSourceManifest(checkout,manifest);
  if (git(source,['rev-parse','HEAD']).trim() !== sourceHead) throw Error('SOURCE_HEAD_CHANGED');
  const snapshot = {sourceHead, snapshotHead:git(checkout,['rev-parse','HEAD']).trim(),
    sourceSha256:manifest.sha256, manifest, matched:true};
  fs.writeFileSync(path.join(checkout,'.git','bridge-source-snapshot.json'),JSON.stringify(snapshot,null,2)+'\n');
  return snapshot;
}
