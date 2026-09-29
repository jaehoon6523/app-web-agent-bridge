import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBridgeServer } from "../../src/server.js";

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function liveFixture() {
  return {
    store:{
      listRuns:() => [],
    },
    codeChanges:{
      list:() => [],
    },
    composition:{},
    async close() {},
  };
}

test("fault: disconnected extension does not become HTTP, dashboard-auth, or runtime failure", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-extension-fault-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const runtimeConfig = {
    host:"127.0.0.1",
    port,
    baseUrl,
    workspace:root,
    logDir:root,
    demoMode:false,
    auditProjectFile:null,
    dashboard:{ token:null },
    codex:{ executablePath:process.execPath },
    persistence:{
      databasePath:path.join(root, "bridge.sqlite"),
      artifactDirectory:path.join(root, "artifacts"),
    },
    webExtension:{
      enabled:true,
      sharedSecret:"extension-fault-secret-0123456789abcdef",
      expectedExtensionIdentity:"extension-fault-fixture",
    },
    relay:{ webResponseTimeoutMs:500 },
  };

  const bridge = createBridgeServer({
    runtimeConfig,
    createLiveRuntime:async () => liveFixture(),
  });
  await bridge.listen();
  t.after(async () => {
    await bridge.close();
    fs.rmSync(root, { recursive:true, force:true });
  });

  const sessionResponse = await fetch(`${baseUrl}/api/dashboard/session`, {
    method:"POST",
    headers:{
      origin:baseUrl,
      "sec-fetch-site":"same-origin",
      "content-type":"application/json",
    },
    body:"{}",
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();

  const headers = { authorization:`Bearer ${session.token}` };
  const stateResponse = await fetch(`${baseUrl}/api/state`, { headers });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();

  assert.equal(state.runtimeAvailability.ready, true);
  assert.equal(state.preflight.checks.extensionConfigured, true);
  assert.equal(state.preflight.checks.extensionAuthenticated, false);
  assert.equal(state.preflight.checks.webAdapterAvailable, true);
  assert.equal(state.commandCapabilities.includes("preparation.start"), false);

  assert.equal((await fetch(`${baseUrl}/api/preflight`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/project`, { headers })).status, 200);
});
