import { fork } from "node:child_process";
import { readFileSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";

// Saving the manifest version last marks a complete local release.
const extension = new URL("../extension/", import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const entry = fileURLToPath(new URL("../src/server.js", import.meta.url));
const manifestVersion = () => {
  const { version } = JSON.parse(readFileSync(new URL("manifest.json", extension), "utf8"));
  if (typeof version !== "string" || !/^\d+(?:\.\d+){1,3}$/u.test(version)) throw new Error("Invalid extension release version.");
  return version;
};
const report = (status, fields = {}) => console.log("[bridge.update]", JSON.stringify({status, ...fields}));
let child, active, requested, rejected, replacement, verify, timer, stopping = false, lastWait;

function schedule() {
  clearTimeout(timer);
  if (!stopping) timer = setTimeout(check, 5000);
}

function check() {
  if (stopping || !child?.connected) return;
  let version;
  try { version = manifestVersion(); }
  catch (error) { report("MANIFEST_UNAVAILABLE", {reason:error.message}); schedule(); return; }
  if (verify && !verify.awaiting) {
    verify.awaiting = true;
    child.send({type:"bridge.release"});
  }
  if (version === active || version === requested || version === rejected || replacement) return;
  requested = version;
  child.send({type:"bridge.update", version});
}

function launch(version, expectedBootId = null) {
  active = version;
  requested = rejected = replacement = lastWait = null;
  verify = {expectedBootId, awaiting:false};
  const proc = fork(entry, [], {
    cwd:root,
    execArgv:["--experimental-sqlite"],
    env:{...process.env, BRIDGE_MANAGED_RELEASE:version},
    stdio:["ignore", "inherit", "inherit", "ipc"],
  });
  child = proc;
  report("SERVER_STARTING", {version, pid:proc.pid});
  proc.on("message", message => {
    if (message.type === "bridge.release.status" && verify) {
      verify.awaiting = false;
      if (message.runtimeReady && message.serverVersion === active && message.extensionVersion === active
        && (!verify.expectedBootId || message.extensionBootId === verify.expectedBootId)) {
        verify = null;
        report("VERIFIED", {version:active, pid:message.serverProcessId,
          extensionVersion:message.extensionVersion, extensionBootId:message.extensionBootId});
      } else schedule();
    }
    if (message.type !== "bridge.update.result" || message.version !== requested) return;
    requested = null;
    if (message.status === "RELOADED") {
      replacement = message;
      report("EXTENSION_RECONNECTED", {version:message.version, extensionBootId:message.bootId});
    } else if (message.status === "BUSY") {
      if (lastWait !== message.reason) report("DEFERRED", {version:message.version, reason:message.reason});
      lastWait = message.reason;
      schedule();
    } else {
      rejected = message.version;
      report("FAILED", {version:message.version, reason:message.reason});
    }
  });
  proc.once("error", error => report("PROCESS_ERROR", {reason:error.message}));
  proc.once("exit", (code, signal) => {
    clearTimeout(timer);
    if (!stopping && code === 0 && replacement) {
      const {version, bootId} = replacement;
      launch(version, bootId);
      return;
    }
    watcher.close();
    if (!stopping) report("SERVER_STOPPED", {code, signal});
    process.exitCode = code ?? 1;
  });
  schedule();
}

const watcher = watch(extension, (_, filename) => {
  if (filename == null || filename === "manifest.json") schedule();
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    clearTimeout(timer);
    watcher.close();
    if (child?.connected) child.send({type:"bridge.shutdown"});
  });
}
launch(manifestVersion());
