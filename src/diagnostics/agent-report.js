import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { collectSelectorDiagnostics, cancelSelectorDiagnostics } from "../orchestration/selector-diagnostics.js";

import { diagnosticToken as token, diagnosticId as uuid, diagnosticNumber as number,
  diagnosticFlag as flag, diagnosticTime, diagnosticTabs, diagnosticDelivery, diagnosticFailure, diagnosticIncident }
  from "./diagnostic-schema.js";
import { enqueueAgentReport, readAgentReportAsync } from "./report-store.js";
export { writeAgentReport, readAgentReport } from "./report-store.js";
export const summarizeTabs = diagnosticTabs;
export const summarizeDelivery = diagnosticDelivery;
export const safeFailure = diagnosticFailure;
const deliveryId = uuid;
const array = value => Array.isArray(value) ? value : [];
/** @param {string} root @param {any} [options] */
export async function repositoryObservation(root, {signal,onDiagnostic,execute = execFile} = {}) {
  const read = args => new Promise(resolve => {
    // A read-only observation must not invoke repository/global fsmonitor hooks
    // or start a daemon whose lifetime is outside this report's owned child.
    const started = performance.now(), command = ['--no-optional-locks','-c','core.fsmonitor=false','-C',root,...args];
    const event = (type,detail = {}) => {
      try { onDiagnostic?.({type,at:new Date().toISOString(),monotonicMs:performance.timeOrigin+performance.now(),
        command:['git',...command],cwd:root,...detail}); } catch { /* Observation only. */ }
    };
    event('agent.report.git.started');
    let outcome, childClosed = false, exitCode = null, exitSignal = null;
    const complete = () => {
      if (!outcome || !childClosed) return;
      const {error,stdout} = outcome;
      event('agent.report.git.completed',{elapsedMs:performance.now()-started,exitCode,errorCode:error?.code ?? null,
        signal:exitSignal,timedOut:Boolean(error?.killed && !signal?.aborted),aborted:Boolean(signal?.aborted),terminationConfirmed:true});
      resolve(error ? null : stdout);
    };
    // Abort can invoke the callback before close. Wait for both before releasing ownership.
    const child = execute('git',command,{encoding:'utf8',timeout:1500,maxBuffer:1024*1024,windowsHide:true,signal},
      (error,stdout) => {outcome = {error,stdout};complete();});
    child.once('close',(code,signal) => {childClosed = true;exitCode = code;exitSignal = signal;complete();});
  });
  const head = await read(['rev-parse','HEAD']);
  const status = signal?.aborted ? null : await read(['status','--porcelain','--untracked-files=normal']);
  return {commit:head && /^[a-f0-9]{40}\s*$/u.test(head) ? head.trim() : null,dirty:status === null ? null : Boolean(status.trim())};
}
/** @param {any} options */
export function createAutomaticAgentReport({ transport, directory, root, collect = collectSelectorDiagnostics,
  collectDelivery = async () => ({status:"NOT_CHECKED",reason:"DELIVERY_READER_UNAVAILABLE"}),
  intervalMs = 60000, onFailure = event => { void event; }, onDiagnostic = undefined,
  observeRepository = repositoryObservation }) {
  let closed = false, pending = null, pendingGeneration = -1, lastRead = -Infinity, timer = null, queued = null;
  let connectionKey = [transport?.authenticated,transport?.responsive,transport?.snapshot?.connected].join(":"), connectionGeneration = 0, lastSnapshot = null, lastWrite = Promise.resolve();
  const processInstanceId = randomUUID();
  const cancellation = new AbortController();
  let finishClose, closePromise, storageFailure, tasks = Promise.resolve();
  const closing = new Promise(resolve => { finishClose = resolve; });
  const emit = (type,detail = {}) => {
    try { onDiagnostic?.({type,at:new Date().toISOString(),monotonicMs:performance.timeOrigin+performance.now(),pid:process.pid,processInstanceId,...detail}); }
    catch { /* A diagnostic sink is observational. */ }
  };
  const write = (section, value) => {
    lastWrite = enqueueAgentReport(directory, section, value,{onDiagnostic:emitEvent}).catch(error => {
      storageFailure ??= error;
      try {onFailure(safeFailure(error,"DIAGNOSTIC_LOG_WRITE_FAILED"));} catch { /* A diagnostic sink is observational. */ }
      return null;
    });
    return lastWrite;
  };
  const emitEvent = event => { try { onDiagnostic?.({...event,processInstanceId}); } catch { /* Observation only. */ } };
  const task = work => {
    if (closed) return Promise.resolve(null);
    const result = tasks.then(work,work);
    tasks = result.catch(error => {
      try { onFailure(safeFailure(error,'DIAGNOSTIC_UNAVAILABLE')); } catch { /* Observation only. */ }
    });
    return result;
  };
  const exportLatest = async () => {
    await tasks;await lastWrite;
    if (storageFailure) throw storageFailure;
    return {...await readAgentReportAsync(directory),logFile:path.join(directory,"runtime-latest.json")};
  };
  const incident = (event, source = "EXTENSION", stage = "UNKNOWN") =>
    closed ? Promise.resolve(null) : write("incident",diagnosticIncident(event,source,stage));
  const persist = (snapshot, error, trigger) => task(async () => {
    if (closed) return;
    const state = transport?.snapshot, generation = connectionGeneration;
    const repository = await observeRepository(root,{signal:cancellation.signal,onDiagnostic:emitEvent});
    if (closed) return;
    const record = {source:"CONTROLLER", processInstanceId,nodeVersion:process.versions.node, trigger, observedAt:new Date().toISOString(),
      repository, connection:{ authenticated:Boolean(transport?.authenticated),
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
  });
  const refresh = async (trigger = "MANUAL") => {
    if (closed) return null;
    // A prior connection's collection may still be persisting after authentication.
    // Await it once, then coalesce a current collection; never retry connection churn.
    if (pending && pendingGeneration !== connectionGeneration) await pending;
    if (closed) return null;
    if (pending) return pending;
    clearTimeout(timer); timer = null; lastRead = Date.now();
    const generation = connectionGeneration;
    pendingGeneration = generation;
    const started = performance.now(); emit('agent.report.collection.started',{trigger});
    pending = Promise.race([Promise.resolve().then(() => closed ? null : collect(transport)),closing]).then(async snapshot => {
      if (closed) return null;
      if (generation !== connectionGeneration) {await persist(null,{code:"DIAGNOSTIC_CONNECTION_CHANGED"},trigger);return null;}
      lastSnapshot = snapshot; await persist(snapshot,null,trigger); return snapshot;
    },async error => {await persist(null,error,trigger);return null;}).finally(() => {
      emit('agent.report.collection.completed',{trigger,elapsedMs:performance.now()-started,closed});
      pending = null;
      pendingGeneration = -1;
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
    emit('agent.report.collection.scheduled',{trigger,delayMs:delay});
    timer = setTimeout(() => {timer = null;void refresh(trigger).catch(error => {
      try { onFailure(safeFailure(error,'DIAGNOSTIC_UNAVAILABLE')); } catch { /* Observation only. */ }
    });},delay); timer.unref?.();
  };
  const stateChanged = () => {
    const key = [transport?.authenticated,transport?.responsive,transport?.snapshot?.connected].join(":");
    if (key === connectionKey) return;
    connectionKey = key; connectionGeneration++;
    void persist(null,{code:"TAB_STATE_NOT_INSPECTED"},"CONNECTION_CHANGED").catch(() => {});
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
      void refresh("EXPORT").then(exportLatest).then(payload => {
        if (!closed) transport.send({type:"controller.agent-report.result",requestId:event.requestId,
          payload});
      }).catch(error => {
        emit('agent.report.export.failed',{code:safeFailure(error,'DIAGNOSTIC_EXPORT_FAILED').code});
        try {onFailure(safeFailure(error,"DIAGNOSTIC_EXPORT_FAILED"));} catch { /* Keep diagnostics observational. */ }
      });
    } else if (["extension.heartbeat","extension.hello"].includes(event?.type)) request("EXTENSION_EVENT");
  };
  const diagnostic = event => {
    if (["EXTENSION_CONNECTION_REJECTED","AUTHENTICATION_REJECTED","WEB_SOCKET_ERROR"].includes(event?.type)) {
      void incident({...event,closeCode:event.type === "EXTENSION_CONNECTION_REJECTED" ? 4409
        : event.type === "AUTHENTICATION_REJECTED" ? 4403 : null},"CONTROLLER_TRANSPORT","CONNECT"); request("TRANSPORT_FAILURE",true);
    }
  };
  transport?.on("state",stateChanged); transport?.on("message",message); transport?.on("diagnostic",diagnostic);
  const ready = task(async () => write("server",{source:"CONTROLLER",processInstanceId,nodeVersion:process.versions.node,
    trigger:"SERVER_CREATED",repository:await observeRepository(root,{signal:cancellation.signal,onDiagnostic:emitEvent}),
    connection:{authenticated:Boolean(transport?.authenticated),responsive:Boolean(transport?.responsive),connected:Boolean(transport?.snapshot?.connected)},
    collection:{status:"NOT_CHECKED",code:"TAB_STATE_NOT_INSPECTED"},tabs:null,tabInspectionAt:null,
    delivery:summarizeDelivery(null),deliveryEvidence:{status:"NOT_CHECKED",reason:"STARTUP_COLLECTION_PENDING",records:null}}));
  void ready.catch(() => {});
  request("SERVER_CREATED");
  const observeDelivery = value => closed ? Promise.resolve(null) : write("deliveryReview",{source:"DELIVERY_REVIEW_API",status:"OBSERVED",
    serverStatus:token(value?.server?.status),extensionPhase:token(value?.extension?.phase),
    expectedDeliveryId:deliveryId(value?.server?.expected?.currentDeliveryId),
    currentDeliveryId:deliveryId(value?.extension?.currentDeliveryId),exact:flag(value?.extension?.exact),
    ackConfirmed:flag(value?.extension?.ackConfirmed),discardConfirmed:flag(value?.extension?.discardConfirmed),
    records:array(value?.server?.records).slice(0,8).map(item => ({deliveryId:deliveryId(item?.deliveryId),
      active:flag(item?.active),state:token(item?.state),processingState:token(item?.processingState),responseStored:flag(item?.responseStored)}))});
  return {ready,refresh,observeDelivery,incident,
    observeRecovery(record) {return closed ? Promise.resolve(null) : write("deliveryRecovery",record);},
    observe(snapshot) {lastSnapshot = snapshot;return persist(snapshot,null,"DIAGNOSTIC_API");},
    failure(error) {return persist(null,error,"DIAGNOSTIC_API");},
    deliveryFailure(error) {return closed ? Promise.resolve(null) : write("deliveryReview",{source:"DELIVERY_REVIEW_API",status:"UNAVAILABLE",
      failure:safeFailure(error,"DELIVERY_INSPECTION_UNAVAILABLE"),records:null});},
    export:exportLatest,
    close() {if (closePromise) return closePromise;closed = true;clearTimeout(timer);queued = null;
      cancellation.abort();finishClose(null);
      if (collect === collectSelectorDiagnostics && transport) cancelSelectorDiagnostics(transport);
      transport?.off("state",stateChanged);transport?.off("message",message);transport?.off("diagnostic",diagnostic);
      closePromise = (async () => {
        const outcomes = await Promise.allSettled([pending,tasks]);
        await lastWrite;emit('agent.report.closed');
        const rejected = outcomes.find(outcome => outcome.status === 'rejected');
        if (storageFailure) throw storageFailure;
        if (rejected?.status === 'rejected') throw rejected.reason;
      })();
      return closePromise;
    }
  };
}
