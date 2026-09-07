const $ = (id) => document.getElementById(id);
let token = "", snapshot = null, selected = "", connected = false, pending = false, showStart = true;
let sequence = 0, lastConfirmed = null, evidencePage = null;
let renderedRecords = "", lastCommandError = "";
const openFindings = new Set();
const terminal = new Set(["APPLIED", "CANCELLED", "INCONCLUSIVE", "FAILED", "COMPLETE"]);
const labels = { CREATED:"접수됨", PROVISIONING:"연결 준비 중", WORKER_RUNNING:"구현·수정 중", CANDIDATE_CAPTURE:"후보 캡처 중", VERIFYING:"검증 중", REVIEW_RUNNING:"웹 감사 중", REPORT_REPAIR:"감사 응답 보완 중", EVIDENCE_SUPPLEMENT:"같은 후보 증거 보완 중", REWORK:"수정 대기", HOLD:"판단 보류", AWAITING_APPLY:"감사 통과·적용 대기", APPLYING:"적용 중", APPLIED:"적용됨", INCONCLUSIVE:"미해결 종료", CANCELLED:"사용자 중단", RECOVERY_REQUIRED:"복구 확인 필요", FAILED:"오류 종료", STOPPING:"중단 확인 중", COMPLETE:"과거 실행 종료" };
const reasons = { ITERATION_LIMIT:"구현 회차 한도에 도달했습니다. 남은 필수 지적을 확인하세요.", EVIDENCE_LIMIT:"증거 보완 한도에 도달했습니다. 부족한 자료를 확인하세요.", REPORT_REPAIR_LIMIT:"감사 보고서 보완 한도에 도달했습니다.", USER_DECISION_REQUIRED:"명세·검증 범위에 대한 사용자 판단이 필요합니다.", TOTAL_TIME_LIMIT:"전체 시간 한도에 도달했습니다. 외부 실행 상태를 확인해야 합니다.", STOP_UNCERTAIN:"중단을 요청했으나 외부 작업 종료를 확인하지 못했습니다.", USER_STOP:"후속 구현·감사·적용 배정을 중단했습니다." };
function text(id, value) { $(id).textContent = value ?? ""; }
function time(value) { return value ? new Date(value).toLocaleString("ko-KR") : "확인 전"; }
function node(tag, value, className = "") { const n = document.createElement(tag); n.textContent = value; n.className = className; return n; }
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, cache:"no-store", headers:{ "Content-Type":"application/json", ...(token ? { Authorization:`Bearer ${token}` } : {}), ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.payload?.message || body.error || `요청 실패 (${response.status})`), { status: response.status });
  return body;
}
async function refresh() {
  const current = ++sequence, target = selected;
  try {
    if (!token) token = (await request("/api/dashboard/session", { method:"POST", body:"{}" })).token;
    const result = await request(`/api/state${target ? `?runId=${encodeURIComponent(target)}` : ""}`);
    if (current !== sequence || target !== selected) return;
    snapshot = result; connected = true; lastConfirmed = new Date().toISOString();
    text("connectionNotice", "");
  } catch (error) {
    if (current !== sequence || target !== selected) return;
    connected = false;
    if (error.status === 401) token = "";
    text("connectionNotice", `연결을 확인해 주세요. ${error.message} · 마지막 확인 ${time(lastConfirmed)}`);
  }
  render();
}
function capabilities() { return new Set(connected ? snapshot?.commandCapabilities ?? [] : []); }
function evidenceLinks(container, refs) {
  const links = node("div", "", "links");
  for (const id of refs ?? []) {
    const button = node("button", `근거 ${id.slice(-8)}`); button.disabled = !connected || pending;
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
    evidenceLinks(row, a?.evidenceRefs); assessments.append(row);
  }
  if (!assessments.children.length) assessments.append(node("p", "요구사항별 감사 기록이 없습니다. 과거 점수 기반 통과는 현재 기준 충족을 뜻하지 않습니다.", "muted"));
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
  if (!findings.children.length) findings.append(node("p", "등록된 지적이 없습니다. 감사 통과를 뜻하지 않습니다.", "muted"));
  for (const e of snapshot?.evidence ?? []) {
    const row = node("article", "", "record");
    row.append(node("strong", `${e.kind} · ${e.producer}${e.valid === false ? " · 후보 증거로 무효" : ""}`), node("p", `${e.candidateId} · ${time(e.createdAt)}`, "muted"), node("p", JSON.stringify(e.result)));
    evidenceLinks(row, [e.evidenceId]); evidence.append(row);
  }
  text("candidateDetails", JSON.stringify({ project:run?.projectRef, requirements:run?.requirements, candidate:run?.candidate, missingInformation:run?.missingInformation, application:run?.application }, null, 2));
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
  text("serverSignal", connected ? "서버 · 연결됨" : "서버 · 확인 필요"); $("serverSignal").className = connected ? "ok" : "";
  text("cliSignal", connected ? preflight?.checks?.codexExecutableConfigured ? "CLI · 경로 설정됨" : "CLI · 설정 필요" : "CLI · 확인 전");
  text("webSignal", connected ? preflight?.checks?.extensionAuthenticated ? "웹 · 확장 인증됨" : "웹 · 연결 대기" : "웹 · 확인 전");
  text("refreshSignal", `런 · ${connected ? "갱신됨" : "마지막 확인"} ${time(lastConfirmed)}`);
  const busy = snapshot?.runs?.some((r) => !terminal.has(r.phase));
  $("newRun").disabled = pending || busy; text("newRunReason", busy ? "미종료 런을 확인하세요. 한 번에 한 런을 실행합니다." : "과거 기록은 언제든 선택할 수 있습니다.");
  const list = $("runList"); list.replaceChildren();
  for (const r of [...snapshot?.runs ?? []].reverse()) {
    const button = node("button", r.objective, `run-item${!showStart && r.runId === run?.runId ? " active" : ""}`);
    button.append(node("small", labels[r.phase] ?? r.phase));
    button.addEventListener("click", () => { selected = r.runId; showStart = false; snapshot = null; text("commandResult", ""); refresh(); }); list.append(button);
  }
  $("startPanel").hidden = !showStart; $("runPanel").hidden = showStart || !run;
  const project = preflight?.project;
  const projectContainer = $("projectSummary"); projectContainer.replaceChildren();
  if (project) {
    projectContainer.append(node("p", `${project.projectId} · ${project.targetRoot}`), node("p", `기준 ${project.requirementsId} / ${project.revision}`));
    for (const req of project.requirements.items) projectContainer.append(node("p", `${req.requirementId} · ${req.statement}`, "muted"));
  } else projectContainer.append(node("p", preflight?.projectError ?? "프로젝트 설정 확인 전", "muted"));
  const reason = pending ? "요청 처리 중입니다." : !connected ? "서버 연결을 확인하세요." : !preflight?.readyForProvisioning ? preflight?.projectError || `시작 조건을 확인하세요: ${preflight?.missing?.join(", ")}`
    : !caps.has("run.start") ? "미종료 런이 있거나 시작 조건이 준비되지 않았습니다." : !$('objective').value.trim() ? "작업 목표를 입력하세요."
      : !/^https:\/\/chatgpt\.com\/c\/[^/?#\s]+$/u.test($("conversationUrl").value.trim()) ? "기존 ChatGPT 대화 URL을 입력하세요." : "";
  $("startRun").disabled = Boolean(reason); text("startReason", lastCommandError || reason || "접수 후 같은 런에서 준비·구현·감사 진행과 실패 이유를 확인할 수 있습니다.");
  if (!run) return;
  text("runObjective", run.objective); text("runContext", `${run.projectRef?.projectId ?? "과거 런"} · 구현 ${run.iteration ?? 0}회 · ${run.activeActor ?? "대기"}`);
  text("runStatus", labels[run.phase] ?? run.phase); $("runStatus").className = ["HOLD", "INCONCLUSIVE", "RECOVERY_REQUIRED"].includes(run.phase) ? "warn" : run.phase === "FAILED" ? "error" : "";
  text("runReason", reasons[run.terminationReason] ?? run.error ?? (run.phase === "AWAITING_APPLY" ? "이 요구사항 버전과 후보의 감사가 통과했습니다. 적용은 별도 명령입니다." : run.phase === "APPLIED" ? "감사한 후보가 반영됐습니다. 배포·추가 환경 검증의 성공을 뜻하지 않습니다." : `감사 결과: ${run.auditResult ?? "미판정"} · 미해결 필수 지적 ${(run.findings ?? []).filter((f) => f.required && ["OPEN","FIX_SUBMITTED"].includes(f.status)).length}건`));
  text("runTime", `접수 ${time(run.createdAt)} · 상태 발생 ${time(run.updatedAt)}${connected ? "" : ` · 연결 끊김, 마지막 확인 ${time(lastConfirmed)}`}`);
  $("stopRun").disabled = pending || !caps.has("run.stop"); $("applyCode").disabled = pending || !caps.has("code.apply"); $("exportEvidence").disabled = pending || !caps.has("evidence.export");
  text("commandReason", pending ? "명령 결과를 확인하고 있습니다." : !connected ? "연결이 끊겨 명령을 보낼 수 없습니다." : !caps.has("code.apply") ? "적용은 유효한 감사 통과 후보가 준비된 경우에만 가능합니다. 종료된 작업은 다시 중단할 수 없습니다." : "후보와 기준 버전을 확인한 뒤 적용할 수 있습니다.");
  const signature = `${run.runId}/${run.version}/${connected}/${pending}`;
  if (renderedRecords !== signature) { renderedRecords = signature; renderAudit(); renderLog(); }
}
async function command(type, payload = {}, start = false) {
  if (pending || !connected) return;
  const run = snapshot?.run, target = run?.runId;
  const body = { type, requestId:crypto.randomUUID(), payload:{ ...payload, ...(start ? { expectedVersion:0 } : { runId:target, expectedVersion:run.version }) } };
  pending = true; lastCommandError = ""; render();
  try {
    const result = await request("/api/commands", { method:"POST", body:JSON.stringify(body) });
    if (start) { selected = result.payload.runId; showStart = false; }
    if (start || selected === target) text("commandResult", "서버가 명령을 처리했습니다. 실제 상태와 적용 결과를 확인하세요.");
    return result.payload;
  } catch (error) {
    lastCommandError = `요청 결과를 확인하세요: ${error.message}. 응답 유실 시 자동 재전송하지 않습니다. 실행 기록을 먼저 확인하세요.`;
    text(start ? "startReason" : "commandResult", lastCommandError);
  } finally { pending = false; await refresh(); }
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
$("startForm").addEventListener("submit", (e) => { e.preventDefault(); if (!$("startRun").disabled) command("run.start", { mode:"CODE_CHANGE", objective:$("objective").value.trim(), conversationUrl:$("conversationUrl").value.trim() }, true); });
$("objective").addEventListener("input", render); $("conversationUrl").addEventListener("input", render);
$("newRun").addEventListener("click", () => { showStart = true; render(); });
$("stopRun").addEventListener("click", () => command("run.stop"));
$("applyCode").addEventListener("click", () => { const r = snapshot.run; command("code.apply", { candidateId:r.candidate.candidateId, reviewId:r.reviews.at(-1).reviewId, artifactHash:r.capture.artifact.sha256, baseCommit:r.baseCommit }); });
$("exportEvidence").addEventListener("click", async () => { const result = await command("evidence.export"); if (!result) return; const url = URL.createObjectURL(new Blob([JSON.stringify(result,null,2)], { type:"application/json" })); const a = node("a", ""); a.href = url; a.download = `${result.runId ?? "audit"}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
for (const [id, audit] of [["showAudit",true],["showLog",false]]) $(id).addEventListener("click", () => { $("auditPanel").hidden = !audit; $("logPanel").hidden = audit; $("showAudit").setAttribute("aria-pressed", String(audit)); $("showLog").setAttribute("aria-pressed", String(!audit)); });
$("closeEvidence").addEventListener("click", () => $("evidenceDialog").close());
$("nextEvidence").addEventListener("click", () => { if (evidencePage?.target === snapshot?.run?.runId) openEvidence(evidencePage.id, evidencePage.next); });
async function poll() { await refresh(); setTimeout(poll, 2500); }
poll();
