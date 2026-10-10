import { writeAgentReport, safeFailure, summarizeTabs, summarizeDelivery, repositoryObservation } from "../src/diagnostics/agent-report.js";
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
let stage = "CONFIG", snapshot = null, reportDirectory = path.join(targetRoot, ".agent-controller", "diagnostics");
let httpStatus = null;
const record = (code, extra = {}) => {
  try { return writeAgentReport(reportDirectory, "repair", {
  source:"SELECTOR_REPAIR_CLI", stage, code, httpStatus,
  repository:repositoryObservation(targetRoot), tabs:snapshot ? summarizeTabs(snapshot) : null,
  delivery:summarizeDelivery(snapshot?.delivery),
  requestedTabId:Number.isSafeInteger(Number(options.tab)) ? Number(options.tab) : null, ...extra });
  } catch (error) { return {logFile:null, loggingFailure:safeFailure(error, "DIAGNOSTIC_LOG_WRITE_FAILED")}; }
};
try {
  if (options.inspect) {
    stage = "INSPECT";
    if (options.apply || options.approve || options.server || options.tab) throw new Error('Inspection cannot be combined with another action.');
    console.log(JSON.stringify(inspectSelectorRepair(targetRoot, options.inspect), null, 2));
  } else if (options.apply) {
    stage = "APPLY";
    if (!options.approve || options.server || options.tab) throw new Error('Application requires the exact patch hash and a separate command.');
    const result = applySelectorRepair(targetRoot, options.apply, options.approve);
    const report = record("REPAIR_APPLIED", {jobId:options.apply});
    console.log(JSON.stringify({...result, diagnosticId:report.diagnosticId, diagnosticLogFile:report.logFile, loggingFailure:report.loggingFailure}, null, 2));
  } else {
    if (options.approve) throw new Error('Approval is only valid with --apply.');
    const config = loadConfig({ env:process.env, cwd:targetRoot });
    reportDirectory = path.join(path.dirname(config.persistence.databasePath), "diagnostics");
    const base = new URL(options.server ?? config.baseUrl);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Use a plain local HTTP controller URL.');
    const request = async (route, init = {}, token = null) => {
      stage = "HTTP";
      const response = await fetch(new URL(route, base), { ...init, signal:AbortSignal.timeout(15000),
        redirect:'error', headers:{ Origin:base.origin, 'Content-Type':'application/json', ...(token ? {Authorization:'Bearer ' + token} : {}) } });
      httpStatus = response.status; stage = "HTTP_JSON";
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error('Controller diagnostic request failed.'), {code:result.code ?? 'DIAGNOSTIC_UNAVAILABLE'});
      return result;
    };
    if (!config.dashboard?.token) throw Object.assign(new Error('Configure DASHBOARD_TOKEN for the controller and CLI.'), {code:'DASHBOARD_TOKEN_REQUIRED'});
    record("REPAIR_DIAGNOSTIC_REQUEST_STARTED");
    snapshot = await request('/api/selector-diagnostics', {}, config.dashboard.token);
    stage = "TAB_SELECTION";
    if (!Array.isArray(snapshot.tabs)) throw Object.assign(new Error("Invalid diagnostic shape."), {code:"DIAGNOSTIC_INVALID_SHAPE"});
    const candidates = snapshot.tabs.filter(tab => tab.pageStatus === 'UI_CONTRACT_CHANGED' && tab.composerPresent === false);
    const tabId = options.tab ? Number(options.tab) : candidates.length === 1 ? candidates[0].tabId : null;
    if (!Number.isInteger(tabId)) {
      const report = record("REPAIR_TAB_SELECTION_REQUIRED");
      console.log(JSON.stringify({...report, code:'REPAIR_TAB_SELECTION_REQUIRED', tabs:candidates.map(tab => ({tabId:tab.tabId, pageStatus:tab.pageStatus}))}, null, 2));
      process.exitCode = 1;
    } else {
      const selected = snapshot.tabs.find(tab => tab.tabId === tabId);
      if (selected?.pageStatus === "READY" && selected.composerPresent === true) {
        const report = record("REPAIR_NOT_NEEDED");
        console.log(JSON.stringify({code:"REPAIR_NOT_NEEDED", tabId, ...report}));
        process.exitCode = 0;
      } else {
      stage = "REPAIR_PREFLIGHT";
      record("REPAIR_PREFLIGHT_STARTED");
      const control = new AbortController();
      const stop = () => control.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        const result = await generateSelectorRepair({ targetRoot, snapshot, tabId, workerConfig:config.codeWorker,
          codex:config.codex, signal:control.signal });
        const report = record("REPAIR_CANDIDATE_CREATED", {jobId:result.jobId});
        console.log(JSON.stringify({...result, diagnosticId:report.diagnosticId, diagnosticLogFile:report.logFile, loggingFailure:report.loggingFailure}, null, 2));
      } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
      }
    }
  }
} catch (error) {
  const failure = safeFailure(error, {CONFIG:"REPAIR_CONFIG_FAILED", HTTP:"REPAIR_HTTP_FAILED",
    HTTP_JSON:"REPAIR_HTTP_JSON_FAILED", TAB_SELECTION:"REPAIR_TAB_SELECTION_FAILED",
    REPAIR_PREFLIGHT:"REPAIR_PREFLIGHT_FAILED"}[stage] ?? "SELECTOR_REPAIR_FAILED");
  let report;
  try { report = record(failure.code, {failure, jobId:error.jobId ?? null}); }
  catch (logError) { report = {logFile:null, loggingFailure:safeFailure(logError, "DIAGNOSTIC_LOG_WRITE_FAILED")}; }
  console.error(JSON.stringify({ ...failure, stage, jobId:error.jobId ?? null,
    auditLogFile:error.logFile ?? null, ...report }));
  process.exitCode = 1;
}
