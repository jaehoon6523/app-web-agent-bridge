import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBridgeServer} from '../../src/server.js';
import {CodeChangeService} from '../../src/orchestration/code-change-service.js';
import {SqliteStore} from '../../src/persistence/sqlite-store.js';
import {ArtifactStore} from '../../src/evidence/artifact-store.js';
import {recoverRunCommandLinks} from '../../public/dashboard-model.js';
import {project} from './audit-fixtures.js';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const evidence=process.env.AB_EVIDENCE;
export async function asyncBoundaryFixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-ab-'));
  t.diagnostic('AB fixture '+directory);
  const filename=path.join(directory,'controller.sqlite'), target=path.join(directory,'target');fs.mkdirSync(target);
  const service=new CodeChangeService({filename,artifactStore:new ArtifactStore(path.join(directory,'artifacts')),project:project(target),codex:{},webSession:null});
  for(const runId of ['A','B']) service.store.save({runId,stage:'FAILED',objective:runId,iteration:0,maxIterations:1,
    projectRef:{projectId:'test-project',targetRoot:target},requirements:project(target).requirements,
    events:[],messages:[],findings:[],evidence:[],operatorNotes:[],reviews:[],conversationBindings:[]});
  const store=new SqliteStore(filename), entered=deferred(), release=deferred();
  const original=service.command.bind(service);
  service.command=async(type,payload)=>{if(payload.runId==='A'&&type==='run.note.add'){entered.resolve();await release.promise;}return original(type,payload);};
  const bridge=createBridgeServer({runtimeConfig:{host:'127.0.0.1',port:0,baseUrl:'http://127.0.0.1:0',workspace:target,logDir:directory,
    persistence:{databasePath:filename},demoMode:false,relay:{webResponseTimeoutMs:500},dashboard:{token:'ab-test-token-0123456789abcdef-0123456789'},codex:{},webExtension:{enabled:true,sharedSecret:'ab-extension-secret-0123456789abcdef',expectedExtensionIdentity:'ab-fixture'}},
    createLiveRuntime:async()=>({codeChanges:service,store,async close(){await service.close();store.close();}})});
  await bridge.listen();const base=`http://127.0.0.1:${bridge.server.address().port}`;

  async function api(url,options={}){const r=await fetch(base+url,{...options,headers:{authorization:`Bearer ab-test-token-0123456789abcdef-0123456789`,origin:'http://127.0.0.1:0','content-type':'application/json'}});return {status:r.status,body:await r.json()};}
  async function state(id){return (await api('/api/state?runId='+id)).body;}
  async function send(type,runId,payload={},requestId=randomUUID()){return api('/api/commands',{method:'POST',body:JSON.stringify({type,requestId,payload:{runId,expectedVersion:service.get(runId).version,...payload}})});}
  t.after(async()=>{release.resolve();await bridge.close();});
  return {directory,service,entered,release,api,state,send,base};
}
function record(id,value){if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,id+'.json'),JSON.stringify(value,null,2));}}
export function registerAsyncBoundaryTests({dashboard}) {
  test('async boundary A-01: uncertain command retains recovery connection after reload',{timeout:10000},async t=>{
    const start=Date.now(),f=await asyncBoundaryFixture(t),state=await f.state('A'),storage=new Map();let pending;
    const mutate=async(url,options)=>{if(url==='/api/commands'){pending=f.api(url,options);await f.entered.promise;throw Object.assign(new Error('controlled response loss'),{name:'TimeoutError'});}return (await f.api(url,options)).body;};
    const ui=await dashboard(state,mutate,storage);await ui.run('command("run.note.add",{kind:"NOTE",text:"only once"})');
    const unknown=ui.run('operations.runCommand'),beforeReceipt=(await f.api('/api/state?requestId=request-1')).body.requestResult;
    const pendingStorage=JSON.parse(storage.get('bridge.run-command-recovery'));
    assert.equal(pendingStorage.requests[0].runId,'A');assert.equal(pendingStorage.requests[0].requestId,'request-1');
    assert.equal(JSON.stringify(pendingStorage).includes('only once'),false);
    const serialized=JSON.stringify(pendingStorage),origin='http://127.0.0.1:8787';
    assert.equal(recoverRunCommandLinks(serialized,'different-auth-session',origin,state.runs).length,0);
    assert.equal(recoverRunCommandLinks(serialized,pendingStorage.scope,'http://other-server',state.runs).length,0);
    assert.equal(recoverRunCommandLinks(serialized,pendingStorage.scope,origin,state.runs.map(run=>({...run,targetRoot:'other-project',projectRef:{targetRoot:'other-project'}}))).length,0);
    const notFound=await dashboard(state,async(url,options)=>url.includes('requestId=')
      ? {requestResult:{requestId:'request-1',status:'NOT_FOUND'}} : mutate(url,options),new Map(storage));
    assert.equal(notFound.run('operations.runCommand'),'UNKNOWN_RESULT');
    assert.equal(notFound.calls.filter(x=>x.url==='/api/commands').length,0);
    const reloaded=await dashboard(state,mutate,storage);const reloadQueries=reloaded.calls.filter(x=>x.url.includes('requestId='));
    f.release.resolve();await pending;
    const afterReceipt=(await f.api('/api/state?requestId=request-1')).body.requestResult;
    await reloaded.run('refresh()');
    const failed=await f.send('run.note.add','A',{kind:'INVALID',text:'rejected'},'failed-request');
    const failedReceipt=(await f.api('/api/state?requestId=failed-request')).body.requestResult;
    assert.equal(failed.status,400);assert.equal(failedReceipt.status,'FAILED');assert.ok(failedReceipt.error.message);
    const duplicate=await f.api('/api/commands',{method:'POST',body:JSON.stringify(ui.calls.find(x=>x.url==='/api/commands').body)});
    const conflicting=await f.api('/api/commands',{method:'POST',body:JSON.stringify({...ui.calls.find(x=>x.url==='/api/commands').body,type:'run.archive'})});
    assert.equal(conflicting.status,409);
    const staleNew=await f.api('/api/commands',{method:'POST',body:JSON.stringify({...ui.calls.find(x=>x.url==='/api/commands').body,requestId:'new-request'})});
    const observed={unknown,beforeReceipt,afterReceipt,reloadQueries,afterReloadQueries:reloaded.calls.filter(x=>x.url.includes('requestId=')),
      notFoundRetainsUnknown:true,conflictingRequestStatus:conflicting.status,failedReceipt,duplicateStatus:duplicate.status,newRequestStaleVersionStatus:staleNew.status,notes:f.service.get('A').operatorNotes.length,
      automaticPosts:reloaded.calls.filter(x=>x.url==='/api/commands').length,pendingStorage,storage:[...storage],directory:f.directory,elapsedMs:Date.now()-start};record('A-01',observed);
    assert.equal(unknown,'UNKNOWN_RESULT');assert.equal(beforeReceipt.status,'PROCESSING');assert.equal(afterReceipt.status,'COMPLETED');
    assert.equal(observed.notes,1);assert.equal(observed.automaticPosts,0);assert.equal(staleNew.status,409);
    assert.ok(observed.afterReloadQueries.some(x=>x.url.includes('request-1')),'reload lost existing receipt connection');
  });
  for(const uncertain of [false,true]) test(`async boundary B-0${uncertain?2:1}: independent B actions during A ${uncertain?'unknown':'pending'}`,{timeout:10000},async t=>{
    const start=Date.now(),id=uncertain?'B-02':'B-01',f=await asyncBoundaryFixture(t),state=await f.state('A');let pending;
    const ui=await dashboard(state,async(url,options)=>{
      if(url==='/api/commands'&&JSON.parse(options.body).payload.runId==='A'){pending=f.api(url,options);await f.entered.promise;if(uncertain)throw Object.assign(new Error('controlled response loss'),{name:'TimeoutError'});return (await pending).body;}
      return (await f.api(url,options)).body;
    });
    const a=ui.run('command("run.note.add",{kind:"NOTE",text:"A note"})');await f.entered.promise;if(uncertain)await a;
    Object.assign(state,await f.state('B'));ui.run('openRun("B")');await ui.run('refresh()');
    ui.elements.get('operatorNoteText').value='B draft';await ui.run('render()');
    const buttons={noteDisabled:ui.elements.get('addOperatorNote').disabled,archiveDisabled:ui.elements.get('archiveRun').disabled};
    const capabilities=state.commandCapabilities;
    const read=await f.api('/api/state?runId=B');const note=await f.send('run.note.add','B',{kind:'NOTE',text:'B note'});
    const archive=await f.send('run.archive','B');const unarchive=await f.send('run.unarchive','B');
    Object.assign(state,await f.state('B'));await ui.run('refresh()');
    ui.context.crypto.randomUUID=randomUUID;
    ui.elements.get('operatorNoteKind').value='NOTE';
    ui.elements.get('operatorNoteText').value='B UI note';await ui.run('render()');
    await ui.elements.get('addOperatorNote').listeners.click();
    Object.assign(state,await f.state('B'));await ui.run('refresh()');
    await ui.run('command("run.archive")');
    const uiArchived=Boolean(f.service.get('B').archivedAt);
    Object.assign(state,await f.state('B'));await ui.run('refresh()');
    await ui.run('command("run.unarchive")');
    ui.elements.get('operatorNoteText').value='B draft';
    f.release.resolve();await pending;await a;
    const observed={buttons,capabilities,readStatus:read.status,noteStatus:note.status,archiveStatus:archive.status,unarchiveStatus:unarchive.status,
      uiArchived,bNotes:f.service.get('B').operatorNotes.length,bArchived:f.service.get('B').archivedAt,selected:ui.run('selected'),draft:ui.elements.get('operatorNoteText').value,
      aNotes:f.service.get('A').operatorNotes.length,receipt:(await f.api('/api/state?requestId=request-1')).body.requestResult,directory:f.directory,elapsedMs:Date.now()-start};record(id,observed);
    assert.equal(read.status,200);assert.equal(note.status,200);assert.equal(archive.status,200);assert.equal(unarchive.status,200);
    assert.equal(observed.bNotes,2);assert.equal(uiArchived,true);assert.equal(observed.selected,'B');assert.equal(observed.draft,'B draft');assert.equal(observed.aNotes,1);
    assert.equal(buttons.noteDisabled,false,'server-authorized independent B note blocked only by UI');
    assert.equal(buttons.archiveDisabled,false,'server-authorized independent B archive blocked only by UI');
  });
}
