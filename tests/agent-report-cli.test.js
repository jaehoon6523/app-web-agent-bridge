import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const run=promisify(execFile), cli=fileURLToPath(new URL("../scripts/repair-selectors.mjs",import.meta.url));
test("CLI logs configuration, non-JSON HTTP failure and READY without launching a worker", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"bridge-agent-cli-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const env={...process.env,DEMO_MODE:"false",WEB_EXTENSION_SHARED_SECRET:"",WEB_EXTENSION_EXPECTED_IDENTITY:"",
    DASHBOARD_TOKEN:"fixture-dashboard-token-0123456789",CONTROLLER_DATA_DIR:path.join(root,".agent-controller"),HOST:"127.0.0.1"};
  let error;
  try {await run(process.execPath,[cli],{cwd:root,env:{...env,HOST:"PRIVATE_INVALID_HOST"}});}catch(e){error=e;}
  const config=JSON.parse(error.stderr); assert.equal(config.stage,"CONFIG"); assert.equal(config.code,"REPAIR_CONFIG_FAILED");
  assert.doesNotMatch(fs.readFileSync(config.logFile,"utf8"),/PRIVATE_INVALID_HOST/u);
  let ready=false;
  const server=http.createServer((_req,res)=>{
    if(!ready){res.writeHead(404);res.end("PRIVATE_BODY_NOT_JSON");return;}
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify({tabs:[{tabId:7,pageStatus:"READY",composerPresent:true}]}));
  });
  await new Promise(done=>server.listen(0,"127.0.0.1",done));
  t.after(()=>new Promise(done=>server.close(done)));
  const args=[cli,"--server",`http://127.0.0.1:${server.address().port}`,"--tab","7"];
  try {await run(process.execPath,args,{cwd:root,env});}catch(e){error=e;}
  const failed=JSON.parse(error.stderr); assert.equal(failed.stage,"HTTP_JSON");assert.equal(failed.code,"REPAIR_HTTP_JSON_FAILED");
  const stored=JSON.parse(fs.readFileSync(failed.logFile));assert.equal(stored.repair.httpStatus,404);
  assert.doesNotMatch(JSON.stringify(stored),/PRIVATE_BODY_NOT_JSON/u);
  ready=true;
  const result=JSON.parse((await run(process.execPath,args,{cwd:root,env})).stdout);
  assert.equal(result.code,"REPAIR_NOT_NEEDED");assert.equal(result.logFile,failed.logFile);
  assert.equal(fs.existsSync(path.join(root,".agent-controller","selector-repair")),false);
  fs.unlinkSync(result.logFile); fs.mkdirSync(result.logFile);
  const unwritable=JSON.parse((await run(process.execPath,args,{cwd:root,env})).stdout);
  assert.equal(unwritable.code,"REPAIR_NOT_NEEDED"); assert.equal(unwritable.logFile,null);
  assert.ok(unwritable.loggingFailure);
  assert.equal(fs.existsSync(path.join(root,".agent-controller","selector-repair")),false);
});
