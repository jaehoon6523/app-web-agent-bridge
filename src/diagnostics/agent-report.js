import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { collectSelectorDiagnostics, cancelSelectorDiagnostics } from "../orchestration/selector-diagnostics.js";

const token = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : null;
const uuid = value => typeof value === "string" && /^[a-f0-9-]{36}$/u.test(value) ? value : null;
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const flag = value => typeof value === "boolean" ? value : null;
const array = value => Array.isArray(value) ? value : [];
const deliveryId = value => typeof value === "string" && /^(?:delivery_)?[a-f0-9-]{36}$/u.test(value) ? value : null;
export function summarizeDelivery(value) {
  return { source:"EXTENSION_STORAGE", currentDeliveryId:deliveryId(value?.currentDeliveryId),
    ownerTabId:number(value?.tabId), bindingStatus:token(value?.bindingStatus),
    responseObserved:flag(value?.responseObserved), acknowledgedDeliveryId:deliveryId(value?.acknowledgedDeliveryId),
    recordObserved:value != null, responsePersistence:"UNKNOWN", acknowledgement:"UNVERIFIED", serverExtensionMatch:"UNKNOWN" };
}
const version = value => typeof value === "string" && /^\d+\.\d+\.\d+$/u.test(value) ? value : null;
export function safeFailure(error, fallback) {
  return { code:token(error?.code) ?? fallback, causeCode:token(error?.cause?.code),
    errorType:["Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError"].includes(error?.name) ? error.name : "Error" };
}
export function summarizeTabs(snapshot) {
  return (Array.isArray(snapshot?.tabs) ? snapshot.tabs : []).slice(0, 8).map(tab => ({
    tabId:number(tab?.tabId), pageStatus:token(tab?.pageStatus), composerPresent:flag(tab?.composerPresent),
    busy:flag(tab?.busy), generating:flag(tab?.generating), runtimeVersion:version(tab?.runtimeVersion),
    extensionVersion:version(tab?.extensionVersion), documentId:uuid(tab?.documentId),
    inspectionErrorPresent:Boolean(tab?.inspectionError),
    selectors:array(tab?.diagnostics?.composerSelectors).slice(0, 16).map((item, index) => ({
      index, matched:number(item?.matched), visible:number(item?.visible) })),
    editableCandidates:array(tab?.diagnostics?.editableCandidates).slice(0, 8).map((item, index) => ({
      index, matched:number(item?.matched), visible:number(item?.visible), sampleCount:number(item?.samples?.length) })),
    decision:tab?.pageStatus === "READY" && tab?.composerPresent === true ? "REPAIR_NOT_NEEDED"
      : tab?.pageStatus === "UI_CONTRACT_CHANGED" && tab?.composerPresent === false ? "INSPECT_SELECTOR_MISMATCH" : "STATUS_UNCONFIRMED"
  }));
}
export function repositoryObservation(root) {
  const read = args => spawnSync("git", ["-C", root, ...args], {encoding:"utf8", timeout:1500, windowsHide:true});
  const head = read(["rev-parse", "HEAD"]), status = read(["status", "--porcelain", "--untracked-files=normal"]);
  return { commit:head.status === 0 && /^[a-f0-9]{40}\s*$/u.test(head.stdout) ? head.stdout.trim() : null,
    dirty:status.status === 0 ? Boolean(status.stdout.trim()) : null };
}
// One atomic latest report. The repair journal remains the durable action history.
export function writeAgentReport(directory, section, record) {
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  const filename = path.join(directory, "runtime-latest.json");
  let previous = {};
  try { if (fs.statSync(filename).size <= 131072) previous = JSON.parse(fs.readFileSync(filename, "utf8")); } catch { /* A missing report is normal on first startup. */ }
  const result = { schemaVersion:1, updatedAt:new Date().toISOString(),
    server:previous.schemaVersion === 1 ? previous.server ?? null : null,
    repair:previous.schemaVersion === 1 ? previous.repair ?? null : null,
    deliveryReview:previous.schemaVersion === 1 ? previous.deliveryReview ?? null : null,
    [section]:{diagnosticId:randomUUID(), observedAt:new Date().toISOString(), ...record} };
  const temporary = filename + "." + randomUUID() + ".tmp";
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(result, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, filename); } catch (error) { fs.unlinkSync(temporary); throw error; }
  return { diagnosticId:result[section].diagnosticId, logFile:filename };
}
export function createAutomaticAgentReport({ transport, directory, root, collect = collectSelectorDiagnostics,
  intervalMs = 60000, onFailure = event => { void event; } }) {
  let closed = false, pending = null, lastRead = -Infinity, timer = null;
  let connectionKey = null;
  const persist = (snapshot, error, trigger) => {
    if (closed) return;
    const state = transport?.snapshot;
    try { writeAgentReport(directory, "server", {source:"CONTROLLER", trigger,
      repository:repositoryObservation(root), connection:{ authenticated:Boolean(transport?.authenticated),
        responsive:Boolean(transport?.responsive), connected:Boolean(state?.connected) },
      collection:error ? safeFailure(error, "DIAGNOSTIC_UNAVAILABLE") : {code:"DIAGNOSTIC_COLLECTED"},
      tabs:error ? null : summarizeTabs(snapshot), tabInspectionAt:error ? null : snapshot?.inspectedAt ?? null,
      bindingObservedAt:new Date().toISOString(),
      binding:{status:token(state?.binding?.bindingStatus), tabId:number(state?.binding?.tabId)},
      delivery:summarizeDelivery(error ? null : snapshot?.delivery),
      limits:{maxTabs:8, minimumAutomaticIntervalMs:intervalMs, promptDispatch:false},
      nextAction:error ? "CHECK_CONNECTION_OR_DIAGNOSTIC_RPC" : "REVIEW_TAB_DECISIONS_AND_DELIVERY_STATUS" });
    } catch (failure) { onFailure(safeFailure(failure, "DIAGNOSTIC_LOG_WRITE_FAILED")); }
  };
  const refresh = (trigger = "MANUAL") => {
    if (closed) return Promise.resolve(null);
    if (pending) return pending;
    clearTimeout(timer); timer = null;
    lastRead = Date.now();
    pending = Promise.resolve().then(() => collect(transport)).then(snapshot => {
      persist(snapshot, null, trigger); return snapshot;
    }, error => { persist(null, error, trigger); return null; }).finally(() => { pending = null; });
    return pending;
  };
  const request = trigger => {
    if (closed || pending || timer || Date.now() - lastRead < intervalMs) return;
    timer = setTimeout(() => { timer = null; void refresh(trigger); }, 100);
    timer.unref?.();
  };
  const stateChanged = () => {
    const key = [transport?.authenticated, transport?.responsive, transport?.snapshot?.connected].join(":");
    if (key === connectionKey) return;
    connectionKey = key;
    // Connection observations must not present the last document inspection as current.
    persist(null, {code:"TAB_STATE_NOT_INSPECTED"}, "CONNECTION_CHANGED");
    request("CONNECTION_CHANGED");
  };
  const message = event => { if (["extension.heartbeat", "web.manual-intervention"].includes(event?.type)) request("EXTENSION_EVENT"); };
  transport?.on("state", stateChanged); transport?.on("message", message);
  persist(null, {code:"TAB_STATE_NOT_INSPECTED"}, "SERVER_CREATED");
  request("SERVER_CREATED");
  const observeDelivery = value => {
    if (closed) return;
    try { writeAgentReport(directory, "deliveryReview", {source:"DELIVERY_REVIEW_API",
      serverStatus:token(value?.server?.status), extensionPhase:token(value?.extension?.phase),
      currentDeliveryId:deliveryId(value?.extension?.currentDeliveryId),
      exact:flag(value?.extension?.exact), ackConfirmed:flag(value?.extension?.ackConfirmed),
      discardConfirmed:flag(value?.extension?.discardConfirmed),
      records:array(value?.server?.records).slice(0, 8).map(item => ({deliveryId:deliveryId(item?.deliveryId),
        active:flag(item?.active), state:token(item?.state), processingState:token(item?.processingState), responseStored:flag(item?.responseStored)})) });
    } catch (error) { onFailure(safeFailure(error, "DIAGNOSTIC_LOG_WRITE_FAILED")); }
  };
  return { refresh, observeDelivery, observe(snapshot) { persist(snapshot, null, "DIAGNOSTIC_API"); },
    failure(error) { persist(null, error, "DIAGNOSTIC_API"); }, close() { closed = true; clearTimeout(timer);
    if (collect === collectSelectorDiagnostics && transport) cancelSelectorDiagnostics(transport);
    transport?.off("state", stateChanged); transport?.off("message", message); } };
}
