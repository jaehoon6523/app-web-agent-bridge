import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waitForPreflight } from '../preflight-readiness.mjs';

export const repository = fileURLToPath(new URL('../../../', import.meta.url));
export const extensionCredentials = Object.freeze({ sharedSecret:'e2e-only-extension-secret-0123456789', extensionIdentity:'e2e-extension' });
export async function productionProcess({ configured = false, fault = null, worker = false } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-e2e-'));
  const probe = net.createServer();
  let child, shutdown, stdout = '', stderr = '', spawnError;
  try {
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = { PATH:process.env.PATH, HOST:'127.0.0.1', PORT:String(port), WORKSPACE:workspace, DEMO_MODE:'false', WEB_RESPONSE_TIMEOUT_MS:'10000' };
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
    if (configured) Object.assign(env, {
      WEB_EXTENSION_SHARED_SECRET:extensionCredentials.sharedSecret,
      WEB_EXTENSION_EXPECTED_IDENTITY:extensionCredentials.extensionIdentity,
      // Configuration sentinel only. Never launched or reported as a real Worker.
      CODEX_EXECUTABLE:path.join(workspace, 'not-installed-codex'),
    });
    if (worker) Object.assign(env, { CODE_WORKER_PROVIDER:'qwen', CODE_WORKER_EXECUTABLE:process.execPath,
      CODE_WORKER_ARGS:JSON.stringify([path.join(repository, 'scripts/e2e/fixtures/worker.mjs'), path.join(workspace, 'worker-observed.json')]) });
    if (worker === 'active') {
      fs.mkdirSync(path.join(workspace, '.agent-controller'), { recursive:true });
      const shim = path.join(workspace, '.agent-controller', 'worker-executable');
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      fs.writeFileSync(shim, '#!/bin/sh\nexec ' + [process.execPath, path.join(repository, 'scripts/e2e/fixtures/active-worker.mjs'), path.join(workspace, 'worker-observed.json')].map(quote).join(' ') + ' "$@"\n', { mode:0o700 });
      Object.assign(env, { CODE_WORKER_PROVIDER:'codex', CODEX_EXECUTABLE:shim });
      delete env.CODE_WORKER_EXECUTABLE; delete env.CODE_WORKER_ARGS;
    }
    if (fault) {
      fs.mkdirSync(path.join(workspace, '.agent-controller'), { recursive:true });
      if (fault === 'runtime-artifact') fs.writeFileSync(path.join(workspace, '.agent-controller/artifacts'), 'fault');
      else if (fault === 'state-database') fs.writeFileSync(path.join(workspace, '.agent-controller/preparations.sqlite'), 'not a SQLite database');
      else throw new Error(`Unknown fault: ${fault}`);
    }
    let exited;
    const launch = () => {
      spawnError = null;
      child = spawn(process.execPath, [path.join(repository, 'src/server.js')], { cwd:workspace, env, stdio:['ignore','pipe','pipe'] });
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => { spawnError = error; });
      exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    };
    launch();
    const alive = () => {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, 'production process exited');
      assert.equal(child.signalCode, null, 'production process was killed');
    };
    const stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null || spawnError) return shutdown;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
      try { shutdown = await exited; } finally { clearTimeout(timer); }
      return shutdown;
    };
    const handle = { workspace, baseUrl, alive, stop,
      restart:async () => { await stop(); launch(); return handle.ready(); },
      ready:() => waitForPreflight(`${baseUrl}/api/preflight`, { checkAlive:alive }),
      logs:() => ({ stdout, stderr, shutdown }),
      dispose:async () => { await stop(); fs.rmSync(workspace, { recursive:true, force:true }); },
    };
    return handle;
  } catch (error) {
    if (probe.listening) await new Promise(resolve => probe.close(resolve));
    child?.kill('SIGKILL');
    fs.rmSync(workspace, { recursive:true, force:true });
    throw error;
  }
}
