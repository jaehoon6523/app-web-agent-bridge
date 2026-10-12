import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDiagnosticLog } from '../public/diagnostic-export.js';
test('export keeps raw response, trace and selector details while redacting credentials', async () => {
  const report=await collectDiagnosticLog({
    includeRaw:true, preparation:{deliveries:[{response:{rawText:'raw response'},trace:{documentId:'doc'}}],error:{details:{stage:'SELECT'}}},
    connectionState:{token:'private'},lastConfirmed:'observed',
    request:async path=>path.includes('selector') ? {tabs:[{diagnostics:{matched:1},documentId:'doc'}]} : {authorization:'Bearer private'}
  });
  assert.equal(report.displayed.preparation.deliveries[0].response.rawText,'raw response');
  assert.equal(report.selectors.data.tabs[0].documentId,'doc');
  assert.equal(report.partial,false); assert.doesNotMatch(JSON.stringify(report),/private/);
});
test('remote failure retains local observation and explicitly marks missing sources',async () => {
  const report=await collectDiagnosticLog({preparation:{error:{code:'AMBIGUOUS'}},connectionState:{},lastConfirmed:null,
    request:async()=>{throw Object.assign(new Error('secret error'),{code:'OFFLINE'});}});
  assert.equal(report.partial,true); assert.equal(report.agent.status,'UNAVAILABLE');
  assert.equal(report.displayed.preparation.error.code,'AMBIGUOUS'); assert.doesNotMatch(JSON.stringify(report),/secret error/);
});

test('key variants and Basic/Bearer headers are masked in both exporters', async () => {
  const {redactDiagnosticLog:controller}=await import('../public/diagnostic-export.js');
  const {redactDiagnosticLog:popup}=await import('../extension/runtime/diagnostic-redaction.js');
  const input={authentication:'private',API_KEY:'private','x-api-key':'private',nested:[{refresh_token:'private'}],
    rawText:'Authorization: Basic dXNlcjpwYXNz\nBearer private\nAPI_KEY=private',documentId:'doc',selectorVersion:'v1'};
  const output=controller(input);assert.deepEqual(output,popup(input));
  assert.doesNotMatch(JSON.stringify(output),/private|dXNlcjpwYXNz/);
  assert.equal(output.documentId,'doc'); assert.equal(output.selectorVersion,'v1');
});

test('URLs redact query credentials, encoded key names, repeats and userinfo in both exporters',async()=>{
  const a=(await import('../public/diagnostic-export.js')).redactDiagnosticLog;
  const b=(await import('../extension/runtime/diagnostic-redaction.js')).redactDiagnosticLog;
  for(const rawText of [
    'https://example.test/path?token=VISIBLE123&shared_secret=VISIBLE456',
    'https://VISIBLEUSER:VISIBLEPASS@example.test/path?%74oken=VISIBLE1&token=VISIBLE2&ok=preserve',
    'prefix https://example.test/?API_KEY=VISIBLE1&x-api-key=VISIBLE2 suffix',
    'token=VISIBLE1 shared_secret=VISIBLE2',
    '{"token":"VISIBLE1","shared_secret":"VISIBLE2"}'
  ]){const output=a({rawText});assert.deepEqual(output,b({rawText}));assert.doesNotMatch(JSON.stringify(output),/VISIBLE/);}
  assert.equal(a('https://example.test/?view=summary'),'https://example.test/?view=summary');
});

test('cancelled export does not collect or download',async()=>{
  const {exportDiagnosticLog}=await import('../public/diagnostic-export.js');
  const saved=globalThis.confirm;globalThis.confirm=()=>false;
  try{assert.deepEqual(await exportDiagnosticLog({request:()=>{throw Error('must not collect');}}),{cancelled:true});}
  finally{if(saved===undefined)delete globalThis.confirm;else globalThis.confirm=saved;}
});

test('actual export masks header strings and nested redirect URLs from every collected source',async()=>{
 const {redactDiagnosticLog:a,prepareDiagnosticLog}=await import('../public/diagnostic-export.js');
 const {redactDiagnosticLog:b,prepareDiagnosticLog:popup}=await import('../extension/runtime/diagnostic-redaction.js');
 const raw='Authorization=VISIBLE1\nCookie: session=VISIBLE2; csrf=VISIBLE3\nSet-Cookie: session=VISIBLE4\nhttps://e.test/?redirect='+encodeURIComponent('https://e.test/?token=VISIBLE5');
 assert.deepEqual(a(raw),b(raw)); assert.doesNotMatch(a(raw),/VISIBLE/);
 const report=await collectDiagnosticLog({includeRaw:true,preparation:{deliveries:[{response:{rawText:raw}}]},request:async()=>({message:raw}),connectionState:{},lastConfirmed:null});
 assert.doesNotMatch(JSON.stringify(report),/VISIBLE/);
 assert.deepEqual(prepareDiagnosticLog(report,{includeRaw:true}),popup(report,{includeRaw:true}));
 const basic=await collectDiagnosticLog({preparation:{objective:'private goal',discussion:[{content:'private message'}],deliveries:[{response:{rawText:'private raw'},trace:{documentId:'keep'}}]},request:async()=>({}),connectionState:{}});
 assert.doesNotMatch(JSON.stringify(basic),/private goal|private message|private raw/);
 assert.equal(basic.displayed.preparation.deliveries[0].trace.documentId,'keep');
 assert.equal(basic.exportMode,'DIAGNOSTIC_ONLY');
});
