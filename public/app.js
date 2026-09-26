import { renderInitialRequest } from "./preparation-view.js";
import { renderConversation } from "./conversation-view.js";
import { externalEventRecords, groupRunsByProject, normalizeDashboardState } from "./dashboard-model.js";
const $ = (id) => document.getElementById(id);
let token = "", snapshot = null, selected = "", connected = false;
let workflow = { stage: "START", state: "START_IDLE", preparationId: null, preparationVersion: null, runId: null, runVersion: null };
let sequence = 0, lastConfirmed = null, evidencePage = null;
let renderedRecords = "", lastCommandError = "", recoveryRunId = null, readinessSignature = "";
let decisionSignature = "", interventionRunId = null;
let agreement = null, preparation = null;
let projectConversationRoot = null;
let followUpSource = null;
let projectViewRoot = sessionStorage.getItem("bridge.project.view") || null;
const operations = { folderPicker: "IDLE", preparationStart: "IDLE", webTurn: "IDLE", approval: "IDLE", runCommand: "IDLE" };
let preparationSignature = "";
let requestedView = "";
const unknownRequests = new Map();

const openFindings = new Set();
const terminal = new Set(["APPLIED", "CANCELLED", "INCONCLUSIVE", "FAILED", "COMPLETE"]);
const labels = { CREATED:"접수됨", PROVISIONING:"연결 준비 중", WORKER_RUNNING:"구현·수정 중", CANDIDATE_CAPTURE:"후보 캡처 중", VERIFYING:"검증 중", REVIEW_RUNNING:"웹 감사 중", REPORT_REPAIR:"감사 응답 보완 중", EVIDENCE_SUPPLEMENT:"같은 후보 증거 보완 중", REWORK:"수정 대기", HOLD:"판단 보류", AWAITING_APPLY:"감사 통과·적용 대기", APPLYING:"적용 중", APPLIED:"적용됨", INCONCLUSIVE:"미해결 종료", CANCELLED:"사용자 중단", RECOVERY_REQUIRED:"복구 확인 필요", FAILED:"오류 종료", STOPPING:"중단 확인 중", COMPLETE:"과거 실행 종료" };
const reasons = { RECOVERY_ABANDONED:"사용자가 외부 종료와 대상 상태를 확인하고 실행을 폐기했습니다. 감사 기록과 작업 사본은 보존됩니다.", ITERATION_LIMIT:"구현 회차 한도에 도달했습니다. 남은 필수 지적을 확인하세요.", EVIDENCE_LIMIT:"증거 보완 한도에 도달했습니다. 부족한 자료를 확인하세요.", REPORT_REPAIR_LIMIT:"감사 보고서 보완 한도에 도달했습니다.", USER_DECISION_REQUIRED:"명세·검증 범위에 대한 사용자 판단이 필요합니다.", TOTAL_TIME_LIMIT:"전체 시간 한도에 도달했습니다. 외부 실행 상태를 확인해야 합니다.", STOP_UNCERTAIN:"중단을 요청했으나 외부 작업 종료를 확인하지 못했습니다.", USER_STOP:"후속 구현·감사·적용 배정을 중단했습니다." };
function text(id, value) { $(id).textContent = value ?? ""; }
function folderName(targetRoot) {
  return String(targetRoot ?? "").replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) || "프로젝트";
}
function time(value) { return value ? new Date(value).toLocaleString("ko-KR") : "확인 전"; }
function node(tag, value, className = "") { const n = document.createElement(tag); n.textContent = value; n.className = className; return n; }
function selectProject(root) { projectViewRoot = root; sessionStorage.setItem("bridge.project.view", root ?? ""); render(); }
function openRun(runId) { selectProject(null); selected = runId; text("commandResult", ""); refresh(); }
function renderProjectOverview(group, busyRun) {
  text("overviewTitle", folderName(group.targetRoot));
  text("overviewPath", group.targetRoot);
  const tasks = group.runs;
  const attention = tasks.filter((r) => ["HOLD", "RECOVERY_REQUIRED", "AWAITING_APPLY"].includes(r.phase));
  text("overviewSummary", `기록 ${tasks.length}건 · 확인할 작업 ${attention.length}건`);
  const list = $("overviewTasks"); list.replaceChildren();
  for (const run of tasks) {
    const card = node("article", "", "overview-task");
    card.append(node("h3", run.objective), node("strong", labels[run.phase] ?? run.phase, `health ${runAppearance(run.phase)}`));
    const guidance = run.phase === "HOLD" ? "감사 질문·판단 대기를 확인하세요."
      : run.phase === "AWAITING_APPLY" ? "통과 후보의 근거를 확인하고 별도로 적용하세요."
      : run.phase === "RECOVERY_REQUIRED" ? "진단과 외부 작업 상태를 확인하세요."
      : terminal.has(run.phase) ? "완료된 기록을 확인할 수 있습니다." : "진행 상태와 기록을 확인하세요.";
    card.append(node("p", guidance), node("p", `시작 ${time(run.createdAt)} · 변경 ${time(run.updatedAt)}`, "muted"));
    const action = node("button", ["HOLD", "RECOVERY_REQUIRED", "AWAITING_APPLY"].includes(run.phase) ? "확인하고 조치하기" : "작업 기록 보기");
    action.addEventListener("click", () => openRun(run.runId));
    card.append(action); list.append(card);
  }
  if (!tasks.length) list.append(node("p", "아직 이 프로젝트의 실행 기록이 없습니다.", "muted"));
  $("newProjectTask").disabled = !connected || $("newRun").disabled;
  $("openProjectBlocker").hidden = !busyRun;
  $("openProjectBlocker").disabled = !connected;
  text("overviewReason", !connected ? "서버에 다시 연결한 뒤 작업을 선택하세요."
    : busyRun ? `‘${busyRun.objective}’ 작업이 아직 종료되지 않았습니다. 현재 작업을 확인하세요.`
    : $("newProjectTask").disabled ? "현재 준비 또는 요청이 끝난 뒤 새 작업을 시작할 수 있습니다."
    : "새 작업은 별도 요구사항 승인과 감사·적용 절차를 거칩니다.");
}
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
async function request(url, options = {}) {
  try {
    const response = await fetch(url, { ...options, signal:AbortSignal.timeout(url === "/api/project/folder" ? 310000 : url.startsWith("/api/preparations/") ? 180000 : url.startsWith("/api/state") || url === "/api/dashboard/session" ? 10000 : 30000), cache:"no-store", headers:{ "Content-Type":"application/json", ...(token ? { Authorization:`Bearer ${token}` } : {}), ...options.headers } });
    let body;
    try { body = await response.json(); }
    catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") throw error;
      throw Object.assign(new Error(`서버 응답을 해석할 수 없습니다 (${response.status}).`), { status:response.status });
    }
    if (!response.ok) throw Object.assign(new Error(body?.payload?.message || body?.error?.message || body?.message || body?.error || `요청 실패 (${response.status})`), { ...(typeof body?.error === "object" ? body.error : body), status: response.status });
    return body;
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") throw Object.assign(new Error("요청 결과 미확인 (UNKNOWN_RESULT). 자동 재전송하지 않습니다. 상태와 요청 ID를 확인하세요."), { code: "UNKNOWN_RESULT" });
    throw error;
  }
}
async function refresh() {
  const current = ++sequence, target = selected;
  try {
    if (!token) {
      const session = await request("/api/dashboard/session", { method:"POST", body:"{}" });
      if (typeof session?.token !== "string" || !session.token.trim()) throw new Error("대시보드 인증 응답에 토큰이 없습니다.");
      token = session.token;
    }
    const result = await request(`/api/state${target ? `?runId=${encodeURIComponent(target)}` : requestedView === "start" ? "?view=start" : ""}`);
    if (current !== sequence || target !== selected) return;
    if (!result || !Array.isArray(result.runs) || !Array.isArray(result.commandCapabilities) || !result.preflight || typeof result.preflight !== "object") throw new Error("서버 상태 응답 형식을 확인하세요.");
    if (!result.workflow) throw new Error("서버가 WORKFLOW_CONTRACT 상태를 제공하지 않습니다. 준비 API와 workflow projection 구현이 필요합니다.");
    const canonical = normalizeDashboardState(result);
    snapshot = result; workflow = canonical.workflow; preparation = canonical.preparation; agreement = preparation?.agreement ?? null; connected = true;
    if (workflow.stage !== "START" || preparation?.lifecycle === "ACTIVE") requestedView = "";
    renderPreparation(); lastConfirmed = new Date().toISOString();
    const extensionNeedsPreparation = workflow.stage === "PREPARE";
    text("connectionNotice", !extensionNeedsPreparation || result.preflight?.checks?.extensionAuthenticated === true
      ? ""
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
    connected = false;
    if (error.status === 401) token = "";
    text("connectionNotice", `로컬 서버 연결이 끊겼습니다. 기본 포트 8787에서 npm start 또는 npm run dev가 실행 중인지 확인하고, 확장 연결을 다시 확인하세요. ${error.message} · 마지막 확인 ${time(lastConfirmed)}`);
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
    element.textContent = `저장됨 · 준비 ID ${preparation.preparationId}${savedAt} · 서버 연결 끊김으로 저장/폐기 조작 불가`;
    element.className = "persistence-status warn";
    return;
  }
  if (preparation.lifecycle === "ACTIVE") {
    element.textContent = `자동 저장됨 · 준비 ID ${preparation.preparationId}${savedAt} · 삭제 대신 ‘준비 취소’로 폐기합니다.`;
    element.className = "persistence-status ok";
  } else {
    element.textContent = `저장된 준비 종료됨 · 준비 ID ${preparation.preparationId}${savedAt}`;
    element.className = "persistence-status muted";
  }
}
function disabledWebReason(action) {
  if (!connected) return "웹 작업 비활성화: 서버 연결이 없어 상태를 확인할 수 없습니다.";
  if (snapshot?.preflight?.checks?.extensionAuthenticated !== true) return "웹 작업 비활성화: 브라우저 확장 인증이 확인되지 않았습니다.";
  if (operations.webTurn !== "IDLE") return "웹 작업 비활성화: 다른 웹 상태 요청을 처리 중입니다.";
  if (preparation?.webSession?.bindingState !== "BOUND") return `웹 작업 비활성화: 세션 바인딩이 BOUND가 아닙니다. 현재 상태: ${preparation?.webSession?.bindingState ?? "UNBOUND"}.`;
  if (preparation?.diagnostics?.exactConversation !== true) return "웹 작업 비활성화: 현재 탭이 준비된 session·conversation·run identity와 정확히 일치하지 않습니다.";
  if (!capabilities().has(action)) return `웹 작업 비활성화: 현재 서버가 ${action} 권한을 제공하지 않습니다. active delivery 또는 응답 처리 상태를 확인하세요.`;
  return "";
}
function health(id, name, state, detail) {
  const el = $(id);
  el.className = `health ${state}`;
  el.textContent = name;
  el.setAttribute("aria-label", `${name}: ${detail}`);
  text(`${id}Detail`, detail);
}
function signal(id, label, state, detail) {
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
  if (runtime.activity === "CANDIDATE_CAPTURE") return { state:"ok running", detail:"Worker 완료 · 후보 캡처 중" };
  if (runtime.activity === "VERIFYING") return { state:"ok running", detail:"Worker 완료 · 후보 검증 중" };
  if (runtime.activity === "WEB_AUDIT") return { state:"ok running", detail:"Worker 완료 · 웹 감사 진행 중" };
  if (runtime.activity === "AWAITING_APPLY") return { state:"ok", detail:"Worker·웹 감사 완료 · 적용 대기" };
  if (runtime.activity === "APPLIED") return { state:"ok", detail:"Worker·웹 감사 완료 · 적용됨" };
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
    button.title = !connected ? "서버 연결을 복구하면 근거를 열 수 있습니다."
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
  health("apiHealth", "api", connected ? "ok" : "unknown", connected ? "응답 정상" : "응답 확인 필요");
  health("sessionHealth", "session", connected && token ? "ok" : "unknown", connected && token ? "대시보드 인증됨" : "인증 확인 필요");
  const workerStatus = workerRuntimeStatus(snapshot?.workerRuntime);
  health("engineHealth", "engine", workerStatus.state, workerStatus.detail);
  health("channelHealth", "channel", !connected || typeof checks?.extensionAuthenticated !== "boolean" ? "unknown" : checks.extensionAuthenticated ? "ok" : "warn",
    !connected || typeof checks?.extensionAuthenticated !== "boolean" ? "확인 전" : checks.extensionAuthenticated ? "확장 인증됨" : "확장 연결 대기");
  signal("serverSignal", "서버", connected ? "ok" : "error", connected ? "연결됨" : "연결 끊김 · npm start 확인 필요");
  signal("cliSignal", "CLI", connected ? workerStatus.state : "warn",
    !connected ? "서버 확인 필요" : workerStatus.detail);
  const webAuthenticated = checks?.extensionAuthenticated === true;
  signal("webSignal", "웹", connected ? (webAuthenticated ? "ok" : "warn") : "warn",
    !connected ? "서버 확인 필요" : webAuthenticated ? "확장 인증됨" : "확장 연결 대기 · 확장 팝업 확인");
  const lastBinding = preflight?.lastWebBinding;
  signal("webBindingSignal", "대화 탭", !connected || !webAuthenticated || !["BOUND", "ROOT_READY"].includes(lastBinding?.bindingStatus) ? "warn" : "ok",
    !connected ? "서버 확인 필요" : !webAuthenticated ? "확장 연결 대기"
      : lastBinding ? `마지막 바인딩 ${lastBinding.bindingStatus} · 전송 시 재확인` : "아직 확인된 바인딩 없음 · 새 작업에서 탭 생성");
  signal("refreshSignal", "런", connected && lastConfirmed ? "ok" : "error",
    connected ? `갱신됨 ${time(lastConfirmed)}` : `마지막 확인 ${time(lastConfirmed)}`);
  const unfinished = snapshot?.runs?.find((r) => !terminal.has(r.phase));
  const busy = Boolean(unfinished);
  $("editProject").disabled = (operations.runCommand !== "IDLE") || !connected || (operations.webTurn !== "IDLE");
  $("planRun").disabled = (operations.runCommand !== "IDLE") || !connected || busy || (operations.webTurn !== "IDLE");
  $("newRun").disabled = (operations.runCommand !== "IDLE") || busy; text("newRunReason", busy ? `‘${unfinished.objective}’ 작업이 아직 종료되지 않았습니다. 아래 버튼에서 확인하고 중단할 수 있습니다.` : "과거 기록은 언제든 선택할 수 있습니다.");
  $("showUnfinishedRun").hidden = !busy;
  $("showUnfinishedRun").disabled = (operations.runCommand !== "IDLE") || !connected;
  const list = $("runList"); list.replaceChildren();
  const groups = groupRunsByProject(snapshot?.runs ?? []);
  for (const record of snapshot?.projectConversations ?? []) {
    if (record.targetRoot && !groups.some((item) => item.targetRoot === record.targetRoot)) groups.push({ targetRoot:record.targetRoot, runs:[] });
  }
  if (projectViewRoot && !groups.some((item) => item.targetRoot === projectViewRoot)) {
    projectViewRoot = null; sessionStorage.setItem("bridge.project.view", "");
  }
  for (const group of groups) {
    const section = node("section", "", "project-history");
    const heading = group.targetRoot ? node("button", folderName(group.targetRoot), `project-open${projectViewRoot === group.targetRoot ? " active" : ""}`)
      : node("h3", "기타 작업");
    if (group.targetRoot) { heading.title = group.targetRoot; heading.addEventListener("click", () => selectProject(group.targetRoot)); }
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
  const project = preflight?.project;
  const projectContainer = $("projectSummary"); projectContainer.replaceChildren();
  if (project) {
    projectContainer.append(node("p", `${folderName(project.targetRoot)} · ${project.targetRoot}`), node("p", `기준 ${project.requirementsId} / ${project.revision}`));
    for (const req of project.requirements.items) projectContainer.append(node("p", `${req.requirementId} · ${req.statement}`, "muted"));
  } else projectContainer.append(node("p", connected ? "사용할 프로젝트가 아직 준비되지 않았습니다." : "연결 후 프로젝트 설정을 확인합니다.", "muted"));
  actionState("planRun", !webConnected() || !caps.has("preparation.start") || operations.preparationStart !== "IDLE" || operations.folderPicker !== "IDLE",
    !webConnected() ? "브릿지 확장 인증이 확인되지 않아 전송할 수 없습니다. ChatGPT 탭은 연결 후 자동으로 엽니다." : "현재 요청이나 작업이 끝나야 준비 대화를 시작할 수 있습니다.",
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
  text("newRunReason", !connected ? "서버 연결 후 새 작업 입력 화면을 열 수 있습니다."
    : workflow.stage === "PREPARE" ? "현재 준비를 유지합니다. 종료하려면 ‘준비 취소’를 선택하세요."
    : preparation?.lifecycle === "ACTIVE" ? "현재 요청의 응답 또는 처리 결과를 확인 중입니다."
    : busy ? "진행 중인 작업을 먼저 종료하세요."
    : "새 작업의 폴더와 요청을 입력할 수 있습니다. 준비 대화 시작에는 웹 연결이 필요합니다.");
  if (overviewGroup) renderProjectOverview(overviewGroup, unfinished);
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
    text("workerInterventionStatus", "서버 연결을 복구해야 Worker에 전달할 수 있습니다.");
  } else if (!interventionTurnId || !caps.has("code.worker.intervene")) {
    text("workerInterventionStatus", "활성 Worker turn의 실시간 전달 capability가 아직 확인되지 않았습니다. turn 시작을 기다리거나 현재 Worker 제공자의 지원 여부를 확인하세요.");
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
  $("retryRun").textContent = "수동 진행";
  if (run?.phase === "RECOVERY_REQUIRED") {
    const recoveryConfirmed = $("recoveryConfirm").checked;
    const abandonBlocked = (operations.runCommand !== "IDLE") || !caps.has("run.abandon") || !recoveryConfirmed;
    const abandonReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리가 끝나야 실행을 폐기할 수 있습니다."
      : !connected ? "서버 연결을 복구해야 실행을 폐기할 수 있습니다."
      : !caps.has("run.abandon") ? "현재 런이 복구 폐기 명령을 받을 수 없는 상태입니다. 상태 갱신 후에도 같으면 실행 기록의 오류·복구 상태를 확인하세요."
      : !recoveryConfirmed ? "외부 작업 종료·대상 저장소 상태 확인·실행 폐기를 한 번에 확인하세요."
      : "확인 기록 후 이 실행을 폐기할 수 있습니다.";
    actionState("abandonRun", abandonBlocked, abandonReason, abandonReason);
    const retryReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리가 끝나야 다시 시도할 수 있습니다."
      : caps.has("run.retry") ? "실패한 임시 worktree를 정리하고 같은 요구사항으로 새 Worker turn을 시작합니다."
      : "후보 생성 전 Worker 실패가 안전하게 확인된 경우에만 수동 진행할 수 있습니다.";
    actionState("retryRun", (operations.runCommand !== "IDLE") || !caps.has("run.retry"), retryReason, retryReason);
  } else if (run?.phase === "HOLD" && caps.has("code.review.retry")) {
    $("abandonRun").disabled = true;
    $("abandonRun").title = "";
    $("retryRun").textContent = "웹 감사 다시 시도";
    const retryReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리가 끝나야 감사를 다시 시도할 수 있습니다."
      : !webConnected() ? "브라우저 확장 연결과 정확한 ChatGPT 세션을 복구해야 같은 후보의 감사를 다시 시도할 수 있습니다."
      : "Worker를 다시 실행하지 않고 현재 후보를 같은 요구사항으로 다시 감사합니다. REWORK 판정이면 기존 수정 루프를 이어갑니다.";
    actionState("retryRun", (operations.runCommand !== "IDLE") || !webConnected(), retryReason, retryReason);
  } else {
    $("abandonRun").disabled = true;
    $("abandonRun").title = "";
    $("retryRun").disabled = true;
    $("retryRun").title = "";
  }
  for (const [id, capability] of [["stopRun", "run.stop"], ["applyCode", "code.apply"], ["exportEvidence", "evidence.export"], ["deleteRun", "run.delete"]]) {
    $(id).disabled = !run || operations.runCommand !== "IDLE" || !caps.has(capability);
  }
  if (!run) return;
  $("continueProject").hidden = run.phase !== "APPLIED";
  $("continueProject").disabled = $("newRun").disabled;
  text("runFollowUp", run.followUp ? `이전 적용 작업: ${run.followUp.objective} · ${run.followUp.runId}` : "");
  $("openFollowUp").hidden = !run.followUp;
  $("openFollowUp").disabled = !snapshot?.runs?.some((item) => item.runId === run.followUp?.runId);
  $("openFollowUp").title = $("openFollowUp").disabled ? "이전 작업 기록이 삭제되어 열 수 없습니다." : "이전 적용 작업의 기록을 엽니다.";
  text("runObjective", run.objective); text("runContext", run.requirements
    ? `${folderName(run.projectRef?.targetRoot)} / ${run.objective} / ${labels[run.phase] ?? run.phase} · 구현 ${run.iteration ?? 0}회 · Worker ${workerIdentity(run)} · ${terminal.has(run.phase) ? "종료됨" : run.activeActor ?? "실행 주체 미확인"}`
    : `작업 기록 · Worker ${workerIdentity(run)} · ${terminal.has(run.phase) ? "종료됨" : run.activeActor ?? "실행 주체 미확인"}`);
  text("runStatus", labels[run.phase] ?? run.phase); $("runStatus").className = `health ${runAppearance(run.phase)}`;
  text("runReason", reasons[run.terminationReason] ?? run.error ?? snapshot?.error ?? (run.phase === "CANCELLED" ? "중단된 작업입니다. 실행 기록은 보존됩니다." : run.phase === "AWAITING_APPLY" ? "이 요구사항 버전과 후보의 감사가 통과했습니다. 적용은 별도 명령입니다." : run.phase === "APPLIED" ? "감사한 후보가 반영됐습니다. 배포·추가 환경 검증의 성공을 뜻하지 않습니다." : `감사 결과: ${run.auditResult ?? "미판정"} · 미해결 필수 지적 ${(run.findings ?? []).filter((f) => f.required && ["OPEN","FIX_SUBMITTED"].includes(f.status)).length}건`));
  text("runTime", `접수 ${time(run.createdAt)} · 상태 발생 ${time(run.updatedAt)}${connected ? "" : ` · 연결 끊김, 마지막 확인 ${time(lastConfirmed)}`}`);
  const workerEvidence = run.worker?.provenance;
  text("workerProvenance", workerEvidence ? `Worker 출처: 설정 ${workerEvidence.requested.provider ?? "미지정"} / 실행 보고 ${workerEvidence.reported.provider ?? "미확인"} · 모델 보고 ${workerEvidence.reported.model ?? "미확인"}` : "Worker 실행 출처: 현재 기록에서 확인되지 않음");
  const stopReason = (operations.runCommand !== "IDLE") ? "현재 요청을 처리 중이라 중단 명령을 보낼 수 없습니다. 처리가 끝난 뒤 다시 누르세요."
    : !connected ? "서버 연결이 끊겨 중단할 수 없습니다. 서버 연결을 먼저 복구하세요."
    : terminal.has(run.phase) ? "이미 종료된 작업이라 중단할 수 없습니다. 왼쪽 ‘새 작업’을 사용하거나 다른 미종료 작업을 선택하세요."
    : run.phase === "RECOVERY_REQUIRED" ? "자동 중단 여부를 확정할 수 없습니다. 아래 확인 항목을 체크한 뒤 ‘실행 폐기’를 누르세요."
    : caps.has("run.stop") ? "현재 작업을 중단할 수 있습니다. ‘작업 중단’을 누르면 후속 구현·감사를 멈추고 기록은 보존합니다."
    : run.phase === "APPLYING" ? "코드를 적용 중이라 지금은 중단할 수 없습니다. 적용 결과가 확정된 뒤 다음 행동을 선택하세요."
    : "현재 단계에서는 중단 명령이 비활성입니다. 상태가 바뀌는지 확인하고, 복구 필요 상태가 되면 복구 확인 절차를 진행하세요.";
  actionState("stopRun", (operations.runCommand !== "IDLE") || !caps.has("run.stop"), stopReason, stopReason);
  text("stopReason", stopReason);

  const applyReason = (operations.runCommand !== "IDLE") ? "현재 명령 처리가 끝나야 후보를 적용할 수 있습니다."
    : !connected ? "서버 연결을 복구해야 후보를 적용할 수 있습니다."
    : caps.has("code.apply") ? "감사 통과 후보가 준비됐습니다. 대상 저장소에 반영할 수 있습니다."
    : run.phase === "AWAITING_APPLY" ? "감사 통과 상태지만 적용 capability가 없습니다. 상태를 다시 확인하고 복구·오류 기록을 확인하세요."
    : "구현 → 검증 → 웹 감사가 PASS되어 ‘감사 통과·적용 대기’ 상태가 되어야 적용할 수 있습니다.";
  actionState("applyCode", (operations.runCommand !== "IDLE") || !caps.has("code.apply"), applyReason, applyReason);

  const exportReason = (operations.runCommand !== "IDLE") ? "현재 명령 처리가 끝나야 감사 기록을 다운로드할 수 있습니다."
    : !connected ? "서버 연결을 복구해야 감사 기록을 다운로드할 수 있습니다."
    : !caps.has("evidence.export") ? "현재 런에는 내보낼 수 있는 감사 기록 capability가 없습니다. 실행 기록과 상태를 먼저 확인하세요."
    : "현재까지 보존된 감사 기록을 JSON으로 다운로드할 수 있습니다.";
  actionState("exportEvidence", (operations.runCommand !== "IDLE") || !caps.has("evidence.export"), exportReason, exportReason);
  text("commandReason", `적용: ${applyReason} · 감사 기록: ${exportReason}`);
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
        "run.retry": "수동 진행을 시작했습니다. 새 Worker 실행 상태를 확인하세요.",
        "code.review.retry": "같은 후보의 웹 감사를 다시 시작했습니다. REWORK가 나오면 수정 루프를 이어갑니다.",
        "run.stop": "중단 요청을 처리했습니다. 최신 실행 상태를 확인하세요.",
        "code.apply": "적용 요청을 처리했습니다. 최신 적용 상태를 확인하세요.",
        "evidence.export": "감사 기록 요청을 처리했습니다.",
        "run.delete": "종료된 작업 기록을 삭제했습니다.",
      }[type] ?? "요청을 처리했습니다. 최신 실행 상태를 확인하세요.";
      text("commandResult", successMessage);
    }
    if (type === "run.delete") { selected = null; requestedView = "start"; }
    return result.payload;
  } catch (error) {
    if (error.code === "UNKNOWN_RESULT") { operations.runCommand = "UNKNOWN_RESULT"; unknownRequests.set("runCommand", body.requestId); }
    lastCommandError = `요청 결과를 확인하세요: ${error.message}. 응답 유실 시 자동 재전송하지 않습니다. 실행 기록을 먼저 확인하세요.`;
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
    !connected ? "서버 연결을 복구해야 준비를 종료할 수 있습니다."
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
    if (!connected) return "서버 연결이 없어 이 상태 확인을 실행할 수 없습니다. 로컬 서버와 8787 포트를 확인하세요.";
    if (snapshot?.preflight?.checks?.extensionAuthenticated !== true) return "브라우저 확장이 인증되지 않았습니다. 확장 팝업에서 서버 주소와 연결 상태를 확인하세요.";
    if (operations.webTurn !== "IDLE") return "다른 웹 상태 요청을 처리하는 중입니다. 처리가 끝난 뒤 다시 시도하세요.";
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
    WAITING_WEB_RESPONSE: "웹 요청을 처리 중입니다. 응답 확인 전에는 승인할 수 없습니다.",
    DISCUSSING: "웹 응답을 확인했습니다. 질문에 답하며 작업 범위를 정하세요.",
    AGREEMENT_READY: "웹이 완료 기준을 제안했습니다. 내용을 검토하고 승인하세요.",
    APPROVING: "승인을 처리하고 작업을 생성하고 있습니다. 작업 생성이 확인되면 이동합니다.",
    RECOVERY_REQUIRED: "전송 또는 응답 확인이 끝나지 않았습니다. 상태 확인이 필요합니다." };
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
    const message = (error.code ?? "REQUEST_FAILED") + ": " + error.message + " · 요청 ID: " + requestId;
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
      ...(followUpSource ? { followUpRunId:followUpSource.runId } : {}),
      reuseProjectConversation:$("reuseProjectConversation").checked && !$("projectConversationPanel").hidden });
}
$("startForm").addEventListener("submit", (event) => { event.preventDefault(); return beginPreparation(); });
$("startRoot").addEventListener("input", render);
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
  } catch (error) { text("folderStatus", error.message); }
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
