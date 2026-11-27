import { exportDiagnosticLog } from "./diagnostic-export.js";
import { renderInvalidAbandonment, invalidAbandonmentInput } from "./invalid-preparation-abandonment.js";
import { createPreparationTabChoice, renderPreparationTransmission } from "./preparation-tab-choice.js";
import { updateDashboardDiagnostics, showDashboardPageError, bindingPresentation, phaseReasons, userFacingError, userFacingStoredError } from "./dashboard-status-view.js";
import { renderInitialRequest, renderPreparationOutcome, renderPreparationResponse, readPreparationOptions, renderPreparationConversation, bindPreparationConversation, renderWorkspaceHeading } from "./preparation-view.js";
import { renderConversation } from "./conversation-view.js";
import { renderProjectOverview } from "./project-overview-view.js";
import { filterRunsForHistory, groupRunsByProject, normalizeDashboardState } from "./dashboard-model.js";
import { createRunActionLayout, ensureOperatorNoteControls } from "./run-action-layout.js";
import { projectRunListKnowledge } from "./dashboard-run-list-knowledge.js";
import { projectDashboardStartActions } from "./dashboard-start-actions.js";
import { projectPreparationActions, projectReviewerActions, projectRunCommandActions, reviewerProviderMatches } from "./dashboard-action-capabilities.js";
import { createRunContextView, reviewerRuntimeTechnicalSummary } from "./run-context-view.js";
import { createDashboardAuditPresentation } from "./dashboard-audit-presentation.js";
import { createDashboardHealthPresentation } from "./dashboard-health-presentation.js";
import {
  classifyDashboardFailure, connectionNoticeFor, dashboardStateReady,
  initialDashboardConnectionState, markDashboardSessionAuthenticated,
  markDashboardSessionPending, markStateReadReady, markStateReadStarted,
  projectDashboardKnowledge, requestFailureCode,
} from "./dashboard-connection-state.js";
const $ = (id) => document.getElementById(id);
let token = "", snapshot = null, selected = "", connected = false;
let connectionState = initialDashboardConnectionState();
let workflow = { stage: "START", state: "START_IDLE", preparationId: null, preparationVersion: null, runId: null, runVersion: null };
let sequence = 0, lastConfirmed = null, evidencePage = null, evidenceRequest = 0;
let applyDecision = null, deleteDecision = null;
let roleReviewRead = null;
let foregroundReads = 0, confirmedStateJson = null;
let renderedRecords = "", recoveryRunId = null;
let decisionSignature = "", interventionRunId = null;
let agreement = null, preparation = null;
let projectConversationRoot = null, reviewDiscussionRunId = null;
let followUpSource = null;
let pendingProjectDraft = null;
let openingPreparation = false;
let reviewerSelectionRoot = null;
let projectViewRoot = sessionStorage.getItem("bridge.project.view") || null;
let historyQuery = sessionStorage.getItem("bridge.history.query") || "";
let historyScope = sessionStorage.getItem("bridge.history.scope") || "ALL";
let historyRenderKey = "", inspectorOwner = "";
const inspectorScrollPositions = new Map();
const tabChoiceFailures = new Map();
const tabChoice = createPreparationTabChoice();
let latestRunDiagnostic = null;
const operations = { folderPicker: "IDLE", preparationStart: "IDLE", webTurn: "IDLE", approval: "IDLE", runCommand: "IDLE" };
let preparationSignature = "";
let preparationContentSignature = "";
let preparationRecovery = null;
let discardTarget = null;
let requestedView = "";
const unknownRequests = new Map();

const openFindings = new Set();
const { bindHealthInteractions, health, signal, runAppearance, workerRuntimeStatus } = createDashboardHealthPresentation({
  $, text, time, getConnectionState:() => connectionState, getConnected:() => connected,
  getSnapshot:() => snapshot, getLastConfirmed:() => lastConfirmed,
});
bindHealthInteractions();
const { renderApplyInspector, renderAudit, renderLog, selectInspector, recordPatchPage } = createDashboardAuditPresentation({
  $, text, node, time, openFindings, openEvidence, closeInspectorEvidence,
  getConnectionState:() => connectionState, getSnapshot:() => snapshot, getOperations:() => operations,
});
const terminal = new Set(["APPLIED", "CANCELLED", "INCONCLUSIVE", "FAILED", "COMPLETE"]);
const labels = { CREATED:"접수됨", PROVISIONING:"작업 환경 준비 중", WORKER_RUNNING:"구현·수정 중", CANDIDATE_CAPTURE:"변경사항 고정 중", VERIFYING:"검증 중", REVIEW_RUNNING:"독립 검토 중", REPORT_REPAIR:"검토 응답 확인 중", EVIDENCE_SUPPLEMENT:"검토 근거 보완 중", REWORK:"수정 대기", HOLD:"확인 필요", AWAITING_APPLY:"감사 통과·적용 대기", APPLYING:"적용 중", APPLIED:"적용됨", INCONCLUSIVE:"미해결 상태로 종료", CANCELLED:"사용자 중단", RECOVERY_REQUIRED:"복구 확인 필요", FAILED:"오류 종료", STOPPING:"중단 확인 중", COMPLETE:"이전 작업 기록" };
const reasons = { RECOVERY_ABANDONED:"사용자가 외부 종료와 대상 상태를 확인하고 실행을 폐기했습니다. 감사 기록과 작업 사본은 보존됩니다.", ITERATION_LIMIT:"구현 회차 한도에 도달했습니다. 남은 필수 지적을 확인하세요.", EVIDENCE_LIMIT:"증거 보완 한도에 도달했습니다. 부족한 자료를 확인하세요.", REPORT_REPAIR_LIMIT:"감사 보고서 보완 한도에 도달했습니다.", USER_DECISION_REQUIRED:"명세·검증 범위에 대한 사용자 판단이 필요합니다.", TOTAL_TIME_LIMIT:"전체 시간 한도에 도달했습니다. 외부 실행 상태를 확인해야 합니다.", STOP_UNCERTAIN:"중단을 요청했으나 외부 작업 종료를 확인하지 못했습니다.", USER_STOP:"후속 구현·감사·적용 배정을 중단했습니다." };
function text(id, value) { $(id).textContent = value ?? ""; }
function folderName(targetRoot) {
  return String(targetRoot ?? "").replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) || "프로젝트";
}
const reviewerProviderIds = new Set(["CHATGPT_WEB", "CLAUDE_WEB"]);
function syncReviewerProviderControls() {
  const judge = $("judgeReviewerProvider"), critic = $("criticReviewerProvider");
  if (!judge || !critic) return;
  if (workflow.stage !== "START" && preparation?.reviewers) {
    judge.value = reviewerProviderIds.has(preparation.reviewers.JUDGE?.provider) ? preparation.reviewers.JUDGE.provider : "CHATGPT_WEB";
    critic.value = reviewerProviderIds.has(preparation.reviewers.CRITIC?.provider) ? preparation.reviewers.CRITIC.provider : "CHATGPT_WEB";
    return;
  }
  const root = $("startRoot")?.value.trim() ?? "";
  if (reviewerSelectionRoot === root) return;
  const project = snapshot?.preflight?.project;
  const reviewers = project?.targetRoot === root ? project.reviewers : null;
  judge.value = reviewerProviderIds.has(reviewers?.JUDGE?.provider) ? reviewers.JUDGE.provider : "CHATGPT_WEB";
  critic.value = reviewerProviderIds.has(reviewers?.CRITIC?.provider) ? reviewers.CRITIC.provider : "CHATGPT_WEB";
  reviewerSelectionRoot = root;
}
function time(value) { return value ? new Date(value).toLocaleString("ko-KR") : "확인 전"; }
function node(tag, value, className = "") { const n = document.createElement(tag); n.textContent = value; n.className = className; return n; }
function ensureArchiveControls() {
  const filter = $("historyStatusFilter");
  if (filter && !Array.from(filter.children ?? []).some((item) => item.value === "ARCHIVED")) {
    const option = node("option", "보관됨");
    option.value = "ARCHIVED";
    filter.append(option);
  }
  let archive = $("archiveRun");
  if (!archive) {
    archive = node("button", "기록 보관");
    archive.id = "archiveRun";
    archive.type = "button";
    archive.disabled = true;
    archive.title = "종료된 실행을 감사 기록과 함께 보관합니다.";
    $("deleteRun")?.after(archive);
  }
}
ensureArchiveControls();
function ensureReviewerBindingRecoveryControls() {
  if ($("reviewBindingRecoveryPanel")) return;
  const panel = node("section", "", "flow-band");
  panel.id = "reviewBindingRecoveryPanel"; panel.hidden = true;
  panel.append(node("h2", "감사 대화 탭 복구"));
  const status = node("p", "", "muted"); status.id = "reviewBindingRecoveryStatus"; status.setAttribute("role", "status");
  const candidates = node("div", ""); candidates.id = "reviewBindingRecoveryCandidates";
  panel.append(status, candidates);
  $("reviewBindingRecoveryHost")?.append(panel);
}
ensureReviewerBindingRecoveryControls();
ensureOperatorNoteControls({ $, node });

const syncRunInformationArchitecture = createRunActionLayout({ $, text });

function selectProject(root) { if (root) { pendingProjectDraft?.cancel(); followUpSource = null; } projectViewRoot = root; sessionStorage.setItem("bridge.project.view", root ?? ""); render(); }
function openRun(runId) { pendingProjectDraft?.cancel(); followUpSource = null; selectProject(null); selected = runId; text("commandResult", ""); refresh(); }
function actionState(id, disabled, disabledReason = "", enabledReason = "") {
  const element = $(id);
  element.disabled = Boolean(disabled);
  const reason = element.disabled ? disabledReason : enabledReason;
  element.title = reason;
  if (reason) element.setAttribute("aria-description", reason);
  else element.removeAttribute("aria-description");
  buttonReason(element, element.disabled ? disabledReason : "");
  return reason;
}
function buttonReason(element, reason = "") {
  let note = element.nextElementSibling;
  if (!note || !note.classList.contains("action-reason")) {
    note = node("p", "", "action-reason muted");
    element.after(note);
  }
  note.hidden = !element.disabled || !reason;
  note.textContent = reason;
}
function workerIdentity(run) {
  const worker = run?.worker ?? {};
  const provider = worker.provider ?? null;
  const model = worker.model ?? null;
  return [provider, model].filter(Boolean).join(" / ") || "정보 없음";
}
const renderRunContextView = createRunContextView({ $, text, labels, terminal, folderName, workerIdentity });
async function request(url, options = {}) {
  let response = null;
  try {
    response = await fetch(url, { ...options, signal:AbortSignal.timeout(url === "/api/project/folder" ? 310000 : url.startsWith("/api/preparations/") ? 180000 : url.startsWith("/api/state") || url === "/api/dashboard/session" ? 10000 : 30000), cache:"no-store", headers:{ "Content-Type":"application/json", ...(token ? { Authorization:`Bearer ${token}` } : {}), ...options.headers } });
    let body;
    try { body = await response.json(); }
    catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") throw error;
      throw Object.assign(new Error(`서버 응답을 해석할 수 없습니다 (${response.status}).`), { code:"INVALID_SERVER_RESPONSE", status:response.status, responseReceived:true });
    }
    if (!response.ok) {
      const detail = body?.type === "command.error" ? body.payload : typeof body?.error === "object" ? body.error : body;
      throw Object.assign(new Error(detail?.message || body?.error || `요청 실패 (${response.status})`),
        { ...detail, status:response.status, responseReceived:true });
    }
    return body;
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError" || (!response && error instanceof TypeError)) {
      const code = requestFailureCode({ url, method:options.method, responseReceived:Boolean(response) });
      throw Object.assign(new Error(code === "UNKNOWN_RESULT" ? "요청 결과를 확인할 수 없습니다." : "서버 응답을 받지 못했습니다."), {
        code, responseReceived:Boolean(response),
      });
    }
    throw error;
  }
}
async function refresh(options = {}) {
  if (options.background) {
    if (!foregroundReads) await readDashboardState(options);
    return;
  }
  foregroundReads++;
  try { await readDashboardState(options); }
  finally { foregroundReads--; }
}
async function readDashboardState({ renewSession = true, recoveryTarget = null, background = false } = {}) {
  if (!$("dashboardPageError").hidden) return;
  const current = ++sequence;
  let target = selected, sourceProject = projectViewRoot;
  const isCurrent = () => $("dashboardPageError").hidden && current === sequence && target === selected
    && (!recoveryTarget || sourceProject === projectViewRoot);
  let phase = token ? "STATE" : "SESSION";
  const keepConfirmed = background && connected;
  let needsRender = !keepConfirmed;
  if (!keepConfirmed) {
    connected = false;
    connectionState = markStateReadStarted(connectionState);
    updateDashboardDiagnostics({ phase, connectionState, snapshot, lastConfirmed, target, loading:true, background });
    if (snapshot) render();
  }
  try {
    if (!token) {
      connectionState = markDashboardSessionPending(connectionState);
      const session = await request("/api/dashboard/session", { method:"POST", body:"{}" });
      if (!isCurrent()) return;
      if (typeof session?.token !== "string" || !session.token.trim()) throw Object.assign(new Error("대시보드 인증 응답에 토큰이 없습니다."), { code:"DASHBOARD_SESSION_INVALID", status:200, responseReceived:true });
      token = session.token;
      connectionState = markDashboardSessionAuthenticated(connectionState);
    }
    phase = "STATE";
    const query = recoveryTarget ? "?view=start"
      : target ? `?runId=${encodeURIComponent(target)}` : requestedView ? "?view=start" : "";
    const result = await request(`/api/state${query}`);
    if (!isCurrent()) return;
    phase = "PROJECTION";
    if (!result || !Array.isArray(result.runs) || !Array.isArray(result.commandCapabilities) || !result.preflight || typeof result.preflight !== "object") throw Object.assign(new Error("서버 상태 응답 형식을 확인하세요."), { code:"DASHBOARD_STATE_INVALID", status:200, responseReceived:true });
    if (!result.workflow) throw Object.assign(new Error("서버가 WORKFLOW_CONTRACT 상태를 제공하지 않습니다. 준비 API와 workflow projection 구현이 필요합니다."), { code:"DASHBOARD_STATE_INVALID", status:200, responseReceived:true });
    projectRunListKnowledge(result);
    const canonical = normalizeDashboardState(result);
    if (recoveryTarget) {
      const active = canonical.activePreparation;
      if (canonical.preparation?.lifecycle !== "ACTIVE" || active?.preparationId !== recoveryTarget.preparationId
        || active.version < recoveryTarget.version || !["START", "PREPARE"].includes(canonical.workflow.stage)) {
        throw Object.assign(new Error("진행 중인 준비가 바뀌었습니다. 상태를 다시 확인하세요."),
          {code:"PREPARATION_NAVIGATION_CHANGED", status:200, responseReceived:true});
      }
      pendingProjectDraft?.cancel();
      followUpSource = null;
      projectConversationRoot = null;
      target = selected = "";
    } else if (target && canonical.run?.runId !== target) throw Object.assign(new Error("조회한 작업과 응답 작업이 일치하지 않습니다."),
      {code:"DASHBOARD_STATE_INVALID", status:200, responseReceived:true});
    connectionState = markStateReadReady(connectionState);
    connected = dashboardStateReady(connectionState);
    const stateJson = JSON.stringify(result);
    needsRender ||= stateJson !== confirmedStateJson;
    confirmedStateJson = stateJson;
    snapshot = {...result, ...canonical, sessions:[...canonical.sessions.values()], commandCapabilities:[...canonical.commandCapabilities]};
    workflow = canonical.workflow; preparation = canonical.preparation; agreement = preparation?.agreement ?? null;
    if (preparation?.lifecycle === "ACTIVE" && preparation.deliveries?.some(item =>
      item.deliveryId === preparation.webSession?.activeDeliveryId && item.cancelRequestedAt) && !target) {
      requestedView = "closing";
    } else if (!["START", "PREPARE"].includes(workflow.stage)
      || (preparation?.lifecycle === "ACTIVE" && requestedView !== "closing")) requestedView = "";
    lastConfirmed = new Date().toISOString();
    if (recoveryTarget) { sourceProject = null; selectProject(null); }
    const runtimeUnavailable = result.runtimeAvailability?.ready === false;
    const extensionNeedsPreparation = workflow.stage === "PREPARE";
    if (needsRender) text("connectionNotice", runtimeUnavailable
      ? "서버·대시보드 정상 · 실행 런타임 준비 필요"
      : !extensionNeedsPreparation || result.preflight?.checks?.extensionAuthenticated === true ? ""
      : "웹 확장이 연결 대기 중입니다. 브라우저의 확장 팝업을 열어 서버 주소와 인증 상태를 확인한 뒤 다시 상태를 확인하세요.");
    for (const [operation, {requestId, runId}] of unknownRequests) {
      phase = "STATE";
      const observed = await request("/api/state?requestId=" + encodeURIComponent(requestId));
      if (!isCurrent()) return;
      const receipt = observed.requestResult;
      if (receipt?.requestId !== requestId) continue;
      if (["COMPLETED", "FAILED"].includes(receipt.status)) {
        needsRender = true;
        operations[operation] = "IDLE"; unknownRequests.delete(operation);
        if (operation !== "runCommand" || (snapshot?.run?.runId === runId && !projectViewRoot)) {
          text(operation === "runCommand" ? "commandResult" : "projectStatus", "요청 " + requestId + ": " + receipt.status);
        }
      }
    }
  } catch (error) {
    if (!isCurrent()) return;
    needsRender = true;
    if (phase === "PROJECTION" && !error.code) Object.assign(error, {code:"DASHBOARD_STATE_INVALID", status:200, responseReceived:true});
    connectionState = classifyDashboardFailure(connectionState, phase, {...error, message:userFacingError(error)});
    connected = dashboardStateReady(connectionState);
    if (phase === "STATE" && [401, 403].includes(error.status)) {
      token = "";
      if (renewSession && error.status === 401) return refresh({ renewSession:false, recoveryTarget });
    }
    text("connectionNotice", connectionNoticeFor(connectionState, lastConfirmed ? time(lastConfirmed) : "없음")
      + (snapshot?.run && (!target || snapshot.run.runId === target) ? " · 마지막 확인 데이터 표시 중입니다." : ""));
  }
  if (needsRender) render();
  pendingProjectDraft?.complete();
  if (needsRender) updateDashboardDiagnostics({ phase:connected ? "READY" : phase, connectionState, snapshot, lastConfirmed });
  const autoApprovalPreparationId = preparation?.autoApproveOnReady === true ? preparation.preparationId : null;
  const autoApprovalKey = autoApprovalPreparationId ? `bridge:auto-approve:${autoApprovalPreparationId}` : null;
  if (!recoveryTarget && autoApprovalPreparationId
    && sessionStorage.getItem(autoApprovalKey) !== "attempted"
    && preparation?.lifecycle === "ACTIVE"
    && agreement?.status === "READY"
    && preparation?.deliveries?.length === 1
    && (agreement.unresolvedQuestions?.length ?? 0) === 0
    && capabilities().has("preparation.approve")
    && operations.approval === "IDLE") {
    // Persist the attempt before sending; a reload during an uncertain request must not resend it.
    sessionStorage.setItem(autoApprovalKey, "attempted");
    void preparationMutation("approval", "preparation.approve",
      "/api/preparations/" + encodeURIComponent(autoApprovalPreparationId) + "/approve");
  }
}
function capabilities() { return new Set(connected ? snapshot?.commandCapabilities ?? [] : []); }
function webConnected() { return connected && snapshot?.preflight?.checks?.extensionAuthenticated === true; }
function currentPreparationActions() {
  const knowledge = projectDashboardKnowledge(connectionState);
  return projectPreparationActions({
    serverReachable:knowledge.transport.currentlyReachable,
    dashboardAuthenticated:knowledge.session.currentlyVerified,
    stateAvailable:knowledge.stateRead.currentlyAvailable,
    extensionAuthenticated:snapshot?.preflight?.checks?.extensionAuthenticated === true,
    commandCapabilities:snapshot?.commandCapabilities ?? [],
  });
}
function renderPreparationPersistence() {
  const element = $("preparationPersistence");
  if (!element) return;
  if (!preparation?.preparationId) {
    element.textContent = "저장된 준비 없음";
    element.className = "persistence-status muted";
    return;
  }
  const savedAt = preparation.updatedAt ? ` · 마지막 저장 ${time(preparation.updatedAt)}` : "";
  if (!connected) {
    element.textContent = `저장됨 · 준비 ID ${preparation.preparationId}${savedAt} · 최신 상태 미확인으로 조작 불가`;
    element.className = "persistence-status warn";
    return;
  }
  if (preparation.lifecycle === "ACTIVE") {
    element.textContent = `자동 저장됨 · 준비 ID ${preparation.preparationId}${savedAt} · 삭제 대신 ‘요구사항 정리 취소’로 종료합니다.`;
    element.className = "persistence-status ok";
  } else {
    element.textContent = `저장된 준비 종료됨 · 준비 ID ${preparation.preparationId}${savedAt}`;
    element.className = "persistence-status muted";
  }
}
function disabledWebReason(action) {
  if (!connected) return "최신 상태를 확인할 수 없습니다.";
  if (snapshot?.preflight?.checks?.extensionAuthenticated !== true) return "브라우저 확장 연결이 필요합니다.";
  if (operations.webTurn !== "IDLE") return "다른 웹 요청을 처리 중입니다.";
  if (preparation?.webSession?.bindingState !== "BOUND") return `대화 탭 연결이 필요합니다. 현재: ${preparation?.webSession?.bindingState ?? "UNBOUND"}.`;
  if (preparation?.diagnostics?.exactConversation !== true) return "정확한 대화 탭 연결이 필요합니다.";
  if (!capabilities().has(action)) return "현재 이 웹 작업을 사용할 수 없습니다.";
  return "";
}
function render() {
  if (!$("dashboardPageError").hidden) return;
  renderPreparation();
  const run = selected && snapshot?.run?.runId !== selected ? null : snapshot?.run;
  const roleTarget = roleReviewTarget(run);
  $("roleReviewPanel").hidden = !roleTarget;
  if (roleReviewRead?.targetKey !== roleTarget?.key) {
    roleReviewRead = null;
    $("roleReviewResults").replaceChildren();
    text("roleReviewStatus", "");
  }
  $("loadRoleReviews").disabled = !roleTarget || !connected || roleReviewRead?.pending === true;
  if (applyDecision && (applyDecision.runId !== run?.runId || applyDecision.version !== workflow.runVersion
    || applyDecision.candidateId !== run?.candidate?.candidateId || !capabilities().has("code.apply"))) {
    applyDecision = null;
    $("applyDecisionDialog").close();
  }
  if (deleteDecision && (deleteDecision.runId !== run?.runId || deleteDecision.version !== workflow.runVersion
    || !capabilities().has("run.delete"))) {
    deleteDecision = null;
    $("deleteRunDialog").close();
  }
  if (evidencePage?.candidateId && (evidencePage.target !== run?.runId
    || evidencePage.candidateId !== run?.candidate?.candidateId)) {
    closeInspectorEvidence(false);
  }
  const preflight = snapshot?.preflight, caps = capabilities();
  $("runPanel").dataset.runId = run?.runId ?? "";
  if (!run) { text("runObjective", ""); text("runStatus", ""); }
  if (!$("proposalWaiting")) {
    const waiting = node("p", "ChatGPT 응답을 기다리고 있습니다", "proposal-waiting");
    const spinner = node("span", "", "spinner"), dots = node("span", "...", "waiting-dots");
    waiting.append(spinner, dots);
    waiting.id = "proposalWaiting"; waiting.setAttribute("role", "status"); waiting.setAttribute("aria-live", "polite");
    $("startForm").append(waiting);
  }
  if ($("proposalWaiting").parentElement !== $("projectForm")) $("projectForm").prepend($("proposalWaiting"));
  $("proposalWaiting").hidden = workflow.stage !== "PREPARE" || !["INITIALIZING", "WAITING_WEB_RESPONSE"].includes(workflow.state);
  proposalControls();
  renderPreparationPersistence();
  const checks = preflight?.checks;
  const knowledge = projectDashboardKnowledge(connectionState);
  health("apiHealth", "서버", knowledge.transport.currentlyReachable ? "ok" : "unknown",
    knowledge.transport.currentlyReachable ? "정상" : "확인 필요");
  health("sessionHealth", "대시보드", knowledge.session.currentlyVerified ? "ok" : "unknown",
    knowledge.session.currentlyVerified ? "인증됨" : "확인 필요");
  const runtimeUnavailable = snapshot?.runtimeAvailability?.ready === false;
  const workerStatus = runtimeUnavailable
    ? { state:"warn", detail:"런타임 준비 필요" }
    : workerRuntimeStatus(snapshot?.workerRuntime);
  health("engineHealth", "Worker", workerStatus.state, workerStatus.detail);
  health("channelHealth", "확장", !connected || typeof checks?.extensionAuthenticated !== "boolean" ? "unknown" : checks.extensionAuthenticated ? "ok" : "warn",
    !connected || typeof checks?.extensionAuthenticated !== "boolean" ? "확인 전" : checks.extensionAuthenticated ? "연결됨" : "연결 대기");
  signal("serverSignal", "서버", knowledge.transport.currentlyReachable ? "ok" : "error",
    knowledge.transport.currentlyReachable ? "연결됨" : "상태 확인 필요");
  signal("cliSignal", "CLI", connected ? workerStatus.state : "warn",
    !connected ? "상태 확인 필요" : workerStatus.detail);
  const webAuthenticated = checks?.extensionAuthenticated === true;
  const runActions = projectRunCommandActions({
    stateAvailable:knowledge.stateRead.currentlyAvailable,
    runPresent:Boolean(run),
    commandCapabilities:[...caps],
    workerTurnAvailable:Boolean(run?.workerTurnId),
    archived:Boolean(run?.archivedAt),
  });
  const reviewerActionsFor = (role, exactBindingAvailable = false, exactDiscardDeliveryAvailable = false) => projectReviewerActions({
    stateAvailable:knowledge.stateRead.currentlyAvailable,
    runPresent:Boolean(run),
    extensionAuthenticated:webAuthenticated,
    commandCapabilities:[...caps],
    reviewerRuntimes:snapshot?.reviewerRuntimes,
    role,
    exactBindingAvailable,
    exactDiscardDeliveryAvailable,
  });
  signal("webSignal", "웹", connected ? (webAuthenticated ? "ok" : "warn") : "warn",
    !connected ? "상태 확인 필요" : webAuthenticated ? "연결됨" : "연결 대기");
  const lastBinding = preflight?.lastWebBinding;
  const bindingStatus = bindingPresentation({ connected, webAuthenticated, binding:lastBinding, workflowStage:workflow.stage });
  signal("webBindingSignal", "대화 탭", bindingStatus.state, bindingStatus.detail);
  signal("refreshSignal", "런", connected && lastConfirmed ? "ok" : "error",
    connected ? `갱신됨 ${time(lastConfirmed)}` : `마지막 확인 · ${lastConfirmed ? time(lastConfirmed) : "없음"}`);
  const runListKnowledge = snapshot
    ? projectRunListKnowledge(snapshot)
    : Object.freeze({ status:"NOT_OBSERVED", count:null, runs:null });
  const runsKnown = ["AVAILABLE_EMPTY", "AVAILABLE_NONEMPTY"].includes(runListKnowledge.status);
  const allRuns = runListKnowledge.runs ?? [], unfinished = runsKnown
    ? allRuns.find((r) => r.blocksNewRun ?? !terminal.has(r.phase)) : null;
  const busy = Boolean(unfinished);
  const preparationStartBlocked = snapshot?.preparationStartBlocked ?? busy;
  const activePreparation = snapshot?.activePreparation;
  const startActions = projectDashboardStartActions({ stateAvailable:knowledge.stateRead.currentlyAvailable, runListKnowledge,
    runtimeAvailable:snapshot?.runtimeAvailability?.ready === true, extensionAuthenticated:checks?.extensionAuthenticated === true,
    preparationStartCapability:caps.has("preparation.start"), hasUnfinishedRun:preparationStartBlocked, workflowStage:workflow.stage,
    preparationActive:activePreparation === undefined ? undefined : activePreparation !== null });
  syncReviewerProviderControls();
  const reviewerProvidersLocked = workflow.stage !== "START" || operations.preparationStart !== "IDLE" || !connected || preparationStartBlocked;
  $("judgeReviewerProvider").disabled = reviewerProvidersLocked;
  $("criticReviewerProvider").disabled = reviewerProvidersLocked;
  $("showUnfinishedRun").hidden = !busy;
  $("showUnfinishedRun").disabled = (operations.runCommand !== "IDLE") || !connected;
  $("historySearch").value = historyQuery;
  $("historyStatusFilter").value = ["ALL", "ACTIVE", "ATTENTION", "CLOSED", "ARCHIVED"].includes(historyScope) ? historyScope : "ALL";
  historyScope = $("historyStatusFilter").value;
  const activeHistoryRuns = allRuns.filter((item) => !item.archivedAt);
  const archivedHistoryRuns = allRuns.filter((item) => item.archivedAt);
  const filteredRuns = filterRunsForHistory(allRuns, { query:historyQuery, scope:historyScope });
  const filtersActive = Boolean(historyQuery.trim()) || historyScope !== "ALL";
  $("historyClearFilters").hidden = !filtersActive;
  const historyBaseCount = historyScope === "ARCHIVED" ? archivedHistoryRuns.length : activeHistoryRuns.length;
  text("historyFilterSummary", !runsKnown ? "작업 기록 조회 불가 · 현재 실행 목록을 확인할 수 없습니다."
    : filtersActive ? `${historyBaseCount}건 중 ${filteredRuns.length}건 표시` : `전체 ${activeHistoryRuns.length}건 · 보관 ${archivedHistoryRuns.length}건`);
  const list = $("runList");
  const groups = runsKnown ? groupRunsByProject(activeHistoryRuns) : [];
  if (runsKnown) for (const record of snapshot?.projectConversations ?? []) {
    if (record.targetRoot && !groups.some((item) => item.targetRoot === record.targetRoot)) groups.push({ targetRoot:record.targetRoot, runs:[] });
  }
  if (runsKnown && projectViewRoot && !groups.some((item) => item.targetRoot === projectViewRoot)) {
    projectViewRoot = null; sessionStorage.setItem("bridge.project.view", "");
  }
  const historyGroups = runsKnown ? groupRunsByProject(filteredRuns) : [];
  if (runsKnown && historyScope === "ALL") {
    const needle = historyQuery.trim().toLowerCase();
    for (const record of snapshot?.projectConversations ?? []) {
      if (!record.targetRoot || historyGroups.some((item) => item.targetRoot === record.targetRoot)) continue;
      const target = record.targetRoot.toLowerCase();
      const name = folderName(record.targetRoot).toLowerCase();
      if (!needle || target.includes(needle) || name.includes(needle)) historyGroups.push({ targetRoot:record.targetRoot, runs:[] });
    }
  }
  $("historyEmpty").hidden = runsKnown && historyGroups.length > 0;
  text("historyEmpty", runsKnown ? "조건에 맞는 실행 기록이 없습니다." : "작업 기록 조회 불가 · 현재 실행 목록을 확인할 수 없습니다.");
  const selectedHistoryRun = workflow.stage !== "START" ? run?.runId : null;
  const historyKey = JSON.stringify([projectViewRoot, historyScope, selectedHistoryRun, connected, historyGroups.map(group =>
    [group.targetRoot, group.runs.map(item => [item.runId, item.objective, item.phase])])]);
  if (historyRenderKey !== historyKey) {
    historyRenderKey = historyKey;
    list.replaceChildren();
    for (const group of historyGroups) {
      const section = node("section", "", "project-history");
      const projectHeadingLink = Boolean(group.targetRoot && historyScope !== "ARCHIVED");
      const heading = group.targetRoot
        ? node(projectHeadingLink ? "button" : "h3", folderName(group.targetRoot),
          projectHeadingLink ? `project-open${projectViewRoot === group.targetRoot ? " active" : ""}` : "")
        : node("h3", "기타 작업");
      if (group.targetRoot) heading.title = group.targetRoot;
      if (projectHeadingLink) heading.addEventListener("click", () => selectProject(group.targetRoot));
      section.append(heading);
      for (const r of group.runs) {
        const button = node("button", r.objective, `run-item${r.runId === selectedHistoryRun ? " active" : ""}`);
        if (r.runId === selectedHistoryRun) button.setAttribute("aria-current", "true");
        button.append(node("small", labels[r.phase] ?? r.phase, `health ${runAppearance(r.phase)}`));
        button.addEventListener("click", () => openRun(r.runId)); section.append(button);
      }
      list.append(section);
    }
  }
  const overviewGroup = projectViewRoot ? groups.find((item) => item.targetRoot === projectViewRoot) : null;
  $("projectOverview").hidden = !overviewGroup;
  $("workflow").hidden = Boolean(overviewGroup);
  const resultStage = workflow.stage === "RESULT";
  const userStep = workflow.stage === "START" ? "stepCollect"
    : workflow.stage === "PREPARE"
      ? (workflow.state === "APPROVING" || preparation?.state === "FAILED"
        ? "stepStartWork"
        : agreement?.status === "READY" || workflow.state === "AGREEMENT_READY"
          ? "stepReview"
          : "stepCollect")
      : workflow.stage === "WORK" ? "stepWork"
      : "stepResult";
  const stepIds = ["stepCollect", "stepReview", "stepStartWork", "stepWork", "stepResult"];
  const stepIndex = stepIds.indexOf(userStep);
  for (const [index, id] of stepIds.entries()) {
    const item = $(id);
    item.setAttribute("aria-current", id === userStep ? "step" : "false");
    item.classList.toggle("done", index < stepIndex);
    item.classList.toggle("failed", id === "stepStartWork" && preparation?.state === "FAILED");
  }
  // HOLD keeps its run inside the WORK stage (still in progress, not a final result), but it means a human
  // decision is needed, so the step nav gets a small badge to make that state noticeable at a glance.
  $("stepWorkBadge").hidden = !(workflow.stage === "WORK" && workflow.state === "HOLD");
  text("runStageHeading", resultStage ? "결과" : "작업");
  $("startPanel").hidden = Boolean(overviewGroup) || workflow.stage !== "START";
  $("followUpSource").hidden = !followUpSource;
  text("followUpSource", followUpSource ? `이어서 작업: ${followUpSource.objective} · 새 부탁과 요구사항은 다시 승인합니다. · 원본 작업 ID ${followUpSource.runId}${$("startRoot").value !== followUpSource.targetRoot ? " 폴더가 달라졌습니다. 원래 프로젝트를 선택하세요." : ""}` : "");
  if (workflow.stage !== "START") projectConversationRoot = null;
  if (workflow.stage === "START") {
    const root = $("startRoot").value.trim();
    const saved = snapshot?.projectConversations?.find((item) => item.targetRoot === root && item.conversationId);
    if (projectConversationRoot !== root) {
      const previous = snapshot?.projectConversations?.find((item) => item.targetRoot === projectConversationRoot);
      if ($("reuseProjectConversation").checked || previous?.conversationUrl === $("conversationUrl").value || followUpSource?.conversationUrl === $("conversationUrl").value) $("conversationUrl").value = "";
      projectConversationRoot = root;
      $("reuseProjectConversation").checked = Boolean(saved);
      $("conversationUrl").value = saved?.conversationUrl ?? (followUpSource?.targetRoot === root ? followUpSource.conversationUrl ?? "" : $("conversationUrl").value);
    }
    $("projectConversationPanel").hidden = !saved;
    text("projectConversationDetail", saved ? `저장된 대화: ${saved.conversationUrl} · 마지막 확인 ${time(saved.updatedAt)}` : "");
    if (saved && /^https:\/\/chatgpt\.com\/c\/[^/?#\s]+\/?$/u.test(saved.conversationUrl)) $("projectConversationLink").href = saved.conversationUrl;
    else $("projectConversationLink").removeAttribute("href");
    const reuse = Boolean(saved && $("reuseProjectConversation").checked);
    if (reuse) $("conversationUrl").value = saved.conversationUrl;
    $("conversationUrl").readOnly = reuse;
  }
  const preparing = workflow.stage === "PREPARE";
  const viewingPreparation = !overviewGroup && ["START", "PREPARE"].includes(workflow.stage);
  const prepActions = currentPreparationActions();
  renderPreparationOutcome($, preparation, {
    visible: viewingPreparation, connected, extensionConnected: webConnected(),
    canReconcile: caps.has("web.reconcile") && operations.webTurn === "IDLE",
    canClose: prepActions.cancel && operations.preparationStart === "IDLE",
    canApprove: prepActions.approve && operations.approval === "IDLE",
    canReply: prepActions.reply && operations.webTurn === "IDLE",
    canStart: startActions.canOpenNewRun,
    closeLabel: preparing ? $("closeProject").textContent : $("cancelInitialPreparation").textContent,
  });
  const feedback = $("proposalFeedback");
  if (preparing && viewingPreparation && preparation?.preparationId && feedback.dataset.preparationId !== preparation.preparationId) {
    feedback.dataset.preparationId = preparation.preparationId;
    feedback.value = "";
  }
  renderWorkspaceHeading($, text, preparation, checks, preparing && !overviewGroup, snapshot?.projectConversations);
  renderInitialRequest(workflow, preparation, $, text, document, caps.has("preparation.cancel"), preparationRecovery?.root);
  $("projectPanel").hidden = Boolean(overviewGroup) || !preparing;
  $("runPanel").hidden = Boolean(overviewGroup) || !["WORK", "RESULT"].includes(workflow.stage) || !run;
  const shownRun = $("runPanel").hidden ? null : run;
  const shownPreparation = $("projectPanel").hidden ? null : preparation;
  const workspacePath = overviewGroup?.targetRoot ?? shownRun?.targetRoot ?? shownPreparation?.targetRoot ?? "";
  const workspaceIdentity = shownRun?.runId ?? shownPreparation?.preparationId ?? "";
  const scrollOwner = JSON.stringify([overviewGroup?.targetRoot, shownRun?.runId,
    shownRun?.candidate?.candidateId, shownPreparation?.preparationId]);
  const inspectorScroll = $("studioInspectorScroll");
  const inspectorOwnerChanged = inspectorOwner !== scrollOwner;
  if (inspectorOwnerChanged) {
    if (inspectorOwner) inspectorScrollPositions.set(inspectorOwner, inspectorScroll.scrollTop);
    inspectorOwner = scrollOwner;
  }
  text("studioWorkspacePath", workspacePath);
  $("studioWorkspacePath").title = workspacePath;
  text("studioContextTitle", overviewGroup ? "프로젝트 기록" : shownPreparation ? "협의" : "현재 작업");
  text("studioContextStage", overviewGroup ? "이력 열람" : shownRun ? labels[shownRun.phase] ?? shownRun.phase : $(userStep).textContent.trim());
  $("studioContextIdentityRow").hidden = !workspaceIdentity;
  text("studioContextIdentity", workspaceIdentity);
  $("studioContextIdentity").title = workspaceIdentity;
  const contextDetail = shownPreparation && !$("preparationOutcome").hidden ? $("preparationOutcomeNext").textContent
    : shownRun?.phase === "RECOVERY_REQUIRED" || shownRun?.phase === "FAILED"
      ? reasons[shownRun.terminationReason] ?? userFacingStoredError(shownRun.error, "확인된 오류 사유가 없습니다.")
      : shownRun?.phase === "WORKER_RUNNING" && snapshot?.workerRuntime?.turnId === shownRun.workerTurnId && shownRun.workerTurnId
        ? workerRuntimeStatus(snapshot.workerRuntime).detail : "";
  $("studioContextDetailRow").hidden = !contextDetail;
  text("studioContextDetailLabel", shownPreparation ? "다음 행동" : shownRun?.phase === "WORKER_RUNNING" ? "Worker 관측" : "확인할 사항");
  text("studioContextDetail", contextDetail);
  if (!shownRun) $("applyInspector").hidden = true;
  actionState("planRun", !startActions.canStartPreparation || operations.preparationStart !== "IDLE" || operations.folderPicker !== "IDLE"
    || operations.runCommand !== "IDLE" || operations.webTurn !== "IDLE",
    runtimeUnavailable ? "실행 런타임 준비가 필요합니다."
      : !knowledge.stateRead.currentlyAvailable || !runsKnown ? "최신 상태와 작업 기록을 확인한 뒤 준비 대화를 시작할 수 있습니다."
        : !webConnected() ? "브릿지 확장 인증이 확인되지 않아 전송할 수 없습니다. ChatGPT 탭은 연결 후 자동으로 엽니다."
          : "현재 요청이나 작업이 끝나야 준비 대화를 시작할 수 있습니다.",
    "ChatGPT 탭이 없으면 새 탭을 열고 첫 부탁을 전송합니다.");
  if (workflow.stage === "START") {
    if (workflow.state === "CONNECTING_WEB") {
      text("startReason", "ChatGPT 대화 탭에 연결 중입니다. 아직 메시지를 전송하지 않았습니다.");
    } else if (preparation?.state === "WEB_BLOCKED" && preparation?.error) {
      const heldFailure = preparation.lifecycle === "ACTIVE";
      text("startReason", heldFailure && preparation.error.code === "WEB_TAB_SELECTION_REQUIRED"
        ? "사용할 ChatGPT 탭을 선택해야 합니다. 아래 후보를 선택한 뒤 전송 계속 버튼을 누르세요. 아직 메시지를 전송하지 않았습니다."
        : (heldFailure ? "현재 준비 요청이 실패했습니다. 오류를 확인하거나 ‘요청 취소’를 선택하세요. "
        : `이전 준비 ${preparation.preparationId}의 전송 실패 기록입니다. `)
        + preparation.error.message + " 상세 원인은 진단 로그로 내보낼 수 있습니다.");
    }
  }
  $("chooseFolder").disabled = !currentPreparationActions().chooseFolder || operations.folderPicker !== "IDLE";
  $("newRun").disabled = !startActions.canOpenNewRun || operations.preparationStart !== "IDLE" || operations.runCommand !== "IDLE";
  $("openActivePreparation").hidden = !activePreparation || (!overviewGroup
    && ["START", "PREPARE"].includes(workflow.stage) && workflow.preparationId === activePreparation.preparationId);
  $("openActivePreparation").disabled = !knowledge.stateRead.currentlyAvailable || openingPreparation;
  text("newRunReason", !knowledge.stateRead.currentlyAvailable ? "최신 상태 확인 후 새 작업을 시작할 수 있습니다."
    : !runsKnown ? "작업 기록 조회 불가 · 현재 실행 목록을 확인한 뒤 새 작업을 시작할 수 있습니다."
    : workflow.stage === "PREPARE" ? "현재 준비를 유지합니다. 종료하려면 ‘준비 취소’를 선택하세요."
    : preparation?.lifecycle === "ACTIVE" && preparation.error?.code === "WEB_TAB_SELECTION_REQUIRED"
      ? "현재 준비 요청에 사용할 ChatGPT 탭을 선택해야 합니다."
    : activePreparation ? "현재 요청의 응답 또는 처리 결과를 확인 중입니다."
    : preparationStartBlocked ? "진행 중인 작업을 먼저 확인하세요."
    : activePreparation === undefined ? "현재 준비 상태를 확인한 뒤 새 작업을 시작할 수 있습니다."
    : !webConnected() ? "준비 대화를 시작하려면 웹 확장 인증이 필요합니다."
    : busy ? "새 협의를 시작할 수 있습니다. 구현을 시작하려면 기존 작업의 복구 상태를 확인하세요." : "");
  if (overviewGroup) renderProjectOverview({ group:overviewGroup, projectConversation:snapshot?.projectConversations?.find(item => item.targetRoot === overviewGroup.targetRoot), busyRun:unfinished, allRuns, $, text, node, folderName, labels, runAppearance, terminal, time, connected, newRunDisabled:$("newRun").disabled, openRun });
  if (workflow.stage === "START" && workflow.state !== "CONNECTING_WEB"
    && !preparation?.error && !checks?.extensionAuthenticated) {
    text("startReason", "입력은 가능합니다. 브릿지 확장이 인증되면 준비 대화를 시작할 수 있습니다. ChatGPT 탭은 자동으로 엽니다.");
  }
  if (recoveryRunId !== run?.runId) {
    recoveryRunId = run?.runId;
    $("recoveryConfirm").checked = false;
    text("reconcileResult", "");
  }
  if (interventionRunId !== run?.runId) {
    interventionRunId = run?.runId ?? null;
    $("workerInterventionKind").value = "GUIDANCE";
    $("workerInterventionText").value = "";
    text("workerInterventionStatus", "");
  }
  if (reviewDiscussionRunId !== run?.runId) {
    reviewDiscussionRunId = run?.runId ?? null;
    $("reviewDiscussionRole").value = "JUDGE";
    $("reviewDiscussionText").value = "";
    $("reviewDiscussionUnresolved").checked = false;
    $("reviewDiscussionNoResend").checked = false;
    $("reviewDiscussionDiscardReason").value = "";
    text("reviewDiscussionStatus", "");
  }
  if (!$("reviewDiscussionRole").value) $("reviewDiscussionRole").value = "JUDGE";
  const discussionActive = ["HOLD","AWAITING_APPLY"].includes(run?.phase) && Boolean(run?.candidate?.candidateId);
  const unresolvedDiscussion = [...(run?.reviewDiscussions ?? [])].reverse().find((item) => item.status === "UNCONFIRMED") ?? null;
  const discussionRole = $("reviewDiscussionRole").value;
  const discussionRuntime = snapshot?.reviewerRuntimes?.[discussionRole] ?? null;
  const discussionBinding = (run?.conversationBindings ?? []).find((item) =>
    item.role === discussionRole && item.conversationUrl && item.conversationId && item.activeDeliveryId === null
      && reviewerProviderMatches(item.provider, discussionRuntime?.provider));
  const unresolvedRuntime = unresolvedDiscussion ? snapshot?.reviewerRuntimes?.[unresolvedDiscussion.role] ?? null : null;
  const unresolvedBinding = unresolvedDiscussion ? (run?.conversationBindings ?? []).find((item) =>
    item.role === unresolvedDiscussion.role && item.activeDeliveryId === unresolvedDiscussion.discussionId
      && item.sessionId && item.conversationUrl
      && reviewerProviderMatches(item.provider, unresolvedRuntime?.provider)) : null;
  const discussionText = $("reviewDiscussionText").value.trim();
  const discussionActions = reviewerActionsFor(discussionRole, Boolean(discussionBinding));
  const unresolvedActions = reviewerActionsFor(unresolvedDiscussion?.role ?? null, false, Boolean(unresolvedBinding));
  $("reviewDiscussionPanel").hidden = !discussionActive;
  $("sendReviewDiscussion").disabled = !discussionActive || operations.runCommand !== "IDLE"
    || !discussionActions.discuss || !discussionText || Boolean(unresolvedDiscussion);
  $("reviewDiscussionRecovery").hidden = !unresolvedDiscussion;
  text("reviewDiscussionRecoveryDetail", unresolvedDiscussion
    ? `${unresolvedDiscussion.role} · ${unresolvedDiscussion.discussionId} · 전송 결과 미확인. 자동 재전송하지 않습니다.`
    : "");
  $("discardReviewDiscussion").disabled = !unresolvedDiscussion || !unresolvedActions.discardDiscussion
    || operations.runCommand !== "IDLE" || !$("reviewDiscussionUnresolved").checked
    || !$("reviewDiscussionNoResend").checked || $("reviewDiscussionDiscardReason").value.trim().length < 3;
  if (!discussionActive) {
    text("reviewDiscussionStatus", "");
  } else if (unresolvedDiscussion) {
    text("reviewDiscussionStatus", "이전 감사자 대화 전송 결과가 미확인이라 새 질문을 보내지 않습니다. 아래에서 결과 미확인과 자동 재전송 금지를 확인한 뒤 폐기할 수 있습니다.");
  } else if (snapshot?.reviewerRuntimes?.[discussionRole]?.availability !== "AVAILABLE") {
    text("reviewDiscussionStatus", `${discussionRole} 감사 provider를 현재 사용할 수 없습니다. 다른 역할의 연결 상태와는 별개입니다.`);
  } else if (!discussionBinding) {
    text("reviewDiscussionStatus", `${discussionRole}의 기존 대화 연결이 아직 확인되지 않았습니다. 다른 역할을 선택하거나 감사자 연결 상태를 확인하세요.`);
  } else if (!connected) {
    text("reviewDiscussionStatus", "최신 상태 확인 후 감사자에게 질문할 수 있습니다.");
  } else if (!caps.has("code.review.discuss")) {
    text("reviewDiscussionStatus", "현재 감사 작업이 진행 중이거나 아직 자유 대화를 받을 수 있는 정지 상태가 아닙니다.");
  } else {
    text("reviewDiscussionStatus", run?.phase === "AWAITING_APPLY"
      ? "이 대화는 이미 계산된 PASS와 적용 권한을 변경하지 않습니다. 답변을 확인한 뒤 적용 여부를 별도로 결정하세요."
      : "답변은 기록되며, 이후 ‘웹 감사 다시 시도’를 실행하면 참고자료로 전달됩니다. 대화만으로 감사 판정은 바뀌지 않습니다.");
  }
  const reviewerBindingHold = run?.phase === "HOLD" && run?.terminationReason === "WEB_BINDING_REQUIRED"
    && ["JUDGE","CRITIC"].includes(run?.coordination?.activeRole);
  const reviewerRole = reviewerBindingHold ? run.coordination.activeRole : null;
  const reviewerBinding = reviewerRole
    ? (run.conversationBindings ?? []).find((item) => item.role === reviewerRole) ?? null
    : null;
  const reviewerCandidates = reviewerBindingHold
    ? (run?.coordination?.bindingCandidates ?? []).filter((candidate) =>
        Boolean(reviewerBinding?.provider) && candidate.provider === reviewerBinding.provider)
    : [];
  $("reviewBindingRecoveryPanel").hidden = !reviewerBindingHold;
  const reviewerCandidateList = $("reviewBindingRecoveryCandidates"); reviewerCandidateList.replaceChildren();
  if (reviewerBindingHold) {
    if (run.coordination?.phase === "ROLE_BINDING_RECOVERED") {
      text("reviewBindingRecoveryStatus", `${reviewerRole} 대화 탭을 다시 연결했습니다. ‘웹 감사 다시 시도’로 재개하세요.`);
    } else if (reviewerCandidates.length) {
      text("reviewBindingRecoveryStatus", `${reviewerRole} 대화 탭이 여러 개입니다. 사용할 탭 하나를 선택하세요.`);
      for (const candidate of reviewerCandidates) {
        const button = node("button", `${candidate.provider} · tab ${candidate.tabId}${candidate.windowId === null ? "" : ` · window ${candidate.windowId}`}`);
        button.type = "button"; button.title = candidate.url ?? reviewerBinding?.conversationUrl ?? "";
        button.disabled = operations.runCommand !== "IDLE" || !reviewerActionsFor(reviewerRole).rebind;
        button.addEventListener("click", () => {
          if (!button.disabled) command("code.review.rebind", { role:reviewerRole, selectedTabId:candidate.tabId });
        });
        reviewerCandidateList.append(button);
      }
    } else {
      text("reviewBindingRecoveryStatus", `${reviewerRole} 대화 탭을 찾지 못했습니다. 정확한 대화를 하나만 열고 ‘독립 검토 다시 시작’을 누르세요.`);
    }
  } else {
    text("reviewBindingRecoveryStatus", "");
  }
  const notePanel = $("operatorNotePanel");
  notePanel.hidden = !run;
  if (notePanel.dataset.runId !== run?.runId) {
    notePanel.dataset.runId = run?.runId ?? "";
    $("operatorNoteKind").value = "NOTE";
    $("operatorNoteText").value = "";
  }
  const noteText = $("operatorNoteText").value.trim();
  $("addOperatorNote").disabled = operations.runCommand !== "IDLE"
    || !runActions.operatorNote || !noteText;
  text("operatorNoteStatus", run
    ? "메모와 결정은 append-only 작업 기록입니다. 에이전트에게 전달하려면 위 전용 대화·개입 기능을 사용하세요."
    : "");
  const noteList = $("operatorNoteList"); noteList.replaceChildren();
  for (const note of [...(run?.operatorNotes ?? [])].reverse()) {
    const row = node("article", "", "conversation-entry decision");
    const title = note.kind === "DECISION" ? "결정" : "메모";
    row.append(
      node("strong", title),
      node("p", `${time(note.createdAt)} · 당시 상태 ${labels[note.phase] ?? note.phase ?? "미확인"}${note.candidateId ? ` · 후보 ${note.candidateId}` : ""}`, "muted"),
      node("p", note.text),
    );
    noteList.append(row);
  }
  if (!(run?.operatorNotes ?? []).length) noteList.append(node("p", "아직 사용자 메모가 없습니다.", "muted"));
  if (!$("workerInterventionKind").value) $("workerInterventionKind").value = "GUIDANCE";
  const interventionActive = run?.phase === "WORKER_RUNNING";
  const interventionKind = $("workerInterventionKind").value;
  const interventionText = $("workerInterventionText").value.trim();
  const interventionTurnId = run?.workerTurnId ?? null;
  const scopeChange = interventionKind === "REQUIREMENTS_CHANGE";
  $("workerInterventionPanel").hidden = !interventionActive;
  $("sendWorkerIntervention").disabled = !interventionActive || operations.runCommand !== "IDLE"
    || !runActions.interveneWorker || !interventionText || scopeChange;
  if (!interventionActive) {
    text("workerInterventionStatus", "");
  } else if (scopeChange) {
    text("workerInterventionStatus", "요구사항이나 완료 기준을 바꾸는 내용은 현재 승인 범위를 우회할 수 없습니다. 작업을 중단한 뒤 새 작업에서 다시 합의·승인하세요.");
  } else if (!connected) {
    text("workerInterventionStatus", "최신 상태 확인 후 Worker에 전달할 수 있습니다.");
  } else if (!interventionTurnId || !caps.has("code.worker.intervene")) {
    text("workerInterventionStatus", "현재 Worker에 실시간으로 전달할 수 있는 상태가 아직 확인되지 않았습니다. Worker 실행이 시작된 뒤 다시 시도하세요.");
  } else if (operations.runCommand !== "IDLE") {
    text("workerInterventionStatus", "현재 명령 처리가 끝난 뒤 전달할 수 있습니다.");
  } else {
    text("workerInterventionStatus", "질문·참고는 현재 Worker turn에만 전달되며 승인된 요구사항 자체는 바뀌지 않습니다. 전송 실패 시 자동 재전송하지 않습니다.");
  }
  $("recoveryPanel").hidden = run?.phase !== "RECOVERY_REQUIRED";
  const decisionQuestions = run?.phase === "HOLD" && run?.terminationReason === "USER_DECISION_REQUIRED"
    ? (run.missingInformation ?? []).filter((item) => item.status === "NEEDS_USER_DECISION") : [];
  $("decisionPanel").hidden = !(run?.phase === "HOLD" && run?.terminationReason === "USER_DECISION_REQUIRED");
  text("decisionStatus", decisionQuestions.length ? "" : "확인 질문이 기록에 없습니다. 진행 기록을 확인하고 이 실행을 중단한 뒤 새 작업으로 요청하세요.");
  const questionSignature = JSON.stringify([run?.runId, run?.candidate?.candidateId, decisionQuestions]);
  if (decisionSignature !== questionSignature) {
    decisionSignature = questionSignature;
    const container = $("decisionQuestions"); container.replaceChildren();
    for (const question of decisionQuestions) {
      const label = node("label", question.reason ?? "감사자의 질문");
      const answer = node("textarea", ""); answer.rows = 3; answer.maxLength = 4000;
      answer.dataset.requestItemId = question.requestItemId;
      answer.placeholder = "이 질문에 대한 결정을 자연어로 적으세요.";
      answer.addEventListener("input", render);
      label.append(answer); container.append(label);
    }
  }
  $("submitDecision").disabled = operations.runCommand !== "IDLE" || !reviewerActionsFor(null).decisionReply
    || !decisionQuestions.length || [...$("decisionQuestions").querySelectorAll("textarea")].some((item) => !item.value.trim());
  $("reconcileRun").disabled = operations.runCommand !== "IDLE" || !runActions.reconcileRun;
  $("retryRun").textContent = "Worker 다시 실행";
  if (run?.phase === "RECOVERY_REQUIRED") {
    const recoveryConfirmed = $("recoveryConfirm").checked;
    const abandonBlocked = (operations.runCommand !== "IDLE") || !runActions.abandonRun || !recoveryConfirmed;
    const abandonReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리가 끝나야 실행을 폐기할 수 있습니다."
      : !connected ? "최신 상태 확인 후 실행을 폐기할 수 있습니다."
      : !runActions.abandonRun ? "현재 런이 복구 폐기 명령을 받을 수 없는 상태입니다. 상태 갱신 후에도 같으면 실행 기록의 오류·복구 상태를 확인하세요."
      : !recoveryConfirmed ? "외부 작업 종료·대상 저장소 상태 확인·실행 폐기를 한 번에 확인하세요."
      : "확인 기록 후 이 실행을 폐기할 수 있습니다.";
    actionState("abandonRun", abandonBlocked, abandonReason, abandonReason);
  } else {
    $("abandonRun").disabled = true;
    $("abandonRun").title = "";
  }
  if (caps.has("code.review.retry")) {
    $("retryRun").textContent = "독립 검토 다시 시작";
    const retryReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리가 끝나야 감사를 다시 시도할 수 있습니다."
      : !reviewerActionsFor(null).retryReview ? "브라우저 확장과 해당 감사자의 대화 연결을 복구해야 현재 변경사항의 독립 검토를 다시 시작할 수 있습니다."
      : "Worker를 다시 실행하지 않고 현재 후보를 같은 요구사항으로 다시 감사합니다. REWORK 판정이면 기존 수정 루프를 이어갑니다.";
    actionState("retryRun", operations.runCommand !== "IDLE" || !reviewerActionsFor(null).retryReview, retryReason, retryReason);
  } else if (run?.phase === "RECOVERY_REQUIRED") {
    const retryReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리가 끝나야 다시 시도할 수 있습니다."
      : caps.has("run.retry") ? "실패한 격리 작업 공간을 정리하고 같은 요구사항으로 Worker를 다시 실행합니다."
      : "변경사항이 고정되기 전 Worker 실패가 안전하게 확인된 경우에만 Worker를 다시 실행할 수 있습니다.";
    actionState("retryRun", (operations.runCommand !== "IDLE") || !runActions.retryWorker, retryReason, retryReason);
  } else {
    $("retryRun").disabled = true;
    $("retryRun").title = "";
  }
  for (const [id, allowed] of [["stopRun", runActions.stopRun], ["applyCode", runActions.applyCode],
    ["exportEvidence", runActions.exportEvidence], ["deleteRun", runActions.deleteRun]]) {
    $(id).disabled = operations.runCommand !== "IDLE" || !allowed;
  }
  $("archiveRun").textContent = run?.archivedAt ? "보관 해제" : "기록 보관";
  $("archiveRun").disabled = operations.runCommand !== "IDLE" || !runActions.archiveRun;
  $("runWorkerConsole").hidden = !["PROVISIONING", "WORKER_RUNNING", "CANDIDATE_CAPTURE", "VERIFYING", "FAILED", "RECOVERY_REQUIRED"].includes(run?.phase);
  if (!$("runWorkerConsole").hidden) {
    const worker = snapshot.workerRuntime;
    const currentTurn = Boolean(run.workerTurnId) && worker?.turnId === run.workerTurnId;
    const state = currentTurn ? workerRuntimeStatus(worker).detail : "이 Worker의 최신 활동은 확인되지 않았습니다.";
    text("runWorkerConsoleState", `${labels[run.phase]} · ${state}`);
    text("runWorkerConsoleCandidate", run.candidate?.candidateId ? `고정 후보 · ${run.candidate.candidateId}` : "고정 후보 없음");
    const lastTurn = run.workerTurns?.at(-1);
    const workerError = lastTurn?.metadata?.error;
    const failure = lastTurn?.turnId === run.workerTurnId && lastTurn?.status === "failed"
      ? (workerError === "External turn timed out; execution state requires recovery."
        ? "Worker 응답 시간이 초과됐습니다. 복구 조치를 확인하세요."
        : userFacingStoredError(workerError, "Worker 실행이 실패했습니다.")) : "";
    $("runWorkerConsoleFailure").hidden = !failure;
    text("runWorkerConsoleFailure", failure);
  }
  if (!run) {
    $("applyInspector").hidden = true;
    if (inspectorOwnerChanged) inspectorScroll.scrollTop = inspectorScrollPositions.get(scrollOwner) ?? 0;
    return;
  }
  $("continueProject").hidden = run.phase !== "APPLIED" || Boolean(run.archivedAt);
  $("continueProject").disabled = $("newRun").disabled;
  text("runFollowUp", run.followUp ? `이전 적용 작업: ${run.followUp.objective} · ${run.followUp.runId}` : "");
  $("openFollowUp").hidden = !run.followUp;
  $("openFollowUp").disabled = !snapshot?.runs?.some((item) => item.runId === run.followUp?.runId);
  $("openFollowUp").title = $("openFollowUp").disabled ? "이전 작업 기록이 삭제되어 열 수 없습니다." : "이전 적용 작업의 기록을 엽니다.";
  let lineagePanel = $("runLineage");
  if (!lineagePanel) {
    lineagePanel = node("section", "", "flow-band");
    lineagePanel.id = "runLineage"; lineagePanel.hidden = true;
    lineagePanel.append(node("h2", "작업 계보"));
    const summary = node("p", "", "muted"); summary.id = "runLineageSummary";
    const children = node("div", ""); children.id = "runLineageChildren";
    lineagePanel.append(summary, children);
    $("openFollowUp")?.after(lineagePanel);
  }
  const projected = snapshot?.runs ?? [];
  const currentProjection = projected.find((item) => item.runId === run.runId) ?? null;
  const parentRunId = currentProjection?.parentRunId ?? run.followUp?.runId ?? null;
  const parent = parentRunId ? projected.find((item) => item.runId === parentRunId) ?? null : null;
  const children = projected.filter((item) => item.parentRunId === run.runId);
  lineagePanel.hidden = !parentRunId && children.length === 0;
  const lineageSummary = [];
  if (parentRunId) lineageSummary.push(parent
    ? `이전 작업: ${parent.objective}`
    : `이전 작업 기록 없음: ${parentRunId}`);
  if (children.length) lineageSummary.push(`후속 작업 ${children.length}건`);
  text("runLineageSummary", lineageSummary.join(" · "));
  const lineageChildren = $("runLineageChildren"); lineageChildren.replaceChildren();
  for (const child of children) {
    const button = node("button", `${child.objective}${child.archivedAt ? " · 보관됨" : ""}`);
    button.type = "button";
    button.addEventListener("click", () => openRun(child.runId));
    lineageChildren.append(button);
  }
  text("runObjective", run.objective);
  renderRunContextView(run, snapshot);
  text("runStatus", labels[run.phase] ?? run.phase); $("runStatus").className = `health ${runAppearance(run.phase)}`;
  text("runReason", reasons[run.terminationReason] ?? (userFacingStoredError(run.error ?? snapshot?.error, "") || (run.phase === "CANCELLED" ? "중단됨 · 기록은 보존됩니다." : run.phase === "AWAITING_APPLY" ? "검토 통과 · 아직 적용되지 않았습니다." : run.phase === "APPLIED" ? "적용 완료 · 배포·환경 검증은 별도입니다." : phaseReasons[run.phase] ?? `미해결 필수 지적 ${(run.findings ?? []).filter((f) => f.required && ["OPEN","FIX_SUBMITTED"].includes(f.status)).length}건`)));
  text("runTime", `작업 ID ${run.runId} · 버전 ${run.version} · 접수 ${time(run.createdAt)} · 변경 ${time(run.updatedAt)}${run.archivedAt ? ` · 보관 ${time(run.archivedAt)}` : ""}`);
  const workerEvidence = run.worker?.provenance;
  text("workerProvenance", workerEvidence ? `Worker 출처: 설정 ${workerEvidence.requested.provider ?? "미지정"} / 실행 보고 ${workerEvidence.reported.provider ?? "미확인"} · 모델 보고 ${workerEvidence.reported.model ?? "미확인"}` : "Worker 실행 출처: 현재 기록에서 확인되지 않음");
  let reviewerRuntimeStatus = $("reviewerRuntimeStatus");
  if (!reviewerRuntimeStatus) {
    reviewerRuntimeStatus = node("p", "", "muted");
    reviewerRuntimeStatus.id = "reviewerRuntimeStatus";
    $("workerProvenance")?.after(reviewerRuntimeStatus);
  }
  text("reviewerRuntimeStatus",
    reviewerRuntimeTechnicalSummary(snapshot?.reviewerRuntimes));
  let reviewIndependenceStatus = $("reviewIndependenceStatus");
  if (!reviewIndependenceStatus) {
    reviewIndependenceStatus = node("p", "", "muted");
    reviewIndependenceStatus.id = "reviewIndependenceStatus";
    $("reviewerRuntimeStatus")?.after(reviewIndependenceStatus);
  }
  const independence = run.reviews?.at(-1)?.reviewerIndependence ?? null;
  if (independence) {
    const providers = (independence.bindings ?? []).map((item) => item.provider ?? "미확인");
    const providerText = independence.providerSeparation === "VERIFIED"
      ? `provider 분리 확인 (${providers.join(" / ")})`
      : `provider 분리 미보장 (${providers.join(" / ")})`;
    text("reviewIndependenceStatus",
      `감사자 독립성: 역할·세션·대화 분리 확인 · ${providerText} · model identity 관측 불가 · 계정 격리 미검증 · Round 0 peer artifact 없음, 교차검토는 공개 artifact만 전달`);
  } else {
    text("reviewIndependenceStatus", run.phase === "AWAITING_APPLY"
      ? "감사자 독립성: 이 PASS에는 현재 독립성 계약이 없습니다. 같은 후보를 다시 감사해야 적용 권한을 얻을 수 있습니다."
      : "감사자 독립성: 아직 고정된 감사 결과가 없습니다.");
  }
  const stopReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리 중입니다."
    : !connected ? "최신 상태 확인 후 중단할 수 있습니다."
    : terminal.has(run.phase) ? "이미 종료된 작업입니다."
    : run.phase === "RECOVERY_REQUIRED" ? "복구 확인 후 종료할 수 있습니다."
    : caps.has("run.stop") ? "작업을 중단합니다. 기록은 보존됩니다."
    : run.phase === "APPLYING" ? "적용 중에는 중단할 수 없습니다."
    : "현재 단계에서는 중단할 수 없습니다.";
  actionState("stopRun", (operations.runCommand !== "IDLE") || !runActions.stopRun, stopReason, stopReason);
  text("stopReason", stopReason);

  const applyReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리 중입니다."
    : !connected ? "최신 상태 확인 후 적용할 수 있습니다."
    : caps.has("code.apply") ? "검토 통과 변경사항을 프로젝트에 적용합니다."
    : run.phase === "AWAITING_APPLY" ? "현재 적용할 수 없습니다. 상태를 확인하세요."
    : "검토 통과 후 적용할 수 있습니다.";
  actionState("applyCode", (operations.runCommand !== "IDLE") || !runActions.applyCode, applyReason, applyReason);
  if (!$("runPanel").hidden) renderApplyInspector(run, applyReason);
  if (inspectorOwnerChanged) inspectorScroll.scrollTop = inspectorScrollPositions.get(scrollOwner) ?? 0;

  const exportReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리 중입니다."
    : !connected ? "최신 상태 확인 후 다운로드할 수 있습니다."
    : !caps.has("evidence.export") ? "다운로드할 감사 기록이 없습니다."
    : "감사 기록을 다운로드합니다.";
  actionState("exportEvidence", (operations.runCommand !== "IDLE") || !runActions.exportEvidence, exportReason, exportReason);
  text("commandReason", "");
  syncRunInformationArchitecture(run);
  const signature = JSON.stringify([run, snapshot?.events, snapshot?.messages, snapshot?.assessments, snapshot?.findings, snapshot?.evidence, connected, (operations.runCommand !== "IDLE")]);
  if (renderedRecords !== signature) {
    renderedRecords = signature;
    renderConversation(run, $("conversationTimeline"), node, time);
    const history = $("preparationHistoryTimeline");
    history.replaceChildren();
    for (const turn of run.preparationSnapshot?.discussion ?? []) {
      const entry = node("article", "", "record");
      entry.append(node("strong", turn.actor === "USER" ? "사용자" : "웹 설계자"), node("pre", turn.content));
      history.append(entry);
    }
    if (!history.children.length) history.append(node("p", "이 실행에 저장된 협의 기록이 없습니다.", "muted"));
    renderAudit();
    renderLog();
  }
}
async function command(type, payload = {}) {
  if (operations.runCommand !== "IDLE" || !capabilities().has(type)) return;
  const run = snapshot?.run, target = run?.runId;
  const sourceSelection = selected, sourceProject = projectViewRoot;
  const stillViewing = () => snapshot?.run?.runId === target && selected === sourceSelection && projectViewRoot === sourceProject;
  const body = { type, requestId:crypto.randomUUID(), payload:{ ...payload, runId:workflow.runId, expectedVersion:workflow.runVersion } };
  operations.runCommand = "RUNNING"; render();
  try {
    const result = await request("/api/commands", { method:"POST", body:JSON.stringify(body) });
    if (stillViewing()) {
      const successMessage = {
        "code.worker.intervene": "현재 Worker turn에 내용을 전달했고 실행 기록에 남겼습니다.",
        "code.decision.reply": "답변을 기록하고 같은 후보를 독립 검토 중입니다.",
        "code.review.discuss": "감사자 답변을 기록했습니다. 현재 감사 판정과 적용 권한은 변경되지 않았습니다.",
        "code.review.discuss.discard": "미확정 감사 대화 전송을 폐기했습니다. 자동 재전송하지 않습니다.",
        "code.review.rebind": "감사자 대화 탭을 다시 연결했습니다. 같은 후보의 감사를 재개하려면 ‘웹 감사 다시 시도’를 누르세요.",
        "run.note.add": "작업 메모를 기록했습니다. 실행 상태와 감사 판정은 변경되지 않았습니다.",
        "run.retry": "수동 진행을 시작했습니다. 새 Worker 실행 상태를 확인하세요.",
        "code.review.retry": "같은 후보의 웹 감사를 다시 시작했습니다. REWORK가 나오면 수정 루프를 이어갑니다.",
        "run.stop": "중단 요청을 처리했습니다. 최신 실행 상태를 확인하세요.",
        "code.apply": "적용 요청을 처리했습니다. 최신 적용 상태를 확인하세요.",
        "evidence.export": "감사 기록 요청을 처리했습니다.",
        "run.archive": "종료된 실행을 보관했습니다. 기록과 감사 근거는 유지됩니다.",
        "run.unarchive": "보관된 실행을 기본 기록으로 복원했습니다.",
        "run.delete": "종료된 작업 기록을 삭제했습니다.",
      }[type] ?? "요청을 처리했습니다. 최신 실행 상태를 확인하세요.";
      text("commandResult", successMessage);
      $("commandResult").dataset.tone = "notice";
      if (type === "run.delete") { selected = null; requestedView = "start"; }
    }
    return result.payload;
  } catch (error) {
    if (error.code === "UNKNOWN_RESULT") { operations.runCommand = "UNKNOWN_RESULT"; unknownRequests.set("runCommand", {requestId:body.requestId,runId:target}); }
    if (stillViewing()) {
      text("commandResult", userFacingError(error, "요청을 처리하지 못했습니다. 최신 실행 기록과 연결 상태를 확인하세요."));
      $("commandResult").dataset.tone = "error";
    }
  } finally { if (operations.runCommand !== "UNKNOWN_RESULT") operations.runCommand = "IDLE"; await refresh(); }
}
function restoreEvidenceFocus(page) {
  if (!page?.source || page.target !== snapshot?.run?.runId
    || (page.candidateId && page.candidateId !== snapshot.run.candidate?.candidateId)) return;
  const source = $(page.source);
  const trigger = Array.from(source?.querySelectorAll("button") ?? [])
    .find(button => button.dataset.evidenceId === page.id && button.dataset.patchPath === page.patchPath
      && button.dataset.evidenceStart === page.evidenceStart && !button.disabled);
  trigger?.focus();
}

function closeInspectorEvidence(restoreFocus = true) {
  evidenceRequest++;
  if (evidencePage?.candidateId) {
    if (restoreFocus) restoreEvidenceFocus(evidencePage);
    evidencePage = null;
  }
  $("inspectorEvidenceReader").hidden = true;
  text("inspectorCopyStatus", "");
}

async function openEvidence(id, startLine = 1, candidateId = undefined, source = "", patchPath, endLine) {
  if (operations.runCommand !== "IDLE") return;
  const target = snapshot?.run?.runId;
  const requestId = ++evidenceRequest;
  const result = await command("evidence.get", { evidenceId:id, startLine, endLine:endLine ?? startLine + 199, patchPath });
  if (requestId !== evidenceRequest || !result || snapshot?.run?.runId !== target) return;
  if (candidateId && (snapshot.run.candidate?.candidateId !== candidateId || result.candidateId !== candidateId)) return;
  if (patchPath !== undefined && (result.patchPath !== patchPath || result.kind !== "PATCH")) return;
  const missingLocation = result.patchLocationFound === false;
  const hasNext = endLine === undefined && result.omittedAfter;
  evidencePage = { id, next:hasNext ? result.endLine + 1 : null, target, candidateId, source, patchPath,
    evidenceStart:endLine === undefined ? undefined : String(startLine) };
  const range = missingLocation ? "" : `${result.startLine}–${result.endLine} / ${result.totalLines}줄${hasNext ? " · 다음 구간 있음" : ""}`;
  if (candidateId) {
    if (patchPath === undefined) recordPatchPage(snapshot.run, result);
    const path = patchPath ?? result.result?.path;
    text("inspectorEvidenceTitle", `${result.kind}${path ? " · " + path : ""}`);
    text("inspectorEvidenceContent", missingLocation ? "이 파일의 텍스트 변경 구간을 원본 Diff에서 확인할 수 없습니다." : result.content);
    text("inspectorCopyStatus", "");
    $("copyInspectorEvidence").disabled = missingLocation || !result.content;
    text("inspectorEvidenceRange", range);
    $("nextInspectorEvidence").disabled = !hasNext;
    $("inspectorEvidenceReader").hidden = false;
    $("inspectorEvidenceContent").focus();
  } else {
    $("inspectorEvidenceReader").hidden = true;
    text("evidenceTitle", `${result.kind} · ${id}`); text("evidenceContent", result.content);
    text("evidenceRange", range);
    actionState("nextEvidence", !result.omittedAfter,
      "이 근거의 마지막 구간입니다. 더 불러올 내용이 없습니다.",
      "다음 근거 구간을 불러옵니다.");
    if (!$("evidenceDialog").open) $("evidenceDialog").showModal();
  }
}

function proposalControls() {
  const caps = capabilities();
  const actions = currentPreparationActions();
  $("proposeRequirements").hidden = true;
  actionState("reviseRequirements", !actions.reply || operations.webTurn !== "IDLE",
    !webConnected() ? "브릿지 확장 연결이 확인돼야 답변을 전송할 수 있습니다." : "현재 전송이나 복구 확인이 끝나야 답변을 보낼 수 있습니다.",
    "같은 ChatGPT 대화에 답변을 전송합니다.");
  const approvalDisabled = !actions.approve || operations.approval !== "IDLE";
  actionState("saveProject", approvalDisabled,
    !caps.has("preparation.approve")
      ? agreement?.status === "READY"
        ? snapshot?.preparationApprovalBlocked
          ? "기존 작업의 복구 또는 종료를 확인한 뒤 구현을 시작할 수 있습니다."
          : "응답 정리 또는 연결 확인이 끝나야 작업을 시작할 수 있습니다."
        : "확인 질문을 모두 정리해 요구사항 검토 단계가 되어야 작업을 시작할 수 있습니다."
      : "작업 시작 요청을 처리 중입니다.",
    "현재 요구사항을 승인하고 작업을 시작합니다.");
  const cancelDisabled = !actions.cancel || operations.preparationStart !== "IDLE";
  $("closeProject").textContent = preparation?.state === "FAILED" && agreement?.status === "APPROVED"
    ? "합의 보존하고 준비 닫기" : "요구사항 정리 취소";
  actionState("closeProject", cancelDisabled,
    !connected ? "최신 상태 확인 후 준비를 종료할 수 있습니다."
      : !caps.has("preparation.cancel") ? "현재 응답 또는 전송 처리가 끝난 뒤 준비를 취소할 수 있습니다."
        : "이전 준비 작업을 처리 중입니다.",
    "현재 준비를 종료하고 기록은 보존합니다.");
  const activeDelivery = preparation?.deliveries?.find((item) => item.deliveryId === preparation?.webSession?.activeDeliveryId);
  const unsentFailure = activeDelivery?.state === "FAILED"
    && (activeDelivery.unsent === true || preparation.error?.details?.browserDispatchStarted === false);
  const discardVisible = Boolean(activeDelivery && !unsentFailure && (
    ["RECOVERY_REQUIRED", "AMBIGUOUS", "WEB_BLOCKED"].includes(preparation.state)
    || ["DELIVERY_RECOVERY_UNCONFIRMED", "REBIND_DURING_ACTIVE_DELIVERY"].includes(preparation.error?.code)
  ));
  const invalidAbandonment = caps.has("preparation.abandonInvalid"), pendingAbandonment = activeDelivery?.invalidAbandonmentIntent;
  const nextDiscardTarget = discardVisible ? JSON.stringify([preparation.preparationId, activeDelivery.deliveryId, invalidAbandonment, pendingAbandonment?.requestId]) : null;
  if (nextDiscardTarget !== discardTarget) {
    discardTarget = nextDiscardTarget;
    $("discardUnresolved").checked = false;
    $("discardNoResend").checked = false;
    $("discardReason").value = "";
    $("discardPageUnconfirmed").checked = false;
  }
  $("discardPanel").hidden = !discardVisible;
  renderInvalidAbandonment($, invalidAbandonment, pendingAbandonment);
  text("discardDelivery", discardVisible ? `준비 ID: ${preparation.preparationId} · 전송 ID: ${activeDelivery.deliveryId} · 세션: ${activeDelivery.sessionId} · 대화: ${activeDelivery.conversationId ?? preparation.webSession?.conversationUrl ?? "확인되지 않음"}` : "");
  $("discardDeliveryButton").disabled = !discardVisible || !actions.discard || (operations.preparationStart !== "IDLE"
    && !(pendingAbandonment && operations.preparationStart === "UNKNOWN_RESULT"))
    || (!pendingAbandonment && (!$("discardUnresolved").checked || !$("discardNoResend").checked || (invalidAbandonment && !$("discardPageUnconfirmed").checked) || $("discardReason").value.trim().length < 3));
  for (const button of document.querySelectorAll("[data-web-command]")) button.disabled = !caps.has(button.dataset.webCommand) || operations.webTurn !== "IDLE";
}
function renderPreparation() {
  if (!preparation) {
    $("preparationStoredResponse").hidden = true;
    text("preparationStoredResponseBody", "");
    $("preparationRequirementInspector").hidden = true;
    preparationSignature = "";
    preparationRecovery?.root.remove();
    preparationRecovery = null;
    document.querySelector(".preparation-tab-choice")?.remove();
    tabChoice.reset();
    return;
  }
  const signature = JSON.stringify([preparation, operations.webTurn, [...capabilities()], [...tabChoiceFailures]]);
  if (signature === preparationSignature) return;
  preparationSignature = signature;
  const requirementInspector = $("preparationRequirementInspector");
  if (requirementInspector.dataset.version !== JSON.stringify([preparation.preparationId, preparation.version])) requirementInspector.hidden = true;
  renderPreparationConversation($, text, preparation);
  $("planningFollowUp").hidden = !preparation.followUp;
  text("planningFollowUp", preparation.followUp ? `이전 적용 작업: ${preparation.followUp.objective} · 요구사항은 이번에 다시 승인합니다.` : "");
  document.querySelector(".preparation-tab-choice")?.remove();
  const summary = $("proposalSummary");
  const contentSignature = JSON.stringify([preparation.preparationId, agreement, preparation.discussion]);
  if (contentSignature !== preparationContentSignature) {
    preparationContentSignature = contentSignature;
    const content = $("proposalSummaryContent");
    const heading = agreement?.status === "READY" ? "합의된 작업 범위" : "현재 정리된 범위";
    content.replaceChildren(node("h2", heading), node("p", agreement?.summary ?? "요구사항을 정리하고 있습니다."));
    if ((agreement?.unresolvedQuestions ?? []).length) {
      content.append(node("p", "추가 확인 필요", "eyebrow"));
      for (const question of agreement.unresolvedQuestions) content.append(node("p", question));
    }
    const discussion = $("preparationDiscussion");
    if (discussion.dataset.preparationId !== preparation.preparationId) {
      discussion.dataset.preparationId = preparation.preparationId;
      discussion.open = false;
    }
    const discussionBody = $("preparationDiscussionBody");
    discussionBody.replaceChildren();
    for (const turn of preparation.discussion ?? []) {
      const row = node("article", "", "record");
      row.append(node("strong", turn.actor === "USER" ? "사용자" : "웹 설계자"), node("pre", turn.content));
      discussionBody.append(row);
    }
    $("projectRequirements").replaceChildren();
    for (const item of agreement?.requirements ?? []) {
      const row = node("article", "", "record");
      row.append(node("strong", item.statement), node("p", item.acceptanceCriteria, "muted"));
      const preparationId = preparation.preparationId;
      const inspect = node("button", `${item.requirementId ?? "요구사항"} · 명세 상세`);
      inspect.type = "button";
      inspect.addEventListener("click", () => {
        if (preparation?.preparationId !== preparationId || !agreement?.requirements?.some(req =>
          req.statement === item.statement && req.acceptanceCriteria === item.acceptanceCriteria)) return;
        requirementInspector.dataset.version = JSON.stringify([preparationId, preparation.version]);
        text("preparationRequirementTitle", item.statement);
        text("preparationRequirementAcceptance", item.acceptanceCriteria);
        text("preparationRequirementState", agreement.status === "APPROVED" ? "확정된 명세"
          : agreement.status === "READY" ? "검토할 명세 · 사용자 승인 대기" : "협의 중인 명세");
        requirementInspector.hidden = false;
      });
      row.append(inspect);
      $("projectRequirements").append(row);
    }
  }
  text("reviewerProviderSummary", `감사 provider · Judge ${preparation.reviewers?.JUDGE?.provider ?? "CHATGPT_WEB"} · Critic ${preparation.reviewers?.CRITIC?.provider ?? "CHATGPT_WEB"} · 준비 대화는 ChatGPT`);
  const session = preparation.webSession;
  const diagnostic = preparation.diagnostics ?? session?.diagnostics ?? {};
  if (preparationRecovery?.root.dataset.preparationId !== preparation.preparationId) {
    preparationRecovery?.root.remove();
    const root = node("details", "", "session-recovery");
    root.dataset.preparationId = preparation.preparationId;
    const content = node("div", ""), buttons = new Map();
    root.append(node("summary", "응답·전송 상태"), content);
    for (const [label, action] of [["대화 열기", "web.focus"], ["상태 확인", "web.inspect"], ["생성 종료", "web.stop"], ["응답 다시 확인", "web.reconcile"]]) {
      const button = node("button", label);
      button.type = "button";
      button.dataset.webCommand = action;
      button.addEventListener("click", () => webSessionCommand(action));
      buttons.set(action, { button, label });
      root.append(button);
    }
    preparationRecovery = { root, content, buttons };
    $("preparationDiagnosticsBody").append(root);
  }
  const { content: recovery, buttons } = preparationRecovery;
  recovery.replaceChildren();
  const rootReady = session?.bindingState === "ROOT_READY" && Number.isSafeInteger(session?.tabId)
    && typeof session?.documentId === "string" && session.documentId && session?.frameId === 0;
  const exactBound = session?.bindingState === "BOUND" && diagnostic.exactConversation === true;
  const bindingConfirmed = exactBound || rootReady;
  recovery.append(node("p", bindingConfirmed ? "사용할 대화 탭이 확인됐습니다."
    : "대화 탭 연결을 확인해야 합니다. 아래 상태 확인 또는 탭 선택을 이용하세요.",
    bindingConfirmed ? "recovery-guidance ok" : "recovery-guidance error"));
  const tabCandidates = tabChoice.candidates(preparation);
  if (!tabCandidates.length) tabChoice.reset();
  if (tabCandidates.length) summary.prepend(tabChoice.render({
    candidates: tabCandidates, operation: operations.webTurn, allowed: capabilities().has("web.rebind"),
    preparation,
    hint: new URLSearchParams(location.search).get("prepareTab"),
    rejection: tabChoiceFailures.get(session.activeDeliveryId) ?? "",
    onSubmit: selectedTabId => webSessionCommand("web.rebind", { selectedTabId }),
    onRefresh: async () => { tabChoiceFailures.delete(session.activeDeliveryId); preparationSignature = ""; await refresh(); },
    onView: tabId => request("/api/preparations/tab-focus", { method:"POST", body:JSON.stringify({
      preparationId:preparation.preparationId, deliveryId:session.activeDeliveryId, tabId }) }),
  }));
  const deliveries = preparation.deliveries ?? [];
  const displayedDelivery = deliveries.find(item => item.deliveryId === session?.activeDeliveryId) ?? deliveries.at(-1);
  const storedResponse = $("preparationStoredResponse");
  const rawText = displayedDelivery?.response?.rawText;
  const identifiedResponse = displayedDelivery?.validation?.status === "CONFIRMED"
    && ["ACK_PENDING", "COMPLETE"].includes(displayedDelivery.processingState) && Boolean(rawText?.trim());
  const responseKey = identifiedResponse ? JSON.stringify([preparation.preparationId, displayedDelivery.deliveryId]) : "";
  if (storedResponse.dataset.delivery !== responseKey) {
    storedResponse.dataset.delivery = responseKey;
    storedResponse.open = false;
  }
  storedResponse.hidden = !identifiedResponse;
  const shownResponse = identifiedResponse ? rawText : "";
  if ($("preparationStoredResponseBody").textContent !== shownResponse) text("preparationStoredResponseBody", shownResponse);
  text("preparationStoredResponseState", !identifiedResponse ? ""
    : displayedDelivery.processingState === "ACK_PENDING" ? "응답 저장됨 · 수신 확인 대기" : "응답 저장과 수신 확인 완료");
  if (displayedDelivery && !tabCandidates.length && !displayedDelivery.response?.rawText?.trim()
    && !["ACK_PENDING", "COMPLETE"].includes(displayedDelivery.processingState)) {
    summary.prepend(renderPreparationTransmission(displayedDelivery));
  }
  if (displayedDelivery) {
    const states = { RESERVED: "연결 확인 중 · 미전송", DISPATCHING: "전송 확인 중", SUBMITTED: "응답 대기",
      RESPONSE_STARTED: "응답 생성 중", RESPONSE_COMPLETED: "응답 수신 · 검증 또는 수신 확인 필요",
      ACKNOWLEDGED: "응답 처리 완료", RECOVERY_REQUIRED: "전송 상태 확인 필요", FAILED: "요청 실패" };
    const failures = displayedDelivery.validation?.checks?.filter(item => !item.passed) ?? [];
    const confidenceFailure = failures.find(item => item.name === "응답 신뢰도");
    const displayedFailures = failures.filter(item => item !== confidenceFailure);
    const responseSettled = displayedDelivery.processingState === "COMPLETE";
    const status = responseSettled ? "응답 처리 완료 · 성공 trace 보존됨"
      : displayedDelivery.processingState === "ACK_PENDING" ? "응답 검증·저장 완료 · 전송 정리 확인 필요"
        : states[displayedDelivery.state] ?? "처리 상태 미확인";
    recovery.append(node("p", status, responseSettled ? "recovery-guidance ok" : "recovery-guidance warn"));
    const cleanup = preparation.tabCleanup?.deliveryId === displayedDelivery.deliveryId ? preparation.tabCleanup : null;
    if (displayedDelivery.deliveryId) recovery.append(node("p", `전송 · ${displayedDelivery.deliveryId}`, "muted"));
    if (displayedDelivery.bridgeOwnedPreparationTab === true) recovery.append(node("p", "탭 소유권 · Bridge", "muted"));
    if (cleanup?.status === "CLOSED") recovery.append(node("p", `탭 닫힘 영수증 · 탭 ${cleanup.tabId ?? "확인 전"}`, "muted"));
    if (displayedDelivery.cancelRequestedAt && !responseSettled) {
      recovery.append(node("p", "종료 요청을 저장했습니다. 이 전송의 수신 확인이 끝나면 협의가 자동으로 종료됩니다."));
    }
    const confidenceReason = displayedDelivery.response?.confidenceReason
      ?? displayedDelivery.response?.evidence?.confidenceReason
      ?? null;
    renderPreparationResponse(recovery, displayedDelivery, node);
    if (displayedDelivery.response?.confidence === "HEURISTIC") {
      recovery.append(node("p", "응답 전달 검증: 확인 불가 · 이번 요청에 대한 응답인지 DOM 순서로 확정하지 못함", "recovery-guidance error"));
      recovery.append(node("p", confidenceReason === "VIRTUALIZED_USER_DOM_UNCERTAIN"
        ? "DOM 상태: 가상화 또는 DOM 변경 의심 · 사용자 메시지가 현재 DOM에서 사라졌을 가능성"
        : "DOM 상태: 원인 특정 불가 · DOM 변경 또는 확장 상태 확인 필요", "diagnostic-row health error"));
    }
    if (["RECOVERY_REQUIRED", "AMBIGUOUS"].includes(displayedDelivery.state) && !displayedDelivery.response) {
      recovery.append(node("p", "전송 결과가 불명확합니다. 브릿지 연결이 끊겼거나 서버가 재시작되어 확장에 재확인 명령이 전달되지 않았을 수 있습니다. 서버와 확장 연결을 확인한 뒤 상태를 다시 확인하세요.", "recovery-guidance error"));
    }
    if (displayedFailures.length) {
      const otherFailures = failures.filter(item => item !== confidenceFailure);
      if (otherFailures.length) recovery.append(node("p", "확인하지 못한 항목: " + otherFailures.map(item => item.name).join(", "), "recovery-guidance error"));
    }
  }
  recovery.append(node("p", "선택자·문서 토큰·전송 상세·원시 응답은 진단 로그 내보내기에 포함됩니다."));
  for (const [action, { button, label }] of buttons) {
    const recheck = action === "web.reconcile" && displayedDelivery?.state === "FAILED"
      && displayedDelivery.unsent === true && displayedDelivery.tabRecheck
      && capabilities().has(action);
    const nextLabel = recheck ? "탭 다시 확인하고 전송 계속"
      : action === "web.reconcile" && displayedDelivery?.processingState === "ACK_PENDING" ? "수신 확인 다시 처리" : label;
    if (button.textContent !== nextLabel) button.textContent = nextLabel;
    const disabled = !capabilities().has(action) || operations.webTurn !== "IDLE";
    button.disabled = disabled;
    buttonReason(button, disabled ? disabledWebReason(action) : "");
  }
  const error = preparation.error;
  const progress = { INITIALIZING: "ChatGPT 대화에 연결 중입니다.",
    WAITING_WEB_RESPONSE: "응답을 기다리고 있습니다.",
    DISCUSSING: "질문에 답해 작업 범위를 정하세요.",
    AGREEMENT_READY: "완료 기준을 확인하고 승인하세요.",
    APPROVING: "작업을 생성하고 있습니다.",
    RECOVERY_REQUIRED: "전송 결과 확인이 필요합니다." };
  text("projectHeading", workflow.state === "AGREEMENT_READY" ? "요구사항 준비 완료"
    : workflow.state === "APPROVING" ? "작업을 시작하고 있습니다"
    : preparation.state === "FAILED" ? "작업을 시작하지 못했습니다"
    : "요구사항 정리 중");
  text("projectLead", (workflow.state === "AGREEMENT_READY"
    ? "작업 범위, 완료 기준, 검증 방식을 확인한 뒤 승인하세요."
    : workflow.state === "APPROVING" ? "요구사항은 확정됐고 작업 생성 상태를 확인하고 있습니다."
    : preparation.state === "FAILED" ? "합의 내용은 보존됩니다. 원인을 확인한 뒤 다음 행동을 선택하세요."
    : "질문에 답하면서 작업 범위와 완료 기준을 확정합니다.")
    + (preparation.projectConversationSource ? " 이전 프로젝트 대화를 이어가지만 이번 요구사항은 별도로 승인해야 합니다." : ""));
  const exception = $("preparationException");
  exception.hidden = !error;
  exception.className = "flow-band" + (error ? " error" : "");
  exception.replaceChildren();
  if (error) {
    exception.append(
      node("h2", preparation.state === "FAILED" ? "작업 시작에 실패했습니다." : "현재 상태를 확인해야 합니다."),
      node("p", error.message)
    );
  }
  text("proposalStatus", error ? "" : progress[workflow.state] ?? "최신 준비 상태를 확인하세요.");
}
async function preparationMutation(operation, capability, url, payload = {}) {
  if ((operations[operation] !== "IDLE" && !(payload.abandonInvalidResponseConfirmed && payload.requestId
    && operations[operation] === "UNKNOWN_RESULT")) || !capabilities().has(capability)) return false;
  if (["preparation.start", "preparation.reply"].includes(capability) && !webConnected()) return false;
  const requestId = payload.requestId ?? crypto.randomUUID();
  const version = capability === "preparation.start" ? {} : { expectedVersion:workflow.preparationVersion };
  operations[operation] = "RUNNING"; render();
  try {
    await request(url, { method: "POST", body: JSON.stringify({ ...version, ...payload, requestId }) });
    if (capability === "preparation.cancel" && !selected) requestedView = "closing";
    if (capability === "preparation.start" && requestedView === "closing") requestedView = "start";
    text("projectStatus", "요청을 접수했습니다. 서버 상태를 확인합니다.");
    return true;
  } catch (error) {
    if (error.code === "UNKNOWN_RESULT") { operations[operation] = "UNKNOWN_RESULT"; unknownRequests.set(operation, {requestId}); }
    const message = userFacingError(error);
    if (capability === "web.rebind" && error.code !== "UNKNOWN_RESULT") tabChoiceFailures.set(payload.deliveryId, message);
    text("projectStatus", message); text("startReason", message);
    return false;
  } finally {
    if (operations[operation] !== "UNKNOWN_RESULT") operations[operation] = "IDLE";
    await refresh();
  }
}
async function webSessionCommand(commandType, extras = {}) {
  const session = preparation?.webSession;
  if (!session) return;
  return preparationMutation("webTurn", commandType, "/api/preparations/web", {
    command: commandType, preparationId: workflow.preparationId,
    sessionId: session.sessionId, conversationId: session.conversationId,
    conversationUrl: session.conversationUrl, deliveryId: session.activeDeliveryId,
    ...extras,
  });
}
async function beginPreparation() {
  if ($("planRun").disabled) return;
  const objective = $("objective").value, targetRoot = $("startRoot").value.trim(), conversationUrl = $("conversationUrl").value.trim() || "https://chatgpt.com/";
  if (!objective.trim() || !targetRoot || !/^https:\/\/chatgpt\.com\/(?:c\/[^/?#\s]+)?\/?$/u.test(conversationUrl)) {
    text("startReason", "첫 부탁과 프로젝트 폴더를 입력하고 기존 대화 URL 형식을 확인하세요."); return;
  }
  await preparationMutation("preparationStart", "preparation.start", "/api/preparations",
    { objective, targetRoot, conversationUrl, ...readPreparationOptions($),
      reviewers:{
        JUDGE:{ provider:$("judgeReviewerProvider").value },
        CRITIC:{ provider:$("criticReviewerProvider").value },
      },
      ...(followUpSource ? { followUpRunId:followUpSource.runId } : {}),
      reuseProjectConversation:$("reuseProjectConversation").checked && !$("projectConversationPanel").hidden });
}
bindPreparationConversation($, text, () => preparation);
$("startForm").addEventListener("submit", (event) => { event.preventDefault(); return beginPreparation(); });
let plainWorkerAvailable = null;
let plainWorkerSubmitting = false;
function showPlainWorker({ run }) {
  $("openPlainWorker").hidden = false;
  $("startPlainWorker").disabled = plainWorkerSubmitting || run?.status === "RUNNING";
  if (!run) return;
  const labels = { RUNNING: "진행 중", COMPLETED: "완료", FAILED: "실패" };
  text("plainWorkerStatus", [labels[run.status], run.runId, run.error].filter(Boolean).join(" · "));
  $("plainWorkerEvidence").hidden = !run.turns.length;
  text("plainWorkerTranscript", run.turns.map(turn => [
    turn.role, turn.runId, turn.threadId ?? turn.conversationId, turn.turnId,
    "송신 원문", turn.sent, "수신 원문", turn.received,
  ].join("\n")).join("\n\n"));
}
$("openPlainWorker").addEventListener("click", () => {
  const panel = $("plainWorkerPanel");
  panel.hidden = !panel.hidden;
  $("openPlainWorker").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) {
    $("plainWorkerRoot").value ||= $("startRoot").value;
    $("plainWorkerObjective").focus();
  }
});
$("startPlainWorker").addEventListener("click", async () => {
  if (plainWorkerSubmitting) return;
  const objective = $("plainWorkerObjective").value.trim(), targetRoot = $("plainWorkerRoot").value.trim();
  if (!objective || !targetRoot) {
    text("plainWorkerStatus", "작업 요청과 격리 프로젝트 폴더를 입력하세요.");
    return;
  }
  plainWorkerSubmitting = true;
  $("startPlainWorker").disabled = true;
  try {
    const result = await request("/api/plain-worker-loop", { method: "POST", body: JSON.stringify({ objective, targetRoot }) });
    showPlainWorker(result);
  } catch (error) {
    text("plainWorkerStatus", error.code ?? error.message);
    $("startPlainWorker").disabled = false;
  } finally {
    plainWorkerSubmitting = false;
  }
});
$("plainTextAdvisory")?.addEventListener("change", (event) => {
  text("planRun", event.target.checked ? "평문 자문 시작" : "요구사항 정리 시작");
});
$("startRoot").addEventListener("input", render);
$("historySearch").addEventListener("input", () => {
  historyQuery = $("historySearch").value;
  sessionStorage.setItem("bridge.history.query", historyQuery);
  render();
});
$("historyStatusFilter").addEventListener("change", () => {
  historyScope = $("historyStatusFilter").value;
  sessionStorage.setItem("bridge.history.scope", historyScope);
  render();
});
$("historyClearFilters").addEventListener("click", () => {
  historyQuery = ""; historyScope = "ALL";
  sessionStorage.setItem("bridge.history.query", "");
  sessionStorage.setItem("bridge.history.scope", "ALL");
  render();
});
$("reuseProjectConversation").addEventListener("input", () => {
  if (!$("reuseProjectConversation").checked) $("conversationUrl").value = "";
  render();
});
$("reviseRequirements").addEventListener("click", async () => {
  const feedback = $("proposalFeedback"), preparationId = workflow.preparationId, content = feedback.value;
  if (!content.trim()) { text("proposalStatus", "답변 또는 수정 요청을 입력하세요."); return; }
  if (await preparationMutation("webTurn", "preparation.reply", "/api/preparations/" + encodeURIComponent(preparationId) + "/reply", { content })) {
    if (feedback.dataset.preparationId === preparationId && feedback.value === content) feedback.value = "";
  }
});
$("projectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await preparationMutation("approval", "preparation.approve",
    "/api/preparations/" + encodeURIComponent(workflow.preparationId) + "/approve");
});
$("closeProject").addEventListener("click", () => preparationMutation("preparationStart", "preparation.cancel",
  "/api/preparations/" + encodeURIComponent(workflow.preparationId) + "/cancel"));
for (const id of ["discardUnresolved", "discardNoResend", "discardReason", "discardPageUnconfirmed"]) $(id).addEventListener("input", render);
$("discardDeliveryButton").addEventListener("click", () => {
  if ($("discardDeliveryButton").disabled) return;
  return preparationMutation("preparationStart", "preparation.discard",
    "/api/preparations/" + encodeURIComponent(workflow.preparationId) + "/discard", capabilities().has("preparation.abandonInvalid") ? invalidAbandonmentInput($, preparation) : {
      deliveryId:preparation.webSession.activeDeliveryId,
      unresolvedResultConfirmed: $("discardUnresolved").checked,
      noAutomaticResendConfirmed: $("discardNoResend").checked,
      reason: $("discardReason").value.trim(),
    });
});
$("reloadProject").addEventListener("click", refresh);
$("reconcilePreparationOutcome").addEventListener("click", () => {
  if (operations.webTurn === "IDLE" && webConnected() && capabilities().has("web.reconcile")
    && !$("reconcilePreparationOutcome").hidden) return webSessionCommand("web.reconcile");
});
$("chooseFolder").addEventListener("click", async () => {
  if (!currentPreparationActions().chooseFolder || operations.folderPicker !== "IDLE") return;
  operations.folderPicker = "RUNNING"; render();
  text("folderStatus", "열린 파일 탐색기에서 프로젝트 폴더를 선택하세요.");
  try {
    const result = await request("/api/project/folder", { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: 0 }) });
    if (result.targetRoot) $("startRoot").value = result.targetRoot;
    text("folderStatus", result.targetRoot ? "폴더를 선택했습니다." : "폴더 선택을 취소했습니다.");
  } catch (error) { text("folderStatus", userFacingError(error)); }
  finally { operations.folderPicker = "IDLE"; render(); }
});
$("newRun").addEventListener("click", () => { if (!$("newRun").disabled) { pendingProjectDraft?.cancel(); followUpSource = null; selectProject(null); projectConversationRoot = null; selected = ""; requestedView = "start"; refresh(); } });
$("openActivePreparation").addEventListener("click", async () => {
  const button = $("openActivePreparation");
  if (button.hidden || button.disabled) return;
  openingPreparation = true;
  try { await refresh({ recoveryTarget:snapshot.activePreparation }); }
  finally { openingPreparation = false; render(); }
});
async function startProjectDraft(root, source) {
  pendingProjectDraft?.cancel();
  const fields = ["startRoot", "objective", "conversationUrl", "judgeReviewerProvider", "criticReviewerProvider"];
  const previous = fields.map(id => $(id).value);
  const previousSource = followUpSource, previousProject = projectViewRoot;
  const previousView = { selected, requestedView };
  const previousConversationRoot = projectConversationRoot, previousReuse = $("reuseProjectConversation").checked;
  const previousReviewerRoot = reviewerSelectionRoot;
  const focused = document.activeElement;
  followUpSource = source; projectConversationRoot = null; selected = ""; requestedView = "start";
  $("startRoot").value = root;
  $("objective").value = "";
  $("conversationUrl").value = "";
  selectProject(null);
  const initialized = fields.map(id => $(id).value);
  let edited = false;
  const onEdit = () => { edited = true; };
  $("startForm").addEventListener("input", onEdit);
  const draft = {
    cancel() {
      $("startForm").removeEventListener("input", onEdit);
      if (pendingProjectDraft === draft) pendingProjectDraft = null;
    },
    complete() {
      draft.cancel();
      if (selected !== "" || projectViewRoot !== null || followUpSource !== source) return;
      if (!connected || workflow.stage !== "START") {
        if (!edited && fields.every((id, index) => $(id).value === initialized[index])) {
          fields.forEach((id, index) => { $(id).value = previous[index]; });
          followUpSource = previousSource; projectConversationRoot = previousConversationRoot;
          selected = previousView.selected; requestedView = previousView.requestedView;
          reviewerSelectionRoot = previousReviewerRoot;
          $("reuseProjectConversation").checked = previousReuse;
          if (previousProject) {
            selectProject(previousProject);
            text("overviewReason", "시작 화면을 열 수 없습니다. 진행 중인 작업 또는 준비 상태를 확인하세요.");
          } else render();
        } else render();
        return;
      }
      if (document.activeElement === focused || document.activeElement === document.body) $("objective").focus();
    },
  };
  pendingProjectDraft = draft;
  await refresh();
}
$("newProjectTask").addEventListener("click", () => {
  if ($("newProjectTask").disabled || !projectViewRoot) return;
  return startProjectDraft(projectViewRoot, null);
});
$("openProjectBlocker").addEventListener("click", () => {
  const pending = snapshot?.runs?.find((item) => !terminal.has(item.phase));
  if (pending) openRun(pending.runId);
});
$("continueProject").addEventListener("click", () => {
  if ($("continueProject").disabled) return;
  const root = snapshot?.run?.projectRef?.targetRoot;
  if (!root || snapshot?.run?.phase !== "APPLIED") return;
  return startProjectDraft(root, { runId:snapshot.run.runId, objective:snapshot.run.objective, targetRoot:root, conversationUrl:snapshot.run.conversationUrl });
});
$("openFollowUp").addEventListener("click", () => { if (!$("openFollowUp").disabled) openRun(snapshot.run.followUp.runId); });
$("cancelInitialPreparation").addEventListener("click", () => preparationMutation("preparationStart", "preparation.cancel",
  "/api/preparations/" + encodeURIComponent(workflow.preparationId) + "/cancel"));
$("showUnfinishedRun").addEventListener("click", () => {
  const unfinished = snapshot?.runs?.find((run) => !terminal.has(run.phase));
  if (unfinished) openRun(unfinished.runId);
});
$("recoveryConfirm").addEventListener("input", render);
$("reconcileRun").addEventListener("click", async () => {
  if ($("reconcileRun").disabled) return;
  const target = snapshot?.run?.runId;
  text("reconcileResult", "현재 상태를 확인 중입니다.");
  const result = await command("run.reconcile");
  if (snapshot?.run?.runId !== target) return;
  latestRunDiagnostic = { runId:target, observedAt:new Date().toISOString(), result };
  text("reconcileResult", result
    ? `진단: ${result.classification ?? "미확인"}\n상세 관측값은 진단 로그 내보내기로 확인하세요.\n가능한 조치: ${(result.allowedActions ?? []).join(", ") || "없음"}\n이 진단은 외부 작업 종료를 확인하지 않습니다.`
    : "진단에 실패했습니다. 위 명령 결과와 연결 상태를 확인하세요.");
});
$("retryRun").addEventListener("click", () => {
  if ($("retryRun").disabled) return;
  return command(capabilities().has("code.review.retry") ? "code.review.retry" : "run.retry");
});
$("submitDecision").addEventListener("click", () => {
  if ($("submitDecision").disabled) return;
  const responses = [...$("decisionQuestions").querySelectorAll("textarea")]
    .map((item) => ({ requestItemId:item.dataset.requestItemId, answer:item.value.trim() }));
  command("code.decision.reply", { responses });
});
$("reviewDiscussionRole").addEventListener("change", render);
$("reviewDiscussionText").addEventListener("input", render);
$("reviewDiscussionUnresolved").addEventListener("input", render);
$("reviewDiscussionNoResend").addEventListener("input", render);
$("reviewDiscussionDiscardReason").addEventListener("input", render);
$("sendReviewDiscussion").addEventListener("click", async () => {
  if ($("sendReviewDiscussion").disabled) return;
  const textValue = $("reviewDiscussionText").value;
  const role = $("reviewDiscussionRole").value;
  const result = await command("code.review.discuss", { role, text:textValue });
  if (result?.status === "DELIVERED" && $("reviewDiscussionText").value === textValue) {
    $("reviewDiscussionText").value = "";
    render();
  }
});
$("discardReviewDiscussion").addEventListener("click", async () => {
  if ($("discardReviewDiscussion").disabled) return;
  const discussion = [...(snapshot?.run?.reviewDiscussions ?? [])].reverse().find((item) => item.status === "UNCONFIRMED");
  if (!discussion) return;
  const result = await command("code.review.discuss.discard", {
    discussionId:discussion.discussionId,
    unresolvedResultConfirmed:$("reviewDiscussionUnresolved").checked,
    noAutomaticResendConfirmed:$("reviewDiscussionNoResend").checked,
    reason:$("reviewDiscussionDiscardReason").value.trim(),
  });
  if (result?.status === "DISCARDED") {
    $("reviewDiscussionUnresolved").checked = false;
    $("reviewDiscussionNoResend").checked = false;
    $("reviewDiscussionDiscardReason").value = "";
    render();
  }
});
$("operatorNoteKind").addEventListener("change", render);
$("operatorNoteText").addEventListener("input", render);
$("addOperatorNote").addEventListener("click", async () => {
  if ($("addOperatorNote").disabled) return;
  const textValue = $("operatorNoteText").value.trim();
  const result = await command("run.note.add", { kind:$("operatorNoteKind").value, text:textValue });
  if (result?.status === "RECORDED" && result.runId === snapshot?.run?.runId && $("operatorNoteText").value.trim() === textValue) {
    $("operatorNoteText").value = "";
    render();
  }
});
$("workerInterventionKind").addEventListener("change", render);
$("workerInterventionText").addEventListener("input", render);
$("sendWorkerIntervention").addEventListener("click", async () => {
  if ($("sendWorkerIntervention").disabled) return;
  const textValue = $("workerInterventionText").value.trim();
  const kind = $("workerInterventionKind").value;
  const turnId = snapshot?.run?.workerTurnId;
  const result = await command("code.worker.intervene", { kind, text:textValue, turnId });
  if (result?.status === "DELIVERED" && $("workerInterventionText").value.trim() === textValue) {
    $("workerInterventionText").value = "";
    render();
  }
});
$("abandonRun").addEventListener("click", () => {
  if (!$("abandonRun").disabled) {
    const confirmed = $("recoveryConfirm").checked;
    command("run.abandon", { externalTerminationConfirmed:confirmed, targetInspected:confirmed, reason:"USER_CONFIRMED_RECOVERY_DISCARD" });
  }
});
$("stopRun").addEventListener("click", () => command("run.stop"));
$("archiveRun").addEventListener("click", () => {
  if (!$("archiveRun").disabled) command(snapshot?.run?.archivedAt ? "run.unarchive" : "run.archive");
});
$("deleteRun").addEventListener("click", () => {
  const run = snapshot?.run;
  if ($("deleteRun").disabled || run?.runId !== workflow.runId) return;
  deleteDecision = {runId:run.runId, version:workflow.runVersion};
  text("deleteRunTarget", run.objective);
  text("deleteRunIdentity", run.runId);
  $("deleteRunDialog").showModal();
});
$("cancelDeleteRun").addEventListener("click", () => $("deleteRunDialog").close());
$("deleteRunDialog").addEventListener("close", () => { deleteDecision = null; });
$("confirmDeleteRun").addEventListener("click", () => {
  if (!deleteDecision || $("deleteRun").disabled || deleteDecision.runId !== workflow.runId
    || deleteDecision.version !== workflow.runVersion) return;
  deleteDecision = null;
  $("deleteRunDialog").close();
  return command("run.delete");
});
$("applyCode").addEventListener("click", () => {
  const run = snapshot?.run;
  const review = run?.reviews?.at(-1);
  if ($("applyCode").disabled || !run?.candidate || !review || !run.capture?.artifact?.sha256) return;
  applyDecision = { runId:run.runId, version:workflow.runVersion, candidateId:run.candidate.candidateId,
    reviewId:review.reviewId, artifactHash:run.capture.artifact.sha256, baseCommit:run.baseCommit };
  text("applyDecisionTarget", run.projectRef?.targetRoot ?? run.targetRoot ?? run.objective);
  text("applyDecisionCandidate", applyDecision.candidateId);
  $("applyDecisionDialog").showModal();
});
$("cancelApplyDecision").addEventListener("click", () => $("applyDecisionDialog").close());
$("applyDecisionDialog").addEventListener("close", () => { applyDecision = null; });
$("confirmApplyDecision").addEventListener("click", () => {
  const decision = applyDecision;
  if (!decision || $("applyCode").disabled || decision.runId !== workflow.runId || decision.version !== workflow.runVersion
    || decision.candidateId !== snapshot?.run?.candidate?.candidateId) return;
  const { candidateId, reviewId, artifactHash, baseCommit } = decision;
  applyDecision = null;
  $("applyDecisionDialog").close();
  return command("code.apply", { candidateId, reviewId, artifactHash, baseCommit });
});
$("exportEvidence").addEventListener("click", async () => { const result = await command("evidence.export"); if (!result) return; const url = URL.createObjectURL(new Blob([JSON.stringify(result,null,2)], { type:"application/json" })); const a = node("a", ""); a.href = url; a.download = `${result.runId ?? "audit"}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
const recordTabs = [["showConversation", "conversationPanel"], ["showPreparationHistory", "preparationHistoryPanel"], ["showAudit", "auditPanel"], ["showLog", "logPanel"]];
function roleReviewTarget(run) {
  const review = run?.reviews?.at(-1);
  if (!run?.candidate || !review?.reviewId || review.candidateId !== run.candidate.candidateId
    || !review.auditManifestHash || run.coordination?.auditManifestHash !== review.auditManifestHash
    || run.coordination?.activeRole || ["REVIEW_RUNNING", "REPORT_REPAIR", "EVIDENCE_SUPPLEMENT", "REWORK"].includes(run.phase)) return null;
  const identity = {runId:run.runId, candidateId:review.candidateId, reviewId:review.reviewId};
  return {identity, manifest:review.auditManifestHash, key:JSON.stringify([identity,review.auditManifestHash])};
}

$("loadRoleReviews").addEventListener("click", async () => {
  if ($("loadRoleReviews").disabled) return;
  const target = roleReviewTarget(snapshot?.run);
  if (!target) return;
  const load = roleReviewRead = {targetKey:target.key, pending:true};
  const selection = selected;
  const stillCurrent = () => roleReviewRead === load && selected === selection && roleReviewTarget(snapshot?.run)?.key === target.key;
  $("loadRoleReviews").disabled = true;
  $("roleReviewResults").replaceChildren();
  text("roleReviewStatus", "개별 판정 조회 중입니다.");
  try {
    const result = await request(`/api/review-assessments?${new URLSearchParams(target.identity)}`);
    if (!stillCurrent()) return;
    if (result.status !== "AVAILABLE" || result.auditManifestHash !== target.manifest
      || !Object.entries(target.identity).every(([key,value])=>result[key]===value)) {
      text("roleReviewStatus", "현재 후보의 검증된 개별 판정을 확인할 수 없습니다.");
      return;
    }
    const reports = new Map(result.roles.map(item => [item.role,item.assessments]));
    const table = node("table", "", "studio-role-table");
    const head = node("thead", ""), header = node("tr", ""), body = node("tbody", "");
    for (const label of ["요구사항", "Judge", "Critic"]) {
      const cell = node("th", label); cell.scope = "col"; header.append(cell);
    }
    head.append(header);
    for (const requirement of snapshot.run.requirements?.items ?? []) {
      const row = node("tr", "");
      const title = node("th", requirement.requirementId); title.scope = "row"; row.append(title);
      for (const role of ["JUDGE", "CRITIC"]) {
        const item = reports.get(role)?.find(assessment=>assessment.requirementId===requirement.requirementId);
        row.append(node("td", {SATISFIED:"충족", UNSATISFIED:"미충족", UNDETERMINED:"판단 보류"}[item?.verdict] ?? "미확인"));
      }
      body.append(row);
    }
    table.append(head,body);
    $("roleReviewResults").append(table);
    text("roleReviewStatus", "현재 후보의 개별 판정입니다. 종합 판정은 위에 표시됩니다.");
  } catch {
    if (stillCurrent()) text("roleReviewStatus", "개별 판정을 조회하지 못했습니다.");
  } finally {
    if (stillCurrent()) {
      load.pending = false;
      $("loadRoleReviews").disabled = !connected;
    }
  }
});
for (const [button, panel] of recordTabs) {
  $(button).addEventListener("click", () => {
    for (const [otherButton, otherPanel] of recordTabs) {
      $(otherPanel).hidden = otherPanel !== panel;
      $(otherButton).setAttribute("aria-pressed", String(otherButton === button));
    }
  });
}
function renderStudioSearch() {
  const query = $("studioSearchQuery").value.trim().toLocaleLowerCase();
  const results = $("studioSearchResults"), run = snapshot?.run;
  results.replaceChildren();
  if (!query) { text("studioSearchStatus", "검색어를 입력하세요."); return; }
  const matches = filterRunsForHistory(snapshot?.runs ?? [], {query, scope:"ALL"}).map(item => ({
    label:item.objective ?? item.runId, open:() => openRun(item.runId),
  }));
  if (run && !$("applyInspector").hidden) {
    for (const [kind, entries] of [["requirement", run.requirements?.items ?? []], ["finding", snapshot.findings ?? []]]) {
      for (const item of entries) {
        const id = kind === "requirement" ? item.requirementId : item.findingId;
        const label = `${id} · ${item.statement ?? item.problem ?? ""}`;
        if (label.toLocaleLowerCase().includes(query)) matches.unshift({
          label, open:() => { $("showAudit").click(); selectInspector(run, kind, id); },
        });
      }
    }
  }
  for (const item of matches.slice(0, 12)) {
    const button = node("button", item.label);
    button.type = "button";
    button.addEventListener("click", () => { $("studioSearchDialog").close(); item.open(); });
    results.append(button);
  }
  text("studioSearchStatus", matches.length ? `${Math.min(matches.length, 12)}건 표시` : "일치하는 기록이 없습니다.");
}
function openStudioSearch() {
  if (!$("dashboardPageError").hidden || $("studioSearchDialog").open) return;
  $("studioSearchQuery").value = "";
  renderStudioSearch();
  $("studioSearchDialog").showModal();
}
$("openStudioSearch").addEventListener("click", openStudioSearch);
$("studioSearchQuery").addEventListener("input", renderStudioSearch);
document.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k"
    && !document.querySelector("dialog[open]")) {
    event.preventDefault();
    openStudioSearch();
  }
});
$("closeEvidence").addEventListener("click", () => $("evidenceDialog").close());
$("openStudioDiagnostics").addEventListener("click", () => {
  const details = $("connectionDiagnostics");
  details.open = true;
  details.querySelector("summary")?.focus();
});
$("evidenceDialog").addEventListener("close", () => {
  if (evidencePage?.candidateId) return;
  restoreEvidenceFocus(evidencePage);
  evidencePage = null;
});
$("closeInspectorEvidence").addEventListener("click", () => closeInspectorEvidence());
$("copyInspectorEvidence").addEventListener("click", async () => {
  const page = evidencePage;
  if (!page?.candidateId || $("copyInspectorEvidence").disabled) return;
  let message = "원문을 복사했습니다.";
  try { await navigator.clipboard.writeText($("inspectorEvidenceContent").textContent); }
  catch { message = "복사 권한을 확인하거나 원문에서 직접 복사하세요."; }
  if (page === evidencePage) text("inspectorCopyStatus", message);
});
for (const [button, inspector] of [["nextEvidence", false], ["nextInspectorEvidence", true]]) {
  $(button).addEventListener("click", () => {
    if (evidencePage?.next && evidencePage.target === snapshot?.run?.runId && Boolean(evidencePage.candidateId) === inspector) {
      return openEvidence(evidencePage.id, evidencePage.next, evidencePage.candidateId, evidencePage.source, evidencePage.patchPath);
    }
  });
}
$("refreshDashboard").addEventListener("click", () => { if ($("dashboardPageError").hidden) void refresh().catch(showDashboardPageError); });
async function poll() {
  try {
    if (!openingPreparation) await refresh({ background:true });
    if (token && plainWorkerAvailable !== false && !plainWorkerSubmitting) {
      try {
        showPlainWorker(await request("/api/plain-worker-loop"));
        plainWorkerAvailable = true;
      } catch (error) {
        if (error.status === 404) plainWorkerAvailable = false;
      }
    }
  }
  catch (error) { connected = false; showDashboardPageError(error); }
  finally { if ($("dashboardPageError").hidden) setTimeout(poll, 2500); }
}

$("exportDiagnosticLog").addEventListener("click", async () => {
  const button = $("exportDiagnosticLog"), status = $("diagnosticExportStatus");
  button.disabled = true; status.textContent = "진단 로그를 수집하는 중입니다.";
  try { const result = await exportDiagnosticLog({ request, preparation, connectionState, lastConfirmed, runDiagnostic:latestRunDiagnostic, includeRaw:$("includeRawDiagnostic").checked });
    status.textContent = result.cancelled ? "로그 내보내기를 취소했습니다." : result.partial ? "일부 정보를 수집하지 못했습니다. 확보된 로그 다운로드를 요청했습니다." : "진단 로그 다운로드를 요청했습니다.";
  } catch { status.textContent = "로그 내보내기에 실패했습니다. 다시 시도하세요."; }
  finally { button.disabled = false; }
});

void poll();
