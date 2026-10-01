import {
  DashboardSessionState, ExtensionState, StateReadState, TransportState, projectBrowserState,
} from "./dashboard-connection-state.js";

export function createDashboardHealthPresentation({
  $, text, time, getConnectionState, getConnected, getSnapshot, getLastConfirmed,
}) {
  function projectConnectionIndicator(id, state, detail) {
    const connectionState = getConnectionState();
    const connected = getConnected();
    const snapshot = getSnapshot();
    const lastConfirmed = getLastConfirmed();
    const serverReachable = connectionState.transport === TransportState.REACHABLE;
    const serverUnreachable = connectionState.transport === TransportState.UNREACHABLE;
    const sessionAuthenticated = serverReachable && connectionState.session === DashboardSessionState.AUTHENTICATED;
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

  function bindHealthInteractions() {
    document.addEventListener("click", (event) => {
      if (!$("systemHealth").contains(event.target)) closeHealthDetails();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && $("systemHealth").contains(event.target)) {
        closeHealthDetails(true); event.preventDefault();
      }
    });
  }

  function runAppearance(phase) {
    if (phase === "FAILED") return "error";
    if (["HOLD", "INCONCLUSIVE", "RECOVERY_REQUIRED", "STOPPING"].includes(phase)) return "warn";
    if (["APPLIED", "COMPLETE", "AWAITING_APPLY"].includes(phase)) return "ok";
    if (["WORKER_RUNNING", "CANDIDATE_CAPTURE", "VERIFYING", "REVIEW_RUNNING", "REPORT_REPAIR", "EVIDENCE_SUPPLEMENT", "REWORK", "APPLYING"].includes(phase)) return getConnected() ? "ok running" : "unknown";
    return "unknown";
  }

  function workerRuntimeStatus(runtime) {
    if (!getConnected() || !runtime) return { state:"unknown", detail:"확인 전" };
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

  return { bindHealthInteractions, health, signal, runAppearance, workerRuntimeStatus };
}
