import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const child = spawn(process.execPath, process.argv.slice(2), {
  stdio:'inherit', windowsHide:true,
  env:{...process.env, UI_BROWSER_EXECUTABLE:process.env.UI_BROWSER_EXECUTABLE || chromium.executablePath()},
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
