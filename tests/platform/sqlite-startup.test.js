import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fork } from "node:child_process";
import { once } from "node:events";
import { resources } from "../../scripts/e2e/helpers/resources.mjs";
import { bounded } from "../../scripts/e2e/helpers/deadline.mjs";
import { observeChildClose, waitChildClose } from "../../src/runtime/child-close.js";

test("declared runtime can start real SQLite, serve the first state and naturally close", {timeout:15000}, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"bridge-sqlite-startup-"));
  const owner=resources(t);
  owner.add("startup workspace",()=>fs.rmSync(root,{recursive:true,force:true}),30);
  const probe=net.createServer(); await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));
  const port=probe.address().port; await new Promise(resolve=>probe.close(resolve));
  const token="sqlite-startup-only-token-0123456789";
  const child=fork(new URL("../../src/server.js",import.meta.url),[],{execArgv:["--experimental-sqlite"],
    stdio:["ignore","pipe","pipe","ipc"],windowsHide:true,
    env:{PATH:process.env.PATH,PORT:String(port),WORKSPACE:root,CONTROLLER_DATA_DIR:root,DASHBOARD_TOKEN:token,
      WEB_EXTENSION_SHARED_SECRET:"sqlite-startup-extension-secret-0123456789",WEB_EXTENSION_EXPECTED_IDENTITY:"startup-extension"}});
  let logs="",ready;
  const listening=new Promise(resolve=>{ready=resolve;});
  child.stdout.on("data",chunk=>{logs+=chunk; if(logs.includes("HTTP server listening"))ready();});
  child.stderr.on("data",chunk=>{logs+=chunk;});
  const observation=observeChildClose(child);
  let closure;
  const stop=()=>closure??=waitChildClose(child,observation,{timeoutMs:8000,request:()=>{if(child.connected)child.send({type:"bridge.shutdown"});}});
  owner.add("startup process",async()=>assert.deepEqual(await stop(),{code:0,signal:null}),20);
  await bounded(Promise.race([listening,once(child,"error").then(([error])=>{throw error;}),
    observation.promise.then(()=>{throw new Error("Server exited before listening: "+logs);})]),5000);
  for(const route of ["/api/health","/api/preflight","/api/state"]) {
    const response=await fetch(`http://127.0.0.1:${port}${route}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
    const body=await response.json(); assert.equal(response.status,200,JSON.stringify(body));
    if(route==="/api/state") {
      assert.equal(body.runtimeAvailability.ready,true);
      assert.equal(body.dataKnowledge.runs.status,"AVAILABLE_EMPTY");
    }
  }
  assert.deepEqual(await stop(),{code:0,signal:null});
  t.diagnostic(JSON.stringify({node:process.version,platform:process.platform,naturalExit:true,firstStateReady:true}));
});
