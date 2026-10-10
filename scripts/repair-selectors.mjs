import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { generateSelectorRepair, inspectSelectorRepair, applySelectorRepair } from '../src/orchestration/selector-repair.js';

const options = {};
const permitted = new Set(['server', 'tab', 'target', 'inspect', 'apply', 'approve']);
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/u, '');
  if (!process.argv[i].startsWith('--') || !permitted.has(key) || options[key] || !process.argv[i + 1]) throw new Error('Usage: npm run repair:selectors -- [--server http://127.0.0.1:8787 --tab TAB_ID] | --inspect JOB_ID | --apply JOB_ID --approve PATCH_HASH');
  options[key] = process.argv[i + 1];
}
const targetRoot = fs.realpathSync(path.resolve(options.target ?? process.cwd()));
try {
  if (options.inspect) {
    if (options.apply || options.approve || options.server || options.tab) throw new Error('Inspection cannot be combined with another action.');
    console.log(JSON.stringify(inspectSelectorRepair(targetRoot, options.inspect), null, 2));
  } else if (options.apply) {
    if (!options.approve || options.server || options.tab) throw new Error('Application requires the exact patch hash and a separate command.');
    console.log(JSON.stringify(applySelectorRepair(targetRoot, options.apply, options.approve), null, 2));
  } else {
    if (options.approve) throw new Error('Approval is only valid with --apply.');
    const config = loadConfig({ env:process.env, cwd:targetRoot });
    const base = new URL(options.server ?? config.baseUrl);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Use a plain local HTTP controller URL.');
    const request = async (route, init = {}, token = null) => {
      const response = await fetch(new URL(route, base), { ...init, signal:AbortSignal.timeout(15000),
        redirect:'error', headers:{ Origin:base.origin, 'Content-Type':'application/json', ...(token ? {Authorization:'Bearer ' + token} : {}) } });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error('Controller diagnostic request failed.'), {code:result.code ?? 'DIAGNOSTIC_UNAVAILABLE'});
      return result;
    };
    if (!config.dashboard?.token) throw Object.assign(new Error('Configure DASHBOARD_TOKEN for the controller and CLI.'), {code:'DASHBOARD_TOKEN_REQUIRED'});
    const snapshot = await request('/api/selector-diagnostics', {}, config.dashboard.token);
    const candidates = snapshot.tabs.filter(tab => tab.pageStatus === 'UI_CONTRACT_CHANGED' && tab.composerPresent === false);
    const tabId = options.tab ? Number(options.tab) : candidates.length === 1 ? candidates[0].tabId : null;
    if (!Number.isInteger(tabId)) {
      console.log(JSON.stringify({code:'REPAIR_TAB_SELECTION_REQUIRED', tabs:candidates.map(tab => ({tabId:tab.tabId, pageStatus:tab.pageStatus}))}, null, 2));
      process.exitCode = 1;
    } else {
      const control = new AbortController();
      const stop = () => control.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        const result = await generateSelectorRepair({ targetRoot, snapshot, tabId, workerConfig:config.codeWorker,
          codex:config.codex, signal:control.signal });
        console.log(JSON.stringify(result, null, 2));
      } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    }
  }
} catch (error) {
  console.error(JSON.stringify({ code:/^[A-Z_]+$/u.test(error.code ?? '') ? error.code : 'SELECTOR_REPAIR_FAILED',
    jobId:error.jobId ?? null, logFile:error.logFile ?? null }));
  process.exitCode = 1;
}
