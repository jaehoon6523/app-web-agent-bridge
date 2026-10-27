import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createSourceCheckout,linkDependencies} from './helpers/source-checkout.mjs';
import {sourceManifest,assertSourceManifest,git} from '../scripts/verification-source.mjs';
import {beginTestEvidence,beginTestEvidenceRun} from './helpers/failure-evidence.mjs';
import {beginDiagnostics} from '../scripts/latest-run.mjs';
import {discoverTests,fileTimeoutMs} from '../scripts/run-tests.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(),'bridge-source-snapshot-'));
  t.after(() => fs.rmSync(base,{recursive:true,force:true}));
  const source = path.join(base,'source'); fs.mkdirSync(source);
  git(source,['init','-q']);
  const write = (name,text) => { const file = path.join(source,name); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,text); };
  write('.gitignore','node_modules/\n.agent-controller/\n');
  write('src/modified.js','HEAD bytes\n'); write('src/deleted.js','delete me\n');
  git(source,['add','.']); git(source,['-c','user.name=Fixture','-c','user.email=fixture@localhost',
    '-c','commit.gpgsign=false','-c','core.hooksPath=','commit','-qm','baseline']);
  return {base,source,write};
}

test('snapshot reflects staged, unstaged, new and deleted source without changing original HEAD or index', t => {
  const {base,source,write} = fixture(t);
  write('src/modified.js','staged bytes\n'); git(source,['add','src/modified.js']);
  write('src/modified.js','current unstaged bytes\n'); write('scripts/new.mjs','new source\n');
  fs.unlinkSync(path.join(source,'src/deleted.js'));
  const head = git(source,['rev-parse','HEAD']), index = fs.readFileSync(path.join(source,'.git/index'));
  const status = git(source,['status','--porcelain=v1']);
  const target = path.join(base,'snapshot'), result = createSourceCheckout(source,target);
  assert.equal(fs.readFileSync(path.join(target,'src/modified.js'),'utf8'),'current unstaged bytes\n');
  assert.equal(fs.readFileSync(path.join(target,'scripts/new.mjs'),'utf8'),'new source\n');
  assert.equal(fs.existsSync(path.join(target,'src/deleted.js')),false);
  assertSourceManifest(target,result.manifest);
  assert.equal(git(target,['status','--porcelain=v1']),''); assert.notEqual(git(target,['rev-parse','HEAD']),head);
  assert.equal(git(source,['rev-parse','HEAD']),head);
  assert.deepEqual(fs.readFileSync(path.join(source,'.git/index')),index);
  assert.equal(git(source,['status','--porcelain=v1']),status);
  fs.appendFileSync(path.join(target,'scripts/new.mjs'),'drift');
  assert.throws(() => assertSourceManifest(target,result.manifest),/SOURCE_MANIFEST_MISMATCH/u);
});

test('dependency junctions, directory symlinks and result folders cannot enter or recursively expand source', t => {
  const {base,source,write} = fixture(t), dependency = path.join(base,'dependency');
  fs.mkdirSync(dependency); fs.writeFileSync(path.join(dependency,'sentinel'),'dependency');
  fs.symlinkSync(dependency,path.join(source,'node_modules'),process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(dependency,path.join(source,'linked-dependency'),process.platform === 'win32' ? 'junction' : 'dir');
  write('.agent-controller/diagnostic-runs/old/raw.log','old result');
  write('test-results/profile/Preferences','browser state'); write('browser-profile/Preferences','browser state');
  write('.history-http-closure-example/program/src/copied.js','generated program copy');
  write('.runtime-cleanup-store-example/controller.sqlite','generated database');
  const target = path.join(base,'snapshot'), snapshot = createSourceCheckout(source,target);
  assert.ok(snapshot.manifest.files.every(item => !/node_modules|sentinel|test-results|browser-profile|\.agent-controller|linked-dependency|\.history-|\.runtime-cleanup-/u.test(item.path)));
  assert.equal(fs.existsSync(path.join(target,'node_modules')),false);
  linkDependencies(source,target); assert.equal(fs.lstatSync(path.join(target,'node_modules')).isSymbolicLink(),true);
  assertSourceManifest(target,snapshot.manifest);
});

test('latest evidence replaces the previous run, rejects overlap and preserves verification and cleanup independently', t => {
  const {source,base} = fixture(t), checkout = path.join(base,'disposable');
  fs.mkdirSync(path.join(checkout,'.agent-controller/selector-repair/job'),{recursive:true});
  fs.writeFileSync(path.join(checkout,'.agent-controller/selector-repair/job/events.jsonl'),'internal failure');
  const first = beginTestEvidence(source,'failure-fixture');
  first.record.commands.push({executable:process.execPath,cwd:checkout,exitCode:1,signal:null,timedOut:false,stdout:'failure',stderr:'details'});
  first.finish(Object.assign(Error('Verification failed'),{code:'REPAIR_VERIFICATION_FAILED'}));
  first.preserve(checkout); first.record.cleanupErrors.push('independent cleanup failure'); first.close();
  fs.rmSync(checkout,{recursive:true,force:true});
  const saved = JSON.parse(fs.readFileSync(path.join(first.directory,'result.json'),'utf8'));
  assert.equal(saved.failure.code,'REPAIR_VERIFICATION_FAILED'); assert.deepEqual(saved.cleanupErrors,['independent cleanup failure']);
  assert.equal(fs.readFileSync(path.join(first.directory,'internal/selector-repair/job/events.jsonl'),'utf8'),'internal failure');
  const second = beginTestEvidence(source,'failure-fixture');
  assert.notEqual(first.record.runId,second.record.runId);
  assert.equal(fs.existsSync(path.join(second.directory,'internal')),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(second.directory,'result.json'),'utf8')).status,'RUNNING');
  assert.throws(() => beginTestEvidence(source,'failure-fixture'),{code:'LATEST_RUN_BUSY'});
  second.finish(null); second.close();
  assert.deepEqual(fs.readdirSync(path.join(source,'.agent-controller')).filter(name => !name.startsWith('.')),['latest-failure-fixture']);
});

test('diagnostics use a fixed latest directory and only the matching child can join an active lease', t => {
  const {base} = fixture(t), output = path.join(base,'diagnostics');
  fs.mkdirSync(path.join(output,'diagnostic-runs/old'),{recursive:true});
  const lease = beginDiagnostics(output,'one');
  fs.mkdirSync(path.join(output,'latest-diagnostics'),{recursive:true});
  fs.writeFileSync(path.join(output,'latest-diagnostics/result.json'),'first');
  assert.throws(() => beginDiagnostics(output,'two'),{code:'LATEST_RUN_BUSY'});
  assert.throws(() => beginDiagnostics(output,'two',lease.token),/DIAGNOSTIC_LEASE_MISMATCH/u);
  beginDiagnostics(output,'one',lease.token).release();
  assert.equal(fs.readFileSync(path.join(output,'latest-diagnostics/result.json'),'utf8'),'first');
  lease.release();
  const second = beginDiagnostics(output,'two');
  assert.equal(fs.existsSync(path.join(output,'diagnostic-runs')),false);
  assert.equal(fs.existsSync(path.join(output,'latest-diagnostics')),false); second.release();
});

test('independent child processes release the lease and replace evidence on the next invocation', t => {
  const {base,source} = fixture(t), script = path.join(base,'child.mjs');
  fs.writeFileSync(script,`import {beginTestEvidence} from ${JSON.stringify(new URL('./helpers/failure-evidence.mjs',import.meta.url).href)};
const evidence=beginTestEvidence(process.argv[2],'child-process');
evidence.finish(null);evidence.close();console.log(evidence.record.runId);`);
  const run = () => execFileSync(process.execPath,[script,source],{encoding:'utf8'}).trim();
  const first = run();
  assert.equal(JSON.parse(fs.readFileSync(path.join(source,'.agent-controller/.child-process.owner.json'),'utf8')).active,false);
  const second = run(); assert.notEqual(first,second);
  assert.equal(JSON.parse(fs.readFileSync(path.join(source,'.agent-controller/.child-process.owner.json'),'utf8')).active,false);
  const saved = JSON.parse(fs.readFileSync(path.join(source,'.agent-controller/latest-child-process/result.json'),'utf8'));
  assert.equal(saved.runId,second); assert.equal(saved.status,'PASS'); assert.equal(saved.terminal,true);
  const crashed = path.join(base,'crashed.mjs');
  fs.writeFileSync(crashed,`import {beginTestEvidence} from ${JSON.stringify(new URL('./helpers/failure-evidence.mjs',import.meta.url).href)};
beginTestEvidence(process.argv[2],'child-process');process.exit(0);`);
  execFileSync(process.execPath,[crashed,source]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(source,'.agent-controller/latest-child-process/result.json'),'utf8')).status,'RUNNING');
  assert.notEqual(run(),second);
  assert.equal(JSON.parse(fs.readFileSync(path.join(source,'.agent-controller/latest-child-process/result.json'),'utf8')).status,'PASS');
});

test('file setup and cleanup failures cannot leave a PASS evidence result', t => {
  const {source} = fixture(t);
  const setup = beginTestEvidenceRun(source,'setup-failure');
  setup.record.failure = {message:'Snapshot setup failed'}; setup.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(setup.directory,'result.json'),'utf8')).status,'FAIL');
  const cleanup = beginTestEvidenceRun(source,'cleanup-failure'), scenario = cleanup.scenario('passed');
  scenario.finish(null); scenario.close();
  cleanup.record.cleanupErrors.push('Snapshot cleanup failed'); cleanup.close();
  const saved = JSON.parse(fs.readFileSync(path.join(cleanup.directory,'result.json'),'utf8'));
  assert.equal(saved.status,'FAIL'); assert.equal(saved.scenarios[0].status,'PASS');
  assert.deepEqual(saved.cleanupErrors,['Snapshot cleanup failed']);
});

const verificationFileBudget = fileTimeoutMs(path.resolve('tests/verification-command.test.js'));
// Two full files, one selected case, and the independent source fixture setup.
test('a failing first verification scenario retains its details after eight successes, then a new invocation replaces the run',
  {timeout:2*verificationFileBudget+2*60000+15000}, t => {
  const {base} = fixture(t), checkout = path.join(base,'verification');
  const source = path.resolve('.');
  createSourceCheckout(source,checkout); linkDependencies(source,checkout);
  const filename = path.join(checkout,'tests/verification-command.test.js');
  const original = fs.readFileSync(filename,'utf8');
  const trigger = "const {code,result,log}=await execute(t,'missing');";
  assert.equal(original.split(trigger).length,2);
  fs.writeFileSync(filename,original.replace(trigger,trigger+"\n  assert.fail('FIRST_SCENARIO_FAILURE');"));
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT; delete env.BRIDGE_TEST_RECEIPT; delete env.BRIDGE_TEST_FILE;
  const invoke = (extra = []) => {
    try {
      return {stdout:execFileSync(process.execPath,['--test','--test-reporter=tap','--experimental-test-isolation=none',...extra,filename],
        {cwd:checkout,env,encoding:'utf8',timeout:verificationFileBudget,maxBuffer:8*1024*1024}),code:0};
    } catch (error) { return {stdout:error.stdout,stderr:error.stderr,code:error.status}; }
  };
  const failed = invoke();
  assert.equal(failed.code,1); assert.match(failed.stdout,/# pass 8\b/u); assert.match(failed.stdout,/# fail 1\b/u);
  const directory = path.join(checkout,'.agent-controller/latest-verification-command');
  const saved = JSON.parse(fs.readFileSync(path.join(directory,'result.json'),'utf8'));
  assert.equal(saved.status,'FAIL'); assert.equal(saved.terminal,true);
  assert.equal(saved.setup.status,'PASS'); assert.equal(fs.existsSync(saved.setup.checkout),false);
  assert.equal(saved.scenarios.length,9);
  assert.equal(saved.scenarios[0].status,'FAIL'); assert.equal(saved.scenarios.at(-1).status,'PASS');
  assert.ok(saved.scenarios.every(item => item.terminal));
  const firstDirectory = path.join(directory,saved.scenarios[0].directory);
  const detail = JSON.parse(fs.readFileSync(path.join(firstDirectory,'result.json'),'utf8'));
  for (const scenario of saved.scenarios) {
    const item = JSON.parse(fs.readFileSync(path.join(directory,scenario.directory,'result.json'),'utf8'));
    assert.equal(item.snapshot.sourceSha256,saved.setup.snapshot.sourceSha256);
    assert.equal(item.commands[0].cwd,saved.setup.checkout);
  }
  assert.match(detail.failure.message,/FIRST_SCENARIO_FAILURE/u);
  assert.equal(detail.commands[0].exitCode,1); assert.equal(detail.commands[0].signal,null);
  assert.equal(detail.commands[0].timedOut,false); assert.match(detail.commands[0].stdout,/peer lint/u);
  assert.equal(typeof detail.commands[0].stderr,'string'); assert.ok(path.isAbsolute(detail.commands[0].cwd));
  assert.equal(detail.commands[0].args.at(-1),path.join(detail.commands[0].cwd,'scripts/verify-all.mjs'));
  assert.equal(fs.existsSync(detail.commands[0].cwd),false);
  assert.match(detail.snapshot.sourceSha256,/^[a-f0-9]{64}$/u);
  assert.match(fs.readFileSync(path.join(firstDirectory,'latest-verification.log'),'utf8'),/VERIFICATION FAIL/u);
  assert.equal(JSON.parse(fs.readFileSync(path.join(firstDirectory,'latest-verification.json'),'utf8')).source.sourceSha256,detail.snapshot.sourceSha256);
  t.diagnostic('Failure retained: '+JSON.stringify({runId:saved.runId,exitCode:failed.code,passed:8,failed:1,
    status:saved.status,first:saved.scenarios[0].status,last:saved.scenarios.at(-1).status,
    failure:detail.failure.message,sourceSha256:detail.snapshot.sourceSha256}));
  // Registration must also retain a test failure that precedes CLI invocation.
  fs.writeFileSync(filename,original.replace(trigger,"assert.fail('EARLY_SCENARIO_FAILURE');\n  "+trigger));
  const early = invoke(['--test-name-pattern=^verification command rejects exit zero without fresh completion receipts$']);
  assert.equal(early.code,1);
  const earlyRun = JSON.parse(fs.readFileSync(path.join(directory,'result.json'),'utf8'));
  assert.equal(earlyRun.status,'FAIL'); assert.equal(earlyRun.terminal,true); assert.equal(earlyRun.scenarios.length,1);
  const earlyDetail = JSON.parse(fs.readFileSync(path.join(directory,earlyRun.scenarios[0].directory,'result.json'),'utf8'));
  assert.match(earlyDetail.failure.message,/EARLY_SCENARIO_FAILURE/u); assert.equal(earlyDetail.commands.length,0);
  assert.equal(earlyDetail.snapshot.sourceSha256,earlyRun.setup.snapshot.sourceSha256);
  t.diagnostic('Pre-command failure retained: '+JSON.stringify({runId:earlyRun.runId,exitCode:early.code,status:earlyRun.status}));
  fs.writeFileSync(path.join(directory,'previous-run-marker'),'old run');
  fs.writeFileSync(filename,original);
  const passed = invoke(); assert.equal(passed.code,0); assert.match(passed.stdout,/# pass 9\b/u);
  const current = JSON.parse(fs.readFileSync(path.join(directory,'result.json'),'utf8'));
  assert.notEqual(current.runId,saved.runId); assert.notEqual(current.runId,earlyRun.runId);
  assert.equal(current.status,'PASS'); assert.equal(current.terminal,true);
  assert.equal(current.scenarios.length,9); assert.ok(current.scenarios.every(item => item.status === 'PASS'));
  assert.equal(fs.existsSync(path.join(directory,'previous-run-marker')),false);
  assert.equal(fs.readdirSync(path.join(directory,'scenarios')).length,9);
  assert.ok(!fs.readFileSync(path.join(directory,current.scenarios[0].directory,'result.json'),'utf8').includes('FIRST_SCENARIO_FAILURE'));
  t.diagnostic('Next invocation: '+JSON.stringify({runId:current.runId,exitCode:passed.code,status:current.status,
    scenarios:current.scenarios.length,previousMarkerExists:false}));
});

test('snapshot and CLI regression files are scheduled by the normal test discovery', () => {
  const files = discoverTests(path.resolve('tests')).map(file => path.relative(process.cwd(),file).split(path.sep).join('/'));
  for (const name of ['tests/source-checkout.test.mjs','tests/verification-command.test.js','tests/selector-repair-cli.test.js'])
    assert.ok(files.includes(name),name);
  assert.ok(sourceManifest(process.cwd()).files.some(file => file.path === 'scripts/verification-source.mjs'));
});
