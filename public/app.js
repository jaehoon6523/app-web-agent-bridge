import { normalizeDashboardState } from "./dashboard-model.js";
const $ = (id) => document.getElementById(id);
let token = "", snapshot = null, selected = "", connected = false;
let workflow = { stage: "START", state: "START_IDLE", preparationId: null, preparationVersion: null, runId: null, runVersion: null };
let sequence = 0, lastConfirmed = null, evidencePage = null;
let renderedRecords = "", lastCommandError = "", recoveryRunId = null, readinessSignature = "";
let agreement = null, preparation = null;
const operations = { folderPicker: "IDLE", preparationStart: "IDLE", webTurn: "IDLE", approval: "IDLE", runCommand: "IDLE" };
let preparationSignature = "";
let requestedView = "";
const unknownRequests = new Map();

const openFindings = new Set();
const terminal = new Set(["APPLIED", "CANCELLED", "INCONCLUSIVE", "FAILED", "COMPLETE"]);
const labels = { CREATED:"접수됨", PROVISIONING:"연결 준비 중", WORKER_RUNNING:"구현·수정 중", CANDIDATE_CAPTURE:"후보 캡처 중", VERIFYING:"검증 중", REVIEW_RUNNING:"웹 감사 중", REPORT_REPAIR:"감사 응답 보완 중", EVIDENCE_SUPPLEMENT:"같은 후보 증거 보완 중", REWORK:"수정 대기", HOLD:"판단 보류", AWAITING_APPLY:"감사 통과·적용 대기", APPLYING:"적용 중", APPLIED:"적용됨", INCONCLUSIVE:"미해결 종료", CANCELLED:"사용자 중단", RECOVERY_REQUIRED:"복구 확인 필요", FAILED:"오류 종료", STOPPING:"중단 확인 중", COMPLETE:"과거 실행 종료" };
const reasons = { RECOVERY_ABANDONED:"사용자가 외부 종료와 대상 상태를 확인하고 실행을 폐기했습니다. 감사 기록과 작업 사본은 보존됩니다.", ITERATION_LIMIT:"구현 회차 한도에 도달했습니다. 남은 필수 지적을 확인하세요.", EVIDENCE_LIMIT:"증거 보완 한도에 도달했습니다. 부족한 자료를 확인하세요.", REPORT_REPAIR_LIMIT:"감사 보고서 보완 한도에 도달했습니다.", USER_DECISION_REQUIRED:"명세·검증 범위에 대한 사용자 판단이 필요합니다.", TOTAL_TIME_LIMIT:"전체 시간 한도에 도달했습니다. 외부 실행 상태를 확인해야 합니다.", STOP_UNCERTAIN:"중단을 요청했으나 외부 작업 종료를 확인하지 못했습니다.", USER_STOP:"후속 구현·감사·적용 배정을 중단했습니다." };
function text(id, value) { $(id).textContent = value ?? ""; }
function time(value) { return value ? new Date(value).toLocaleString("ko-KR") : "확인 전"; }
function node(tag, value, className = "") { const n = document.createElement(tag); n.textContent = value; n.className = className; return n; }
function actionState(id, disabled, disabledReason = "", enabledReason = "") {
  const element = $(id);
  element.disabled = Boolean(disabled);
  const reason = element.disabled ? disabledReason : enabledReason;
  element.title = reason;
  if (reason) element.setAttribute("aria-description", reason);
  else element.removeAttribute("aria-description");
  return reason;
}
function workerIdentity(run) {
  const worker = run?.worker ?? {};
  const provider = worker.provider ?? null;
  const model = worker.model ?? null;
  return [provider, model].filter(Boolean).join(" / ") || "정보 없음";
}
function externalEventRecords(run) {
  if (!run) return [];
  const workerTurns = (run.workerTurns ?? []).map((turn) => ({
    at: turn.finishedAt ?? turn.startedAt,
    title: `WORKER_TURN_${String(turn.status ?? "UNKNOWN").toUpperCase()}`,
    content: JSON.stringify({
      provider: turn.provider ?? run.worker?.provider ?? null,
      model: turn.model ?? run.worker?.model ?? null,
      sessionId: turn.sessionId ?? null,
      turnId: turn.turnId ?? null,
      startedAt: turn.startedAt ?? null,
      finishedAt: turn.finishedAt ?? null,
      durationMs: turn.durationMs ?? null,
      usage: turn.usage ?? null,
      inputRef: turn.inputRef ?? null,
      outputRef: turn.outputRef ?? null,
      metadata: turn.metadata ?? null,
    }),
  }));
  const reviews = (run.reviews ?? []).map((review) => ({
    at: review.createdAt ?? review.finishedAt ?? review.reviewedAt ?? run.updatedAt,
    title: "REVIEW_RESULT",
    content: JSON.stringify({
      reviewId: review.reviewId ?? null,
      candidateId: review.candidateId ?? null,
      decision: review.decision ?? review.report?.decision ?? null,
      requestId: review.requestId ?? null,
      requirementsRef: review.requirementsRef ?? null,
    }),
  }));
  const verifications = (snapshot?.evidence ?? []).filter((e) => ["EXECUTION", "ARTIFACT"].includes(e.kind)).map((e) => ({
    at: e.createdAt, title:`VERIFICATION_${e.kind}`, content:JSON.stringify({ evidenceId:e.evidenceId, candidateId:e.candidateId, producer:e.producer, valid:e.valid, result:e.result }),
  }));
  return [...workerTurns, ...reviews, ...verifications];
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
    text("connectionNotice", "");
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
    text("connectionNotice", `연결을 확인해 주세요. ${error.message} · 마지막 확인 ${time(lastConfirmed)}`);
  }
  render();
}
function capabilities() { return new Set(connected ? snapshot?.commandCapabilities ?? [] : []); }
function webConnected() { return connected && snapshot?.preflight?.checks?.extensionAuthenticated === true; }
function health(id, name, state, detail) {
  const el = $(id);
  el.className = `health ${state}`;
  el.textContent = name;
  el.setAttribute("aria-label", `${name}: ${detail}`);
  text(`${id}Detail`, detail);
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
    ...externalEventRecords(snapshot?.run)].sort((a,b) => String(a.at).localeCompare(String(b.at)));
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
  const readiness = JSON.stringify([connected, preflight, [...caps], snapshot?.runs]);
  if (readiness !== readinessSignature) { lastCommandError = ""; readinessSignature = readiness; }
  const checks = preflight?.checks;
  health("apiHealth", "api", connected ? "ok" : "unknown", connected ? "응답 정상" : "응답 확인 필요");
  health("sessionHealth", "session", connected && token ? "ok" : "unknown", connected && token ? "대시보드 인증됨" : "인증 확인 필요");
  health("engineHealth", "engine", !connected || typeof checks?.codeWorkerExecutableConfigured !== "boolean" ? "unknown" : "warn",
    !connected || typeof checks?.codeWorkerExecutableConfigured !== "boolean" ? "확인 전" : checks.codeWorkerExecutableConfigured ? "경로 설정됨 · 실제 실행 상태는 확인 전" : "경로 설정 필요");
  health("channelHealth", "channel", !connected || typeof checks?.extensionAuthenticated !== "boolean" ? "unknown" : checks.extensionAuthenticated ? "ok" : "warn",
    !connected || typeof checks?.extensionAuthenticated !== "boolean" ? "확인 전" : checks.extensionAuthenticated ? "확장 인증됨" : "확장 연결 대기");
  text("serverSignal", connected ? "서버 · 연결됨" : "서버 · 확인 필요"); $("serverSignal").className = connected ? "ok" : "";
  text("cliSignal", connected ? preflight?.checks?.codeWorkerExecutableConfigured ? "CLI · 경로 설정됨" : "CLI · 설정 필요" : "CLI · 확인 전");
  text("webSignal", connected ? preflight?.checks?.extensionAuthenticated ? "웹 · 확장 인증됨" : "웹 · 연결 대기" : "웹 · 확인 전");
  text("refreshSignal", `런 · ${connected ? "갱신됨" : "마지막 확인"} ${time(lastConfirmed)}`);
  const unfinished = snapshot?.runs?.find((r) => !terminal.has(r.phase));
  const busy = Boolean(unfinished);
  $("editProject").disabled = (operations.runCommand !== "IDLE") || !connected || (operations.webTurn !== "IDLE");
  $("planRun").disabled = (operations.runCommand !== "IDLE") || !connected || busy || (operations.webTurn !== "IDLE");
  $("newRun").disabled = (operations.runCommand !== "IDLE") || busy; text("newRunReason", busy ? `‘${unfinished.objective}’ 작업이 아직 종료되지 않았습니다. 아래 버튼에서 확인하고 중단할 수 있습니다.` : "과거 기록은 언제든 선택할 수 있습니다.");
  $("showUnfinishedRun").hidden = !busy;
  $("showUnfinishedRun").disabled = (operations.runCommand !== "IDLE") || !connected;
  const list = $("runList"); list.replaceChildren();
  for (const r of [...snapshot?.runs ?? []].reverse()) {
    const button = node("button", r.objective, `run-item${workflow.stage !== "START" && r.runId === run?.runId ? " active" : ""}`);
    button.append(node("small", labels[r.phase] ?? r.phase, `health ${runAppearance(r.phase)}`));
    button.addEventListener("click", () => { selected = r.runId; text("commandResult", ""); refresh(); }); list.append(button);
  }
  const resultStage = workflow.stage === "RESULT";
  const step = { START: "stepStart", PREPARE: "stepPrepare", WORK: "stepWork", RESULT: "stepResult" }[workflow.stage];
  for (const id of ["stepStart", "stepPrepare", "stepWork", "stepResult"]) $(id).setAttribute("aria-current", id === step ? "step" : "false");
  text("runStageHeading", resultStage ? "결과" : "작업");
  $("startPanel").hidden = workflow.stage !== "START";
  const preparing = workflow.stage === "PREPARE";
  renderInitialRequest();
  $("projectPanel").hidden = !preparing;
  $("runPanel").hidden = !["WORK", "RESULT"].includes(workflow.stage) || !run;
  const project = preflight?.project;
  const projectContainer = $("projectSummary"); projectContainer.replaceChildren();
  if (project) {
    projectContainer.append(node("p", `${project.projectId} · ${project.targetRoot}`), node("p", `기준 ${project.requirementsId} / ${project.revision}`));
    for (const req of project.requirements.items) projectContainer.append(node("p", `${req.requirementId} · ${req.statement}`, "muted"));
  } else projectContainer.append(node("p", connected ? "사용할 프로젝트가 아직 준비되지 않았습니다." : "연결 후 프로젝트 설정을 확인합니다.", "muted"));
  actionState("planRun", !webConnected() || !caps.has("preparation.start") || operations.preparationStart !== "IDLE" || operations.folderPicker !== "IDLE",
    !webConnected() ? "브릿지 확장 연결이 확인돼야 전송할 수 있습니다." : "현재 요청이나 작업이 끝나야 준비 대화를 시작할 수 있습니다.",
    "지정한 대화 탭을 확인한 뒤 첫 부탁을 전송합니다.");
  if (workflow.stage === "START") {
    if (workflow.state === "CONNECTING_WEB") {
      text("startReason", "ChatGPT 대화 탭에 연결 중입니다. 아직 메시지를 전송하지 않았습니다.");
    } else if (preparation?.state === "WEB_BLOCKED" && preparation?.error) {
      text("startReason", "ChatGPT 연결에 실패해 메시지를 전송하지 않았습니다. 대화 탭과 브릿지 연결을 확인한 뒤 다시 시작하세요. "
        + preparation.error.code + ": " + preparation.error.message);
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
  if (workflow.stage === "START" && workflow.state !== "CONNECTING_WEB"
    && !preparation?.error && !checks?.extensionAuthenticated) {
    text("startReason", "입력은 가능합니다. 준비 대화를 시작하려면 브릿지 확장을 연결하세요.");
  }
  if (recoveryRunId !== run?.runId) {
    recoveryRunId = run?.runId;
    $("recoveryExternal").checked = false; $("recoveryTarget").checked = false; $("recoveryReason").value = "";
  }
  $("recoveryPanel").hidden = run?.phase !== "RECOVERY_REQUIRED";
  if (run?.phase === "RECOVERY_REQUIRED") {
    const recoverySteps = [];
    if (!$("recoveryExternal").checked) recoverySteps.push("외부 작업 종료 확인");
    if (!$("recoveryTarget").checked) recoverySteps.push("대상 저장소 상태 확인");
    if (!$("recoveryReason").value.trim()) recoverySteps.push("확인 내용과 폐기 사유 입력");
    const abandonBlocked = (operations.runCommand !== "IDLE") || !caps.has("run.abandon") || recoverySteps.length > 0;
    const abandonReason = (operations.runCommand !== "IDLE") ? "현재 요청 처리가 끝나야 실행을 폐기할 수 있습니다."
      : !connected ? "서버 연결을 복구해야 실행을 폐기할 수 있습니다."
      : !caps.has("run.abandon") ? "현재 런이 복구 폐기 명령을 받을 수 없는 상태입니다. 상태 갱신 후에도 같으면 실행 기록의 오류·복구 상태를 확인하세요."
      : recoverySteps.length ? `다음 항목을 완료하세요: ${recoverySteps.join(", ")}.`
      : "확인 기록 후 이 실행을 폐기할 수 있습니다.";
    actionState("abandonRun", abandonBlocked, abandonReason, abandonReason);
  } else {
    $("abandonRun").disabled = true;
    $("abandonRun").title = "";
  }
  for (const [id, capability] of [["stopRun", "run.stop"], ["applyCode", "code.apply"], ["exportEvidence", "evidence.export"]]) {
    $(id).disabled = !run || operations.runCommand !== "IDLE" || !caps.has(capability);
  }
  if (!run) return;
  text("runObjective", run.objective); text("runContext", run.requirements
    ? `${run.projectRef?.projectId ?? "프로젝트"} · 구현 ${run.iteration ?? 0}회 · Worker ${workerIdentity(run)} · ${terminal.has(run.phase) ? "종료됨" : run.activeActor ?? "실행 주체 미확인"}`
    : `작업 기록 · Worker ${workerIdentity(run)} · ${terminal.has(run.phase) ? "종료됨" : run.activeActor ?? "실행 주체 미확인"}`);
  text("runStatus", labels[run.phase] ?? run.phase); $("runStatus").className = `health ${runAppearance(run.phase)}`;
  text("runReason", reasons[run.terminationReason] ?? run.error ?? snapshot?.error ?? (run.phase === "CANCELLED" ? "중단된 작업입니다. 실행 기록은 보존됩니다." : run.phase === "AWAITING_APPLY" ? "이 요구사항 버전과 후보의 감사가 통과했습니다. 적용은 별도 명령입니다." : run.phase === "APPLIED" ? "감사한 후보가 반영됐습니다. 배포·추가 환경 검증의 성공을 뜻하지 않습니다." : `감사 결과: ${run.auditResult ?? "미판정"} · 미해결 필수 지적 ${(run.findings ?? []).filter((f) => f.required && ["OPEN","FIX_SUBMITTED"].includes(f.status)).length}건`));
  text("runTime", `접수 ${time(run.createdAt)} · 상태 발생 ${time(run.updatedAt)}${connected ? "" : ` · 연결 끊김, 마지막 확인 ${time(lastConfirmed)}`}`);
  const stopReason = (operations.runCommand !== "IDLE") ? "현재 요청을 처리 중이라 중단 명령을 보낼 수 없습니다. 처리가 끝난 뒤 다시 누르세요."
    : !connected ? "서버 연결이 끊겨 중단할 수 없습니다. 서버 연결을 먼저 복구하세요."
    : terminal.has(run.phase) ? "이미 종료된 작업이라 중단할 수 없습니다. 왼쪽 ‘새 작업’을 사용하거나 다른 미종료 작업을 선택하세요."
    : run.phase === "RECOVERY_REQUIRED" ? "자동 중단 여부를 확정할 수 없습니다. 아래 복구 확인 3개 항목을 완료한 뒤 ‘확인 기록 후 실행 폐기’를 누르세요."
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
  if (renderedRecords !== signature) { renderedRecords = signature; renderAudit(); renderLog(); }
}
async function command(type, payload = {}) {
  if (operations.runCommand !== "IDLE" || !capabilities().has(type)) return;
  const run = snapshot?.run, target = run?.runId;
  const body = { type, requestId:crypto.randomUUID(), payload:{ ...payload, runId:workflow.runId, expectedVersion:workflow.runVersion } };
  operations.runCommand = "RUNNING"; lastCommandError = ""; render();
  try {
    const result = await request("/api/commands", { method:"POST", body:JSON.stringify(body) });
    if (snapshot?.run?.runId === target) text("commandResult", "서버가 명령을 처리했습니다. 실제 상태와 적용 결과를 확인하세요.");
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
  $("saveProject").disabled = !caps.has("preparation.approve") || operations.approval !== "IDLE";
  $("closeProject").disabled = !caps.has("preparation.cancel") || operations.preparationStart !== "IDLE";
  for (const button of document.querySelectorAll("[data-web-command]")) button.disabled = !caps.has(button.dataset.webCommand) || operations.webTurn !== "IDLE";
}
function renderInitialRequest() {
  const initial = workflow.stage === "START" && preparation?.lifecycle === "ACTIVE";
  const pending = initial && ["INITIALIZING", "WAITING_WEB_RESPONSE"].includes(preparation.state);
  const recovery = document.querySelector(".session-recovery");
  $("startRecovery").replaceChildren();
  if (recovery) (initial ? $("startRecovery") : $("proposalSummary")).append(recovery);
  $("startRecovery").hidden = !initial || pending;
  $("startProgress").hidden = !initial;
  $("startProgress").classList.toggle("is-waiting", pending);
  $("startProgress").setAttribute("aria-busy", String(pending));
  text("startProgressTitle", preparation?.state === "INITIALIZING" ? "ChatGPT 대화에 연결하고 있습니다"
    : pending ? "ChatGPT 응답을 기다리고 있습니다" : "요청 상태 확인이 필요합니다");
  text("startProgressDetail", pending ? "응답 확인이 끝나면 준비 화면으로 이동합니다."
    : preparation?.error?.message ?? "전송 상태를 확인한 뒤 계속할 수 있습니다.");
  for (const id of ["objective", "startRoot", "conversationUrl"]) {
    $(id).readOnly = initial;
    if (initial) $(id).value = id === "objective" ? preparation.objective : id === "startRoot" ? preparation.targetRoot : (preparation.webSession?.conversationUrl ?? preparation.conversationUrl);
  }
  $("cancelInitialPreparation").hidden = !initial;
  $("cancelInitialPreparation").disabled = !capabilities().has("preparation.cancel");
}
function renderPreparation() {
  if (!preparation) { preparationSignature = ""; return; }
  const signature = JSON.stringify(preparation);
  if (signature === preparationSignature) return;
  preparationSignature = signature;
  $("planningObjective").value = preparation.objective;
  $("planningUrl").value = preparation.webSession?.conversationUrl ?? preparation.conversationUrl ?? "";
  $("projectRoot").value = preparation.targetRoot;
  const summary = $("proposalSummary"); summary.replaceChildren();
  summary.append(node("p", agreement?.summary ?? "설계 대화를 준비하고 있습니다."));
  for (const question of agreement?.unresolvedQuestions ?? []) summary.append(node("p", question));
  const discussion = node("section", "", "discussion");
  discussion.append(node("h2", "준비 대화"));
  for (const turn of preparation.discussion ?? []) {
    const row = node("article", "", "record");
    row.append(node("strong", turn.actor === "USER" ? "사용자" : "웹 설계자"), node("pre", turn.content));
    discussion.append(row);
  }
  summary.append(discussion);
  $("projectRequirements").replaceChildren();
  for (const item of agreement?.requirements ?? []) {
    const row = node("article", "", "record");
    row.append(node("p", item.statement), node("p", item.acceptanceCriteria));
    $("projectRequirements").append(row);
  }
  const session = preparation.webSession;
  const diagnostic = preparation.diagnostics ?? session?.diagnostics ?? {};
  const recovery = node("section", "", "session-recovery");
  const activeDelivery = preparation.deliveries?.find(item => item.deliveryId === session?.activeDeliveryId);
  if (activeDelivery) {
    const states = { RESERVED: "연결 확인 중 · 미전송", DISPATCHING: "전송 확인 중", SUBMITTED: "응답 대기",
      RESPONSE_STARTED: "응답 생성 중", RESPONSE_COMPLETED: "응답 수신 · 검증 또는 수신 확인 필요",
      ACKNOWLEDGED: "응답 처리 완료", RECOVERY_REQUIRED: "전송 상태 확인 필요", FAILED: "요청 실패" };
    recovery.append(node("p", activeDelivery.processingState === "ACK_PENDING" ? "응답 검증·저장 완료 · 전송 정리 확인 필요"
      : states[activeDelivery.state] ?? "처리 상태 미확인"));
    const failures = activeDelivery.validation?.checks?.filter(item => !item.passed) ?? [];
    if (failures.length) {
      recovery.append(node("p", "확인하지 못한 항목: " + failures.map(item => item.name).join(", ")));
      const detail = node("details", "");
      detail.append(node("summary", "응답 확인 상세"), node("pre", JSON.stringify(failures, null, 2)));
      recovery.append(detail);
    }
  }
  recovery.append(node("h2", "대화 · 전송 상태"));
  const bool = (value) => value === true ? "예" : value === false ? "아니오" : "확인되지 않음";
  for (const [label, value] of [
    ["작업", preparation.objective], ["준비 ID", preparation.preparationId],
    ["대화", session?.conversationUrl], ["대화 ID", session?.conversationId],
    ["sessionId", session?.sessionId], ["deliveryId", session?.activeDeliveryId],
    ["연결 상태", session?.bindingState], ["탭 도달 가능", bool(diagnostic.pageReachable)],
    ["정확한 conversation", bool(diagnostic.exactConversation)],
    ["pageBusy", bool(diagnostic.pageBusy)], ["generating", bool(diagnostic.generating)],
    ["extensionBusy", bool(diagnostic.extensionBusy)], ["pageStatus", diagnostic.pageStatus],
    ["canFocus", bool(diagnostic.canFocus)], ["canStop", bool(diagnostic.canStop)],
    ["해당 전송 종료 확인", bool(diagnostic.canRecover)],
  ]) recovery.append(node("p", label + ": " + (value ?? "확인되지 않음")));
  for (const [label, action] of [["대화 열기", "web.focus"], ["상태 확인", "web.inspect"], ["생성 종료", "web.stop"], ["응답 다시 확인", "web.reconcile"]]) {
    const button = node("button", action === "web.reconcile" && activeDelivery?.processingState === "ACK_PENDING" ? "수신 확인 다시 처리" : label); button.type = "button";
    button.dataset.webCommand = action;
    button.addEventListener("click", () => webSessionCommand(action)); recovery.append(button);
  }
  summary.append(recovery);
  const error = preparation.error;
  const progress = { INITIALIZING: "ChatGPT 대화에 연결 중입니다.",
    WAITING_WEB_RESPONSE: "웹 요청을 처리 중입니다. 응답 확인 전에는 승인할 수 없습니다.",
    DISCUSSING: "웹 응답을 확인했습니다. 질문에 답하며 작업 범위를 정하세요.",
    AGREEMENT_READY: "웹이 완료 기준을 제안했습니다. 내용을 검토하고 승인하세요.",
    APPROVING: "승인을 처리하고 작업을 생성하고 있습니다. 작업 생성이 확인되면 이동합니다.",
    RECOVERY_REQUIRED: "전송 또는 응답 확인이 끝나지 않았습니다. 상태 확인이 필요합니다." };
  text("proposalStatus", error ? (error.code ?? "ERROR") + ": " + error.message : progress[workflow.state] ?? workflow.state);
}
async function preparationMutation(operation, capability, url, payload = {}) {
  if (operations[operation] !== "IDLE" || !capabilities().has(capability)) return false;
  if (["preparation.start", "preparation.reply"].includes(capability) && !webConnected()) return false;
  const requestId = crypto.randomUUID();
  const expectedVersion = capability === "preparation.start" ? 0 : workflow.preparationVersion;
  operations[operation] = "RUNNING"; render();
  try {
    await request(url, { method: "POST", body: JSON.stringify({ ...payload, requestId, expectedVersion }) });
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
async function webSessionCommand(commandType) {
  const session = preparation?.webSession;
  if (!session) return;
  await preparationMutation("webTurn", commandType, "/api/preparations/web", {
    command: commandType, preparationId: workflow.preparationId,
    sessionId: session.sessionId, conversationId: session.conversationId,
    conversationUrl: session.conversationUrl, deliveryId: session.activeDeliveryId,
  });
}
async function beginPreparation() {
  if ($("planRun").disabled) return;
  const objective = $("objective").value, targetRoot = $("startRoot").value.trim(), conversationUrl = $("conversationUrl").value.trim();
  if (!objective.trim() || !targetRoot || !/^https:\/\/chatgpt\.com\/c\/[^/?#\s]+$/u.test(conversationUrl)) {
    text("startReason", "첫 부탁·프로젝트 폴더·ChatGPT 대화 URL을 모두 입력하세요."); return;
  }
  await preparationMutation("preparationStart", "preparation.start", "/api/preparations", { objective, targetRoot, conversationUrl });
}
$("startForm").addEventListener("submit", (event) => { event.preventDefault(); return beginPreparation(); });
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
$("newRun").addEventListener("click", () => { if (!$("newRun").disabled) { selected = ""; requestedView = "start"; refresh(); } });
$("cancelInitialPreparation").addEventListener("click", () => preparationMutation("preparationStart", "preparation.cancel",
  "/api/preparations/" + encodeURIComponent(workflow.preparationId) + "/cancel"));
$("showUnfinishedRun").addEventListener("click", () => {
  const unfinished = snapshot?.runs?.find((run) => !terminal.has(run.phase));
  if (unfinished) { selected = unfinished.runId; refresh(); }
});
for (const id of ["recoveryExternal", "recoveryTarget", "recoveryReason"]) $(id).addEventListener("input", render);
$("abandonRun").addEventListener("click", () => {
  if (!$("abandonRun").disabled) command("run.abandon", { externalTerminationConfirmed:$("recoveryExternal").checked, targetInspected:$("recoveryTarget").checked, reason:$("recoveryReason").value.trim() });
});
$("stopRun").addEventListener("click", () => command("run.stop"));
$("applyCode").addEventListener("click", () => { const r = snapshot.run; command("code.apply", { candidateId:r.candidate.candidateId, reviewId:r.reviews.at(-1).reviewId, artifactHash:r.capture.artifact.sha256, baseCommit:r.baseCommit }); });
$("exportEvidence").addEventListener("click", async () => { const result = await command("evidence.export"); if (!result) return; const url = URL.createObjectURL(new Blob([JSON.stringify(result,null,2)], { type:"application/json" })); const a = node("a", ""); a.href = url; a.download = `${result.runId ?? "audit"}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
for (const [id, audit] of [["showAudit",true],["showLog",false]]) $(id).addEventListener("click", () => { $("auditPanel").hidden = !audit; $("logPanel").hidden = audit; $("showAudit").setAttribute("aria-pressed", String(audit)); $("showLog").setAttribute("aria-pressed", String(!audit)); });
$("closeEvidence").addEventListener("click", () => $("evidenceDialog").close());
$("nextEvidence").addEventListener("click", () => { if (evidencePage?.target === snapshot?.run?.runId) openEvidence(evidencePage.id, evidencePage.next); });
async function poll() { await refresh(); setTimeout(poll, 2500); }
poll();
