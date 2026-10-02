import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../src/config.js";
import { watchServerProcess } from "./server-watchdog.mjs";

export function runDiagnosticServer({ runtimeConfig, outputFile, onEvent=() => {} }) {
  fs.mkdirSync(path.dirname(outputFile), {recursive:true});
  const fd = fs.openSync(outputFile, "wx", 0o600);
  function record(event) {
    const entry = { at:new Date().toISOString(), ...event };
    fs.writeSync(fd, JSON.stringify(entry)+"\n");
    try { onEvent(entry); } catch { /* Optional observers cannot stop monitoring. */ }
  }
  // Preserve the OS/auth paths used by existing worker environment contracts.
  // Configuration and credentials travel through private IPC, never log records.
  const inheritedKeys = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
    "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "LANG", "LC_ALL", "TERM",
    ...(runtimeConfig.codex?.authPathKeys?.includes("CODEX_HOME") ? ["CODEX_HOME"] : []),
  ]);
  const childEnvironment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => inheritedKeys.has(key.toUpperCase())));
  const child = fork(fileURLToPath(new URL("./diagnose-server-child.mjs", import.meta.url)), [], {
    cwd:process.cwd(), execArgv:[],
    env:childEnvironment,
    stdio:["ignore", "inherit", "inherit", "ipc"],
  });
  const stopWatchdog = watchServerProcess(child, record);
  let stopped = false;
  let probing = false;
  const aborts = new Set();
  async function probe(route) {
    const started = performance.now();
    const abort = new AbortController();
    aborts.add(abort);
    const deadline = setTimeout(() => abort.abort(), 1500);
    try {
      const response = await fetch(runtimeConfig.baseUrl+route, { signal:abort.signal });
      await response.arrayBuffer();
      if (!stopped) record({ type:"probe.completed", route, status:response.status, elapsedMs:performance.now()-started });
    } catch {
      if (!stopped) record({ type:"probe.unanswered", route, elapsedMs:performance.now()-started });
    } finally { clearTimeout(deadline); aborts.delete(abort); }
  }
  // Probe only reads. No automatic retries of a mutation or token issuance.
  const probes = setInterval(async () => {
    if (probing || stopped) return;
    probing = true;
    try { await Promise.all([probe("/api/preflight"), probe("/api/health")]); }
    finally { probing = false; }
  }, 1000);
  child.once("close", (code, signal) => {
    record({ type:"process.exited", code, signal });
    stopped = true;
    clearInterval(probes);
    stopWatchdog();
    for (const abort of aborts) abort.abort();
    fs.closeSync(fd);
  });
  child.once("error", () => record({type:"process.error"}));
  child.send({ runtimeConfig });
  return child;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output")) throw new Error("Usage: npm run diagnose:server -- [--output new-file.jsonl]");
  const outputFile = path.resolve(args[1] ?? path.join(".agent-controller", "diagnostics", `server-${Date.now()}.jsonl`));
  const child = runDiagnosticServer({runtimeConfig:loadConfig(),outputFile});
  console.log(`Diagnostic log: ${outputFile}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    child.kill(signal);
    const failsafe = setTimeout(() => child.kill("SIGKILL"), 5500);
    failsafe.unref();
  });
  child.once("exit", code => { process.exitCode = code ?? 1; });
}
