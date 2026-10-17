import {beginVerificationIdentity,finishVerificationIdentity} from './verification-identity.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {runOwnedNode} from './e2e/platform/process.mjs';
const root=process.cwd(), directory=process.env.BRIDGE_VERIFICATION_OUTPUT || path.join(root,'.agent-controller');
const identity=beginVerificationIdentity(root);
const executable=process.env.UI_BROWSER_EXECUTABLE || chromium.executablePath();
const managedLinux=process.platform==='linux' && !process.env.UI_BROWSER_EXECUTABLE;
const installArgs=['node_modules/playwright-core/cli.js','install',...(managedLinux?['--with-deps']:[]),'chromium'];
if(managedLinux || !fs.existsSync(executable)) {
  const result=await runOwnedNode(installArgs,
    {cwd:root,timeoutMs:25*60*1000,onStdout:c=>process.stdout.write(c),onStderr:c=>process.stderr.write(c)});
  if(result.code!==0 || result.signal || result.forced) throw Error('BROWSER_INSTALL_FAILED');
}
let browser;
const result={status:'FAIL',executable,dependencyPreparation:managedLinux?'MANAGED_WITH_DEPS':process.env.UI_BROWSER_EXECUTABLE?'EXTERNAL_EXECUTABLE_LAUNCH_ONLY':'MANAGED_BROWSER',installArgs};
try {
  browser=await chromium.launch({executablePath:executable,headless:true});
  result.version=browser.version();result.status='PASS';
} catch(error) {result.error=error.message;process.exitCode=1;}
finally {
  try {await browser?.close();} catch(error) {result.cleanupError=error.message;result.status='FAIL';process.exitCode=1;}
  Object.assign(result,finishVerificationIdentity(root,identity));
  if(!result.candidateUnchanged) {result.status='FAIL';result.error='Source changed during browser preparation';process.exitCode=1;}
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'latest-browser-preparation.json'),JSON.stringify(result,null,2)+'\n');
}
