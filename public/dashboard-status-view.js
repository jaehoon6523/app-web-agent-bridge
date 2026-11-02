import { redactDiagnosticLog } from "./diagnostic-export.js";

export function bindingPresentation({ connected, webAuthenticated, binding, workflowStage }) {
  if (!connected) return { state:"unknown", detail:"최신 상태 확인 필요" };
  if (!webAuthenticated) return { state:"warn", detail:"확장 연결 대기" };
  if (["BOUND", "ROOT_READY"].includes(binding?.bindingStatus)) return { state:"ok", detail:`연결됨 · ${binding.bindingStatus}` };
  if (binding?.bindingStatus) return { state:"warn", detail:`연결 확인 필요 · ${binding.bindingStatus}` };
  return { state:workflowStage === "START" ? "unknown" : "warn", detail:workflowStage === "START"
    ? "대화 선택 전 · 준비 시작 시 연결" : "대화 연결 미확인" };
}

export function showDashboardPageError(error) {
  const panel = document.getElementById("dashboardPageError");
  if (!panel) return;
  if (!panel.hidden) { console.error("Additional dashboard page failure:", error); return; }
  panel.hidden = false;
  const detail = typeof error?.message === "string" ? redactDiagnosticLog(error.message).slice(0, 500) : "";
  panel.textContent = "화면 초기화 또는 표시 중 오류가 발생했습니다. 페이지를 새로고침하세요."
    + (detail ? " 원인: " + detail : " 브라우저 Console의 오류를 확인하세요.");
  document.getElementById("dashboardPhase").textContent = "화면 오류";
  document.getElementById("dashboardErrorCode").textContent = "DASHBOARD_RENDER_FAILED";
  // Prevent stale controls from dispatching mutations after a render failure.
  for (const control of document.querySelectorAll("button")) {
    if (control.id !== "refreshDashboard") control.disabled = true;
  }
  document.getElementById("refreshDashboard").textContent = "페이지 새로고침";
  document.getElementById("refreshDashboard").onclick = () => window.location.reload();
  console.error("Dashboard page failed:", error);
}

export function updateDashboardDiagnostics({ phase, connectionState, snapshot, lastConfirmed, target, loading = false }) {
  if (document.getElementById("dashboardPageError")?.hidden === false) return;
  const put = (id, value) => { document.getElementById(id).textContent = value; };
  document.getElementById("runPanel").dataset.loadState = phase === "READY" ? "READY" : connectionState.lastError ? "ERROR" : "LOADING";
  if (loading && snapshot && !connectionState.lastError) put("connectionNotice", target && target !== snapshot.run?.runId
    ? `작업 ${target} 조회 중입니다.` : "작업 상태 조회 중 · 마지막 확인 데이터 표시 중입니다.");
  const labels = { SESSION:"대시보드 인증 확인", STATE:"작업 상태 조회", PROJECTION:"화면 데이터 확인", READY:"최신 상태 확인 완료" };
  put("dashboardAddress", window.location.origin);
  put("dashboardPhase", connectionState.runtimeError ? "화면 데이터 해석 실패" : labels[phase] ?? phase);
  const error = connectionState.lastError;
  put("dashboardErrorCode", error ? [error.code, error.status ? `HTTP ${error.status}` : null].filter(Boolean).join(" · ") || "상태 확인 실패" : "없음");
  const failures = connectionState.failureHistory ?? [];
  const history = document.getElementById("dashboardLastError");
  if (history) history.textContent = failures.length
    ? [error ? "해결되지 않은 오류가 있습니다." : "현재 상태 조회는 복구됐습니다.", ...failures.map(failure =>
      [failure.at ? new Date(failure.at).toLocaleString("ko-KR") : null, failure.code,
        failure.status ? `HTTP ${failure.status}` : null, failure.message].filter(Boolean).join(" · "))].join("\n")
    : "없음";
  const runtime = snapshot?.runtimeAvailability;
  put("dashboardRuntimeDetail", runtime?.ready === true ? "준비됨" : runtime?.ready === false
    ? ["준비 실패 또는 대기", runtime.code, runtime.message].filter(Boolean).join(" · ") : "확인 전");
  put("dashboardLastConfirmed", lastConfirmed ? new Date(lastConfirmed).toLocaleString("ko-KR") : "없음");
  if (error || runtime?.ready === false) document.getElementById("connectionDiagnostics").open = true;
}

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
export function userFacingError(error, fallback = "요청을 처리하지 못했습니다. 최신 상태를 확인하고 필요하면 진단 로그를 내보내세요.") {
  const code = typeof error?.code === "string" ? error.code : null;
  if (code && errorCopy[code]) return errorCopy[code];
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  if (message && /[가-힣]/u.test(message)) return message;
  return fallback;
}
export function userFacingStoredError(value, fallback) {
  const message = typeof value === "string" ? value.trim() : "";
  if (!message) return fallback;
  return /[가-힣]/u.test(message) ? message : fallback;
}

export function runCommandSuccessMessage(type) {
  return {
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
}

export const phaseReasons = {
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
