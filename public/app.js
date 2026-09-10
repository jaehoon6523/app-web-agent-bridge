import { normalizeDashboardState } from "./dashboard-model.js";
const $ = (id) => document.getElementById(id);
let token = "", snapshot = null, selected = "", connected = false;
let workflow = { stage: "START", state: "START_IDLE", preparationId: null, preparationVersion: null, runId: null, runVersion: null };
let sequence = 0, lastConfirmed = null, evidencePage = null;
let renderedRecords = "", lastCommandError = "", recoveryRunId = null, readinessSignature = "";
let agreement = null, preparation = null;
const operations = { folderPicker: "IDLE", preparationStart: "IDLE", webTurn: "IDLE", approval: "IDLE", runCommand: "IDLE" };
let preparationSignature = "";
const unknownRequests = new Map();

const openFindings = new Set();
const terminal = new Set(["APPLIED", "CANCELLED", "INCONCLUSIVE", "FAILED", "COMPLETE"]);
const labels = { CREATED:"접수됨", PROVISIONING:"연결 준비 중", WORKER_RUNNING:"구현·수정 중", CANDIDATE_CAPTURE:"후보 캡처 중", VERIFYING:"검증 중", REVIEW_RUNNING:"웹 감사 중", REPORT_REPAIR:"감사 응답 보완 중", EVIDENCE_SUPPLEMENT:"같은 후보 증거 보완 중", REWORK:"수정 대기", HOLD:"판단 보류", AWAITING_APPLY:"감사 통과·적용 대기", APPLYING:"적용 중", APPLIED:"적용됨", INCONCLUSIVE:"미해결 종료", CANCELLED:"사용자 중단", RECOVERY_REQUIRED:"복구 확인 필요", FAILED:"오류 종료", STOPPING:"중단 확인 중", COMPLETE:"과거 실행 종료" };
const reasons = { RECOVERY_ABANDONED:"사용자가 외부 종료와 대상 상태를 확인하고 실행을 폐기했습니다. 감사 기록과 작업 사본은 보존됩니다.", ITERATION_LIMIT:"구현 회차 한도에 도달했습니다. 남은 필수 지적을 확인하세요.", EVIDENCE_LIMIT:"증거 보완 한도에 도달했습니다. 부족한 자료를 확인하세요.", REPORT_REPAIR_LIMIT:"감사 보고서 보완 한도에 도달했습니다.", USER_DECISION_REQUIRED:"명세·검증 범위에 대한 사용자 판단이 필요합니다.", TOTAL_TIME_LIMIT:"전체 시간 한도에 도달했습니다. 외부 실행 상태를 확인해야 합니다.", STOP_UNCERTAIN:"중단을 요청했으나 외부 작업 종료를 확인하지 못했습니다.", USER_STOP:"후속 구현·감사·적용 배정을 중단했습니다." };
function text(id, value) { $(id).textContent = value ?? ""; }
function time(value) { return value ? new Date(value).toLocaleString("ko-KR") : "확인 전"; }
function node(tag, value, className = "") { const n = document.createElement(tag); n.textContent = value; n.className = className; return n; }
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
    const result = await request(`/api/state${target ? `?runId=${encodeURIComponent(target)}` : ""}`);
    if (current !== sequence || target !== selected) return;
    if (!result || !Array.isArray(result.runs) || !Array.isArray(result.commandCapabilities) || !result.preflight || typeof result.preflight !== "object") throw new Error("서버 상태 응답 형식을 확인하세요.");
    if (!result.workflow) throw new Error("서버가 WORKFLOW_CONTRACT 상태를 제공하지 않습니다. 준비 API와 workflow projection 구현이 필요합니다.");
    const canonical = normalizeDashboardState(result);
    snapshot = result; workflow = canonical.workflow; preparation = canonical.preparation; agreement = preparation?.agreement ?? null; connected = true;
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
    const button = node("button", `근거 ${id.slice(-8)}`); button.disabled = !connected || (operations.runCommand !== "IDLE");
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
    ? "아직 요구사항별 감사 결과가 없습니다." : "이전 대화 방식의 작업입니다. 대화 내용과 상태 변경은 ‘진행 기록’에서 확인하세요.", "muted"));
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
    ? "등록된 감사 지적이 없습니다." : "이전 대화 작업에는 요구사항별 감사 지적이 없습니다.", "muted"));
  for (const e of snapshot?.evidence ?? []) {
    const row = node("article", "", "record");
    row.append(node("strong", `${e.kind} · ${e.producer}${e.valid === false ? " · 후보 증거로 무효" : ""}`), node("p", `${e.candidateId} · ${time(e.createdAt)}`, "muted"), node("p", JSON.stringify(e.result)));
    evidenceLinks(row, [e.evidenceId]); evidence.append(row);
  }
  text("candidateDetails", JSON.stringify({ project:run?.projectRef, requirements:run?.requirements, candidate:run?.candidate, missingInformation:run?.missingInformation, application:run?.application, recovery:run?.recovery }, null, 2));
}
function renderLog() {
  const log = $("eventLog"); log.replaceChildren();
  const records = [...(snapshot?.events ?? []).map((e) => ({ at:e.createdAt, title:e.type, content:JSON.stringify(e.payload) })),
    ...(snapshot?.messages ?? []).map((m) => ({ at:m.createdAt, title:m.fromActor ?? "CONTROLLER", content:m.content }))].sort((a,b) => String(a.at).localeCompare(String(b.at)));
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
  health("engineHealth", "engine", !connected || typeof checks?.codexExecutableConfigured !== "boolean" ? "unknown" : "warn",
    !connected || typeof checks?.codexExecutableConfigured !== "boolean" ? "확인 전" : checks.codexExecutableConfigured ? "경로 설정됨 · 실제 실행 상태는 확인 전" : "경로 설정 필요");
  health("channelHealth", "channel", !connected || typeof checks?.extensionAuthenticated !== "boolean" ? "unknown" : checks.extensionAuthenticated ? "ok" : "warn",
    !connected || typeof checks?.extensionAuthenticated !== "boolean" ? "확인 전" : checks.extensionAuthenticated ? "확장 인증됨" : "확장 연결 대기");
  text("serverSignal", connected ? "서버 · 연결됨" : "서버 · 확인 필요"); $("serverSignal").className = connected ? "ok" : "";
  text("cliSignal", connected ? preflight?.checks?.codexExecutableConfigured ? "CLI · 경로 설정됨" : "CLI · 설정 필요" : "CLI · 확인 전");
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
  $("projectPanel").hidden = !preparing;
  $("runPanel").hidden = !["WORK", "RESULT"].includes(workflow.stage) || !run;
  const project = preflight?.project;
  const projectContainer = $("projectSummary"); projectContainer.replaceChildren();
  if (project) {
    projectContainer.append(node("p", `${project.projectId} · ${project.targetRoot}`), node("p", `기준 ${project.requirementsId} / ${project.revision}`));
    for (const req of project.requirements.items) projectContainer.append(node("p", `${req.requirementId} · ${req.statement}`, "muted"));
  } else projectContainer.append(node("p", connected ? "사용할 프로젝트가 아직 준비되지 않았습니다." : "연결 후 프로젝트 설정을 확인합니다.", "muted"));
  $("planRun").disabled = !caps.has("preparation.start") || operations.preparationStart !== "IDLE" || operations.folderPicker !== "IDLE";
  $("chooseFolder").disabled = !connected || operations.folderPicker !== "IDLE";
  $("newRun").disabled = !caps.has("preparation.start") || ["PREPARE", "WORK"].includes(workflow.stage);
  text("newRunReason", workflow.stage === "PREPARE" ? "현재 준비를 유지합니다. 종료하려면 ‘준비 취소’를 선택하세요." : "새 준비는 서버가 허용할 때 시작할 수 있습니다.");
  if (recoveryRunId !== run?.runId) {
    recoveryRunId = run?.runId;
    $("recoveryExternal").checked = false; $("recoveryTarget").checked = false; $("recoveryReason").value = "";
  }
  $("recoveryPanel").hidden = run?.phase !== "RECOVERY_REQUIRED";
  $("abandonRun").disabled = (operations.runCommand !== "IDLE") || !caps.has("run.abandon") || !$("recoveryExternal").checked || !$("recoveryTarget").checked || !$("recoveryReason").value.trim();
  for (const [id, capability] of [["stopRun", "run.stop"], ["applyCode", "code.apply"], ["exportEvidence", "evidence.export"]]) {
    $(id).disabled = !run || operations.runCommand !== "IDLE" || !caps.has(capability);
  }
  if (!run) return;
  text("runObjective", run.objective); text("runContext", run.requirements
    ? `${run.projectRef?.projectId ?? "프로젝트"} · 구현 ${run.iteration ?? 0}회 · ${run.activeActor ?? "대기"}`
    : `이전 대화 작업 · ${run.activeActor ?? "대기"}`);
  text("runStatus", labels[run.phase] ?? run.phase); $("runStatus").className = `health ${runAppearance(run.phase)}`;
  text("runReason", reasons[run.terminationReason] ?? run.error ?? snapshot?.error ?? (run.phase === "CANCELLED" ? "중단된 작업입니다. 실행 기록은 보존됩니다." : run.phase === "AWAITING_APPLY" ? "이 요구사항 버전과 후보의 감사가 통과했습니다. 적용은 별도 명령입니다." : run.phase === "APPLIED" ? "감사한 후보가 반영됐습니다. 배포·추가 환경 검증의 성공을 뜻하지 않습니다." : `감사 결과: ${run.auditResult ?? "미판정"} · 미해결 필수 지적 ${(run.findings ?? []).filter((f) => f.required && ["OPEN","FIX_SUBMITTED"].includes(f.status)).length}건`));
  text("runTime", `접수 ${time(run.createdAt)} · 상태 발생 ${time(run.updatedAt)}${connected ? "" : ` · 연결 끊김, 마지막 확인 ${time(lastConfirmed)}`}`);
  $("stopRun").disabled = (operations.runCommand !== "IDLE") || !caps.has("run.stop"); $("applyCode").disabled = (operations.runCommand !== "IDLE") || !caps.has("code.apply"); $("exportEvidence").disabled = (operations.runCommand !== "IDLE") || !caps.has("evidence.export");
  text("stopReason", (operations.runCommand !== "IDLE") ? "요청을 처리하고 있습니다." : !connected ? "서버에 다시 연결되면 중단할 수 있습니다."
    : terminal.has(run.phase) ? "이미 종료된 작업입니다. 다른 미종료 작업이 있다면 왼쪽 안내에서 선택하세요."
    : run.phase === "RECOVERY_REQUIRED" ? "외부 작업의 종료를 확인한 뒤 아래 ‘복구 확인 후 실행 폐기’를 진행하세요."
    : caps.has("run.stop") ? "이 작업의 후속 실행을 중단합니다. 실행 기록은 보존됩니다."
    : run.phase === "APPLYING" ? "변경 사항을 적용 중입니다. 적용 결과가 확인될 때까지 기다려 주세요."
    : "현재 상태에서는 중단할 수 없습니다. 연결과 실행 상태를 확인하세요.");
  text("commandReason", (operations.runCommand !== "IDLE") ? "명령 결과를 확인하고 있습니다." : !connected ? "연결이 끊겨 명령을 보낼 수 없습니다." : !caps.has("code.apply") ? "적용은 유효한 감사 통과 후보가 준비된 경우에만 가능합니다. 종료된 작업은 다시 중단할 수 없습니다." : "후보와 기준 버전을 확인한 뒤 적용할 수 있습니다.");
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
  $("nextEvidence").disabled = !result.omittedAfter;
  if (!$("evidenceDialog").open) $("evidenceDialog").showModal();
}

function proposalControls() {
  const caps = capabilities();
  $("proposeRequirements").hidden = true;
  $("reviseRequirements").disabled = !caps.has("preparation.reply") || operations.webTurn !== "IDLE";
  $("saveProject").disabled = !caps.has("preparation.approve") || operations.approval !== "IDLE";
  $("closeProject").disabled = !caps.has("preparation.cancel") || operations.preparationStart !== "IDLE";
  for (const button of document.querySelectorAll("[data-web-command]")) button.disabled = !caps.has(button.dataset.webCommand) || operations.webTurn !== "IDLE";
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
    ["canRecover", bool(diagnostic.canRecover)],
  ]) recovery.append(node("p", label + ": " + (value ?? "확인되지 않음")));
  for (const [label, action] of [["대화 열기", "web.focus"], ["상태 확인", "web.inspect"], ["생성 종료", "web.stop"], ["전송 기록 정리", "web.reconcile"]]) {
    const button = node("button", label); button.type = "button";
    button.dataset.webCommand = action;
    button.addEventListener("click", () => webSessionCommand(action)); recovery.append(button);
  }
  summary.append(recovery);
  const error = preparation.error;
  text("proposalStatus", error ? (error.code ?? "ERROR") + ": " + error.message : workflow.state);
}
async function preparationMutation(operation, capability, url, payload = {}) {
  if (operations[operation] !== "IDLE" || !capabilities().has(capability)) return false;
  const requestId = crypto.randomUUID();
  const expectedVersion = workflow.stage === "START" ? 0 : workflow.preparationVersion;
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
$("newRun").addEventListener("click", () => { if (!$("newRun").disabled) { selected = ""; refresh(); } });
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
