import {
  ACTORS,
  buildCommandEnvelope,
  classifyMessageOrigin,
  deliveryState,
  normalizeDashboardState,
  sessionFieldRows,
  statusKind,
} from "./dashboard-model.js";

const $ = (selector) => document.querySelector(selector);

const elements = {
  dashboardStatus: $("#dashboardStatus"),
  runStatus: $("#runStatus"),
  runVersion: $("#runVersion"),
  errorBanner: $("#errorBanner"),
  objective: $("#objective"),
  maxTurns: $("#maxTurns"),
  startRun: $("#startRun"),
  pauseRun: $("#pauseRun"),
  resumeRun: $("#resumeRun"),
  stopRun: $("#stopRun"),
  interruptRun: $("#interruptRun"),
  exportEvidence: $("#exportEvidence"),
  steerForm: $("#steerForm"),
  steerActor: $("#steerActor"),
  steerText: $("#steerText"),
  sendSteer: $("#sendSteer"),
  runMeta: $("#runMeta"),
  codexStatus: $("#codexStatus"),
  chatgptWebStatus: $("#chatgptWebStatus"),
  codexSessionFields: $("#codexSessionFields"),
  chatgptWebSessionFields: $("#chatgptWebSessionFields"),
  conversationFeed: $("#conversationFeed"),
  codexDraft: $("#codexDraft"),
  chatgptWebDraft: $("#chatgptWebDraft"),
  focusWebSession: $("#focusWebSession"),
  rebindWebSession: $("#rebindWebSession"),
  deliveries: $("#deliveries"),
  approvals: $("#approvals"),
  controllerTimeline: $("#controllerTimeline"),
  timelineCursor: $("#timelineCursor"),
  toast: $("#toast"),
  recoveryNotice: $("#recoveryNotice"),
  connectionPanel: $("#connectionPanel"),
  toggleConnectionPanel: $("#toggleConnectionPanel"),
  sessionGrid: $("#sessionGrid"),
  cleanupPanel: $("#cleanupPanel"),
  cleanupList: $("#cleanupList"),
  composerLock: $("#composerLock"),
  recoveryStopRun: $("#recoveryStopRun"),
};

let dashboardToken = "";
let connectionManuallyToggled = false;
let connectionAutoCollapsedOnce = false;
let selectedRunId = "";
let polling = false;
let state = normalizeDashboardState(null);
let controllerAvailable = false;
let reconnectTimer = null;
let toastTimer = null;
const drafts = new Map(ACTORS.map((actor) => [actor, ""]));
let snapshot = null;
let refreshSerial = 0;
let commandPending = false;
let startError = "";
let startPending = false;
let historySignature = "";
const renderSignatures = new WeakMap();
// Tracks when each actor's session most recently entered a RUNNING status, so the
// UI can show elapsed time instead of leaving "응답 중" ambiguous between active and stuck.
const turnStartedAt = new Map();
let stopConfirmArmed = null;
let stopConfirmTimer = null;

function phaseLabel(phase) {
  return ({ CREATED: "시작 대기", STARTING_SESSIONS: "세션 준비 중", COMPLETE: "완료", CANCELLED: "취소됨", FAILED: "실패",
    CODEX_TURN_PENDING: "Codex 응답 대기", CODEX_TURN_RUNNING: "Codex 응답 중", WEB_TURN_RUNNING: "ChatGPT 응답 중",
    CODEX_TO_WEB_PENDING: "ChatGPT 전달 대기", WEB_TO_CODEX_PENDING: "Codex 전달 대기", HUMAN_GATE: "사용자 결정 필요",
    RECOVERY_REQUIRED: "복구 확인 필요", CONSENSUS_CHECK: "합의 확인 중" })[phase] || phase || "실행 없음";
}

function unfinishedRuns() {
  if (!controllerAvailable || !snapshot) return [];
  return (snapshot.runs || []).filter((run) => !["COMPLETE", "FAILED", "CANCELLED"].includes(run.phase));
}

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}분 ${remainder}초`;
}

function currentStartReason() {
  if (startPending || snapshot?.starting) return "ChatGPT 대화 탭과 입력창 준비 상태를 확인하고 있습니다. 아직 실행은 시작되지 않았습니다.";
  if (commandPending || snapshot?.starting) return "요청을 처리하고 있습니다. 잠시 기다려주세요.";
  if (!controllerAvailable) return "로컬 서버 연결을 확인하고 있습니다. 왼쪽 연결 설정을 확인하세요.";
  if (!snapshot?.preflight?.checks?.extensionAuthenticated) return "브라우저 확장이 연결되지 않았습니다. 왼쪽 연결 설정를 확인하세요.";
  if (!snapshot.preflight.readyForProvisioning) return "서버 설정이 아직 준비되지 않았습니다. 왼쪽 연결 설정를 확인하세요.";
  const unfinished = unfinishedRuns();
  if (unfinished.length) return `아직 끝나지 않은 토론이 ${unfinished.length}개 있습니다. 진행 상황을 확인하세요.`;
  if (!elements.objective.value.trim()) return "토론할 목표를 입력하세요.";
  if (!/^https:\/\/chatgpt\.com\/c\/[^/?#\s]+(?:[?#][^\s]*)?$/u.test($("#conversationUrl").value.trim())) return "ChatGPT의 기존 대화 URL을 입력하세요. (https://chatgpt.com/c/...)";
  if (!state.commandCapabilities.has("run.start")) return "서버가 새 실행을 준비하고 있습니다. 잠시 기다려주세요.";
  return null;
}

function unchanged(container, value) {
  const signature = JSON.stringify(value);
  if (renderSignatures.get(container) === signature) return true;
  renderSignatures.set(container, signature);
  return false;
}

function requestId() {
  return `ui_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function setBadge(element, text, kind = "neutral") {
  element.textContent = text;
  element.className = `badge ${kind}`;
}

function showToast(text, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = text;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.remove("hidden");
  toastTimer = setTimeout(() => elements.toast.classList.add("hidden"), 4_200);
}

function showView(view) {
  const dialog = $("#setupView");
  if (view === "setup") {
    if (!dialog.open) dialog.showModal();
    elements.objective.focus();
  } else if (dialog.open) dialog.close();
}
$("#showSetup").addEventListener("click", () => showView("setup"));
$("#showHistory").addEventListener("click", () => showView("history"));

function setConnectionPanelCollapsed(collapsed) {
  elements.toggleConnectionPanel.setAttribute("aria-expanded", String(!collapsed));
  elements.connectionPanel.classList.toggle("collapsed", collapsed);
  elements.toggleConnectionPanel.textContent = collapsed ? "연결 정보 보기" : "연결 정보 숨기기";
}

elements.toggleConnectionPanel.addEventListener("click", () => {
  connectionManuallyToggled = true;
  setConnectionPanelCollapsed(!elements.connectionPanel.classList.contains("collapsed"));
});

function setControllerUnavailable(message) {
  controllerAvailable = false;
  setBadge(elements.dashboardStatus, dashboardToken ? "서버 연결 확인 필요" : "서버 연결 전", "neutral");
  elements.errorBanner.textContent = message;
  elements.errorBanner.classList.remove("hidden");
  render();
}

function setControllerAvailable() {
  controllerAvailable = true;
  setBadge(elements.dashboardStatus, "서버 연결됨", "ok");
  elements.errorBanner.classList.add("hidden");
}

async function explainUnavailable() {
  if (!dashboardToken) {
    try {
      const response = await fetch("/api/dashboard/session", {
        method: "POST", headers: { Accept: "application/json" },
        cache: "no-store", signal: AbortSignal.timeout(15_000),
      });
      const session = await response.json();
      if (!response.ok) throw new Error(session.error || "자동 연결을 준비하지 못했습니다.");
      if (typeof session.token !== "string" || !session.token) throw new Error("자동 연결 응답이 올바르지 않습니다.");
      dashboardToken = session.token;
    } catch (error) {
      setControllerUnavailable(error.message || "로컬 서버에 연결할 수 없습니다.");
      return;
    }
  }
  const serial = ++refreshSerial;
  const requestedRunId = selectedRunId;
  try {
    const response = await fetch(`/api/state${selectedRunId ? `?runId=${encodeURIComponent(selectedRunId)}` : ""}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${dashboardToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (serial !== refreshSerial || requestedRunId !== selectedRunId) return;
    if (response.ok) {
      const received = await response.json();
      if (serial !== refreshSerial || requestedRunId !== selectedRunId) return;
      snapshot = received;
      state = normalizeDashboardState(snapshot);
      for (const actor of ACTORS) drafts.set(actor, snapshot.drafts?.[actor] || "");
      setControllerAvailable();
      const history = $("#runHistory");
      const nextHistorySignature = JSON.stringify(snapshot.runs || []);
      if (historySignature !== nextHistorySignature) {
        historySignature = nextHistorySignature;
        history.replaceChildren(new Option("최근 실행", ""));
        for (const run of [...snapshot.runs || []].reverse()) history.add(new Option(`${phaseLabel(run.phase)} · ${run.objective}`, run.runId));
      }
      history.value = selectedRunId;
      render();
      return;
    }
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) dashboardToken = "";
    setControllerUnavailable(
      payload.error || `Controller state API가 HTTP ${response.status}를 반환했습니다.`,
    );
  } catch {
    if (serial !== refreshSerial) return;
    setControllerUnavailable("Controller state API에 연결할 수 없습니다.");
  }
}

async function command(type, payload = {}, { allowWithoutRun = false } = {}) {
  if (!controllerAvailable || !dashboardToken) {
    return Promise.reject(new Error("Controller canonical command channel is unavailable."));
  }
  if (!allowWithoutRun && !state.run) {
    return Promise.reject(new Error(`${type} requires a canonical run.`));
  }

  const envelope = buildCommandEnvelope({
    type,
    requestId: requestId(),
    run: type === "run.start" ? null : state.run,
    payload,
    allowWithoutRun,
  });

  const response = await fetch("/api/commands", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${dashboardToken}` },
    body: JSON.stringify(envelope),
  });
  const result = await response.json();
  await explainUnavailable();
  if (!response.ok || result.type === "command.error") throw new Error(result.payload?.message || result.error || "명령을 처리하지 못했습니다.");
  return result.payload;
}

function connect() {
  clearTimeout(reconnectTimer);
  if (polling) return;
  polling = true;
  void explainUnavailable().finally(() => {
    polling = false;
    reconnectTimer = setTimeout(connect, 1500);
  });
}

function render() {
  const { run } = state;
  const codex = state.sessions.get("CODEX_AGENT");
  const chatgptWeb = state.sessions.get("CHATGPT_WEB_AGENT");

  elements.sessionGrid.dataset.active = run?.activeActor || "";
  setBadge(elements.runStatus, run?.phase || "실행 없음", statusKind(run?.phase));
  setBadge(elements.runVersion, `version ${run?.version ?? "—"}`, "neutral");
  setBadge(elements.codexStatus, codex?.status || "NOT_AVAILABLE", statusKind(codex?.status));
  setBadge(
    elements.chatgptWebStatus,
    chatgptWeb?.status || "NOT_AVAILABLE",
    statusKind(chatgptWeb?.status),
  );

  renderSessionFields(elements.codexSessionFields, sessionFieldRows("CODEX_AGENT", codex));
  renderSessionFields(
    elements.chatgptWebSessionFields,
    sessionFieldRows("CHATGPT_WEB_AGENT", chatgptWeb),
  );

  elements.runMeta.textContent = run
    ? [
        run.runId,
        `turn ${run.currentTurn}/${run.maxTurns}`,
        run.activeActor ? `active ${run.activeActor}` : "active —",
        run.paused ? "paused" : null,
        run.blocker?.type ? `blocker ${run.blocker.type}` : null,
      ].filter(Boolean).join(" · ")
    : "canonical run 없음";

  const phase = run?.phase || "";
  const terminal = ["COMPLETE", "FAILED", "CANCELLED"].includes(phase);
  const active = Boolean(run && !terminal);
  const hasActiveTurn = phase.endsWith("_TURN_RUNNING") || Boolean(run?.activeActor);
  const canMutate = controllerAvailable && !commandPending;

  elements.startRun.disabled = !canMutate || active;
  elements.pauseRun.disabled = !canMutate || !active || run.paused;
  elements.resumeRun.disabled = !canMutate || !active;
  elements.stopRun.disabled = !canMutate || !active;
  if (elements.stopRun.disabled) resetStopConfirm(elements.stopRun);
  elements.interruptRun.disabled = !canMutate || !active || !hasActiveTurn;
  elements.exportEvidence.disabled = !canMutate || !run || !state.commandCapabilities.has("evidence.export");
  elements.steerText.disabled = !canMutate || !active || !hasActiveTurn;
  elements.sendSteer.disabled = elements.steerText.disabled;
  elements.focusWebSession.disabled = !canMutate || hasActiveTurn || !chatgptWeb?.externalLocator;
  elements.rebindWebSession.disabled = !canMutate || hasActiveTurn || !run;
  for (const [element, capability] of [
    [elements.startRun, "run.start"], [elements.pauseRun, "run.pause"],
    [elements.resumeRun, "run.resume"], [elements.stopRun, "run.stop"],
    [elements.interruptRun, "run.interrupt"], [elements.sendSteer, "run.steer"],
    [elements.focusWebSession, "web.session.focus"], [elements.rebindWebSession, "web.session.rebind"],
  ]) element.disabled ||= !state.commandCapabilities.has(capability);
  elements.steerText.disabled = elements.sendSteer.disabled;
  renderOverview();

  renderConversation();
  renderDrafts();
  renderDeliveries();
  renderApprovals();
  renderTimeline();
}

function renderOverview() {
  const checks = controllerAvailable ? snapshot?.preflight?.checks || {} : {};
  const extensionReady = checks.extensionAuthenticated === true;
  setBadge($("#extensionStatus"), !controllerAvailable ? "확장 확인 전" : extensionReady ? "확장 연결됨" : "확장 미연결", extensionReady ? "ok" : "neutral");
  $("#serverCheck").textContent = controllerAvailable ? "✓" : "1";
  $("#serverCheck").classList.toggle("ready", controllerAvailable);
  $("#serverCheckText").textContent = controllerAvailable ? ".env 설정으로 자동 연결되었습니다." : "로컬 서버의 설정을 확인하고 있습니다.";
  $("#webCheck").textContent = extensionReady ? "✓" : "2";
  $("#webCheck").classList.toggle("ready", extensionReady);
  $("#webCheckText").textContent = !controllerAvailable ? "서버 인증 후 확인합니다." : extensionReady ? "확장이 인증되었습니다. 대화 탭은 시작할 때 확인합니다." : "확장과 서버의 인증 연결을 기다립니다.";
  $("#connectionSummary").textContent = controllerAvailable && extensionReady ? "연결 준비 완료" : "연결 확인 필요";
  $("#extensionHelp").classList.toggle("hidden", extensionReady);
  if (controllerAvailable && extensionReady && !connectionAutoCollapsedOnce && !connectionManuallyToggled) {
    connectionAutoCollapsedOnce = true;
    setConnectionPanelCollapsed(true);
  }
  $("#connectDashboard").textContent = controllerAvailable ? "토큰으로 다시 연결" : "토큰으로 연결";
  const missingLabels = { demoModeDisabled: "실행 모드 설정", codexExecutableConfigured: "Codex 실행 파일 설정", webAdapterAvailable: "웹 연결 기능", commandAuthenticationConfigured: "대시보드 인증 설정" };
  $("#connectionHint").textContent = controllerAvailable
    ? (snapshot?.preflight?.missing || []).filter((key) => key !== "extensionAuthenticated").map((key) => `${missingLabels[key] || key} 확인이 필요합니다.`).join(" ") : "";
  renderRunList();
  const reason = currentStartReason();
  const canCreate = controllerAvailable && !commandPending && !snapshot?.starting && unfinishedRuns().length === 0;
  $("#showSetup").disabled = !canCreate;
  $("#newRunHint").textContent = !controllerAvailable ? "서버 연결을 확인하고 있습니다."
    : unfinishedRuns().length ? "진행 중인 토론이 있습니다. 완료·종료 후 시작할 수 있습니다."
    : "검토할 주제를 입력해 새 토론을 시작하세요.";
  $("#startReason").textContent = startPending ? reason : startError || reason || "시작을 누르면 ChatGPT 대화 탭과 입력창을 확인한 뒤 실행합니다.";
  elements.startRun.disabled = reason !== null;
  elements.startRun.textContent = startPending ? "대화 탭 확인 중…" : commandPending ? "요청 처리 중…" : $("#runMode").value === "CODE_CHANGE" ? "개발 작업 시작" : "토론 시작";
  $("#codeChangeInputs").hidden = $("#runMode").value !== "CODE_CHANGE";
  const code = state.run?.mode === "CODE_CHANGE" ? state.run : null;
  const candidate = code?.captures?.at(-1)?.capture;
  $("#codeCandidate").hidden = !code;
  $("#codeCandidate").textContent = code ? `상태: ${code.stage}\n대상: ${code.targetRoot}\n기준: ${code.baseCommit}\n후보: ${candidate?.artifact.sha256 || "아직 없음"}\n점수: ${code.captures?.at(-1)?.review?.score ?? "—"}` : "";
  $("#applyCode").hidden = !code || code.stage !== "AWAITING_APPLY";
  $("#applyCode").disabled = commandPending || !state.commandCapabilities.has("code.apply");
  const run = state.run;
  const terminal = ["COMPLETE", "FAILED", "CANCELLED"].includes(run?.phase);
  setBadge(elements.runStatus, phaseLabel(run?.phase), run?.phase === "CANCELLED" ? "neutral" : statusKind(run?.phase));
  $("#savedObjective").textContent = run?.objective || "아직 선택한 실행이 없습니다.";
  $("#turnProgress").textContent = run ? `${run.currentTurn} / ${run.maxTurns}회 응답` : "—";
  const staleRun = Boolean(snapshot?.error && snapshot.error.includes("이전 서버 세션"));
  elements.recoveryNotice.classList.toggle("hidden", !staleRun);
  $("#recordNotice").textContent = !run ? "새 토론 화면에서 연결하고 주제를 입력하세요."
    : terminal ? "종료된 실행의 기록입니다. 아래 세션 상태는 현재 연결 상태를 뜻하지 않습니다."
    : staleRun ? "이전 서버의 기록입니다. 오른쪽에서 가능한 진행 동작을 확인하세요."
    : "두 에이전트가 번갈아 응답합니다. 아래에서 대화를 확인하세요.";
  const outcome = snapshot?.outcome?.outcome || snapshot?.outcome;
  $("#runOutcome").textContent = !run ? "아직 결과가 없습니다." : outcome?.type === "CANCELLED"
    ? (run.currentTurn === 0 ? "응답을 처리하기 전에 사용자가 실행을 취소했습니다." : `${run.currentTurn}턴을 처리한 뒤 실행을 취소했습니다.`)
    : outcome?.type === "CONSENSUS" ? "두 에이전트가 같은 제안에 합의했습니다."
    : outcome?.type === "INCONCLUSIVE" ? "최대 턴에 도달해 토론을 마쳤습니다. 최종 합의에는 도달하지 못했습니다."
    : snapshot?.error || (run.paused && !terminal ? "일시정지 상태입니다. 현재 응답은 저장하고 다음 전송을 기다립니다." : terminal ? "토론이 종료되었습니다." : "진행 중 — 아직 결과가 없습니다.");
  if (code) $("#runOutcome").textContent = ({ AWAITING_APPLY: "검토 통과 — 후보를 확인하고 승인하면 반영됩니다.",
    APPLIED: "검토한 변경을 반영했습니다. commit·push는 하지 않았습니다.", INCONCLUSIVE: "반복 한도에 도달했습니다. 변경은 반영되지 않았습니다.",
    RECOVERY_REQUIRED: code.error || "복구 확인이 필요합니다. 자동으로 재전송·재반영하지 않습니다.",
    CANCELLED: "개발 작업을 취소했습니다. worktree는 보존됩니다." })[code.stage] || "개발 작업·검토 진행 중";
  for (const [actor, element] of [["CODEX_AGENT", elements.codexStatus], ["CHATGPT_WEB_AGENT", elements.chatgptWebStatus]]) {
    const session = state.sessions.get(actor);
    const labels = { CREATING: "준비 중", READY: "준비됨", RUNNING: "응답 중", WAITING: "대기", DISCONNECTED: "연결 끊김", FAILED: "실패" };
    if (!session) {
      setBadge(element, "세션 기록 없음", "neutral");
      continue;
    }
    const key = `${state.run?.runId || "none"}:${actor}`;
    const label = labels[session.status] || session.status;
    if (session.status === "RUNNING") {
      if (!turnStartedAt.has(key)) turnStartedAt.set(key, Date.now());
      const elapsedMs = Date.now() - turnStartedAt.get(key);
      const stalled = elapsedMs > 120_000;
      setBadge(element, `${label} · ${formatElapsed(elapsedMs)}${stalled ? " · 지연 확인" : ""}`, stalled ? "bad" : "busy");
    } else {
      turnStartedAt.delete(key);
      setBadge(element, label, statusKind(session.status));
    }
  }

  const unfinished = unfinishedRuns();
  elements.cleanupPanel.classList.toggle("hidden", unfinished.length === 0);
  if (!unchanged(elements.cleanupList, unfinished.map((entry) => [entry.runId, entry.phase, entry.objective, entry.currentTurn]))) {
    elements.cleanupList.replaceChildren();
    for (const entry of unfinished) {
      const item = document.createElement("div");
      item.className = "cleanup-item";
      const text = document.createElement("div");
      text.className = "cleanup-item-text";
      const title = document.createElement("strong");
      title.textContent = entry.objective || "(목표 없음)";
      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent = phaseLabel(entry.phase);
      text.append(title, meta);
      const actions = document.createElement("div");
      actions.className = "buttons";
      const viewButton = document.createElement("button");
      viewButton.className = "small";
      viewButton.textContent = "기록 보기";
      viewButton.addEventListener("click", () => {
        showView("history");
        selectRun(entry.runId);
        $("#historySection").scrollIntoView({ behavior: "smooth", block: "start" });
      });
      const stopButton = document.createElement("button");
      stopButton.className = "small danger";
      stopButton.textContent = "종료";
      stopButton.disabled = !controllerAvailable || !state.commandCapabilities.has("run.stop");
      stopButton.addEventListener("click", () => {
        armStopConfirm(stopButton, () => { void stopRunById(entry.runId); });
      });
      actions.append(viewButton, stopButton);
      item.append(text, actions);
      elements.cleanupList.append(item);
    }
  }

  const composerReady = reason.startsWith("준비됐습니다.");
  elements.composerLock.classList.add("hidden");
  elements.composerLock.classList.toggle("ready", composerReady);
  if (!composerReady) elements.composerLock.textContent = reason;

  elements.recoveryStopRun.disabled = !controllerAvailable || commandPending || !state.run || !state.commandCapabilities.has("run.stop");
}

function renderSessionFields(container, rows) {
  container.replaceChildren();
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value ?? "—";
    container.append(dt, dd);
  }
}

function renderRunList() {
  const container = $("#runList");
  const runs = snapshot?.runs || [];
  if (unchanged(container, [runs, state.run?.runId, controllerAvailable, [...state.commandCapabilities]])) return;
  container.replaceChildren();
  if (!runs.length) {
    const empty = document.createElement("p");
    empty.className = "empty-inline";
    empty.textContent = controllerAvailable ? "아직 토론 기록이 없습니다." : "연결 후 토론 목록이 표시됩니다.";
    container.append(empty);
  }
  for (const run of [...runs].reverse()) {
    const item = document.createElement("div");
    item.className = "run-item-wrap";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "run-item";
    button.classList.toggle("active", state.run?.runId === run.runId);
    button.setAttribute("aria-current", state.run?.runId === run.runId ? "true" : "false");
    const title = document.createElement("span");
    title.className = "obj";
    title.textContent = run.objective;
    button.title = run.objective;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = phaseLabel(run.phase);
    button.append(title, meta);
    button.addEventListener("click", () => selectRun(run.runId));
    item.append(button);
    const terminal = ["COMPLETE", "FAILED", "CANCELLED"].includes(run.phase);
    const menu = document.createElement("button");
    menu.type = "button";
    menu.className = "run-menu";
    menu.textContent = "⋮";
    menu.title = terminal ? "토론 기록 메뉴" : "대화 종료 메뉴";
    menu.setAttribute("aria-label", `${run.objective} ${terminal ? "기록 메뉴" : "종료 메뉴"}`);
    menu.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (selectedRunId !== run.runId) selectRun(run.runId);
      await explainUnavailable();
      if (terminal) {
        if (!state.commandCapabilities.has("run.delete") || !confirm("이 토론과 관련 기록을 모두 삭제할까요?")) return;
        await execute("run.delete", {}, "토론과 관련 기록을 삭제했습니다.").catch(() => {});
        selectedRunId = "";
      } else {
        if (!state.commandCapabilities.has("run.stop") || !confirm("이 대화를 종료할까요?")) return;
        await execute("run.stop", {}, "대화를 종료했습니다.").catch(() => {});
      }
      await explainUnavailable();
    });
    item.append(menu);
    container.append(item);
  }
}

function renderConversation() {
  const container = elements.conversationFeed;
  const messages = state.messages.filter((m) => m.runId === state.run?.runId)
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const left = Date.parse(a.message.createdAt);
      const right = Date.parse(b.message.createdAt);
      return Number.isFinite(left) && Number.isFinite(right) && left !== right
        ? left - right : Number(a.message.sequence ?? a.index) - Number(b.message.sequence ?? b.index);
    }).map(({ message }) => message).slice(-100);
  if (unchanged(container, [state.run?.runId, messages])) return;
  const feed = elements.sessionGrid;
  const changedRun = container.dataset.runId !== (state.run?.runId || "");
  const keepBottom = changedRun || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 64;
  container.dataset.runId = state.run?.runId || "";
  container.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = state.run ? "아직 저장된 응답이 없습니다." : "Codex와 ChatGPT의 대화가 이곳에 표시됩니다. 왼쪽에서 새 토론을 시작하세요.";
    container.append(empty);
  }
  for (const message of messages) {
    const origin = classifyMessageOrigin(message);
    const actor = message.fromActor || message.actor;
    if (origin.cssClass !== "agent") {
      const details = document.createElement("details");
      details.className = "system-note";
      const summary = document.createElement("summary");
      summary.textContent = origin.cssClass === "human" ? "사용자 지시" : "컨트롤러 전달 기록";
      const content = document.createElement("pre");
      content.textContent = String(message.content ?? message.text ?? "");
      details.append(summary, content);
      container.append(details);
      continue;
    }
    const web = actor === "CHATGPT_WEB_AGENT";
    const article = document.createElement("article");
    article.className = "turn " + (web ? "chatgpt" : "codex");
    const avatar = document.createElement("div");
    avatar.className = "avatar " + (web ? "chatgpt" : "codex");
    avatar.textContent = web ? "GPT" : "CX";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const head = document.createElement("div");
    head.className = "bubble-head";
    const name = document.createElement("span");
    name.className = "bubble-name";
    name.textContent = web ? "ChatGPT" : "Codex";
    const time = document.createElement("span");
    time.textContent = message.createdAt ? new Date(message.createdAt).toLocaleTimeString() : "저장된 응답";
    head.append(name, time);
    const body = document.createElement("div");
    body.className = "bubble-body";
    body.textContent = String(message.content ?? message.text ?? "");
    const details = document.createElement("details");
    details.className = "message-details";
    const summary = document.createElement("summary");
    summary.textContent = "원본 · 식별 정보";
    const raw = document.createElement("pre");
    raw.textContent = JSON.stringify(message, null, 2);
    details.append(summary, raw);
    bubble.append(head, body, details);
    article.append(avatar, bubble);
    container.append(article);
  }
  if (keepBottom) feed.scrollTop = feed.scrollHeight;
}

function renderDrafts() {
  for (const [actor, element] of [
    ["CODEX_AGENT", elements.codexDraft],
    ["CHATGPT_WEB_AGENT", elements.chatgptWebDraft],
  ]) {
    const text = drafts.get(actor) || "";
    element.textContent = text;
    element.classList.toggle("hidden", !text);
  }
}

function renderDeliveries() {
  if (unchanged(elements.deliveries, [state.deliveries, controllerAvailable, [...state.commandCapabilities]])) return;
  elements.deliveries.replaceChildren();
  if (!state.deliveries.length) {
    elements.deliveries.append(emptyLine("이 실행에 전송 기록이 없습니다."));
    return;
  }
  for (const delivery of state.deliveries) {
    const card = document.createElement("article");
    card.className = "data-card delivery-card";
    const stateName = deliveryState(delivery);
    const title = document.createElement("div");
    title.className = "data-card-title";
    const label = document.createElement("strong");
    label.textContent = delivery.deliveryId || "delivery";
    const badge = document.createElement("span");
    badge.className = `badge ${statusKind(stateName)}`;
    badge.textContent = stateName;
    title.append(label, badge);
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = [delivery.actor, delivery.messageId, `attempt ${delivery.attemptCount ?? 0}`]
      .filter(Boolean).join(" · ");
    card.append(title, meta);
    if (stateName === "FAILED") {
      const note = document.createElement("p");
      note.className = "meta";
      note.textContent = "전달 실패 · 이 화면에서는 재시도를 지원하지 않습니다.";
      card.append(note);
    } else if (stateName === "AMBIGUOUS") {
      const warning = document.createElement("p");
      warning.className = "meta warning";
      warning.textContent = "Recovery decision required · automatic retry blocked";
      card.append(warning);
    }
    elements.deliveries.append(card);
  }
}

function renderApprovals() {
  if (unchanged(elements.approvals, [state.approvals, controllerAvailable, [...state.commandCapabilities]])) return;
  elements.approvals.replaceChildren();
  if (!state.approvals.length) {
    elements.approvals.append(emptyLine("대기 중인 승인 없음"));
    return;
  }
  for (const approval of state.approvals) {
    const card = document.createElement("article");
    card.className = "data-card approval";
    const title = document.createElement("strong");
    title.textContent = approval.type || approval.method || "APPROVAL";
    const detail = document.createElement("pre");
    detail.textContent = [
      approval.approvalId ? `approval: ${approval.approvalId}` : null,
      approval.scopeHash ? `scope hash: ${approval.scopeHash}` : null,
      approval.reason ? `reason: ${approval.reason}` : null,
      approval.actor ? `actor: ${approval.actor}` : null,
      approval.turnId ? `turn: ${approval.turnId}` : null,
    ].filter(Boolean).join("\n") || "Controller가 상세 정보를 제공하지 않았습니다.";
    const note = document.createElement("p");
    note.className = "meta";
    note.textContent = "승인 기록 조회 · 이 화면에서는 승인 결정을 지원하지 않습니다.";
    card.append(title, detail, note);
    elements.approvals.append(card);
  }
}

function renderTimeline() {
  if (unchanged(elements.controllerTimeline, state.events)) return;
  elements.controllerTimeline.replaceChildren();
  const events = [...state.events].sort((left, right) => left.sequence - right.sequence);
  const last = events.at(-1);
  elements.timelineCursor.textContent = `sequence ${last?.sequence ?? "—"}`;
  if (!events.length) {
    elements.controllerTimeline.append(emptyLine("저장된 이벤트가 없습니다."));
    return;
  }
  for (const event of events.slice(-150).reverse()) {
    const article = document.createElement("article");
    article.className = "timeline-event";
    const marker = document.createElement("span");
    marker.className = "timeline-sequence";
    marker.textContent = `#${event.sequence}`;
    const body = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = event.eventType || event.type || "EVENT";
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = [event.actor, event.createdAt, event.eventHash].filter(Boolean).join(" · ");
    body.append(name, meta);
    article.append(marker, body);
    elements.controllerTimeline.append(article);
  }
}

function emptyLine(text) {
  const element = document.createElement("p");
  element.className = "empty-inline";
  element.textContent = text;
  return element;
}

function selectRun(runId) {
  resetStopConfirm(elements.stopRun);
  resetStopConfirm(elements.recoveryStopRun);
  refreshSerial += 1;
  selectedRunId = runId;
  $("#runHistory").value = runId;
  state = normalizeDashboardState(null);
  drafts.clear();
  render();
  void explainUnavailable();
}

async function stopRunById(runId) {
  if (selectedRunId !== runId) selectRun(runId);
  await explainUnavailable();
  if (state.run?.runId !== runId) {
    showToast("이 실행 정보를 불러오지 못했습니다. 잠시 후 다시 시도하세요.", true);
    return;
  }
  await execute("run.stop", {}, "실행을 종료했습니다.").catch(() => {});
}

function armStopConfirm(button, onConfirm) {
  if (stopConfirmArmed !== button) {
    if (stopConfirmArmed) resetStopConfirm(stopConfirmArmed);
    stopConfirmArmed = button;
    const original = button.dataset.originalLabel || button.textContent;
    button.dataset.originalLabel = original;
    button.textContent = "다시 클릭하면 종료";
    clearTimeout(stopConfirmTimer);
    stopConfirmTimer = setTimeout(() => {
      resetStopConfirm(button);
    }, 4_000);
    return;
  }
  resetStopConfirm(button);
  onConfirm();
}

function resetStopConfirm(button) {
  if (stopConfirmArmed === button) {
    clearTimeout(stopConfirmTimer);
    stopConfirmArmed = null;
  }
  if (button.dataset.originalLabel) button.textContent = button.dataset.originalLabel;
}

async function execute(type, payload, successText, options) {
  if (commandPending) return;
  commandPending = true;
  render();
  try {
    const result = await command(type, payload, options);
    if (successText) showToast(successText);
    return result;
  } catch (error) {
    showToast(error.message, true);
    throw error;
  } finally {
    commandPending = false;
    render();
  }
}

elements.startRun.addEventListener("click", () => {
  if (commandPending) return;
  const objective = elements.objective.value.trim();
  if (!objective) {
    showToast("토론 주제를 입력하세요.", true);
    return;
  }
  selectedRunId = "";
  startError = "";
  startPending = true;
  void execute("run.start", {
    mode: $("#runMode").value,
    ...($("#runMode").value === "CODE_CHANGE" ? {
      targetRoot: $("#targetRoot").value.trim(), reviewCriteria: $("#reviewCriteria").value.trim(),
      threshold: $("#reviewThreshold").value === "" ? null : Number($("#reviewThreshold").value),
      maxIterations: Number($("#maxIterations").value),
    } : {}),
    objective,
    maxTurns: Number(elements.maxTurns.value),
    conversationUrl: $("#conversationUrl").value.trim(),
  }, "실행을 시작했습니다.", { allowWithoutRun: true }).then(() => showView("history"))
    .catch((error) => { startError = error.message; })
    .finally(() => { startPending = false; render(); });
});

elements.pauseRun.addEventListener("click", () => {
  void execute("run.pause", {}, "현재 응답 후 다음 전송을 멈춥니다.").catch(() => {});
});

$("#runMode").addEventListener("change", renderOverview);
$("#applyCode").addEventListener("click", () => {
  const capture = state.run?.captures?.at(-1)?.capture;
  if (!capture) return;
  void execute("code.apply", { artifactHash: capture.artifact.sha256, baseCommit: capture.baseCommit }, "검토한 변경을 반영했습니다. commit·push는 하지 않았습니다.").catch(() => {});
});
elements.resumeRun.addEventListener("click", () => {
  void execute("run.resume", {}, "재개 요청을 보냈습니다.").catch(() => {});
});
elements.stopRun.addEventListener("click", () => {
  armStopConfirm(elements.stopRun, () => {
    void execute("run.stop", {}, "토론 종료를 요청했습니다.").catch(() => {});
  });
});
elements.recoveryStopRun.addEventListener("click", () => {
  armStopConfirm(elements.recoveryStopRun, () => {
    void execute("run.stop", {}, "토론 종료를 요청했습니다.").catch(() => {});
  });
});
elements.interruptRun.addEventListener("click", () => {
  void execute("run.interrupt", {
    actor: state.run?.activeActor,
    turnId: state.sessions.get(state.run?.activeActor)?.activeTurnId || null,
  }, "현재 응답 중단을 요청했습니다.").catch(() => {});
});
elements.exportEvidence.addEventListener("click", () => {
  void execute("evidence.export", {}, "실행 기록을 다운로드합니다.").then((evidence) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(evidence, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${state.run.runId}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }).catch(() => {});
});
elements.focusWebSession.addEventListener("click", () => {
  void execute("web.session.focus", {
    sessionId: state.sessions.get("CHATGPT_WEB_AGENT")?.sessionId,
  }, "결박된 ChatGPT 탭을 여는 요청을 보냈습니다.").catch(() => {});
});
elements.rebindWebSession.addEventListener("click", () => {
  void execute("web.session.rebind", {
    sessionId: state.sessions.get("CHATGPT_WEB_AGENT")?.sessionId,
  }, "session rebind 요청을 보냈습니다.").catch(() => {});
});
elements.steerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.steerText.value.trim();
  if (!text) return;
  void execute("run.steer", {
    actor: elements.steerActor.value,
    text,
    turnId: state.sessions.get(elements.steerActor.value)?.activeTurnId || null,
  }, "추가 지시를 보냈습니다.")
    .then(() => { elements.steerText.value = ""; })
    .catch(() => {});
});

$("#connectionForm").addEventListener("submit", (event) => {
  event.preventDefault();
  dashboardToken = $("#dashboardToken").value.trim();
  $("#dashboardToken").value = "";
  connect();
});
$("#runHistory").addEventListener("change", () => {
  selectRun($("#runHistory").value);
});
for (const element of [elements.objective, $("#conversationUrl"), elements.maxTurns]) {
  element.addEventListener("input", renderOverview);
}
render();
setControllerUnavailable("로컬 서버에 자동 연결하고 있습니다…");
connect();
