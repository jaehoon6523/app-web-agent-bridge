import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBridgeServer } from "../../src/server.js";

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
function config(root, port) { return { host:"127.0.0.1", port, baseUrl:`http://127.0.0.1:${port}`, workspace:root, logDir:root,
  demoMode:false, auditProjectFile:null, dashboard:{token:null}, codex:{executablePath:process.execPath},
  persistence:{databasePath:path.join(root,"bridge.sqlite"),artifactDirectory:path.join(root,"artifacts")},
  webExtension:{enabled:true,sharedSecret:"run-store-fault-secret-0123456789abcdef",expectedExtensionIdentity:"run-store-fault-extension"},
  relay:{webResponseTimeoutMs:500} }; }
function runStoreFaultRuntime() { return { store:{listRuns:()=>{ throw Object.assign(new Error("injected run-store read failure"),{code:"RUN_STORE_READ_FAULT_INJECTED"}); }},
  codeChanges:{list:()=>[]}, composition:{}, async close(){} }; }

test("fault: run-store read failure is unavailable state, never a known-empty run list", async (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"bridge-run-store-fault-")); const port=await freePort(); const runtimeConfig=config(root,port);
  const bridge=createBridgeServer({runtimeConfig,createLiveRuntime:async()=>runStoreFaultRuntime()}); await bridge.listen();
  t.after(async()=>{await bridge.close();fs.rmSync(root,{recursive:true,force:true});});
  const sessionResponse=await fetch(`${runtimeConfig.baseUrl}/api/dashboard/session`,{method:"POST",headers:{origin:runtimeConfig.baseUrl,"sec-fetch-site":"same-origin","content-type":"application/json"},body:"{}"});
  assert.equal(sessionResponse.status,200); const session=await sessionResponse.json(); const headers={authorization:`Bearer ${session.token}`};
  const stateResponse=await fetch(`${runtimeConfig.baseUrl}/api/state`,{headers}); assert.equal(stateResponse.status,503); const body=await stateResponse.json();
  assert.match(body.error,/injected run-store read failure/u); assert.equal(Object.hasOwn(body,"runs"),false);
  assert.equal((await fetch(`${runtimeConfig.baseUrl}/api/preflight`)).status,200);
  assert.equal((await fetch(`${runtimeConfig.baseUrl}/api/project`,{headers})).status,200);
});
