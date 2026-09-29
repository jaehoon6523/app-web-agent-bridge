import { renderInitialRequest } from "./preparation-view.js";
import { renderConversation } from "./conversation-view.js";
import { renderProjectOverview } from "./project-overview-view.js";
import { externalEventRecords, filterRunsForHistory, groupRunsByProject, normalizeDashboardState } from "./dashboard-model.js";
import { createRunActionLayout } from "./run-action-layout.js";
import { createRunContextView, reviewerRuntimeTechnicalSummary } from "./run-context-view.js";
import {
  DashboardSessionState, ExtensionState, StateReadState, TransportState,
  classifyDashboardFailure, connectionNoticeFor, dashboardStateReady,
  initialDashboardConnectionState, markDashboardSessionAuthenticated,
  markDashboardSessionPending, markStateReadReady, markStateReadStarted,
  projectBrowserState, requestFailureCode,
} from "./dashboard-connection-state.js";
const $ = (id) => document.getElementById(id);
let token = "", snapshot = null, selected = "", connected = false;
let connectionState = initialDashboardConnectionState();
let workflow = { stage: "START", state: "START_IDLE", preparationId: null, preparationVersion: null, runId: null, runVersion: null };
let sequence = 0, lastConfirmed = null, evidencePage = null;
let renderedRecords = "", lastCommandError = "", recoveryRunId = null, readinessSignature = "";
let decisionSignature = "", interventionRunId = null;
let agreement = null, preparation = null;
let projectConversationRoot = null, reviewDiscussionRunId = null;
let followUpSource = null;
let reviewerSelectionRoot = null;
let projectViewRoot = sessionStorage.getItem("bridge.project.view") || null;
let historyQuery = sessionStorage.getItem("bridge.history.query") || "";
let historyScope = sessionStorage.getItem("bridge.history.scope") || "ALL";
const operations = { folderPicker: "IDLE", preparationStart: "IDLE", webTurn: "IDLE", approval: "IDLE", runCommand: "IDLE" };
let preparationSignature = "";
let requestedView = "";
const unknownRequests = new Map();

const openFindings = new Set();
const terminal = new Set(["APPLIED", "CANCELLED", "INCONCLUSIVE", "FAILED", "COMPLETE"]);
const labels = { CREATED:"접수됨", PROVISIONING:"작업 환경 준비 중", WORKER_RUNNING:"구현·수정 중", CANDIDATE_CAPTURE:"변경사항 고정 중", VERIFYING:"검증 중", REVIEW_RUNNING:"독립 검토 중", REPORT_REPAIR:"검토 응답 확인 중", EVIDENCE_SUPPLEMENT:"검토 근거 보완 중", REWORK:"수정 대기", HOLD:"확인 필요", AWAITING_APPLY:"감사 통과·적용 대기", APPLYING:"적용 중", APPLIED:"적용됨", INCONCLUSIVE:"미해결 상태로 종료", CANCELLED:"사용자 중단", RECOVERY_REQUIRED:"복구 확인 필요", FAILED:"오류 종료", STOPPING:"중단 확인 중", COMPLETE:"이전 작업 기록" };
const phaseReasons = {
  CREATED:"작업이 접수되었습니다.",
  PROVISIONING:"격리된 작업 환경을 준비하고 있습니다.",
  WORKER_RUNNING:"Worker가 승인된 요구사항을 구현하고 있습니다.",
  CANDIDATE_CAPTURE:"구현 결과를 검토할 변경사항으로 고정하고 있습니다.",
  VERIFYING:"고정된 변경사항의 검증 근거를 확인하고 있습니다.",
  REVIEW_RUNNING:"Judge와 Critic이 현재 변경사항을 독립적으로 검토하고 있습니다.",
  REPORT_REPAIR:"검토 응답을 확인하고 있습니다.",
  EVIDENCE_SUPPLEMENT:"현재 변경사항의 검토 근거를 보완하고 있습니다.",
  REWORK:"검토 지적을 반영하기 위한 수정 절차를 진행합니다.",
  APPLYING:"검토를 통과한 변경사항을 프로젝트에 적용하고 있습니다.",
};
const errorCopy = Object.freeze({
  UNKNOWN_RESULT:"진행 중이던 요청의 결과를 확인할 수 없습니다. 같은 요청을 자동으로 다시 보내지 않습니다. 연결을 복구한 뒤 상태를 확인하세요.",
  RUN_VERSION_CONFLICT:"작업 상태가 변경되었습니다. 최신 상태를 확인한 뒤 다시 시도하세요.",
  RUN_BUSY:"다른 작업이 진행 중입니다. 현재 작업을 확인한 뒤 다시 시도하세요.",
  WEB_BLOCKED:"브라우저 확장 연결을 확인한 뒤 다시 시도하세요.",
  RECOVERY_REQUIRED:"현재 작업 상태를 먼저 확인해야 합니다. 복구 안내에 따라 상태를 확인하세요.",
  WORKER_TURN_CHANGED:"Worker 상태가 변경되었습니다. 최신 상태를 확인한 뒤 다시 보내세요.",
  WORKER_INTERVENTION_UNAVAILABLE:"현재 Worker에 메시지를 전달할 수 있는 상태가 아닙니다. Worker 실행 상태를 확인하세요.",
  REVIEW_DISCUSSION_RECOVERY_REQUIRED:"이전 감사자 요청의 결과가 확인되지 않았습니다. 기존 요청을 먼저 확인하거나 정리하세요.",
  REVIEW_DISCUSSION_BINDING_REQUIRED:"감사자의 기존 대화 연결을 확인한 뒤 다시 시도하세요.",
  WEB_SESSION_PROVIDER_MISMATCH:"설정한 감사 서비스와 실제 연결이 다릅니다. 감사자 대화 연결을 다시 확인하세요.",
  INVALID_INPUT:"입력 내용을 확인하세요.",
});
function userFacingError(error, fallback = "요청을 처리하지 못했습니다. 최신 상태와 기술 진단을 확인하세요.") {
  const code = typeof error?.code === "string" ? error.code : null;
  if (code && errorCopy[code]) return errorCopy[code];
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  if (message && /[가-힣]/u.test(message)) return message;
  return fallback;
}
function userFacingStoredError(value, fallback) {
  const message = typeof value === "string" ? value.trim() : "";
  if (!message) return fallback;
  return /[가-힣]/u.test(message) ? message : fallback;
}
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
function ensureOperatorNoteControls() {
  if ($("operatorNotePanel")) return;
  const panel = node("section", "", "flow-band");
  panel.id = "operatorNotePanel"; panel.hidden = true;
  panel.append(node("h2", "작업 메모 · 결정 기록"));
  panel.append(node("p", "이 기록은 Worker나 감사자에게 전송되지 않으며 요구사항·감사 판정·적용 권한을 바꾸지 않습니다.", "muted"));
  const kindLabel = node("label", "기록 종류"); kindLabel.setAttribute("for", "operatorNoteKind");
  const kind = node("select", ""); kind.id = "operatorNoteKind";
  const noteOption = node("option", "메모"); noteOption.value = "NOTE";
  const decisionOption = node("option", "결정"); decisionOption.value = "DECISION";
  kind.append(noteOption, decisionOption);
  const textLabel = node("label", "내용"); textLabel.setAttribute("for", "operatorNoteText");
  const input = node("textarea", ""); input.id = "operatorNoteText"; input.rows = 3; input.maxLength = 4000;
  input.placeholder = "나중에 이 작업을 다시 볼 때 필요한 판단 근거나 인수인계 내용을 기록하세요.";
  const add = node("button", "기록 추가"); add.id = "addOperatorNote"; add.type = "button"; add.disabled = true;
  const status = node("p", "", "muted"); status.id = "operatorNoteStatus"; status.setAttribute("role", "status");
  const list = node("div", ""); list.id = "operatorNoteList";
  panel.append(kindLabel, kind, textLabel, input, add, status, list);
  $("runSecondaryContent")?.append(panel);
}
ensureOperatorNoteControls();

const syncRunInformationArchitecture = createRunActionLayout({ $, text });

function selectProject(root) { projectViewRoot = root; sessionStorage.setItem("bridge.project.view", root ?? ""); render(); }
function openRun(runId) { selectProject(null); selected = runId; text("commandResult", ""); refresh(); }
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
  const fetchOptions = options;
  let response = null;
  try {
    response = await fetch(url, { ...fetchOptions, signal:AbortSignal.timeout(url === "/api/project/folder" ? 310000 : url.startsWith("/api/preparations/") ? 180000 : url.startsWith("/api/state") || url === "/api/dashboard/session" ? 10000 : 30000), cache:"no-store", headers:{ "Content-Type":"application/json", ...(token ? { Authorization:`Bearer ${token}` } : {}), ...fetchOptions.headers } });
    let body;
    try { body = await response.json(); }
    catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") throw error;
      throw Object.assign(new Error(`서버 응답을 해석할 수 없습니다 (${response.status}).`), { code:"INVALID_SERVER_RESPONSE", status:response.status, responseReceived:true });
    }
    if (!response.ok) throw Object.assign(new Error(body?.payload?.message || body?.error?.message || body?.message || body?.error || `요청 실패 (${response.status})`), { ...(typeof body?.error === "object" ? body.error : body), status:response.status, responseReceived:true });
    return body;
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError" || (!response && error instanceof TypeError)) {
      const code = requestFailureCode({ url, method:fetchOptions.method, responseReceived:Boolean(response) });
      throw Object.assign(new Error(code === "UNKNOWN_RESULT" ? "요청 결과를 확인할 수 없습니다." : "서버 응답을 받지 못했습니다."), {
        code, responseReceived:Boolean(response),
      });
    }
    throw error;
  }
}
async function refresh() {
  const current = ++sequence, target = selected;
  let phase = token ? "STATE" : "SESSION";
  try {
    if (!token) {
      connectionState = markDashboardSessionPending(connectionState);
      const session = await request("/api/dashboard/session", { method:"POST", body:"{}" });
      if (typeof session?.token !== "string" || !session.token.trim()) throw Object.assign(new Error("대시보드 인증 응답에 토큰이 없습니다."), { code:"DASHBOARD_SESSION_INVALID", status:200, responseReceived:true });
      token = session.token;
      connectionState = markDashboardSessionAuthenticated(connectionState);
    }
    phase = "STATE";
    connectionState = markStateReadStarted(connectionState);
    const result = await request(`/api/state${target ? `?runId=${encodeURIComponent(target)}` : requestedView === "start" ? "?view=start" : ""}`);
    if (current !== sequence || target !== selected) return;
    phase = "PROJECTION";
    if (!result || !Array.isArray(result.runs) || !Array.isArray(result.commandCapabilities) || !result.preflight || typeof result.preflight !== "object") throw Object.assign(new Error("서버 상태 응답 형식을 확인하세요."), { code:"DASHBOARD_STATE_INVALID", status:200, responseReceived:true });
    if (!result.workflow) throw Object.assign(new Error("서버가 WORKFLOW_CONTRACT 상태를 제공하지 않습니다. 준비 API와 workflow projection 구현이 필요합니다."), { code:"DASHBOARD_STATE_INVALID", status:200, responseReceived:true });
    const canonical = normalizeDashboardState(result);
    connectionState = markStateReadReady(connectionState);
    connected = dashboardStateReady(connectionState);
    snapshot = result; workflow = canonical.workflow; preparation = canonical.preparation; agreement = preparation?.agreement ?? null;
    if (workflow.stage !== "START" || preparation?.lifecycle === "ACTIVE") requestedView = "";
    renderPreparation(); lastConfirmed = new Date().toISOString();
    const runtimeUnavailable = result.runtimeAvailability?.ready === false;
    const extensionNeedsPreparation = workflow.stage === "PREPARE";
    text("connectionNotice", runtimeUnavailable
      ? "서버·대시보드 정상 · 실행 런타임 준비 필요"
      : !extensionNeedsPreparation || result.preflight?.checks?.extensionAuthenticated === true ? ""
      : "웹 확장이 연결 대기 중입니다. 브라우저의 확장 팝업을 열어 서버 주소와 인증 상태를 확인한 뒤 다시 상태를 확인하세요.");
    for (const [operation, requestId] of unknownRequests) {
      const observed = await request("/api/state?requestId=" + encodeURIComponent(requestId));
      if (current !== sequence || target !== selected) return;
      const receipt = observed.requestResult;
      if (receipt?.requestId !== requestId) continue;
      if (["COMPLETED", "FAILED", "NOT_FOUND"].includes(receipt.status)) {
        operations[operation] = "IDLE"; unknownRequests.delete(operation);
        text("projectStatus", "요청 " + requestId + ": " + receipt.status);
      }
    }
  } catch (error) {
    if (current !== sequence || target !== selected) return;
    connectionState = classifyDashboardFailure(connectionState, phase, error);
    connected = dashboardStateReady(connectionState);
    if (phase === "STATE" && [401, 403].includes(error.status)) token = "";
    text("connectionNotice", connectionNoticeFor(connectionState, lastConfirmed ? time(lastConfirmed) : "없음"));
  }
  render();
  const autoApprovalPreparationId = preparation?.autoApproveOnReady === true ? preparation.preparationId : null;
  const autoApprovalKey = autoApprovalPreparationId ? `bridge:auto-approve:${autoApprovalPreparationId}` : null;
  if (autoApprovalPreparationId
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
function projectConnectionIndicator(id, state, detail) {
  const serverReachable = connectionState.transport === TransportState.REACHABLE;
  const serverUnreachable = connectionState.transport === TransportState.UNREACHABLE;
  const sessionAuthenticated = connectionState.session === DashboardSessionState.AUTHENTICATED;
  const sessionRejected = connectionState.session === DashboardSessionState.REJECTED;
  const sessionInvalid = connectionState.session === DashboardSessionState.AUTH_INVALID;
  const stateReadFailed = connectionState.stateRead === StateReadState.FAILED;
  if (id === "apiHealth" || id === "serverSignal") {
    return serverReachable
      ? { state:"ok", detail:id === "serverSignal" ? "응답 정상" : "서버 응답 확인됨" }
      : serverUnreachable
        ? { state:"error", detail:id === "serverSignal" ? "응답 없음 · npm start 및 포트 확인 필요" : "서버 응답 없음" }
        : { state:"unknown", detail:"확인 전" };
  }
  if (id === "sessionHealth") {
    return sessionAuthenticated ? { state:"ok", detail:"대시보드 인증됨" }
      : connectionState.session === DashboardSessionState.PENDING ? { state:"unknown", detail:"대시보드 인증 확인 중" }
        : sessionInvalid ? { state:"warn", detail:"대시보드 인증 실패" }
          : sessionRejected ? { state:"warn", detail:"브라우저 세션 거부됨" }
            : { state:"unknown", detail:"인증 확인 전" };
  }
  if (id === "channelHealth") {
    if (!connected) return { state:"unknown", detail:"최신 상태 확인 필요" };
    const browser = projectBrowserState(snapshot?.preflight);
    return browser.extension === ExtensionState.AUTHENTICATED
      ? { state:"ok", detail:"확장 인증됨" }
      : browser.extension === ExtensionState.DISCONNECTED
        ? { state:"warn", detail:"확장 연결 대기" }
        : { state:"unknown", detail:"확인 전" };
  }
  if (["cliSignal", "webSignal", "webBindingSignal"].includes(id) && !connected) {
    if (serverUnreachable) return { state:"warn", detail:"서버 응답 없음" };
    if (sessionInvalid || sessionRejected) return { state:"warn", detail:"대시보드 인증 확인 필요" };
    if (stateReadFailed && serverReachable) return { state:"warn", detail:"최신 상태 확인 필요" };
  }
  if (id === "refreshSignal" && !connected) {
    return stateReadFailed
      ? { state:"warn", detail:`상태 조회 실패 · 마지막 정상 확인 ${lastConfirmed ? time(lastConfirmed) : "없음"}` }
      : { state:"unknown", detail:`확인 전 · 마지막 정상 확인 ${lastConfirmed ? time(lastConfirmed) : "없음"}` };
  }
  return { state, detail };
}
function health(id, name, state, detail) {
  ({ state, detail } = projectConnectionIndicator(id, state, detail));
  const el = $(id);
  el.className = `health ${state}`;
  el.textContent = name;
  el.setAttribute("aria-label", `${name}: ${detail}`);
  text(`${id}Detail`, detail);
}
function signal(id, label, state, detail) {
  ({ state, detail } = projectConnectionIndicator(id, state, detail));
  const el = $(id);
  text(id, `${label} · ${detail}`);
  el.className = `health ${state}`;
  el.setAttribute("aria-label", `${label}: ${detail}`);
}
function closeHealthDetails(restoreFocus = false) {
  for (const id of ["apiHealth", "sessionHealth", "engineHealth", "channelHealth"]) {
    const summary = $(id), details = summary.parentElement;
    if (details?.open) { details.open = false; if (restoreFocus) summary.focus(); }
  }
}
document.addEventListener("click", (event) => {
  if (!$("systemHealth").contains(event.target)) closeHealthDetails();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("systemHealth").contains(event.target)) {
    closeHealthDetails(true); event.preventDefault();
  }
});
function runAppearance(phase) {
  if (phase === "FAILED") return "error";
  if (["HOLD", "INCONCLUSIVE", "RECOVERY_REQUIRED", "STOPPING"].includes(phase)) return "warn";
  if (["APPLIED", "COMPLETE", "AWAITING_APPLY"].includes(phase)) return "ok";
  if (["WORKER_RUNNING", "CANDIDATE_CAPTURE", "VERIFYING", "REVIEW_RUNNING", "REPORT_REPAIR", "EVIDENCE_SUPPLEMENT", "REWORK", "APPLYING"].includes(phase)) return connected ? "ok running" : "unknown";
  return "unknown";
}
function workerRuntimeStatus(runtime) {
  if (!connected || !runtime) return { state:"unknown", detail:"확인 전" };
  if (!runtime.configured) return { state:"warn", detail:"경로 설정 필요" };
  const activityAt = runtime.lastActivityAt ? ` · ${time(runtime.lastActivityAt)}` : "";
  const diff = runtime.diff;
  const diffSize = diff && Number.isSafeInteger(diff.patchBytes)
    ? (() => {
      const bytes = diff.patchBytes;
      const size = bytes < 1024 ? `${bytes} B`
        : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB`
          : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      const binary = diff.binaryFiles ? ` · binary ${diff.binaryFiles}` : "";
      return ` · diff ${diff.changedFiles ?? 0} files · +${diff.additions ?? 0}/-${diff.deletions ?? 0}${binary} · ${size}`;
    })() : "";
  const runtimeSuffix = `${diffSize}${activityAt}`;
  const toolLabels = {
    commandExecution:"명령 실행", fileChange:"파일 변경", mcpToolCall:"도구 호출",
    dynamicToolCall:"도구 호출", collabToolCall:"협업 도구", collabAgentToolCall:"협업 에이전트",
    webSearch:"웹 검색", imageView:"이미지 확인",
  };
  const tool = toolLabels[runtime.toolType] ?? runtime.toolType ?? "도구";
  if (runtime.processState === "UNCONFIGURED") return { state:"warn", detail:"경로 설정 필요" };
  if (runtime.processState === "STARTING") return { state:"ok running", detail:"Codex 프로세스 시작 중" };
  if (runtime.processState === "DISCONNECTED") return { state:"warn", detail:`Codex 연결 끊김${runtimeSuffix}` };
  if (runtime.processState === "RECOVERY_REQUIRED") return { state:"warn", detail:"최근 Worker 상태 복구 필요" };
  if (runtime.activity === "TOOL_RUNNING") return { state:"ok running", detail:`실행 확인됨 · ${tool} 진행 중${runtimeSuffix}` };
  if (runtime.activity === "TOOL_COMPLETED") return { state:"ok running", detail:`실행 확인됨 · ${tool} 완료${runtimeSuffix}` };
  if (runtime.activity === "APPROVAL_WAIT") return { state:"warn", detail:`실행 확인됨 · Codex 승인 대기${runtimeSuffix}` };
  if (runtime.activity === "CANDIDATE_CAPTURE") return { state:"ok running", detail:"Worker 완료 · 변경사항 고정 중" };
  if (runtime.activity === "VERIFYING") return { state:"ok running", detail:"Worker 완료 · 변경사항 검증 중" };
  if (runtime.activity === "WEB_AUDIT") return { state:"ok running", detail:"Worker 완료 · 독립 검토 진행 중" };
  if (runtime.activity === "AWAITING_APPLY") return { state:"ok", detail:"구현·독립 검토 완료 · 적용 대기" };
  if (runtime.activity === "APPLIED") return { state:"ok", detail:"구현·독립 검토 완료 · 적용됨" };
  if (runtime.turnState === "ACTIVE") return { state:"ok running", detail:`실행 확인됨 · Worker turn 진행 중${runtimeSuffix}` };
  if (runtime.sessionState === "READY" && runtime.processState === "RUNNING") return { state:"ok running", detail:`Codex 실행 확인 · 세션 준비됨${runtimeSuffix}` };
  if (runtime.processState === "COMPLETE") return { state:"ok", detail:"Worker 실행 완료" };
  return { state:"ok", detail:"경로 설정됨 · 실행 전" };
}
function evidenceLinks(container, refs) {
  const links = node("div", "", "links");
  for (const id of refs ?? []) {
    const button = node("button", `근거 ${id.slice(-8)}`);
    button.disabled = !connected || (operations.runCommand !== "IDLE");
    button.title = !connected ? "최신 상태 확인 후 근거를 열 수 있습니다."
      : (operations.runCommand !== "IDLE") ? "현재 요청 처리가 끝나면 근거를 열 수 있습니다." : "근거 원문을 엽니다.";
    button.addEventListener("click", () => openEvidence(id)); links.append(button);
  }
  container.append(links);
}
function renderAudit() {
  const run = snapshot?.run;
  const assessments = $("assessments"), findings = $("findings"), evidence = $("evidenceList");
  assessments.replaceChildren(); findings.replaceChildren(); evidence.replaceChildren();
  for (const req of run?.requirements?.items ?? []) {
    const a = snapshot.assessments?.find((a) => a.requirementId === req.requirementId);
    const row = node("article", "", "record");
    row.append(node("strong", `${req.requirementId} · ${req.required ? "필수" : "선택"} · ${a?.verdict ?? "아직 판정 없음"}`), node("p", req.statement), node("p", a?.reason ?? req.acceptanceCriteria));
    if (a?.missingInformation) row.append(node("p", `부족한 정보: ${a.missingInformation}`, "muted"));
    evidenceLinks(row, a?.evidenceRefs);
    for (const suggestion of run?.reviews?.at(-1)?.report?.suggestions ?? []) {
      if (suggestion.requirementId === req.requirementId) row.append(node("p", `선택 개선 제안: ${suggestion.description}`, "muted"));
    }
    assessments.append(row);
  }
  if (!assessments.children.length) assessments.append(node("p", run?.requirements
    ? "아직 요구사항별 감사 결과가 없습니다." : "요구사항 기록이 없습니다. 확인 가능한 대화와 상태 변경은 ‘진행 기록’에서 확인하세요.", "muted"));
  for (const f of snapshot?.findings ?? []) {
    const row = node("article", "", "record");
    row.append(node("strong", `${f.findingId} · ${f.status}${f.status === "RESOLVED" && f.verifiedCandidateId !== run.candidate?.candidateId ? " · 새 후보 재검증 필요" : ""}`), node("p", f.problem), node("p", `해결 조건: ${f.resolutionCriteria}`));
    evidenceLinks(row, f.evidenceRefs);
    const history = node("details", ""); history.append(node("summary", "처리 이력"));
    history.open = openFindings.has(f.findingId);
    history.addEventListener("toggle", () => { if (history.open) openFindings.add(f.findingId); else openFindings.delete(f.findingId); });
    for (const h of f.history) history.append(node("p", `${time(h.at)} · ${h.status} · ${h.reason} · ${h.candidateId}`));
    row.append(history); findings.append(row);
  }
  if (!findings.children.length) findings.append(node("p", run?.requirements
    ? "등록된 감사 지적이 없습니다." : "요구사항별 감사 지적 기록이 없습니다.", "muted"));
  for (const e of snapshot?.evidence ?? []) {
    const row = node("article", "", "record");
    row.append(node("strong", `${e.kind} · ${e.producer}${e.valid === false ? " · 후보 증거로 무효" : ""}`), node("p", `${e.candidateId} · ${time(e.createdAt)}`, "muted"), node("p", JSON.stringify(e.result)));
    evidenceLinks(row, [e.evidenceId]); evidence.append(row);
  }
  text("candidateDetails", JSON.stringify({ project:run?.projectRef, requirements:run?.requirements, worker:run?.worker, workerTurns:run?.workerTurns, candidate:run?.candidate, latestReview:run?.reviews?.at(-1), missingInformation:run?.missingInformation, application:run?.application, recovery:run?.recovery }, null, 2));
}
function renderLog() {
  const log = $("eventLog"); log.replaceChildren();
  const records = [...(snapshot?.events ?? []).map((e) => ({ at:e.createdAt, title:e.type, content:JSON.stringify(e.payload) })),
    ...(snapshot?.messages ?? []).map((m) => ({ at:m.createdAt, title:m.fromActor ?? "CONTROLLER", content:m.content })),
    ...externalEventRecords(snapshot?.run, snapshot?.evidence ?? [])].sort((a,b) => String(a.at).localeCompare(String(b.at)));
  for (const record of records) {
    const row = node("article", "", "record"); row.append(node("time", time(record.at)), node("p", record.title), node("pre", record.content)); log.append(row);
  }
  if (!records.length) log.append(node("p", "아직 수신한 실행 기록이 없습니다.", "muted"));
}
function render() {
  const run = snapshot?.run, preflight = snapshot?.preflight, caps = capabilities();
  if (!$("proposalWaiting")) {
    const waiting = node("p", "ChatGPT 응답을 기다리고 있습니다", "proposal-waiting");
    const spinner = node("span", "", "spinner"), dots = node("span", "...", "waiting-dots");
    waiting.append(spinner, dots);
    waiting.id = "proposalWaiting"; waiting.setAttribute("role", "status"); waiting.setAttribute("aria-live", "polite");
    $("startForm").append(waiting);
  }
  $("projectForm").prepend($("proposalWaiting"));
  $("proposalWaiting").hidden = workflow.stage !== "PREPARE" || !["INITIALIZING", "WAITING_WEB_RESPONSE"].includes(workflow.state);
  proposalControls();
  renderPreparationPersistence();
  const readiness = JSON.stringify([connected, preflight, [...caps], snapshot?.runs]);
  if (readiness !== readinessSignature) { lastCommandError = ""; readinessSignature = readiness; }
  const checks = preflight?.checks;
  health("apiHealth", "서버", connected ? "ok" : "unknown", connected ? "정상" : "확인 필요");
  health("sessionHealth", "대시보드", connected && token ? "ok" : "unknown", connected && token ? "인증됨" : "확인 필요");
  const runtimeUnavailable = snapshot?.runtimeAvailability?.ready === false;
  const workerStatus = runtimeUnavailable
    ? { state:"warn", detail:"런타임 준비 필요" }
    : workerRuntimeStatus(snapshot?.workerRuntime);
  health("engineHealth", "Worker", workerStatus.state, workerStatus.detail);
  health("channelHealth", "확장", !connected || typeof checks?.extensionAuthenticated !== "boolean" ? "unknown" : checks.extensionAuthenticated ? "ok" : "warn",
    !connected || typeof checks?.extensionAuthenticated !== "boolean" ? "확인 전" : checks.extensionAuthenticated ? "연결됨" : "연결 대기");
  signal("serverSignal", "서버", connected ? "ok" : "error", connected ? "연결됨" : "상태 확인 필요");
  signal("cliSignal", "CLI", connected ? workerStatus.state : "warn",
    !connected ? "상태 확인 필요" : workerStatus.detail);
  const webAuthenticated = checks?.extensionAuthenticated === true;
  signal("webSignal", "웹", connected ? (webAuthenticated ? "ok" : "warn") : "warn",
    !connected ? "상태 확인 필요" : webAuthenticated ? "연결됨" : "연결 대기");
  const lastBinding = preflight?.lastWebBinding;
  signal("webBindingSignal", "대화 탭", !connected || !webAuthenticated || !["BOUND", "ROOT_READY"].includes(lastBinding?.bindingStatus) ? "warn" : "ok",
    !connected ? "상태 확인 필요" : !webAuthenticated ? "확장 연결 대기"
      : lastBinding ? `연결됨 · ${lastBinding.bindingStatus}` : "연결 필요");
  signal("refreshSignal", "런", connected && lastConfirmed ? "ok" : "error",
    connected ? `갱신됨 ${time(lastConfirmed)}` : `마지막 확인 · ${lastConfirmed ? time(lastConfirmed) : "없음"}`);
  const unfinished = snapshot?.runs?.find((r) => !terminal.has(r.phase));
  const busy = Boolean(unfinished);
  syncReviewerProviderControls();
  const reviewerProvidersLocked = workflow.stage !== "START" || operations.preparationStart !== "IDLE" || !connected || busy;
  $("judgeReviewerProvider").disabled = reviewerProvidersLocked;
  $("criticReviewerProvider").disabled = reviewerProvidersLocked;
  $("planRun").disabled = (operations.runCommand !== "IDLE") || !connected || busy || (operations.webTurn !== "IDLE");
  $("newRun").disabled = (operations.runCommand !== "IDLE") || busy; text("newRunReason", busy ? "진행 중인 작업을 먼저 확인하세요." : "");
  $("showUnfinishedRun").hidden = !busy;
  $("showUnfinishedRun").disabled = (operations.runCommand !== "IDLE") || !connected;
  $("historySearch").value = historyQuery;
  $("historyStatusFilter").value = ["ALL", "ACTIVE", "ATTENTION", "CLOSED", "ARCHIVED"].includes(historyScope) ? historyScope : "ALL";
  historyScope = $("historyStatusFilter").value;
  const allRuns = snapshot?.runs ?? [];
  const activeHistoryRuns = allRuns.filter((item) => !item.archivedAt);
  const archivedHistoryRuns = allRuns.filter((item) => item.archivedAt);
  const filteredRuns = filterRunsForHistory(allRuns, { query:historyQuery, scope:historyScope });
  const filtersActive = Boolean(historyQuery.trim()) || historyScope !== "ALL";
  $("historyClearFilters").hidden = !filtersActive;
  const historyBaseCount = historyScope === "ARCHIVED" ? archivedHistoryRuns.length : activeHistoryRuns.length;
  text("historyFilterSummary", filtersActive ? `${historyBaseCount}건 중 ${filteredRuns.length}건 표시`
    : `전체 ${activeHistoryRuns.length}건 · 보관 ${archivedHistoryRuns.length}건`);
  const list = $("runList"); list.replaceChildren();
  const groups = groupRunsByProject(activeHistoryRuns);
  for (const record of snapshot?.projectConversations ?? []) {
    if (record.targetRoot && !groups.some((item) => item.targetRoot === record.targetRoot)) groups.push({ targetRoot:record.targetRoot, runs:[] });
  }
  if (projectViewRoot && !groups.some((item) => item.targetRoot === projectViewRoot)) {
    projectViewRoot = null; sessionStorage.setItem("bridge.project.view", "");
  }
  const historyGroups = groupRunsByProject(filteredRuns);
  if (historyScope === "ALL") {
    const needle = historyQuery.trim().toLowerCase();
    for (const record of snapshot?.projectConversations ?? []) {
      if (!record.targetRoot || historyGroups.some((item) => item.targetRoot === record.targetRoot)) continue;
      const target = record.targetRoot.toLowerCase();
      const name = folderName(record.targetRoot).toLowerCase();
      if (!needle || target.includes(needle) || name.includes(needle)) historyGroups.push({ targetRoot:record.targetRoot, runs:[] });
    }
  }
  $("historyEmpty").hidden = historyGroups.length > 0;
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
      const button = node("button", r.objective, `run-item${workflow.stage !== "START" && r.runId === run?.runId ? " active" : ""}`);
      button.append(node("small", labels[r.phase] ?? r.phase, `health ${runAppearance(r.phase)}`));
      button.addEventListener("click", () => openRun(r.runId)); section.append(button);
    }
    list.append(section);
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
  text("followUpSource", followUpSource ? `이어서 작업: ${followUpSource.objective} · 새 부탁과 요구사항은 다시 승인합니다.${$("startRoot").value !== followUpSource.targetRoot ? " 폴더가 달라졌습니다. 원래 프로젝트를 선택하세요." : ""}` : "");
  if (workflow.stage !== "START") projectConversationRoot = null;
  if (workflow.stage === "START") {
    const root = $("startRoot").value.trim();
    const saved = snapshot?.projectConversations?.find((item) => item.targetRoot === root && item.conversationId);
    if (projectConversationRoot !== root) {
      const previous = snapshot?.projectConversations?.find((item) => item.targetRoot === projectConversationRoot);
      if ($("reuseProjectConversation").checked || previous?.conversationUrl === $("conversationUrl").value) $("conversationUrl").value = "";
      projectConversationRoot = root;
      $("reuseProjectConversation").checked = Boolean(saved);
      if (saved) $("conversationUrl").value = saved.conversationUrl;
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
  renderInitialRequest(workflow, preparation, $, text, document, capabilities().has("preparation.cancel"));
  $("projectPanel").hidden = Boolean(overviewGroup) || !preparing;
  $("runPanel").hidden = Boolean(overviewGroup) || !["WORK", "RESULT"].includes(workflow.stage) || !run;
  actionState("planRun", !webConnected() || !caps.has("preparation.start") || operations.preparationStart !== "IDLE" || operations.folderPicker !== "IDLE",
    runtimeUnavailable ? "실행 런타임 준비가 필요합니다."
      : !webConnected() ? "브릿지 확장 인증이 확인되지 않아 전송할 수 없습니다. ChatGPT 탭은 연결 후 자동으로 엽니다."
        : "현재 요청이나 작업이 끝나야 준비 대화를 시작할 수 있습니다.",
    "ChatGPT 탭이 없으면 새 탭을 열고 첫 부탁을 전송합니다.");
  if (workflow.stage === "START") {
    if (workflow.state === "CONNECTING_WEB") {
      text("startReason", "ChatGPT 대화 탭에 연결 중입니다. 아직 메시지를 전송하지 않았습니다.");
    } else if (preparation?.state === "WEB_BLOCKED" && preparation?.error) {
      text("startReason", `이전 준비 ${preparation.preparationId}의 전송 실패 기록입니다. 메시지는 전송되지 않았습니다. 새 작업의 연결 상태와는 별개입니다. `
        + preparation.error.code + ": " + preparation.error.message
        + (preparation.error.details ? "\n실패 진단: " + JSON.stringify(preparation.error.details) : ""));
    }
  }
  $("chooseFolder").disabled = !connected || operations.folderPicker !== "IDLE" || preparation?.lifecycle === "ACTIVE";
  $("newRun").disabled = !connected || busy || operations.preparationStart !== "IDLE"
    || operations.runCommand !== "IDLE" || ["PREPARE", "WORK"].includes(workflow.stage)
    || preparation?.lifecycle === "ACTIVE";
  text("newRunReason", !connected ? "최신 상태 확인 후 새 작업을 시작할 수 있습니다."
    : workflow.stage === "PREPARE" ? "현재 준비를 유지합니다. 종료하려면 ‘준비 취소’를 선택하세요."
    : preparation?.lifecycle === "ACTIVE" ? "현재 요청의 응답 또는 처리 결과를 확인 중입니다."
    : busy ? "진행 중인 작업을 먼저 종료하세요."
    : "새 작업의 폴더와 요청을 입력할 수 있습니다. 준비 대화 시작에는 웹 연결이 필요합니다.");
  if (overviewGroup) renderProjectOverview({ group:overviewGroup, busyRun:unfinished, allRuns, $, text, node, folderName, labels, runAppearance, terminal, time, connected, newRunDisabled:$("newRun").disabled, openRun });
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
  const discussionBinding = (run?.conversationBindings ?? []).find((item) =>
    item.role === discussionRole && item.conversationUrl && item.conversationId && item.activeDeliveryId === null);
  const discussionText = $("reviewDiscussionText").value.trim();
  $("reviewDiscussionPanel").hidden = !discussionActive;
  $("sendReviewDiscussion").disabled = !discussionActive || !connected || operations.runCommand !== "IDLE"
    || !caps.has("code.review.discuss") || !discussionBinding || !discussionText || Boolean(unresolvedDiscussion);
  $("reviewDiscussionRecovery").hidden = !unresolvedDiscussion;
  text("reviewDiscussionRecoveryDetail", unresolvedDiscussion
    ? `${unresolvedDiscussion.role} · ${unresolvedDiscussion.discussionId} · 전송 결과 미확인. 자동 재전송하지 않습니다.`
    : "");
  $("discardReviewDiscussion").disabled = !unresolvedDiscussion || !caps.has("code.review.discuss.discard")
    || operations.runCommand !== "IDLE" || !$("reviewDiscussionUnresolved").checked
    || !$("reviewDiscussionNoResend").checked || $("reviewDiscussionDiscardReason").value.trim().length < 3;
  if (!discussionActive) {
    text("reviewDiscussionStatus", "");
  } else if (unresolvedDiscussion) {
    text("reviewDiscussionStatus", "이전 감사자 대화 전송 결과가 미확인이라 새 질문을 보내지 않습니다. 아래에서 결과 미확인과 자동 재전송 금지를 확인한 뒤 폐기할 수 있습니다.");
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
        button.disabled = !connected || operations.runCommand !== "IDLE" || !caps.has("code.review.rebind");
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
  $("addOperatorNote").disabled = !run || !connected || operations.runCommand !== "IDLE"
    || !caps.has("run.note.add") || !noteText;
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
  const interventionTurnId = snapshot?.workerRuntime?.turnId ?? run?.workerTurnId ?? null;
  const scopeChange = interventionKind === "REQUIREMENTS_CHANGE";
  $("workerInterventionPanel").hidden = !interventionActive;
  $("sendWorkerIntervention").disabled = !interventionActive || !connected || operations.runCommand !== "IDLE"
    || !caps.has("code.worker.intervene") || !interventionTurnId || !interventionText || scopeChange;
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
  $("submitDecision").disabled = !connected || operations.runCommand !== "IDLE" || !caps.has("code.decision.reply")
    || !decisionQuestions.length || [...$("decisionQuestions").querySelectorAll("textarea")].some((item) => !item.value.trim());
  $("reconcileRun").disabled = !connected || operations.runCommand !== "IDLE" || !caps.has("run.reconcile");
  $("retryRun").textContent = "Worker 다시 실행";
  if (run?.phase === "RECOVERY_REQUIRED") {
    const recoveryConfirmed = $("recoveryConfirm").checked;
    const abandonBlocked = (operations.runCommand !== "IDLE") || !caps.has("run.abandon") || !recoveryConfirmed;
    const abandonReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리가 끝나야 실행을 폐기할 수 있습니다."
      : !connected ? "최신 상태 확인 후 실행을 폐기할 수 있습니다."
      : !caps.has("run.abandon") ? "현재 런이 복구 폐기 명령을 받을 수 없는 상태입니다. 상태 갱신 후에도 같으면 실행 기록의 오류·복구 상태를 확인하세요."
      : !recoveryConfirmed ? "외부 작업 종료·대상 저장소 상태 확인·실행 폐기를 한 번에 확인하세요."
      : "확인 기록 후 이 실행을 폐기할 수 있습니다.";
    actionState("abandonRun", abandonBlocked, abandonReason, abandonReason);
    const retryReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리가 끝나야 다시 시도할 수 있습니다."
      : caps.has("run.retry") ? "실패한 격리 작업 공간을 정리하고 같은 요구사항으로 Worker를 다시 실행합니다."
      : "변경사항이 고정되기 전 Worker 실패가 안전하게 확인된 경우에만 Worker를 다시 실행할 수 있습니다.";
    actionState("retryRun", (operations.runCommand !== "IDLE") || !caps.has("run.retry"), retryReason, retryReason);
  } else if (run?.phase === "HOLD" && caps.has("code.review.retry")) {
    $("abandonRun").disabled = true;
    $("abandonRun").title = "";
    $("retryRun").textContent = "독립 검토 다시 시작";
    const needsReviewerTabSelection = caps.has("code.review.rebind");
    const retryReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리가 끝나야 감사를 다시 시도할 수 있습니다."
      : needsReviewerTabSelection ? "감사자 대화 탭이 여러 개입니다. 먼저 위 복구 영역에서 사용할 탭을 선택하세요."
      : !webConnected() ? "브라우저 확장과 해당 감사자의 대화 연결을 복구해야 현재 변경사항의 독립 검토를 다시 시작할 수 있습니다."
      : "Worker를 다시 실행하지 않고 현재 후보를 같은 요구사항으로 다시 감사합니다. REWORK 판정이면 기존 수정 루프를 이어갑니다.";
    actionState("retryRun", (operations.runCommand !== "IDLE") || needsReviewerTabSelection || !webConnected(), retryReason, retryReason);
  } else {
    $("abandonRun").disabled = true;
    $("abandonRun").title = "";
    $("retryRun").disabled = true;
    $("retryRun").title = "";
  }
  for (const [id, capability] of [["stopRun", "run.stop"], ["applyCode", "code.apply"], ["exportEvidence", "evidence.export"], ["deleteRun", "run.delete"]]) {
    $(id).disabled = !run || operations.runCommand !== "IDLE" || !caps.has(capability);
  }
  const archiveCapability = run?.archivedAt ? "run.unarchive" : "run.archive";
  $("archiveRun").textContent = run?.archivedAt ? "보관 해제" : "기록 보관";
  $("archiveRun").disabled = !run || operations.runCommand !== "IDLE" || !caps.has(archiveCapability);
  if (!run) return;
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
  text("runTime", `접수 ${time(run.createdAt)} · 변경 ${time(run.updatedAt)}${run.archivedAt ? ` · 보관 ${time(run.archivedAt)}` : ""}`);
  const workerEvidence = run.worker?.provenance;
  text("workerProvenance", workerEvidence ? `Worker 출처: 설정 ${workerEvidence.requested.provider ?? "미지정"} / 실행 보고 ${workerEvidence.reported.provider ?? "미확인"} · 모델 보고 ${workerEvidence.reported.model ?? "미확인"}` : "Worker 실행 출처: 현재 기록에서 확인되지 않음");
  let reviewerRuntimeStatus = $("reviewerRuntimeStatus");
  if (!reviewerRuntimeStatus) {
    reviewerRuntimeStatus = node("p", "", "muted");
    reviewerRuntimeStatus.id = "reviewerRuntimeStatus";
    $("workerProvenance")?.after(reviewerRuntimeStatus);
  }
  text("reviewerRuntimeStatus",
    reviewerRuntimeTechnicalSummary(snapshot?.reviewerRuntimes, snapshot?.reviewerRuntime));
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
  actionState("stopRun", (operations.runCommand !== "IDLE") || !caps.has("run.stop"), stopReason, stopReason);
  text("stopReason", stopReason);

  const applyReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리 중입니다."
    : !connected ? "최신 상태 확인 후 적용할 수 있습니다."
    : caps.has("code.apply") ? "검토 통과 변경사항을 프로젝트에 적용합니다."
    : run.phase === "AWAITING_APPLY" ? "현재 적용할 수 없습니다. 상태를 확인하세요."
    : "검토 통과 후 적용할 수 있습니다.";
  actionState("applyCode", (operations.runCommand !== "IDLE") || !caps.has("code.apply"), applyReason, applyReason);

  const exportReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리 중입니다."
    : !connected ? "최신 상태 확인 후 다운로드할 수 있습니다."
    : !caps.has("evidence.export") ? "다운로드할 감사 기록이 없습니다."
    : "감사 기록을 다운로드합니다.";
  actionState("exportEvidence", (operations.runCommand !== "IDLE") || !caps.has("evidence.export"), exportReason, exportReason);
  text("commandReason", "");
  syncRunInformationArchitecture(run);
  const signature = JSON.stringify([run, snapshot?.events, snapshot?.messages, snapshot?.assessments, snapshot?.findings, snapshot?.evidence, connected, (operations.runCommand !== "IDLE")]);
  if (renderedRecords !== signature) { renderedRecords = signature; renderConversation(run, $("conversationTimeline"), node, time); renderAudit(); renderLog(); }
}
async function command(type, payload = {}) {
  if (operations.runCommand !== "IDLE" || !capabilities().has(type)) return;
  const run = snapshot?.run, target = run?.runId;
  const body = { type, requestId:crypto.randomUUID(), payload:{ ...payload, runId:workflow.runId, expectedVersion:workflow.runVersion } };
  operations.runCommand = "RUNNING"; lastCommandError = ""; render();
  try {
    const result = await request("/api/commands", { method:"POST", body:JSON.stringify(body) });
    if (snapshot?.run?.runId === target) {
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
    }
    if (type === "run.delete") { selected = null; requestedView = "start"; }
    return result.payload;
  } catch (error) {
    if (error.code === "UNKNOWN_RESULT") { operations.runCommand = "UNKNOWN_RESULT"; unknownRequests.set("runCommand", body.requestId); }
    lastCommandError = userFacingError(error, "요청을 처리하지 못했습니다. 최신 실행 기록과 연결 상태를 확인하세요.");
    text("commandResult", lastCommandError);
  } finally { if (operations.runCommand !== "UNKNOWN_RESULT") operations.runCommand = "IDLE"; await refresh(); }
}
async function openEvidence(id, startLine = 1) {
  const target = snapshot?.run?.runId;
  const result = await command("evidence.get", { evidenceId:id, startLine, endLine:startLine + 199 });
  if (!result || snapshot?.run?.runId !== target) return;
  evidencePage = { id, next:result.endLine + 1, target };
  text("evidenceTitle", `${result.kind} · ${id}`); text("evidenceContent", result.content);
  text("evidenceRange", `${result.startLine}–${result.endLine} / ${result.totalLines}줄${result.omittedAfter ? " · 다음 구간 있음" : ""}`);
  actionState("nextEvidence", !result.omittedAfter,
    "이 근거의 마지막 구간입니다. 더 불러올 내용이 없습니다.",
    "다음 근거 구간을 불러옵니다.");
  if (!$("evidenceDialog").open) $("evidenceDialog").showModal();
}

function proposalControls() {
  const caps = capabilities();
  $("proposeRequirements").hidden = true;
  actionState("reviseRequirements", !webConnected() || !caps.has("preparation.reply") || operations.webTurn !== "IDLE",
    !webConnected() ? "브릿지 확장 연결이 확인돼야 답변을 전송할 수 있습니다." : "현재 전송이나 복구 확인이 끝나야 답변을 보낼 수 있습니다.",
    "같은 ChatGPT 대화에 답변을 전송합니다.");
  const approvalDisabled = !caps.has("preparation.approve") || operations.approval !== "IDLE";
  actionState("saveProject", approvalDisabled,
    !caps.has("preparation.approve")
      ? agreement?.status === "READY"
        ? "응답 정리 또는 연결 확인이 끝나야 작업을 시작할 수 있습니다."
        : "확인 질문을 모두 정리해 요구사항 검토 단계가 되어야 작업을 시작할 수 있습니다."
      : "작업 시작 요청을 처리 중입니다.",
    "현재 요구사항을 승인하고 작업을 시작합니다.");
  const cancelDisabled = !caps.has("preparation.cancel") || operations.preparationStart !== "IDLE";
  actionState("closeProject", cancelDisabled,
    !connected ? "최신 상태 확인 후 준비를 종료할 수 있습니다."
      : !caps.has("preparation.cancel") ? "현재 응답 또는 전송 처리가 끝난 뒤 준비를 취소할 수 있습니다."
        : "이전 준비 작업을 처리 중입니다.",
    "현재 준비를 종료하고 기록은 보존합니다.");
  const activeDelivery = preparation?.deliveries?.find((item) => item.deliveryId === preparation?.webSession?.activeDeliveryId);
  const discardVisible = Boolean(activeDelivery && (
    ["RECOVERY_REQUIRED", "AMBIGUOUS", "WEB_BLOCKED"].includes(preparation.state)
    || ["DELIVERY_RECOVERY_UNCONFIRMED", "REBIND_DURING_ACTIVE_DELIVERY"].includes(preparation.error?.code)
  ));
  $("discardPanel").hidden = !discardVisible;
  text("discardDelivery", discardVisible ? `준비 ID: ${preparation.preparationId} · 전송 ID: ${activeDelivery.deliveryId} · 세션: ${activeDelivery.sessionId} · 대화: ${activeDelivery.conversationId ?? preparation.webSession?.conversationUrl ?? "확인되지 않음"}` : "");
  $("discardDeliveryButton").disabled = !discardVisible || !caps.has("preparation.discard") || operations.preparationStart !== "IDLE"
    || !$("discardUnresolved").checked || !$("discardNoResend").checked || $("discardReason").value.trim().length < 3;
  for (const button of document.querySelectorAll("[data-web-command]")) button.disabled = !caps.has(button.dataset.webCommand) || operations.webTurn !== "IDLE";
}
function renderPreparation() {
  if (!preparation) { preparationSignature = ""; return; }
  const signature = JSON.stringify(preparation);
  if (signature === preparationSignature) return;
  preparationSignature = signature;
  $("planningObjective").value = preparation.objective;
  $("planningUrl").value = preparation.webSession?.conversationUrl ?? preparation.conversationUrl ?? "";
  $("planningFollowUp").hidden = !preparation.followUp;
  text("planningFollowUp", preparation.followUp ? `이전 적용 작업: ${preparation.followUp.objective} · 요구사항은 이번에 다시 승인합니다.` : "");
  $("projectRoot").value = preparation.targetRoot;
  const summary = $("proposalSummary"); summary.replaceChildren();
  const heading = agreement?.status === "READY" ? "합의된 작업 범위" : "현재 정리된 범위";
  summary.append(node("h2", heading), node("p", agreement?.summary ?? "요구사항을 정리하고 있습니다."));
  if ((agreement?.unresolvedQuestions ?? []).length) {
    summary.append(node("p", "추가 확인 필요", "eyebrow"));
    for (const question of agreement.unresolvedQuestions) summary.append(node("p", question));
  }
  const discussion = node("details", "", "discussion-fold");
  discussion.append(node("summary", "이전 준비 대화"));
  const discussionBody = node("div", "");
  for (const turn of preparation.discussion ?? []) {
    const row = node("article", "", "record");
    row.append(node("strong", turn.actor === "USER" ? "사용자" : "웹 설계자"), node("pre", turn.content));
    discussionBody.append(row);
  }
  discussion.append(discussionBody);
  summary.append(discussion);
  $("projectRequirements").replaceChildren();
  for (const item of agreement?.requirements ?? []) {
    const row = node("article", "", "record");
    row.append(node("p", item.statement), node("p", item.acceptanceCriteria));
    $("projectRequirements").append(row);
  }
  text("reviewerProviderSummary", `감사 provider · Judge ${preparation.reviewers?.JUDGE?.provider ?? "CHATGPT_WEB"} · Critic ${preparation.reviewers?.CRITIC?.provider ?? "CHATGPT_WEB"} · 준비 대화는 ChatGPT`);
  const session = preparation.webSession;
  const diagnostic = preparation.diagnostics ?? session?.diagnostics ?? {};
  const recovery = node("details", "", "session-recovery");
  recovery.append(node("summary", "응답·전송 상태"));
  const rootReady = session?.bindingState === "ROOT_READY" && Number.isSafeInteger(session?.tabId)
    && typeof session?.documentId === "string" && session.documentId && session?.frameId === 0;
  const exactBound = session?.bindingState === "BOUND" && diagnostic.exactConversation === true;
  const bindingConfirmed = exactBound || rootReady;
  const tabId = diagnostic.tabId ?? session?.tabId ?? "확인되지 않음";
  const identity = diagnostic.extensionIdentity ?? session?.extensionIdentity ?? "확인되지 않음";
  recovery.append(node("p",
    bindingConfirmed
      ? rootReady
        ? `연결 성공: ChatGPT tab ${tabId} · ROOT_READY · 새 대화 입력 document 확인됨`
        : `연결 성공: ChatGPT tab ${tabId} · BOUND · identity: ${identity} · 정확한 conversation 일치`
      : `연결 비활성화: ChatGPT tab ${tabId} · ${session?.bindingState ?? "UNBOUND"} · identity: ${identity} · BOUND 및 정확한 conversation 일치가 확인되지 않음`,
    bindingConfirmed ? "recovery-guidance ok" : "recovery-guidance error"));
  const tabCandidates = preparation.error?.code === "WEB_TAB_SELECTION_REQUIRED"
    && Array.isArray(preparation.error?.details?.candidates)
    ? preparation.error.details.candidates
    : [];
  if (tabCandidates.length) {
    const chooser = node("div", "", "flow-band");
    chooser.append(
      node("h2", "사용할 ChatGPT 탭 선택"),
      node("p", "메시지는 아직 전송되지 않았습니다. 아래 후보 중 이 작업에 사용할 탭을 선택하면 정확한 탭으로 다시 연결한 뒤 최초 전송을 계속합니다."),
    );
    for (const candidate of tabCandidates) {
      const row = node("div", "", "record");
      row.append(node("p", `tab ${candidate.tabId}${candidate.windowId === null ? "" : ` · window ${candidate.windowId}`} · ${candidate.url}`));
      const button = node("button", `tab ${candidate.tabId} 사용`);
      button.type = "button"; button.dataset.webCommand = "web.rebind";
      const disabled = !capabilities().has("web.rebind") || operations.webTurn !== "IDLE";
      button.disabled = disabled; buttonReason(button, disabled ? disabledWebReason("web.rebind") : "");
      button.addEventListener("click", () => webSessionCommand("web.rebind", { selectedTabId:candidate.tabId }));
      row.append(button); chooser.append(row);
    }
    recovery.append(chooser);
  }
  const deliveries = preparation.deliveries ?? [];
  const displayedDelivery = deliveries.find(item => item.deliveryId === session?.activeDeliveryId) ?? deliveries.at(-1);
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
    const confidenceReason = displayedDelivery.response?.confidenceReason
      ?? displayedDelivery.response?.evidence?.confidenceReason
      ?? null;
    const packet = displayedDelivery.response?.packet;
    if (packet?.type === "REQUIREMENTS_PROPOSAL") {
      const questionCount = (packet.questions ?? []).length;
      const requirementCount = (packet.items ?? []).length;
      recovery.append(node("p", `내용 해석: 요구사항 ${requirementCount}개와 확인 질문 ${questionCount}개를 인지함`, "recovery-guidance ok"));
      recovery.append(node("p", `packet 양식: 정상 · REQUIREMENTS_PROPOSAL / 확인 질문 ${questionCount}개`, "diagnostic-row health ok"));
      recovery.append(node("p", questionCount === 0
        ? "요구사항 상태: 요구사항 합의 완료 · 승인 가능"
        : "요구사항 상태: 추가 합의 필요 · 확인 질문에 답변 필요",
      questionCount === 0 ? "diagnostic-row health ok" : "diagnostic-row health warn"));
    } else if (packet) {
      recovery.append(node("p", `내용 해석: packet은 확인됨 · ${packet.type ?? "알 수 없는 유형"}`, "diagnostic-row health warn"));
      recovery.append(node("p", "packet 양식: 현재 준비 단계에서 기대한 REQUIREMENTS_PROPOSAL이 아님", "diagnostic-row health error"));
    } else if (displayedDelivery.response && !packet) {
      recovery.append(node("p", "내용 해석: 확인 불가 · 응답 packet을 해석하지 못함", "recovery-guidance error"));
      const formatError = displayedDelivery.validation?.formatError;
      recovery.append(node("p", formatError
        ? `packet 양식: ${formatError.code} · ${formatError.message}`
        : "packet 양식: 부족하거나 파싱되지 않음", "diagnostic-row health error"));
    }
    if (typeof displayedDelivery.response?.rawText === "string") {
      const raw = node("details", "", "session-raw-response");
      raw.append(node("summary", "raw 응답"), node("pre", displayedDelivery.response.rawText));
      recovery.append(raw);
    }
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
      const detail = node("details", "");
      detail.append(node("summary", "응답 확인 상세"), node("pre", JSON.stringify(displayedFailures, null, 2)));
      recovery.append(detail);
    }
    const trace = displayedDelivery.trace ?? displayedDelivery.response?.trace ?? null;
    const traceDetails = {
      commandRequestId: displayedDelivery.commandRequestId ?? null,
      preparationId: displayedDelivery.preparationId ?? preparation.preparationId,
      sessionId: displayedDelivery.sessionId ?? session?.sessionId ?? null,
      deliveryId: displayedDelivery.deliveryId,
      requestId: trace?.requestId ?? null,
      bindingId: trace?.bindingId ?? null,
      tabId: trace?.tabId ?? null,
      documentId: trace?.documentId ?? null,
      frameId: trace?.frameId ?? null,
      actionId: trace?.actionId ?? null,
      result: trace?.result ?? null,
    };
    const detail = node("details", "");
    detail.append(node("summary", "요청→브라우저 성공 trace"), node("pre", JSON.stringify(traceDetails, null, 2)));
    recovery.append(detail);
  }
  recovery.append(node("h2", "대화 · 전송 상태"));
  const bool = (value) => value === true ? "예" : value === false ? "아니오" : "확인되지 않음";
  for (const [label, value] of [
    ["작업", preparation.objective], ["준비 ID", preparation.preparationId],
    ["대화", session?.conversationUrl], ["대화 ID", session?.conversationId],
    ["sessionId", session?.sessionId], ["deliveryId", displayedDelivery?.deliveryId],
    ["연결 상태", session?.bindingState], ["탭 도달 가능", bool(diagnostic.pageReachable)],
    ["정확한 conversation", bool(diagnostic.exactConversation)],
    ["pageBusy", bool(diagnostic.pageBusy)], ["generating", bool(diagnostic.generating)],
    ["extensionBusy", bool(diagnostic.extensionBusy)], ["pageStatus", diagnostic.pageStatus],
    ["canFocus", bool(diagnostic.canFocus)], ["canStop", bool(diagnostic.canStop)],
    ["해당 전송 종료 확인", bool(diagnostic.canRecover)],
  ]) recovery.append(node("p", label + ": " + (value ?? "확인되지 않음")));
  for (const row of recovery.querySelectorAll("p")) {
    const value = row.textContent.split(": ").at(-1);
    if (value === "RECOVERY_REQUIRED") row.classList.add("health", "error", "diagnostic-row");
    else if (["READY", "예", "아니오"].includes(value)) row.classList.add("health", "ok", "diagnostic-row");
    else if (value === "확인되지 않음") row.classList.add("health", "warn", "diagnostic-row");
  }
  const webActionReason = (action) => {
    if (!connected) return "최신 상태를 확인할 수 없습니다.";
    if (snapshot?.preflight?.checks?.extensionAuthenticated !== true) return "브라우저 확장 연결이 필요합니다.";
    if (operations.webTurn !== "IDLE") return "다른 웹 요청을 처리 중입니다.";
    if (!capabilities().has(action)) return "현재 서버 상태에서는 이 작업을 사용할 수 없습니다.";
    return "";
  };
  for (const [label, action] of [["대화 열기", "web.focus"], ["상태 확인", "web.inspect"], ["생성 종료", "web.stop"], ["응답 다시 확인", "web.reconcile"]]) {
    const button = node("button", action === "web.reconcile" && displayedDelivery?.processingState === "ACK_PENDING" ? "수신 확인 다시 처리" : label); button.type = "button";
    button.dataset.webCommand = action;
    const disabled = !capabilities().has(action) || operations.webTurn !== "IDLE";
    button.disabled = disabled;
    buttonReason(button, disabled ? disabledWebReason(action) : "");
    button.addEventListener("click", () => webSessionCommand(action)); recovery.append(button);
  }
  const diagnostics = $("preparationDiagnosticsBody");
  diagnostics.replaceChildren(recovery);
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
  text("proposalStatus", error ? "" : progress[workflow.state] ?? workflow.state);
}
async function preparationMutation(operation, capability, url, payload = {}) {
  if (operations[operation] !== "IDLE" || !capabilities().has(capability)) return false;
  if (["preparation.start", "preparation.reply"].includes(capability) && !webConnected()) return false;
  const requestId = crypto.randomUUID();
  operations[operation] = "RUNNING"; render();
  try {
    await request(url, { method: "POST", body: JSON.stringify({ ...payload, requestId }) });
    text("projectStatus", "요청을 접수했습니다. 서버 상태를 확인합니다.");
    return true;
  } catch (error) {
    if (error.code === "UNKNOWN_RESULT") { operations[operation] = "UNKNOWN_RESULT"; unknownRequests.set(operation, requestId); }
    const message = userFacingError(error);
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
  await preparationMutation("webTurn", commandType, "/api/preparations/web", {
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
  const autoApprove = $("autoApprovePreparation").checked;
  await preparationMutation("preparationStart", "preparation.start", "/api/preparations",
    { objective, targetRoot, conversationUrl, autoApproveOnReady: autoApprove,
      reviewers:{
        JUDGE:{ provider:$("judgeReviewerProvider").value },
        CRITIC:{ provider:$("criticReviewerProvider").value },
      },
      ...(followUpSource ? { followUpRunId:followUpSource.runId } : {}),
      reuseProjectConversation:$("reuseProjectConversation").checked && !$("projectConversationPanel").hidden });
}
$("startForm").addEventListener("submit", (event) => { event.preventDefault(); return beginPreparation(); });
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
  const content = $("proposalFeedback").value;
  if (!content.trim()) { text("proposalStatus", "답변 또는 수정 요청을 입력하세요."); return; }
  if (await preparationMutation("webTurn", "preparation.reply", "/api/preparations/" + encodeURIComponent(workflow.preparationId) + "/reply", { content })) {
    if ($("proposalFeedback").value === content) $("proposalFeedback").value = "";
  }
});
$("projectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await preparationMutation("approval", "preparation.approve", "/api/preparations/" + encodeURIComponent(workflow.preparationId) + "/approve");
});
$("closeProject").addEventListener("click", () => preparationMutation("preparationStart", "preparation.cancel",
  "/api/preparations/" + encodeURIComponent(workflow.preparationId) + "/cancel"));
for (const id of ["discardUnresolved", "discardNoResend", "discardReason"]) $(id).addEventListener("input", render);
$("discardDeliveryButton").addEventListener("click", () => preparationMutation("preparationStart", "preparation.discard",
  "/api/preparations/" + encodeURIComponent(workflow.preparationId) + "/discard", {
    unresolvedResultConfirmed: $("discardUnresolved").checked,
    noAutomaticResendConfirmed: $("discardNoResend").checked,
    reason: $("discardReason").value.trim(),
  }));
$("reloadProject").addEventListener("click", refresh);
$("chooseFolder").addEventListener("click", async () => {
  if (!connected || operations.folderPicker !== "IDLE") return;
  operations.folderPicker = "RUNNING"; render();
  text("folderStatus", "열린 파일 탐색기에서 프로젝트 폴더를 선택하세요.");
  try {
    const result = await request("/api/project/folder", { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: 0 }) });
    if (result.targetRoot) $("startRoot").value = result.targetRoot;
    text("folderStatus", result.targetRoot ? "폴더를 선택했습니다." : "폴더 선택을 취소했습니다.");
  } catch (error) { text("folderStatus", userFacingError(error)); }
  finally { operations.folderPicker = "IDLE"; render(); }
});
$("newRun").addEventListener("click", () => { if (!$("newRun").disabled) { followUpSource = null; selectProject(null); projectConversationRoot = null; selected = ""; requestedView = "start"; refresh(); } });
$("newProjectTask").addEventListener("click", async () => {
  if ($("newProjectTask").disabled || !projectViewRoot) return;
  const root = projectViewRoot;
  followUpSource = null;
  selectProject(null); projectConversationRoot = null; selected = ""; requestedView = "start";
  await refresh();
  if (!connected || workflow.stage !== "START") {
    selectProject(root);
    text("overviewReason", "시작 화면을 열 수 없습니다. 진행 중인 작업 또는 준비 상태를 확인하세요.");
    return;
  }
  $("startRoot").value = root;
  $("objective").value = "";
  $("conversationUrl").value = "";
  render();
  $("objective").focus();
});
$("openProjectBlocker").addEventListener("click", () => {
  const pending = snapshot?.runs?.find((item) => !terminal.has(item.phase));
  if (pending) openRun(pending.runId);
});
$("continueProject").addEventListener("click", async () => {
  if ($("continueProject").disabled) return;
  const root = snapshot?.run?.projectRef?.targetRoot;
  if (!root || snapshot?.run?.phase !== "APPLIED") return;
  followUpSource = { runId:snapshot.run.runId, objective:snapshot.run.objective, targetRoot:root };
  selected = ""; requestedView = "start";
  await refresh();
  if (workflow.stage !== "START") return;
  $("startRoot").value = root;
  $("conversationUrl").value = "https://chatgpt.com/";
  $("objective").value = "";
  $("objective").focus();
  render();
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
  text("reconcileResult", result
    ? `진단: ${result.classification ?? "미확인"}\n관찰: ${JSON.stringify(result.observations ?? [], null, 2)}\n가능한 조치: ${(result.allowedActions ?? []).join(", ") || "없음"}\n이 진단은 외부 작업 종료를 확인하지 않습니다.`
    : "진단에 실패했습니다. 위 명령 결과와 연결 상태를 확인하세요.");
});
$("retryRun").addEventListener("click", () => {
  const caps = capabilities();
  if (caps.has("code.review.retry")) command("code.review.retry");
  else command("run.retry");
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
  const textValue = $("reviewDiscussionText").value.trim();
  const role = $("reviewDiscussionRole").value;
  const result = await command("code.review.discuss", { role, text:textValue });
  if (result?.status === "DELIVERED" && $("reviewDiscussionText").value.trim() === textValue) {
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
  if (result?.status === "RECORDED" && $("operatorNoteText").value.trim() === textValue) {
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
  const turnId = snapshot?.workerRuntime?.turnId ?? snapshot?.run?.workerTurnId ?? null;
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
  if (!$("deleteRun").disabled && window.confirm("종료된 작업의 실행 기록·감사 근거·임시 작업 사본을 삭제합니다. 적용된 프로젝트 코드는 유지됩니다. 삭제할까요?")) {
    command("run.delete");
  }
});
$("applyCode").addEventListener("click", () => { const r = snapshot.run; command("code.apply", { candidateId:r.candidate.candidateId, reviewId:r.reviews.at(-1).reviewId, artifactHash:r.capture.artifact.sha256, baseCommit:r.baseCommit }); });
$("exportEvidence").addEventListener("click", async () => { const result = await command("evidence.export"); if (!result) return; const url = URL.createObjectURL(new Blob([JSON.stringify(result,null,2)], { type:"application/json" })); const a = node("a", ""); a.href = url; a.download = `${result.runId ?? "audit"}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
for (const [button, panel] of [["showConversation", "conversationPanel"], ["showAudit", "auditPanel"], ["showLog", "logPanel"]]) {
  $(button).addEventListener("click", () => {
    for (const [otherButton, otherPanel] of [["showConversation", "conversationPanel"], ["showAudit", "auditPanel"], ["showLog", "logPanel"]]) {
      $(otherPanel).hidden = otherPanel !== panel;
      $(otherButton).setAttribute("aria-pressed", String(otherButton === button));
    }
  });
}
$("closeEvidence").addEventListener("click", () => $("evidenceDialog").close());
$("nextEvidence").addEventListener("click", () => { if (evidencePage?.target === snapshot?.run?.runId) openEvidence(evidencePage.id, evidencePage.next); });
async function poll() { await refresh(); setTimeout(poll, 2500); }
poll();
