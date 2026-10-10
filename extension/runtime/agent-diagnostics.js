import { diagnosticTabs, diagnosticDelivery, diagnosticIncident, diagnosticTime,
  diagnosticId, diagnosticNumber, diagnosticFingerprint, diagnosticFailure, mergeDiagnosticIncident } from './agent-diagnostic-schema.js';
const KEY = 'agentDiagnosticLatest';
const transitions = { 'prompt:reserved':'RESERVED','prompt:dispatch':'DISPATCH', 'prompt:conversation-bound':'BOUND',
  'prepare:start':'PREPARE','prepare:bound':'BOUND' };
/** Persist an independent diagnostic key; never mutate session/delivery ownership. */
export function createExtensionAgentDiagnostics({chromeApi,store,inspect,getConnection,send}) {
  let queue = Promise.resolve(), pending = null, timer = null, lastInspection = -Infinity, loggingFailure = null;
  const version = () => chromeApi.runtime.getManifest().version;
  const clean = value => ({schemaVersion:1,diagnosticId:diagnosticId(value?.diagnosticId),
    source:'EXTENSION_STORAGE',observedAt:diagnosticTime(value?.observedAt),extensionVersion:version(),
    connection:{authenticated:value?.connection?.authenticated === true,connected:value?.connection?.connected === true},
    tabs:Array.isArray(value?.tabs) ? diagnosticTabs(value) : null,
    tabInspectionAt:diagnosticTime(value?.tabInspectionAt),delivery:diagnosticDelivery(value?.delivery),
    incidents:(Array.isArray(value?.incidents) ? value.incidents : []).slice(-32).map(item => ({
      ...diagnosticIncident(item,'EXTENSION'),count:diagnosticNumber(item?.count),
      firstSeenAt:diagnosticTime(item?.firstSeenAt),lastSeenAt:diagnosticTime(item?.lastSeenAt),fingerprint:diagnosticFingerprint(diagnosticIncident(item,'EXTENSION'))})),
    recentTransitions:(Array.isArray(value?.recentTransitions) ? value.recentTransitions : []).slice(-32)
      .map(item => diagnosticIncident(item,'EXTENSION')),
    server:{status:'UNAVAILABLE',reason:'SERVER_STATE_NOT_COLLECTED'},loggingFailure});
  const read = async () => clean((await chromeApi.storage.local.get([KEY]))[KEY]);
  const update = operation => {
    const task = queue.then(async () => {
      const value = await read();
      await operation(value);
      value.diagnosticId = crypto.randomUUID();value.observedAt = new Date().toISOString();
      value.connection = getConnection();
      await chromeApi.storage.local.set({[KEY]:value});loggingFailure = null;
      return value;
    }).catch(error => {loggingFailure = diagnosticFailure(error,'DIAGNOSTIC_LOG_WRITE_FAILED');return null;});
    queue = task;return task;
  };
  const inspectNow = () => {
    if (pending) return pending;
    clearTimeout(timer);timer = null;lastInspection = Date.now();
    pending = Promise.all([inspect(),store.read()]).then(async ([tabs,state]) => update(value => {
      const at = new Date().toISOString();value.tabs = diagnosticTabs({tabs,inspectedAt:at});value.tabInspectionAt = at;
      value.delivery = diagnosticDelivery({...state,responseObserved:state.currentDeliveryId
        ? state.completedDelivery?.turnId === state.currentDeliveryId : false,
        acknowledgedDeliveryId:state.lastAcknowledgedDelivery?.deliveryId});
    }),error => update(value => {value.tabs = null;value.tabInspectionAt = null;
      value.incidents = mergeDiagnosticIncident(value.incidents,diagnosticIncident(error,'EXTENSION','INSPECT'));}))
      .finally(() => {pending = null;});
    return pending;
  };
  const schedule = () => {
    if (timer || pending) return;
    timer = setTimeout(() => {timer = null;void inspectNow();},Math.max(100,60000-(Date.now()-lastInspection)));
  };
  const failure = (error,stage,closeCode = null) => {
    void update(value => {value.incidents = mergeDiagnosticIncident(value.incidents,
      diagnosticIncident({...error,code:error?.code,stage,closeCode},'EXTENSION',stage));});
    schedule();
  };
  const recordMessage = message => {
    if (!['web.prompt.error','web.session.error','web.manual-intervention'].includes(message?.type)) return;
    void update(value => {value.incidents = mergeDiagnosticIncident(value.incidents,
      diagnosticIncident(message,'EXTENSION',message.type === 'web.prompt.error' ? 'DISPATCH' : 'PREPARE'));});schedule();
  };
  const recordTransition = (event,details) => {
    const stage = transitions[event];if (!stage) return;
    void update(value => {value.recentTransitions.push(diagnosticIncident({code:'STATE_OBSERVED',details:{...details,stage}},'EXTENSION',stage));
      value.recentTransitions = value.recentTransitions.slice(-32);});
  };
  const publish = async () => {await queue;const value = await read();send({type:'extension.diagnostic.report',payload:value});};
  chromeApi.runtime.onMessage.addListener((message,_sender,respond) => {
    if (message?.type !== 'bridge.exportDiagnostics') return false;
    void inspectNow().then(async () => {
      await queue;let value;
      try {value = await read();} catch (error) {value = clean(null);value.loggingFailure = diagnosticFailure(error,'DIAGNOSTIC_LOG_READ_FAILED');}
      value.loggingFailure = loggingFailure ?? value.loggingFailure;
      if (getConnection().authenticated) {
        // Reuse the authenticated WebSocket. Never bypass auth to export a report.
        const requestId = crypto.randomUUID();
        value.server = {status:'NOT_CHECKED',reason:'SERVER_REPORT_REQUEST_PENDING'};
        const result = new Promise(resolve => {
          const timeout = setTimeout(() => {responses.delete(requestId);resolve(null);},15000);
          responses.set(requestId,payload => {clearTimeout(timeout);resolve(payload);});
        });
        send({type:'extension.agent-report.get',requestId});
        const server = await result;
        if (server) value = {...server,offlineExtension:value};
        else value.server = {status:'UNAVAILABLE',reason:'SERVER_REPORT_TIMEOUT'};
      }
      respond({ok:true,report:value});
    }).catch(error => respond({ok:false,code:diagnosticFailure(error).code}));
    return true;
  });
  const responses = new Map();
  return {failure,recordMessage,recordTransition,publish,inspectNow,
    accept(message) {if (message?.type !== 'controller.agent-report.result') return false;
      const response = responses.get(message.requestId);if (response) {responses.delete(message.requestId);response(message.payload);}return true;}
  };
}
