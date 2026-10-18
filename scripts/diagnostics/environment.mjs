// Module A: provenance, requested/observed launch conditions and pinned v3 fixture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const extensionHashExpected = {
  'manifest.json': '414efabb73898dea10b89de5fde7505607c2812a5ae8f864f6b72c6e6bd54081',
  'background.js': '1e24fdc16b8f6d3ef3e7ae384f4309f36aae649d9fb74dc1c7002b78891be165',
  'popup.html': '4d200ad69b85c8cf33c77edbb5e2f2bed98055c7cf6f2663accdeb6e59720910',
};
// Baseline fixture bytes are pinned to the A–D experiment from e331ea8.

export function createExtension(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    'manifest.json': JSON.stringify({
      manifest_version: 3, name: 'Isolated MV3 Reload Probe', version: '0.0.1',
      permissions: ['storage'],
      background: { service_worker: 'background.js', type: 'module' },
      action: { default_popup: 'popup.html' },
    }, null, 2),
    'background.js': `const instanceId=crypto.randomUUID();\nchrome.runtime.onMessage.addListener((msg,_sender,reply)=>{\nif(msg?.type!=='matrix.ping')return false;reply({ok:true,instanceId});return false;\n});\nexport {};\n`,
    'popup.html': '<!doctype html><html><head><meta charset="utf-8"><title>Matrix</title></head><body><h1 id="matrix">MV3_MATRIX_READY</h1></body></html>',
  };
  const hashes = {};
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.writeFileSync(target, value);
    hashes[name] = sha256(target);
    if (hashes[name] !== extensionHashExpected[name]) {
      throw new Error(`FIXTURE_HASH_MISMATCH ${name}: ${hashes[name]} expected ${extensionHashExpected[name]}`);
    }
  }
  return hashes;
}

export function findExecutable() {
  const fromEnv = process.env.UI_BROWSER_EXECUTABLE;
  if (!fromEnv) throw new Error('UI_BROWSER_EXECUTABLE must identify the exact previously tested Chromium executable');
  const executable = path.resolve(fromEnv);
  if (!fs.existsSync(executable)) throw new Error(`Browser executable not found: ${executable}`);
  return executable;
}
export function getWindowsCommandLine(pid, {platform=process.platform, execute=execFileSync, hash=sha256} = {}) {
  if (platform !== 'win32') return { status: 'UNSUPPORTED', commandLine: null };
  const started=performance.now(), query={executable:'powershell.exe',timeoutMs:6000,pid};
  const cmd = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){$p | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress}`;
  try {
    const str = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { encoding: 'utf8', timeout: 6000, windowsHide: true }).trim();
    const record = str ? JSON.parse(str) : null;
    return { status: record?.CommandLine ? 'OBSERVED' : 'UNVERIFIED', commandLine: record?.CommandLine ?? null,
      executablePath: record?.ExecutablePath ?? null,
      executableSha256: record?.ExecutablePath ? hash(record.ExecutablePath) : null,
      pid: record?.ProcessId ?? pid, parentPid: record?.ParentProcessId ?? null,
      query:{...query,elapsedMs:performance.now()-started,timedOut:false,
        result:record?.CommandLine?'OBSERVED':record?'COMMAND_LINE_MISSING':'PROCESS_NOT_FOUND'} };
  } catch (error) { return { status: 'UNVERIFIED', error: error.message, commandLine: null,
    query:{...query,elapsedMs:performance.now()-started,errorCode:error.code ?? null,
      exitCode:error.status ?? null,signal:error.signal ?? null,killed:error.killed ?? null,
      timedOut:error.code==='ETIMEDOUT',result:'QUERY_FAILED'} }; }
}


export function sourceRecord(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 });
  let commit = null;
  try {
    commit = git(['rev-parse', 'HEAD']).trim();
    const candidates = [...git(['diff', '--name-only', 'HEAD', '-z']).split('\0'),
      ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean);
    // Git for Windows can enumerate a junction as a directory, including no
    // files for an empty target. Retain the link itself in either case.
    for (const directory of git(['ls-files','--others','--directory','--exclude-standard','-z']).split('\0').filter(Boolean)) {
      const name = directory.replace(/\/$/u,'');
      try { if (fs.lstatSync(path.join(root,name)).isSymbolicLink()) candidates.push(name); }
      catch { candidates.push(name); } // Preserve per-path errors with the other hashes below.
    }
    const sourcePath = file => {
      const parts = file.split('/'); let current = root;
      for (let index = 0; index < parts.length; index++) {
        current = path.join(current,parts[index]);
        try { if (fs.lstatSync(current).isSymbolicLink()) return parts.slice(0,index+1).join('/'); }
        catch { break; }
      }
      return file;
    };
    const changed = [...new Set(candidates.map(sourcePath))].sort();
    const required = ['scripts/direct-chromium-reload-compare.mjs', 'scripts/mv3-reload-core.mjs',
      'scripts/direct-mv3-identity.mjs', 'scripts/minimal-native-reload-matrix-v2.mjs',
      'scripts/ack-windows-result.mjs', 'scripts/windows-diagnostics.mjs',
      'scripts/diagnostics/environment.mjs', 'scripts/diagnostics/reload-observer.mjs',
      'scripts/diagnostics/reload-result.mjs', 'scripts/run-windows-direct-reload.ps1'];
    const files = {}, fileKinds = {}, hashErrors = {};
    for (const file of new Set([...required, ...changed].map(sourcePath))) {
      const absolute = path.join(root, file);
      try {
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          fileKinds[file] = 'SYMLINK_TARGET_TEXT';
          files[file] = crypto.createHash('sha256').update(fs.readlinkSync(absolute)).digest('hex');
        } else if (stat.isFile()) { fileKinds[file] = 'FILE_BYTES'; files[file] = sha256(absolute); }
        else { fileKinds[file] = 'UNVERIFIED'; files[file] = null; hashErrors[file] = 'NOT_A_REGULAR_FILE'; }
      } catch (error) {
        files[file] = null; fileKinds[file] = error.code === 'ENOENT' ? 'ABSENT' : 'UNVERIFIED';
        if (error.code !== 'ENOENT') hashErrors[file] = error.message;
      }
    }
    return { commit, changedFiles: changed, files, fileKinds, hashErrors };
  } catch (error) { return { commit, error: error.message, changedFiles: [], files: {} }; }
}

export function environmentRecord(executable = process.env.UI_BROWSER_EXECUTABLE) {
  const record = { os: { platform: process.platform, release: os.release(), arch: process.arch },
    node: { version: process.version, executable: fs.realpathSync(process.execPath), sha256: sha256(process.execPath) },
    browser: { status: 'UNVERIFIED', requestedPath: executable ?? null } };
  try {
    if (!executable) throw Error('UI_BROWSER_EXECUTABLE_NOT_SELECTED');
    const realPath = fs.realpathSync(executable);
    record.browser = { status: 'OBSERVED', requestedPath: executable, executablePath: realPath, sha256: sha256(realPath) };
  } catch (error) { record.browser.error = error.message; }
  return record;
}

// Node's diagnostic report records this running process's startup argv. Use it
// for self-observation rather than starting PowerShell/CIM to query ourselves.
// Do not substitute requested args or synthesize OBSERVED if reporting fails.
export function nodeCommandLine(readReport=()=>process.report.getReport()) {
  try {
    const argv=readReport().header?.commandLine;
    if(!Array.isArray(argv) || !argv.length || argv.some(arg=>typeof arg!=='string')) throw Error('NODE_COMMAND_LINE_UNAVAILABLE');
    const executablePath=fs.realpathSync(process.execPath);
    return {status:'OBSERVED',source:'NODE_DIAGNOSTIC_REPORT',pid:process.pid,parentPid:process.ppid,
      commandLine:argv.join(' '),argv,executablePath,executableSha256:sha256(executablePath)};
  } catch(error) {return {status:'UNVERIFIED',source:'NODE_DIAGNOSTIC_REPORT',commandLine:null,error:error.message};}
}

export function actualCommandLine(pid) {
  if (!Number.isInteger(pid)) return { status: 'UNVERIFIED', commandLine: null, reason: 'NO_PROCESS_PID' };
  if (process.platform === 'win32') return pid===process.pid?nodeCommandLine():getWindowsCommandLine(pid);
  if (process.platform === 'linux') {
    try {
      // /proc can belong to the host PID namespace. Never read an unrelated
      // host process with the same numeric PID as our namespace-local child.
      const namespace = fs.readlinkSync('/proc/self/ns/pid');
      const procPath = pid === process.pid ? '/proc/self' : fs.readdirSync('/proc')
        .filter(name => /^\d+$/u.test(name)).map(name => `/proc/${name}`).find(directory => {
          try {
            const ids = fs.readFileSync(`${directory}/status`, 'utf8').match(/^NSpid:\s+(.+)$/mu)?.[1].trim().split(/\s+/u);
            return Number(ids?.at(-1)) === pid && fs.readlinkSync(`${directory}/ns/pid`) === namespace;
          } catch { return false; }
        });
      if (!procPath) throw Error('PROCESS_NOT_FOUND_IN_OWN_NAMESPACE');
      const argv = fs.readFileSync(`${procPath}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const executablePath = fs.readlinkSync(`${procPath}/exe`);
      return { status: 'OBSERVED', commandLine: argv.join(' '), argv, executablePath,
        executableSha256: sha256(`${procPath}/exe`) };
    } catch (error) { return { status: 'UNVERIFIED', commandLine: null, error: error.message }; }
  }
  return { status: 'UNVERIFIED', commandLine: null, reason: 'OS_COMMAND_LINE_UNSUPPORTED' };
}

export function windowsArgv(commandLine) {
  const result = []; let token = '', quoted = false, active = false;
  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
    if (ch === '\\') {
      let count = 1; while (commandLine[i + 1] === '\\') { count++; i++; }
      if (commandLine[i + 1] === '"') {
        token += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) token += '"'; else quoted = !quoted;
        i++;
      } else token += '\\'.repeat(count);
      active = true;
    } else if (ch === '"') { quoted = !quoted; active = true; }
    else if (/\s/u.test(ch) && !quoted) {
      if (active) result.push(token); token = ''; active = false;
    } else { token += ch; active = true; }
  }
  if (quoted) return null;
  if (active) result.push(token);
  return result;
}

export function launchConditions(requestedArgs, actual, unsafe) {
  if (actual?.status !== 'OBSERVED') return { status: 'UNVERIFIED', matchesRequested: null };
  const argv = actual.argv ?? windowsArgv(actual.commandLine ?? '');
  if (!argv) return { status: 'UNVERIFIED', matchesRequested: null, reason: 'ARGUMENT_PARSING_FAILED' };
  const matches = arg => argv.includes(arg);
  const unsafePresent = matches('--enable-unsafe-extension-debugging') === true;
  return { status: 'OBSERVED', matchesRequested: requestedArgs.every(matches) && unsafePresent === unsafe,
    unsafeExpected: unsafe, unsafePresent, argvEvidence: actual.argv ? 'ARGV' : 'CIM_COMMAND_LINE' };
}

export async function launchBrowser(spec, scratch) {
  const { spawn } = await import('node:child_process');
  const extensionPath = path.join(scratch, 'extension'), profile = path.join(scratch, 'profile');
  const extensionSourceHashes = createExtension(extensionPath);
  const binary = fs.realpathSync(findExecutable());
  const args = [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
    ...(spec.unsafe ? ['--enable-unsafe-extension-debugging'] : []), `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    ...(process.platform !== 'win32' ? ['--no-sandbox'] : []),
    ...(process.env.DIRECT_HEADLESS === '1' ? ['--headless=new'] : []), 'about:blank'];
  const launch = { executablePath: binary, executableSha256: sha256(binary), args, profilePath: profile,
    extensionPath, headless: process.env.DIRECT_HEADLESS === '1', playwrightUsed: false,
    externalCdp: 'REQUESTED', devToolsUi: { requested: false, observed: 'UNVERIFIED' } };
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  const browserProcessLifecycle = { pid: child.pid ?? null, spawnedAt: new Date().toISOString(), exitedAt: null, closedAt: null };
  child.on('exit', (code, signal) => Object.assign(browserProcessLifecycle,
    { code, signal, exitedAt: new Date().toISOString() }));
  child.on('close', (code, signal) => Object.assign(browserProcessLifecycle,
    { code, signal, closedAt: new Date().toISOString() }));
  let spawnError;
  child.on('error', error => { spawnError = error; });
  await new Promise(resolve => { child.once('spawn', resolve); child.once('error', resolve); });
  if (spawnError) throw spawnError;
  const actualProcessCommandLine = actualCommandLine(child.pid);
  return { child, launch, browserProcessLifecycle, extensionSourceHashes, fixtureHashesVerified: true,
    actualProcessCommandLine, actualArgsEvidence: { ...launchConditions(args, actualProcessCommandLine, spec.unsafe),
      browserExecutableMatches: actualProcessCommandLine.executableSha256
        ? actualProcessCommandLine.executableSha256 === launch.executableSha256 : null } };
}
