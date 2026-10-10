import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDeliveryRecoveryAudit} from '../src/diagnostics/delivery-recovery-audit.js';
import {createAutomaticAgentReport,readAgentReport} from '../src/diagnostics/agent-report.js';

test('durable recovery audit and single latest diagnostic separate unknown outcome from completed disposal',async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recovery-audit-'));
  const report=createAutomaticAgentReport({directory:path.join(root,'diagnostics'),root});
  t.after(async()=>{await report.close();await fs.rm(root,{recursive:true,force:true});});
  const audit=createDeliveryRecoveryAudit({directory:root,observe:record=>report.observeRecovery(record)});
  const input={currentDeliveryId:'delivery_618fcd37-ec59-4d1b-9151-eb437b6468e2',reason:'PRIVATE_PROMPT',conversationUrl:'https://chatgpt.com/?secret=PRIVATE_KEY',terminalDiscardConfirmed:true};
  for(const phase of ['STARTED','FAILED','STARTED','COMPLETED']) await audit({phase,input,code:'CONFIRM_FAILED'});
  const bytes=await fs.readFile(path.join(root,'events.jsonl'),'utf8');
  assert.equal(bytes.trim().split('\n').length,4);assert.doesNotMatch(bytes,/PRIVATE|chatgpt/u);
  await report.observeDelivery({server:{status:'MATCHED',records:[]},extension:{discardConfirmed:true}});
  const latest=readAgentReport(path.join(root,'diagnostics'));
  assert.equal(latest.deliveryRecovery.phase,'COMPLETED');assert.equal(latest.deliveryRecovery.resultStatus,'UNKNOWN');
  assert.equal(latest.deliveryRecovery.disposalStatus,'BOTH_DISCARDED');assert.equal(latest.deliveryReview.discardConfirmed,true);
});
test('audit storage failure reports a safe failure and fails closed',async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'recovery-audit-fail-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'file');await fs.writeFile(file,'occupied');const records=[];
  const audit=createDeliveryRecoveryAudit({directory:file,observe:async record=>records.push(record)});
  await assert.rejects(audit({phase:'STARTED',input:{}}),{code:'DELIVERY_AUDIT_WRITE_FAILED'});
  assert.equal(records[0].phase,'FAILED');assert.equal(records[0].disposalStatus,'UNVERIFIED');
});
