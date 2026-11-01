import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceManifest } from './verification-source.mjs';

const inside = (root, selected) => {
  const relative = path.relative(root, selected);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding:'utf8', windowsHide:true,
    maxBuffer:1024*1024, timeout:30000 });
  if (result.error || result.status !== 0) {
    const error = new Error(result.error?.message ?? result.stderr?.trim() ?? 'Git command failed');
    error.code = result.error?.code ?? 'GIT_PROBE_FAILED';
    throw error;
  }
}

function probeWorktree(temporary, longestPath) {
  const fixture = path.join(temporary, 'bridge-selector-cli-XXXXXX');
  const target = path.join(fixture, 'target');
  const worktree = path.join(fixture, '.bridge-selector-worktrees', '00000000-0000-4000-8000-000000000000');
  fs.mkdirSync(target, { recursive:true });
  try {
    git(target, ['init', '-q']);
    const filename = path.join(target, ...longestPath.split('/'));
    fs.mkdirSync(path.dirname(filename), { recursive:true });
    fs.writeFileSync(filename, 'path probe\n');
    git(target, ['add', '--all']);
    git(target, ['-c', 'user.name=Verification probe', '-c', 'user.email=probe@localhost',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'path probe']);
    git(target, ['worktree', 'add', '--detach', '--', worktree, 'HEAD']);
    if (!fs.existsSync(path.join(worktree, ...longestPath.split('/')))) throw Error('WORKTREE_PROBE_FILE_MISSING');
  } finally {
    try { if (fs.existsSync(worktree)) git(target, ['worktree', 'remove', '--force', '--', worktree]); }
    finally { fs.rmSync(fixture, { recursive:true, force:true }); }
  }
}

export function configureVerificationTemp(root, { env = process.env, platform = process.platform } = {}) {
  const repository = fs.realpathSync.native(root);
  const override = env.BRIDGE_VERIFICATION_TEMP_ROOT;
  const candidates = override ? [override] : [env.TMPDIR, env.TMP, env.TEMP,
    platform === 'win32' && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Temp') : null,
    os.tmpdir(), platform === 'win32' ? path.join(path.parse(repository).root, 'tmp') : '/tmp'];
  const bases = [...new Set(candidates.filter(Boolean).map(value => path.resolve(value)))].sort((a,b) => a.length-b.length);
  const longestPath = sourceManifest(repository).files.map(file => file.path).sort((a,b) => b.length-a.length)[0] ?? 'path-probe.txt';
  const failures = [];
  for (const base of bases) {
    let temporary;
    try {
      if (override || base === path.join(path.parse(repository).root, 'tmp')) fs.mkdirSync(base, { recursive:true });
      const resolvedBase = fs.realpathSync.native(base);
      if (inside(repository, resolvedBase)) throw Error('INSIDE_REPOSITORY');
      temporary = fs.mkdtempSync(path.join(resolvedBase, 'bv-'));
      const selected = fs.realpathSync.native(temporary);
      probeWorktree(selected, longestPath);
      const childEnv = { ...env, TEMP:selected, TMP:selected, TMPDIR:selected };
      const child = spawnSync(process.execPath, ['-p', "require('node:os').tmpdir()"],
        { env:childEnv, encoding:'utf8', windowsHide:true, timeout:10000 });
      if (child.error || child.status !== 0 || fs.realpathSync.native(child.stdout.trim()) !== selected)
        throw Error('CHILD_TEMP_MISMATCH');
      env.TEMP = selected; env.TMP = selected; env.TMPDIR = selected;
      if (fs.realpathSync.native(os.tmpdir()) !== selected) throw Error('PARENT_TEMP_MISMATCH');
      return selected;
    } catch (error) {
      failures.push(`${base}: ${error.code ?? error.message}`);
      if (temporary) {
        try { fs.rmSync(temporary, { recursive:true, force:true }); }
        catch (cleanupError) { failures.push(`${base}: CLEANUP_${cleanupError.code ?? 'FAILED'}`); }
      }
    }
  }
  throw Error(`VERIFICATION_TEMP_UNAVAILABLE: ${failures.join('; ') || 'NO_CANDIDATES'}`);
}
