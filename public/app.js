const $ = (id) => document.getElementById(id);
let token = "", snapshot = null, selected = "", connected = false, pending = false, showStart = true;
let sequence = 0, lastConfirmed = null, evidencePage = null;
let renderedRecords = "", lastCommandError = "", recoveryRunId = null;
let projectVersion = null, requirementEditors = [];
const missingLabels = { auditProjectConfigured: "프로젝트 설정", codexExecutableConfigured: "CLI 실행 경로",
  extensionAuthenticated: "브라우저 확장 연결", webAdapterAvailable: "웹 연결", commandAuthenticationConfigured: "서버 인증 설정", demoModeDisabled: "실제 실행 모드" };
const openFindings = new Set();
const terminal = new Set(["APPLIED", "CANCELLED", "INCONCLUSIVE", "FAILED", "COMPLETE"]);
const labels = { CREATED:"접수됨", PROVISIONING:"연결 준비 중", WORKER_RUNNING:"구현·수정 중", CANDIDATE_CAPTURE:"후보 캡처 중", VERIFYING:"검증 중", REVIEW_RUNNING:"웹 감사 중", REPORT_REPAIR:"감사 응답 보완 중", EVIDENCE_SUPPLEMENT:"같은 후보 증거 보완 중", REWORK:"수정 대기", HOLD:"판단 보류", AWAITING_APPLY:"감사 통과·적용 대기", APPLYING:"적용 중", APPLIED:"적용됨", INCONCLUSIVE:"미해결 종료", CANCELLED:"사용자 중단", RECOVERY_REQUIRED:"복구 확인 필요", FAILED:"오류 종료", STOPPING:"중단 확인 중", COMPLETE:"과거 실행 종료" };
const reasons = { RECOVERY_ABANDONED:"사용자가 외부 종료와 대상 상태를 확인하고 실행을 폐기했습니다. 감사 기록과 작업 사본은 보존됩니다.", ITERATION_LIMIT:"구현 회차 한도에 도달했습니다. 남은 필수 지적을 확인하세요.", EVIDENCE_LIMIT:"증거 보완 한도에 도달했습니다. 부족한 자료를 확인하세요.", REPORT_REPAIR_LIMIT:"감사 보고서 보완 한도에 도달했습니다.", USER_DECISION_REQUIRED:"명세·검증 범위에 대한 사용자 판단이 필요합니다.", TOTAL_TIME_LIMIT:"전체 시간 한도에 도달했습니다. 외부 실행 상태를 확인해야 합니다.", STOP_UNCERTAIN:"중단을 요청했으나 외부 작업 종료를 확인하지 못했습니다.", USER_STOP:"후속 구현·감사·적용 배정을 중단했습니다." };
function text(id, value) { $(id).textContent = value ?? ""; }
function time(value) { return value ? new Date(value).toLocaleString("ko-KR") : "확인 전"; }
function node(tag, value, className = "") { const n = document.createElement(tag); n.textContent = value; n.className = className; return n; }
function workerIdentity(run) {
  const worker = run?.worker ?? {};
  const provider = worker.provider ?? "codex";
  const model = worker.model ?? null;
  return model ? `${provider} / ${model}` : provider;
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
function addRequirementEditor(statement = "", criteria = "") {
  const row = node("div", "", "requirement-editor");
  const title = node("textarea", ""), acceptance = node("textarea", "");
  title.value = statement; acceptance.value = criteria;
  title.rows = 2; acceptance.rows = 2;
  const titleLabel = node("label", "요구사항"), acceptanceLabel = node("label", "통과 기준 (확인할 입력·결과·실패 조건)");
  titleLabel.append(title); acceptanceLabel.append(acceptance);
  const remove = node("button", "이 요구사항 삭제"); remove.type = "button";
  const editor = { row, title, acceptance };
  remove.addEventListener("click", () => {
    requirementEditors = requirementEditors.filter((item) => item !== editor);
    row.remove();
  });
  row.append(titleLabel, acceptanceLabel, remove);
  requirementEditors.push(editor); $("projectRequirements").append(row);
}
function basicProject() {
  const value = (id) => String($(id).value).trim();
  const number = (id) => {
    if (!value(id)) throw new Error("실행 한도와 제한 시간을 모두 입력하세요.");
    return Number(value(id));
  };
  const projectId = value("projectName"), execution = !$("projectCodeOnly").checked;
  if (!projectId || !value("projectRoot") || !value("projectRevision")) throw new Error("프로젝트 이름·저장소 경로·기준 버전을 입력하세요.");
  if (!requirementEditors.length || requirementEditors.some((r) => !r.title.value.trim() || !r.acceptance.value.trim())) {
    throw new Error("요구사항을 하나 이상 추가하고 각 통과 기준을 입력하세요.");
  }
  return { projectId, targetRoot: value("projectRoot"), requirements: {
    requirementsId: `${projectId}-requirements`, revision: value("projectRevision"), authority: "REQUIREMENTS_JSON",
    sourceRoles: [], unresolvedQuestions: [], items: requirementEditors.map((r, i) => ({
      requirementId: `R${i + 1}`, statement: r.title.value.trim(), acceptanceCriteria: r.acceptance.value.trim(), required: true,
      verificationMethod: { kinds: execution ? ["CODE_SNAPSHOT", "EXECUTION"] : ["CODE_SNAPSHOT"],
        description: execution ? "코드와 등록된 검증 명령의 실행 결과 확인" : "코드 스냅샷 검토",
        ...(execution ? { checks: [{ verificationId: "project-check", expectedExitCode: 0, requiredResultFiles: [] }] } : {}) }, sourceRefs: [],
    })),
  }, policy: { maxIterations: number("projectIterations"), maxEvidenceRounds: number("projectEvidenceRounds"),
    maxFormatRepairs: number("projectFormatRepairs"), totalTimeoutMs: number("projectTotalMinutes") * 60000,
    turnTimeoutMs: number("projectTurnMinutes") * 60000 }, verifications: execution ? [{
      verificationId: "project-check", executable: value("projectExecutable"),
      args: $("projectArgs").value.replace(/\r/gu, "").split("\n").filter((arg) => arg !== ""), cwd: value("projectCwd"),
      timeoutMs: number("projectVerificationSeconds") * 1000, purpose: "요구사항 검증", environmentId: "local", resultFiles: [],
    }] : [] };
}
function projectMode() {
  $("projectBasic").hidden = $("projectAdvanced").checked;
  $("projectAdvancedFields").hidden = !$("projectAdvanced").checked;
  $("projectExecution").hidden = $("projectCodeOnly").checked;
}
async function openProjectSettings() {
  if (pending || !connected) return;
  $("projectPanel").hidden = false; $("saveProject").disabled = true;
  render(); $("projectPanel").scrollIntoView?.({ block: "start" });
  text("projectStatus", "설정을 불러오고 있습니다.");
  try {
    const saved = await request("/api/project"); projectVersion = saved.version;
    $("projectRoot").value = saved.defaults.targetRoot;
    $("projectExecutable").value = saved.defaults.executable;
    $("projectArgs").value = "--test";
    requirementEditors = []; $("projectRequirements").replaceChildren();
    const project = saved.project;
    if (project) {
      $("projectName").value = project.projectId; $("projectRoot").value = project.targetRoot;
      $("projectRevision").value = project.requirements.revision;
      for (const r of project.requirements.items) addRequirementEditor(r.statement, r.acceptanceCriteria);
      $("projectCodeOnly").checked = !project.verifications.length;
      const verification = project.verifications[0];
      if (verification) {
        $("projectExecutable").value = verification.executable; $("projectArgs").value = verification.args.join("\n");
        $("projectCwd").value = verification.cwd; $("projectVerificationSeconds").value = verification.timeoutMs / 1000;
      }
      for (const [id, key, divisor] of [["projectIterations", "maxIterations", 1], ["projectEvidenceRounds", "maxEvidenceRounds", 1],
        ["projectFormatRepairs", "maxFormatRepairs", 1], ["projectTotalMinutes", "totalTimeoutMs", 60000], ["projectTurnMinutes", "turnTimeoutMs", 60000]]) {
        $(id).value = project.policy[key] / divisor;
      }
    } else addRequirementEditor();
    // Complex imported settings must not lose source snapshots or verification bindings.
    const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical(v[key])])) : v;
    const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
    const basic = project ? basicProject() : null;
    const compatible = project && equal(project.requirements, basic.requirements)
      && equal(project.verifications, basic.verifications);
    $("projectAdvanced").checked = Boolean(project && !compatible);
    $("projectAdvanced").disabled = Boolean(project && !compatible);
    $("projectJson").value = project ? JSON.stringify(project, null, 2) : "";
    projectMode(); $("saveProject").disabled = false;
    text("projectStatus", project ? "설정을 변경한 뒤 저장하세요. 요구사항 변경 시 기준 버전도 올려 주세요." : saved.error || "");
  } catch (error) { text("projectStatus", `설정을 불러오지 못했습니다: ${error.message}`); }
}
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
  text("serverSignal", connected ? "서버 · 연결됨" : "서버 · 확인 필요"); $("serverSignal").className = connected ? "ok" : "";
  const workerName = run ? workerIdentity(run) : "worker";
  text("cliSignal", connected ? run ? `Worker · ${workerName}` : preflight?.checks?.codexExecutableConfigured ? "Worker · 설정됨" : "Worker · 설정 필요" : "Worker · 확인 전");
  text("webSignal", connected ? preflight?.checks?.extensionAuthenticated ? "웹 · 확장 인증됨" : "웹 · 연결 대기" : "웹 · 확인 전");
  text("refreshSignal", `런 · ${connected ? "갱신됨" : "마지막 확인"} ${time(lastConfirmed)}`);
  const unfinished = snapshot?.runs?.find((r) => !terminal.has(r.phase));
  const busy = Boolean(unfinished);
  $("editProject").disabled = pending || !connected;
  $("newRun").disabled = pending || busy; text("newRunReason", busy ? `‘${unfinished.objective}’ 작업이 아직 종료되지 않았습니다. 아래 버튼에서 확인하고 중단할 수 있습니다.` : "과거 기록은 언제든 선택할 수 있습니다.");
  $("showUnfinishedRun").hidden = !busy;
  $("showUnfinishedRun").disabled = pending || !connected;
  const list = $("runList"); list.replaceChildren();
  for (const r of [...snapshot?.runs ?? []].reverse()) {
    const button = node("button", r.objective, `run-item${!showStart && r.runId === run?.runId ? " active" : ""}`);
    button.append(node("small", labels[r.phase] ?? r.phase));
    button.addEventListener("click", () => { selected = r.runId; showStart = false; $("projectPanel").hidden = true; snapshot = null; text("commandResult", ""); render(); refresh(); }); list.append(button);
  }
  const editingProject = !$("projectPanel").hidden;
  $("startPanel").hidden = editingProject || !showStart; $("runPanel").hidden = editingProject || showStart || !run;
  const project = preflight?.project;
  const projectContainer = $("projectSummary"); projectContainer.replaceChildren();
  if (project) {
    projectContainer.append(node("p", `${project.projectId} · ${project.targetRoot}`), node("p", `기준 ${project.requirementsId} / ${project.revision}`));
    for (const req of project.requirements.items) projectContainer.append(node("p", `${req.requirementId} · ${req.statement}`, "muted"));
  } else projectContainer.append(node("p", preflight?.projectError ?? "프로젝트 설정 확인 전", "muted"));
  const reason = pending ? "요청 처리 중입니다." : !connected ? "서버 연결을 확인하세요." : !preflight?.readyForProvisioning ? preflight?.projectError || `시작 전 준비가 필요합니다: ${(preflight?.missing ?? []).map((key) => missingLabels[key] || key).join(", ")}`
    : !caps.has("run.start") ? "미종료 런이 있거나 시작 조건이 준비되지 않았습니다." : !$('objective').value.trim() ? "작업 목표를 입력하세요."
      : !/^https:\/\/chatgpt\.com\/c\/[^/?#\s]+$/u.test($("conversationUrl").value.trim()) ? "기존 ChatGPT 대화 URL을 입력하세요." : "";
  $("startRun").disabled = Boolean(reason); text("startReason", lastCommandError || reason || "접수 후 같은 런에서 준비·구현·감사 진행과 실패 이유를 확인할 수 있습니다.");
  if (recoveryRunId !== run?.runId) {
    recoveryRunId = run?.runId;
    $("recoveryExternal").checked = false; $("recoveryTarget").checked = false; $("recoveryReason").value = "";
  }
  $("recoveryPanel").hidden = run?.phase !== "RECOVERY_REQUIRED";
  $("abandonRun").disabled = pending || !caps.has("run.abandon") || !$("recoveryExternal").checked || !$("recoveryTarget").checked || !$("recoveryReason").value.trim();
  if (!run) return;
  text("runObjective", run.objective); text("runContext", run.requirements
    ? `${run.projectRef?.projectId ?? "프로젝트"} · 구현 ${run.iteration ?? 0}회 · Worker ${workerIdentity(run)} · ${run.activeActor ?? "대기"}`
    : `이전 대화 작업 · Worker ${workerIdentity(run)} · ${run.activeActor ?? "대기"}`);
  text("runStatus", labels[run.phase] ?? run.phase); $("runStatus").className = ["HOLD", "INCONCLUSIVE", "RECOVERY_REQUIRED"].includes(run.phase) ? "warn" : run.phase === "FAILED" ? "error" : "";
  text("runReason", reasons[run.terminationReason] ?? run.error ?? snapshot?.error ?? (run.phase === "CANCELLED" ? "중단된 작업입니다. 실행 기록은 보존됩니다." : run.phase === "AWAITING_APPLY" ? "이 요구사항 버전과 후보의 감사가 통과했습니다. 적용은 별도 명령입니다." : run.phase === "APPLIED" ? "감사한 후보가 반영됐습니다. 배포·추가 환경 검증의 성공을 뜻하지 않습니다." : `감사 결과: ${run.auditResult ?? "미판정"} · 미해결 필수 지적 ${(run.findings ?? []).filter((f) => f.required && ["OPEN","FIX_SUBMITTED"].includes(f.status)).length}건`));
  text("runTime", `접수 ${time(run.createdAt)} · 상태 발생 ${time(run.updatedAt)}${connected ? "" : ` · 연결 끊김, 마지막 확인 ${time(lastConfirmed)}`}`);
  $("stopRun").disabled = pending || !caps.has("run.stop"); $("applyCode").disabled = pending || !caps.has("code.apply"); $("exportEvidence").disabled = pending || !caps.has("evidence.export");
  text("stopReason", pending ? "요청을 처리하고 있습니다." : !connected ? "서버에 다시 연결되면 중단할 수 있습니다."
    : terminal.has(run.phase) ? "이미 종료된 작업입니다. 다른 미종료 작업이 있다면 왼쪽 안내에서 선택하세요."
    : run.phase === "RECOVERY_REQUIRED" ? "외부 작업의 종료를 확인한 뒤 아래 ‘복구 확인 후 실행 폐기’를 진행하세요."
    : caps.has("run.stop") ? "이 작업의 후속 실행을 중단합니다. 실행 기록은 보존됩니다."
    : run.phase === "APPLYING" ? "변경 사항을 적용 중입니다. 적용 결과가 확인될 때까지 기다려 주세요."
    : "현재 상태에서는 중단할 수 없습니다. 연결과 실행 상태를 확인하세요.");
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
$("editProject").addEventListener("click", openProjectSettings);
$("closeProject").addEventListener("click", () => {
  if (!pending) { $("projectPanel").hidden = true; render(); $("startPanel").scrollIntoView?.({ block: "start" }); }
});
$("reloadProject").addEventListener("click", openProjectSettings);
$("projectJson").addEventListener("input", () => { $("projectAdvanced").disabled = true; });
$("addProjectRequirement").addEventListener("click", () => addRequirementEditor());
$("projectCodeOnly").addEventListener("input", projectMode);
$("projectAdvanced").addEventListener("change", () => {
  if ($("projectAdvanced").checked) {
    try { $("projectJson").value = JSON.stringify(basicProject(), null, 2); }
    catch { text("projectStatus", "전체 프로젝트 JSON을 붙여넣거나 기본 입력으로 돌아가 내용을 작성하세요."); }
  }
  projectMode();
});
$("projectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pending || !connected || $("saveProject").disabled) return;
  let project;
  try { project = $("projectAdvanced").checked ? JSON.parse($("projectJson").value) : basicProject(); }
  catch (error) { text("projectStatus", `입력 내용을 확인하세요: ${error.message}`); return; }
  pending = true; $("saveProject").disabled = true; render(); text("projectStatus", "설정을 저장하고 있습니다.");
  try {
    const saved = await request("/api/project", { method: "PUT", body: JSON.stringify({ project, expectedVersion: projectVersion }) });
    projectVersion = saved.version; $("projectJson").value = JSON.stringify(saved.project, null, 2);
    text("projectStatus", "설정을 저장했습니다. ‘작업 화면으로’를 눌러 작업 목표와 대화 URL을 입력하세요.");
    lastCommandError = "";
  } catch (error) { text("projectStatus", `저장하지 못했습니다: ${error.message}`); }
  finally { pending = false; $("saveProject").disabled = false; await refresh(); }
});
$("newRun").addEventListener("click", () => { showStart = true; $("projectPanel").hidden = true; render(); });
$("showUnfinishedRun").addEventListener("click", () => {
  if (pending || !connected) return;
  const unfinished = snapshot?.runs?.find((r) => !terminal.has(r.phase));
  if (!unfinished) return;
  selected = unfinished.runId; showStart = false; $("projectPanel").hidden = true; snapshot = null;
  text("commandResult", ""); render(); refresh();
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
