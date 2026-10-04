import { observeChildClose, waitChildClose } from '../../../src/runtime/child-close.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ownedSpawn, forceProcessTree } from '../platform/process.mjs';
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
      // The production Codex manager starts its pinned executable with
      // ["app-server"] and cwd=the isolated Git worktree. Node(.exe) is a real
      // native executable on both platforms; the tracked disposable target
      // entrypoint is copied into that worktree by normal Git checkout.
      const entry = path.join(workspace, 'app-server');
      const fixture = new URL('../fixtures/active-worker.mjs', import.meta.url).href;
      fs.writeFileSync(entry, 'process.argv[2] = ' + JSON.stringify(path.join(workspace, 'worker-observed.json')) + ';\nimport(' + JSON.stringify(fixture) + ');\n');
      Object.assign(env, { CODE_WORKER_PROVIDER:'codex', CODEX_EXECUTABLE:process.execPath });
      delete env.CODE_WORKER_EXECUTABLE; delete env.CODE_WORKER_ARGS;
    }
    if (fault) {
      fs.mkdirSync(path.join(workspace, '.agent-controller'), { recursive:true });
      if (fault === 'runtime-artifact') fs.writeFileSync(path.join(workspace, '.agent-controller/artifacts'), 'fault');
      else if (fault === 'state-database') fs.writeFileSync(path.join(workspace, '.agent-controller/preparations.sqlite'), 'not a SQLite database');
      else throw new Error(`Unknown fault: ${fault}`);
    }
    let observation, stopping, forced = false, sendError = null;
    const launch = () => {
      spawnError = null; forced = false; sendError = null; stopping = null;
      child = ownedSpawn([path.join(repository, 'src/server.js')], { cwd:workspace, env, ipc:true });
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => { spawnError = error; });
      observation = observeChildClose(child);
    };
    launch();
    const alive = () => {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, 'production process exited');
      assert.equal(child.signalCode, null, 'production process was killed');
    };
    const stop = () => {
      if (stopping) return stopping;
      stopping = (async () => {
        const request = () => {
          if (child.exitCode !== null || child.signalCode !== null || spawnError) return;
          try {
            if (child.connected) child.send({type:'bridge.shutdown'}, error => {if(error)sendError=error.code ?? 'IPC_SEND_FAILED';});
            else sendError='IPC_DISCONNECTED';
          } catch(error) {sendError=error.code ?? 'IPC_SEND_FAILED';}
        };
        try {
          const result = await waitChildClose(child, observation, {timeoutMs:8000,request,
            onDeadline:()=>{forced=true;},forceClose:()=>forceProcessTree(child)});
          shutdown = {...result,forced};
        } catch(error) {
          // Resource closure failed even if the parent exited successfully.
          child.stdout?.destroy(); child.stderr?.destroy();
          if(child.connected)child.disconnect();
          child.unref();
          shutdown={code:child.exitCode,signal:child.signalCode,forced:true,closureError:error.code,cleanupError:error.cleanupError ?? null};
        }
        return shutdown;
      })();
      return stopping;
    };
    const assertShutdown = result => {
      // forced records harness containment after failed process/stdio closure.
      // It does not describe whether production terminates an owned socket.
      assert.equal(result.code, 0, ['production bounded shutdown failed', JSON.stringify({...result,shutdownSendError:sendError}),stdout.slice(-12000),stderr.slice(-12000)].join('\n'));
      assert.equal(result.signal,null,'production shutdown used a kill signal');
      assert.equal(result.forced,false,'E2E harness containment was required for process/resource closure');
    };
    const handle = { workspace, baseUrl, alive, stop, assertShutdown,
      restart:async () => { assertShutdown(await stop()); launch(); return handle.ready(); },
      ready:() => waitForPreflight(`${baseUrl}/api/preflight`, { checkAlive:alive }),
      logs:() => ({ stdout, stderr, shutdown, shutdownSendError:sendError }),
      dispose:async () => {
        const result = await stop();
        const failures=[];
        try { assertShutdown(result); } catch(error) {failures.push(error);}
        try {
        // A completed turn does not imply that a persistent app-server exited.
        const observed = path.join(workspace, 'worker-observed.json');
        if (worker === 'active' && fs.existsSync(observed)) {
          const { pid } = JSON.parse(fs.readFileSync(observed, 'utf8'));
          assert.ok(Number.isInteger(pid) && pid > 0);
          const deadline = Date.now() + 5000;
          let exists;
          do {
            try { process.kill(pid, 0); exists = true; }
            catch (error) { if (error.code !== 'ESRCH') throw error; exists = false; }
            if (!exists) break;
            await new Promise(resolve => setTimeout(resolve, 25));
          } while (Date.now() < deadline);
          assert.equal(exists, false, 'active Worker child must exit before workspace cleanup');
        }
        } catch(error) {failures.push(error);}
        try {fs.rmSync(workspace,{recursive:true,force:true});} catch(error) {failures.push(error);}
        if(failures.length)throw new AggregateError(failures,failures.map(e=>e.message).join('\n'));
      },
    };
    return handle;
  } catch (error) {
    if (probe.listening) await new Promise(resolve => probe.close(resolve));
    child?.kill('SIGKILL');
    fs.rmSync(workspace, { recursive:true, force:true });
    throw error;
  }
}
