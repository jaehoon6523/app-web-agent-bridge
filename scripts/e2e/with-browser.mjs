import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { recordProcess, startResourceSamples, startWindowsMemorySamples } from './diagnostics.mjs';

const directory = path.resolve('.agent-controller/ui-qa/e2e-diagnostics');
fs.rmSync(directory, {recursive:true,force:true});
fs.mkdirSync(directory, {recursive:true});
process.env.BRIDGE_E2E_DIAGNOSTICS_DIR = directory;
const stopSamples = startResourceSamples(directory);
const stopWindowsMemory = startWindowsMemorySamples(directory);
recordProcess('wrapper',process.pid,process.ppid);
const nodeOptions = `${process.env.NODE_OPTIONS || ''} --report-on-fatalerror --report-exclude-env --report-exclude-network --report-directory="${directory.replaceAll('\\','/')}"`;

const child = spawn(process.execPath, process.argv.slice(2), {
  stdio:'inherit', windowsHide:true,
  env:{...process.env, NODE_OPTIONS:nodeOptions, UI_BROWSER_EXECUTABLE:process.env.UI_BROWSER_EXECUTABLE || chromium.executablePath()},
});
recordProcess('suite',child.pid);
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', (code, signal) => {
  stopSamples(); stopWindowsMemory();
  try {
    const files = fs.readdirSync(directory);
    fs.writeFileSync(path.join(directory,'capture-status.json'),JSON.stringify({
      suiteCode:code,suiteSignal:signal,
      processMap:files.includes('processes.jsonl'),resources:files.includes('resources.jsonl'),
      windowsMemory:process.platform !== 'win32' ? 'NOT_APPLICABLE' : files.includes('windows-memory.jsonl') ? 'CAPTURED' : 'MISSING',
      fatalReports:files.filter(name => /^report\..*\.json$/u.test(name)).length,
    }));
  } catch (error) { console.error('[E2E diagnostics] capture status unavailable:',error.code); }
  process.exitCode = signal ? 1 : code ?? 1;
});
