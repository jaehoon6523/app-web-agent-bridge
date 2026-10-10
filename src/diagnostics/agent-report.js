import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { collectSelectorDiagnostics, cancelSelectorDiagnostics } from "../orchestration/selector-diagnostics.js";

import { diagnosticToken as token, diagnosticId as uuid, diagnosticNumber as number,
  diagnosticFlag as flag, diagnosticTime, diagnosticTabs, diagnosticDelivery, diagnosticFailure, diagnosticIncident }
  from "./diagnostic-schema.js";
import { enqueueAgentReport, readAgentReport, writeAgentReport } from "./report-store.js";
export { writeAgentReport, readAgentReport } from "./report-store.js";
export const summarizeTabs = diagnosticTabs;
export const summarizeDelivery = diagnosticDelivery;
export const safeFailure = diagnosticFailure;
const deliveryId = uuid;
const array = value => Array.isArray(value) ? value : [];
export function repositoryObservation(root) {
  const read = args => spawnSync("git", ["-C", root, ...args], {encoding:"utf8", timeout:1500, windowsHide:true});
  const head = read(["rev-parse", "HEAD"]), status = read(["status", "--porcelain", "--untracked-files=normal"]);
  return { commit:head.status === 0 && /^[a-f0-9]{40}\s*$/u.test(head.stdout) ? head.stdout.trim() : null,
    dirty:status.status === 0 ? Boolean(status.stdout.trim()) : null };
}
/** @param {any} options */
export function createAutomaticAgentReport({ transport, directory, root, collect = collectSelectorDiagnostics,
  collectDelivery = async () => ({status:"NOT_CHECKED",reason:"DELIVERY_READER_UNAVAILABLE"}),
  intervalMs = 60000, onFailure = event => { void event; } }) {
  let closed = false, pending = null, lastRead = -Infinity, timer = null, queued = null;
  let connectionKey = [transport?.authenticated,transport?.responsive,transport?.snapshot?.connected].join(":"), connectionGeneration = 0, lastSnapshot = null, lastWrite = Promise.resolve();
  const processInstanceId = randomUUID();
  const write = (section, value) => {
    if (closed) return Promise.resolve(null);
    lastWrite = enqueueAgentReport(directory, section, value).catch(error => {
      try {onFailure(safeFailure(error,"DIAGNOSTIC_LOG_WRITE_FAILED"));} catch { /* A diagnostic sink is observational. */ }
      return null;
    });
    return lastWrite;
  };
  const incident = (event, source = "EXTENSION", stage = "UNKNOWN") =>
    write("incident",diagnosticIncident(event,source,stage));
  const persist = async (snapshot, error, trigger) => {
    if (closed) return;
    const state = transport?.snapshot, generation = connectionGeneration;
    const record = {source:"CONTROLLER", processInstanceId,nodeVersion:process.versions.node, trigger, observedAt:new Date().toISOString(),
      repository:repositoryObservation(root), connection:{ authenticated:Boolean(transport?.authenticated),
        responsive:Boolean(transport?.responsive), connected:Boolean(state?.connected),
        authenticationState:token(state?.authenticationState),extensionIdentity:uuid(state?.extensionIdentity) },
      collection:error ? {...safeFailure(error,"DIAGNOSTIC_UNAVAILABLE"),status:"UNAVAILABLE"} : {code:"DIAGNOSTIC_COLLECTED",status:"OBSERVED"},
      tabs:error ? null : summarizeTabs(snapshot), tabInspectionAt:error ? null : snapshot?.inspectedAt ?? null,
      lastKnownTabs:error && lastSnapshot ? {status:"STALE",observedAt:lastSnapshot.inspectedAt,tabs:summarizeTabs(lastSnapshot)} : null,
      bindingObservedAt:new Date().toISOString(),
      binding:{status:token(state?.binding?.bindingStatus),tabId:number(state?.binding?.tabId),
        documentId:uuid(state?.binding?.documentId),sessionId:uuid(state?.binding?.sessionId),runId:uuid(state?.binding?.runId)},
      delivery:summarizeDelivery(error ? null : snapshot?.delivery),
      limits:{maxTabs:8,minimumAutomaticIntervalMs:intervalMs,promptDispatch:false},
      nextAction:error ? "CHECK_CONNECTION_OR_DIAGNOSTIC_RPC" : "REVIEW_TAB_DECISIONS_AND_DELIVERY_STATUS"};
    {
      try {record.deliveryEvidence = await collectDelivery(error ? null : snapshot?.delivery);}
      catch (failure) {record.deliveryEvidence = {status:"UNAVAILABLE",reason:safeFailure(failure,"PERSISTED_DELIVERY_READ_FAILED").code,records:null};}
    }
    if (generation !== connectionGeneration) {
      record.tabs = null;record.tabInspectionAt = null;
      record.collection = {status:"UNAVAILABLE",code:"DIAGNOSTIC_CONNECTION_CHANGED"};
      record.deliveryEvidence = {status:"UNAVAILABLE",reason:"DIAGNOSTIC_CONNECTION_CHANGED",records:null};
    }
    if (!closed) await write("server",record);
  };
  const refresh = (trigger = "MANUAL") => {
    if (closed) return Promise.resolve(null);
    if (pending) return pending;
    clearTimeout(timer); timer = null; lastRead = Date.now();
    const generation = connectionGeneration;
    pending = Promise.resolve().then(() => collect(transport)).then(async snapshot => {
      if (generation !== connectionGeneration) {await persist(null,{code:"DIAGNOSTIC_CONNECTION_CHANGED"},trigger);return null;}
      lastSnapshot = snapshot; await persist(snapshot,null,trigger); return snapshot;
    },async error => {await persist(null,error,trigger);return null;}).finally(() => {
      pending = null;
      if (queued && !closed) {const trigger = queued;queued = null;request(trigger,true);}
    });
    return pending;
  };
  const request = (trigger, urgent = false) => {
    if (closed) return;
    if (pending) {if (urgent) queued = trigger;return;}
    const delay = urgent ? Math.max(100,1000-(Date.now()-lastRead)) : 100;
    if (!urgent && (timer || Date.now()-lastRead < intervalMs)) return;
    if (timer) {if (!urgent) return;clearTimeout(timer);}
    timer = setTimeout(() => {timer = null;void refresh(trigger);},delay); timer.unref?.();
  };
  const stateChanged = () => {
    const key = [transport?.authenticated,transport?.responsive,transport?.snapshot?.connected].join(":");
    if (key === connectionKey) return;
    connectionKey = key; connectionGeneration++;
    void persist(null,{code:"TAB_STATE_NOT_INSPECTED"},"CONNECTION_CHANGED");
    request("CONNECTION_CHANGED",true);
  };
  const message = event => {
    if (["web.prompt.error","web.session.error","web.manual-intervention"].includes(event?.type)) {
      void incident(event,"EXTENSION",event.type === "web.prompt.error" ? "DISPATCH" : "PREPARE");
      request("WEB_FAILURE",true);
    } else if (event?.type === "extension.diagnostic.report") {
      // Offline records are projected again; never trust extension-supplied arbitrary fields.
      const value = event.payload;
      void write("extension",{source:"EXTENSION_STORAGE",status:"OBSERVED",observedAt:diagnosticTime(value?.observedAt),
        diagnosticId:uuid(value?.diagnosticId),tabs:summarizeTabs(value),delivery:summarizeDelivery(value?.delivery),
        incidents:array(value?.incidents).slice(-32).map(item => ({...diagnosticIncident(item,"EXTENSION_OFFLINE"),
          count:number(item?.count),firstSeenAt:diagnosticTime(item?.firstSeenAt),lastSeenAt:diagnosticTime(item?.lastSeenAt)})),
        serverStatus:"NOT_CHECKED"});
    } else if (event?.type === "extension.agent-report.get") {
      void refresh("EXPORT").then(() => lastWrite).then(() => {
        if (!closed) transport.send({type:"controller.agent-report.result",requestId:event.requestId,
          payload:{...readAgentReport(directory),logFile:path.join(directory,"runtime-latest.json")}});
      }).catch(error => {try {onFailure(safeFailure(error,"DIAGNOSTIC_EXPORT_FAILED"));} catch { /* Keep diagnostics observational. */ }});
    } else if (["extension.heartbeat","extension.hello"].includes(event?.type)) request("EXTENSION_EVENT");
  };
  const diagnostic = event => {
    if (["EXTENSION_CONNECTION_REJECTED","AUTHENTICATION_REJECTED","WEB_SOCKET_ERROR"].includes(event?.type)) {
      void incident({...event,closeCode:event.type === "EXTENSION_CONNECTION_REJECTED" ? 4409
        : event.type === "AUTHENTICATION_REJECTED" ? 4403 : null},"CONTROLLER_TRANSPORT","CONNECT"); request("TRANSPORT_FAILURE",true);
    }
  };
  transport?.on("state",stateChanged); transport?.on("message",message); transport?.on("diagnostic",diagnostic);
  try {writeAgentReport(directory,"server",{source:"CONTROLLER",processInstanceId,nodeVersion:process.versions.node,
    trigger:"SERVER_CREATED",repository:repositoryObservation(root),
    connection:{authenticated:Boolean(transport?.authenticated),responsive:Boolean(transport?.responsive),connected:Boolean(transport?.snapshot?.connected)},
    collection:{status:"NOT_CHECKED",code:"TAB_STATE_NOT_INSPECTED"},tabs:null,tabInspectionAt:null,
    delivery:summarizeDelivery(null),deliveryEvidence:{status:"NOT_CHECKED",reason:"STARTUP_COLLECTION_PENDING",records:null}});}
  catch (error) {try {onFailure(safeFailure(error,"DIAGNOSTIC_LOG_WRITE_FAILED"));} catch { /* Keep startup observational. */ }}
  request("SERVER_CREATED");
  const observeDelivery = value => write("deliveryReview",{source:"DELIVERY_REVIEW_API",status:"OBSERVED",
    serverStatus:token(value?.server?.status),extensionPhase:token(value?.extension?.phase),
    expectedDeliveryId:deliveryId(value?.server?.expected?.currentDeliveryId),
    currentDeliveryId:deliveryId(value?.extension?.currentDeliveryId),exact:flag(value?.extension?.exact),
    ackConfirmed:flag(value?.extension?.ackConfirmed),discardConfirmed:flag(value?.extension?.discardConfirmed),
    records:array(value?.server?.records).slice(0,8).map(item => ({deliveryId:deliveryId(item?.deliveryId),
      active:flag(item?.active),state:token(item?.state),processingState:token(item?.processingState),responseStored:flag(item?.responseStored)}))});
  return {refresh,observeDelivery,incident,
    observeRecovery(record) {return write("deliveryRecovery",record);},
    observe(snapshot) {lastSnapshot = snapshot;return persist(snapshot,null,"DIAGNOSTIC_API");},
    failure(error) {return persist(null,error,"DIAGNOSTIC_API");},
    deliveryFailure(error) {return write("deliveryReview",{source:"DELIVERY_REVIEW_API",status:"UNAVAILABLE",
      failure:safeFailure(error,"DELIVERY_INSPECTION_UNAVAILABLE"),records:null});},
    async export() {await lastWrite;return {...readAgentReport(directory),logFile:path.join(directory,"runtime-latest.json")};},
    close() {closed = true;clearTimeout(timer);queued = null;
      if (collect === collectSelectorDiagnostics && transport) cancelSelectorDiagnostics(transport);
      transport?.off("state",stateChanged);transport?.off("message",message);transport?.off("diagnostic",diagnostic);
      return lastWrite;
    }
  };
}
