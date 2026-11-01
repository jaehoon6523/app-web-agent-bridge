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
  stage('spec','verify:spec',{receipt:'spec'}),
  stage('discovery','test',{receipt:'gate',evidencePaths:['latest-test.log','latest-agent-diagnostics-complete','latest-server-response-deadline','latest-server-responsiveness','latest-verification-lifecycle','latest-verification-command','latest-source-checkout','latest-selector-repair-cli']}),
  stage('integration','test:integration'),
  stage('platform','test:platform',{receipt:'gate'}),
  stage('cleanup','test:runtime-cleanup-contract',{receipt:'gate'}),
  stage('windows-focused',null,{os:['win32'],nodeArgs:['scripts/run-tests.mjs',
    'tests/persistence-cleanup.test.js','tests/verification-lifecycle.test.js','tests/preparation-contention.test.js'],receipt:'gate'}),
  stage('platform-browser','test:platform:browser',{browser:true,receipt:'gate'}),
  stage('e2e','test:e2e:ci',{browser:true,receipt:'e2e',evidencePaths:['ui-qa/e2e-startup','ui-qa/e2e-wave','ui-qa/e2e-diagnostics','ui-qa/startup-runner-failure.json','ui-qa/wave-runner-failure.json']}),
  stage('ui','test:ui',{browser:true,os:['linux'],evidencePaths:['ui-qa/failure.json']}),
  stage('browser','test:browser:core',{browser:true,os:['linux'],receipt:'gate'}),
  stage('tab-ux','test:tab-ux-browser',{browser:true,receipt:'gui',expectedScenarios:[...requiredGuiScenarios]}),
  stage('sabotage','test:sabotage',{browser:true,os:['linux']}),
  stage('native','test:extension:native',{browser:true,receipt:'native',evidencePaths:['native-reload-control']}),
  stage('minimum-dependencies',null,{args:['ci'],scopes:['minimum'],needs:[],phase:'PREPARATION'}),
  stage('minimum-sqlite',null,{scopes:['minimum'],needs:['minimum-dependencies'],nodeArgs:[
    '--experimental-sqlite','--test','tests/platform/sqlite-database.test.js','tests/platform/sqlite-startup.test.js']}),
];
export function verificationPlan({scope='full',platform=process.platform}={}) {
  if (!['full','minimum'].includes(scope)) throw Error('Unknown verification scope: '+scope);
  const discovered=scope==='full'?discoverTests(path.join(root,'tests')).map(file=>path.relative(root,file).split(path.sep).join('/')):[];
  const specFiles=scope==='full'?JSON.parse(fs.readFileSync(path.join(root,'docs/spec/registry.json'),'utf8')).boundaries.map(entry=>entry.testPath):[];
  if(scope==='full' && (!specFiles.length || specFiles.some(file=>typeof file!=='string' || !discovered.includes(file))
    || new Set(specFiles).size!==specFiles.length)) throw Error('INVALID_SPEC_FILE_SET');
  const discoveryFiles=discovered.filter(file=>!specFiles.includes(file));
  // #154 exhausted the discovery stage budget while completing files normally.
  // Split Windows discovery into bounded groups. They run sequentially unless
  // verification explicitly requests concurrency. File deadlines, the complete
  // test inventory and OS policy stay unchanged. Each group keeps 25 minutes.
  const catalog=verificationCatalog.filter(item=>item.scopes.includes(scope)).flatMap(item=>{
    if(item.id!=='discovery' || item.nodeArgs) return [item];
    const files=discoveryFiles;
    if(platform!=='win32') return [{...item,command:null,nodeArgs:['scripts/run-tests.mjs',...files],isolatedGateOutput:true}];
    // This file completed in 169.8 s alone and reached its former 180 s file
    // deadline beside another discovery runner. Keep it in the inventory ahead
    // of concurrent groups; its file watchdog now allows scheduling variance.
    const exclusive='tests/audit-ack-recovery.test.js';
    if(!files.includes(exclusive)) throw Error('MISSING_EXCLUSIVE_DISCOVERY_FILE');
    const groups=Array.from({length:Math.min(4,files.length)},()=>[]);
    files.forEach((file,index)=>groups[index%groups.length].push(file));
    for(const group of groups) {
      const index=group.indexOf(exclusive);
      if(index!==-1) {group.splice(index,1);break;}
    }
    // The last measured Windows run (e8b50d22) spent 293 s on this file in
    // discovery and only 0.3 s on the exchanged file in discovery-4. Keep the
    // inventory and group sizes unchanged while reducing the longest group.
    const slow='tests/runtime-cleanup/contract.test.js';
    const fast='tests/prepared-session-target.test.js';
    const slowIndex=groups[0].indexOf(slow),fastIndex=groups[3].indexOf(fast);
    if(slowIndex!==-1 && fastIndex!==-1) {
      groups[0][slowIndex]=fast;
      groups[3][fastIndex]=slow;
    }
    return [{...item,id:'discovery-serial',command:null,nodeArgs:['scripts/run-tests.mjs',exclusive],
      isolatedGateOutput:true,parallelEligible:false},
    ...groups.map((files,index)=>({...item,id:index===0?'discovery':`discovery-${index+1}`,
      command:null,nodeArgs:['scripts/run-tests.mjs',...files],isolatedGateOutput:true,parallelEligible:true}))];
  });
  return catalog.map(item=>{
    const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
    const args=item.nodeArgs || (pkg.scripts[item.command] || '').split(/\s+/u);
    const gateIndex=args.findIndex(arg=>arg==='scripts/run-tests.mjs');
    const expectedFiles=item.receipt==='spec'?specFiles:item.receipt==='gate' ? (item.command==='test'
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
