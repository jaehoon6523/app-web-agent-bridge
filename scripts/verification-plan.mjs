import {requiredGuiScenarios} from './verification-gui-contract.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {discoverTests} from './run-tests.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
// The same catalog drives local verification and CI. Explicit overlaps are
// retained: platform/cleanup are focused contracts as well as full discovery.
const stage = (id, command, options = {}) => ({id, command, required:true,
  node:'>=22.5', timeoutMs:25*60*1000, scopes:['full'], needs:['dependencies'], evidence:[], ...options});
export const verificationCatalog = [
  stage('dependencies', null, {args:['ci'],needs:[],phase:'PREPARATION'}),
  stage('browser-install', 'verify:browser-install', {receipt:'browser',
    phase:'PREPARATION',browser:true}),
  stage('lint','lint'), stage('architecture','architecture:check'), stage('types','typecheck'),
  stage('discovery','test',{receipt:'gate',evidencePaths:['latest-test.log','latest-agent-diagnostics-complete','latest-server-response-deadline','latest-server-responsiveness','latest-verification-lifecycle','latest-verification-command','latest-source-checkout']}),
  stage('integration','test:integration'),
  stage('platform','test:platform',{receipt:'gate'}),
  stage('cleanup','test:runtime-cleanup-contract',{receipt:'gate'}),
  stage('windows-focused',null,{os:['win32'],nodeArgs:['scripts/run-tests.mjs',
    'tests/persistence-cleanup.test.js','tests/verification-lifecycle.test.js','tests/preparation-contention.test.js'],receipt:'gate'}),
  stage('platform-browser','test:platform:browser',{browser:true,receipt:'gate'}),
  stage('e2e','test:e2e:ci',{browser:true,receipt:'e2e',evidencePaths:['ui-qa/e2e-startup','ui-qa/e2e-wave','ui-qa/startup-runner-failure.json','ui-qa/wave-runner-failure.json']}),
  stage('ui','test:ui',{browser:true,os:['linux'],evidencePaths:['ui-qa/failure.json']}),
  stage('browser','test:browser:core',{browser:true,os:['linux'],receipt:'gate'}),
  stage('tab-ux','test:tab-ux-browser',{browser:true,receipt:'gui',expectedScenarios:[...requiredGuiScenarios]}),
  stage('sabotage','test:sabotage',{browser:true,os:['linux']}),
  stage('native','test:extension:native',{browser:true,receipt:'native'}),
  stage('minimum-dependencies',null,{args:['ci'],scopes:['minimum'],needs:[],phase:'PREPARATION'}),
  stage('minimum-sqlite',null,{scopes:['minimum'],needs:['minimum-dependencies'],nodeArgs:[
    '--experimental-sqlite','--test','tests/platform/sqlite-database.test.js','tests/platform/sqlite-startup.test.js']}),
];
export function verificationPlan({scope='full',platform=process.platform}={}) {
  if (!['full','minimum'].includes(scope)) throw Error('Unknown verification scope: '+scope);
  return verificationCatalog.filter(item=>item.scopes.includes(scope)).map(item=>{
    const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
    const args=item.nodeArgs || (pkg.scripts[item.command] || '').split(/\s+/u);
    const gateIndex=args.findIndex(arg=>arg==='scripts/run-tests.mjs');
    const expectedFiles=item.receipt==='gate' ? (item.command==='test'
      ?discoverTests(path.join(root,'tests')).map(file=>path.relative(root,file).split(path.sep).join('/'))
      :args.slice(gateIndex+1)) : undefined;
    if(item.receipt==='gate' && item.command!=='test' && gateIndex<0) throw Error('UNRESOLVED_GATE_SCOPE: '+item.id);
    const expectedProfiles=item.receipt==='e2e'?JSON.parse(fs.readFileSync(path.join(root,'scripts/e2e/flows.json'),'utf8')).map(f=>f.id):undefined;
    const applicable=!item.os || item.os.includes(platform);
    return {...item,expectedFiles,expectedProfiles,evidencePaths:item.evidencePaths || (item.receipt==='gate'?['latest-test.log']:[]), needs:[...item.needs,...(item.browser && item.phase!=='PREPARATION'?['browser-install']:[])],
      required:applicable && item.required,status:'NOT_RUN',
      evidence:['output.log',...(item.receipt?['receipt.json']:[])],
      reason:applicable?'PENDING':'POLICY_EXCLUDED_OS',applicable};
  });
}
