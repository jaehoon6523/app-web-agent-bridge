// Shared, content-free projection for controller files and offline extension exports.
const uuidPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const identityPattern = new RegExp('^(?:(?:web_)?prep_|(?:run|session|web|delivery|request|turn)_)?' + uuidPattern + '$', 'u');
export const diagnosticToken = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : null;
export const diagnosticId = value => typeof value === 'string' && identityPattern.test(value) ? value : null;
export const diagnosticNumber = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export const diagnosticFlag = value => typeof value === 'boolean' ? value : null;
export const diagnosticTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ? value : null;
const version = value => typeof value === 'string' && /^\d{1,4}(?:\.\d{1,4}|-\d\d){1,5}$/u.test(value) ? value : null;
const array = value => Array.isArray(value) ? value : [];
export function diagnosticFailure(error, fallback = 'DIAGNOSTIC_UNAVAILABLE') {
  return {code:diagnosticToken(error?.code) ?? fallback, causeCode:diagnosticToken(error?.cause?.code),
    errorType:['Error','TypeError','SyntaxError','AbortError','TimeoutError'].includes(error?.name) ? error.name : 'Error'};
}
export function diagnosticIncident(event, source = 'CONTROLLER', defaultStage = 'UNKNOWN') {
  const details = event?.details ?? event?.payload?.details ?? event ?? {};
  const payload = event?.payload ?? event ?? {};
  return {source:diagnosticToken(source), code:diagnosticToken(payload.code) ?? 'WEB_FAILED',
    stage:diagnosticToken(details.stage ?? payload.stage) ?? defaultStage,
    occurredAt:diagnosticTime(event?.occurredAt ?? event?.at) ?? new Date().toISOString(),
    requestId:diagnosticId(event?.requestId), deliveryId:diagnosticId(details.deliveryId ?? event?.requestId),
    runId:diagnosticId(details.runId), sessionId:diagnosticId(details.sessionId),
    tabId:diagnosticNumber(details.tabId), documentId:diagnosticId(details.documentId),
    httpStatus:diagnosticNumber(payload.httpStatus),route:["/api/state","/api/preflight","/api/health","/api/dashboard/session","/api/commands","preparation-mutation","other-api","static"].includes(payload.route) ? payload.route : null,
    closeCode:diagnosticNumber(payload.closeCode), originalCode:diagnosticToken(details.originalCode),
    browserDispatchStarted:diagnosticFlag(details.browserDispatchStarted)};
}
export function diagnosticTabs(snapshot) {
  return array(snapshot?.tabs).slice(0,8).map(tab => {
    const failed = Boolean(tab?.inspectionError) || tab?.inspectionErrorPresent === true;
    const mismatch = !failed && tab?.pageStatus === 'UI_CONTRACT_CHANGED' && tab?.composerPresent === false;
    return {tabId:diagnosticNumber(tab?.tabId), pageStatus:diagnosticToken(tab?.pageStatus),
      composerPresent:failed ? null : diagnosticFlag(tab?.composerPresent), busy:diagnosticFlag(tab?.busy),
      generating:diagnosticFlag(tab?.generating), runtimeVersion:version(tab?.runtimeVersion),
      extensionVersion:version(tab?.extensionVersion), selectorVersion:version(tab?.selectorVersion ?? tab?.diagnostics?.selectorVersion),
      documentId:diagnosticId(tab?.documentId), frameId:diagnosticNumber(tab?.frameId),
      observedAt:diagnosticTime(tab?.inspectedAt ?? tab?.observedAt) ?? diagnosticTime(snapshot?.inspectedAt),
      inspectionErrorPresent:failed, inspectionErrorCode:failed ? diagnosticFailure(tab.inspectionError ?? {code:tab.inspectionErrorCode}).code : null,
      transport:{status:diagnosticToken(tab?.transport?.status), tabStatus:diagnosticToken(tab?.transport?.tabStatus),
        loadingStatus:diagnosticToken(tab?.transport?.loadingStatus)},
      pageState:{authenticationSignal:diagnosticToken(tab?.pageState?.authenticationSignal),
        readyState:['loading','interactive','complete'].includes(tab?.pageState?.readyState) ? tab.pageState.readyState : null},
      selectors:array(tab?.diagnostics?.composerSelectors ?? tab?.selectors).slice(0,16).map((item,index) => ({index,
        matched:diagnosticNumber(item?.matched),visible:diagnosticNumber(item?.visible)})),
      editableCandidates:array(tab?.diagnostics?.editableCandidates ?? tab?.editableCandidates).slice(0,8).map((item,index) => ({index,
        matched:diagnosticNumber(item?.matched),visible:diagnosticNumber(item?.visible),sampleCount:diagnosticNumber(item?.samples?.length ?? item?.sampleCount)})),
      decision:!failed && tab?.pageStatus === 'READY' && tab?.composerPresent === true ? 'REPAIR_NOT_NEEDED'
        : mismatch ? 'INSPECT_SELECTOR_MISMATCH' : 'STATUS_UNCONFIRMED'};
  });
}
export function diagnosticDelivery(value) {
  const scopes = Array.isArray(value?.scopedDeliveries) ? value.scopedDeliveries : Object.entries(value?.deliveryScopes ?? {})
    .slice(0,8).map(([sessionId,slot]) => ({sessionId,currentDeliveryId:slot.currentDeliveryId,runId:slot.lastBoundRunId,tabId:slot.tabId}));
  return {scopedDeliveries:scopes.slice(0,8).map(slot => ({sessionId:diagnosticId(slot?.sessionId),
    deliveryId:diagnosticId(slot?.currentDeliveryId ?? slot?.deliveryId),runId:diagnosticId(slot?.runId),tabId:diagnosticNumber(slot?.tabId)})),
    source:'EXTENSION_STORAGE',currentDeliveryId:diagnosticId(value?.currentDeliveryId),
    sessionId:diagnosticId(value?.sessionId ?? value?.lastBoundSessionId),runId:diagnosticId(value?.runId ?? value?.lastBoundRunId),
    ownerTabId:diagnosticNumber(value?.tabId ?? value?.ownerTabId),documentId:diagnosticId(value?.documentId),frameId:diagnosticNumber(value?.frameId),
    bindingStatus:diagnosticToken(value?.bindingStatus),responseObserved:diagnosticFlag(value?.responseObserved),
    acknowledgedDeliveryId:diagnosticId(value?.acknowledgedDeliveryId),recordObserved:value != null,
    responsePersistence:'UNKNOWN',acknowledgement:'UNVERIFIED',serverExtensionMatch:'UNKNOWN'};
}
export const diagnosticFingerprint = incoming => [incoming.source,incoming.code,incoming.stage,incoming.deliveryId,incoming.tabId,incoming.documentId].join(':');
export function mergeDiagnosticIncident(previous, incoming) {
  const fingerprint = diagnosticFingerprint(incoming);
  const items = array(previous).slice(-31).map(item => ({...item}));
  const found = items.find(item => item.fingerprint === fingerprint);
  if (found) {found.count = Math.min(1000000,(diagnosticNumber(found.count) ?? 0)+1); found.lastSeenAt = incoming.occurredAt;}
  else items.push({...incoming,fingerprint,firstSeenAt:incoming.occurredAt,lastSeenAt:incoming.occurredAt,count:1});
  return items.slice(-32);
}
