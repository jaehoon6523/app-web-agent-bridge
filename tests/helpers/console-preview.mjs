// Explicit UI test fixture. No real Codex or ChatGPT calls; never used by npm start.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupAudit } from "./audit-fixtures.js";

let cleanup;
const fixture = setupAudit({after(fn){cleanup=fn;}});
const publicRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../public");
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,"http://127.0.0.1");
  const json=(status,value)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(value));};
  try {
    if(url.pathname==="/api/dashboard/session") return json(200,{token:"ui-fixture"});
    if(url.pathname==="/api/state") {
      const runs=fixture.service.list();const runId=url.searchParams.get("runId")||runs.at(-1)?.runId;
      const preflight={readyForProvisioning:true,checks:{codexExecutableConfigured:true,extensionAuthenticated:true},missing:[],project:{...fixture.options.project,requirementsId:"fixture-requirements",revision:"1"}};
      const snapshot=runId?fixture.service.snapshot(runId,preflight):{run:null,messages:[],events:[],preflight,commandCapabilities:[]};
      snapshot.runs=runs.map((r)=>({runId:r.runId,objective:`[모의 UI 검증] ${r.objective}`,phase:r.stage}));
      if(!fixture.service.busy()) snapshot.commandCapabilities.push("run.start");
      return json(200,snapshot);
    }
    if(url.pathname==="/api/commands" && req.method==="POST") {
      let body="";for await(const part of req)body+=part;
      const command=JSON.parse(body);const payload=await fixture.dashboard.executeDurable(command);return json(200,{payload});
    }
    const name=url.pathname==="/"?"index.html":url.pathname.slice(1);
    if(!["index.html","styles.css","app.js"].includes(name)){res.writeHead(404);res.end();return;}
    res.writeHead(200,{"Content-Type":name.endsWith(".js")?"text/javascript":name.endsWith(".css")?"text/css":"text/html"});res.end(fs.readFileSync(path.join(publicRoot,name)));
  }catch(error){json(400,{error:error.message});}
});
server.listen(8799,"127.0.0.1",()=>console.log("MOCK UI ONLY: http://127.0.0.1:8799"));
process.on("SIGINT",()=>{server.close(async()=>{await cleanup();process.exit(0);});});
