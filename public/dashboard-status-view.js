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
  panel.hidden = false;
  panel.textContent = "화면 초기화 또는 표시 중 오류가 발생했습니다. 페이지를 새로고침하세요. 계속되면 브라우저 Console의 오류를 확인하세요.";
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

export function updateDashboardDiagnostics({ phase, connectionState, snapshot, lastConfirmed }) {
  const put = (id, value) => { document.getElementById(id).textContent = value; };
  const labels = { SESSION:"대시보드 인증 확인", STATE:"작업 상태 조회", PROJECTION:"화면 데이터 확인", READY:"최신 상태 확인 완료" };
  put("dashboardAddress", window.location.origin);
  put("dashboardPhase", connectionState.runtimeError ? "화면 데이터 해석 실패" : labels[phase] ?? phase);
  const error = connectionState.lastError;
  put("dashboardErrorCode", error ? [error.code, error.status ? `HTTP ${error.status}` : null].filter(Boolean).join(" · ") || "상태 확인 실패" : "없음");
  const runtime = snapshot?.runtimeAvailability;
  put("dashboardRuntimeDetail", runtime?.ready === true ? "준비됨" : runtime?.ready === false
    ? ["준비 실패 또는 대기", runtime.code, runtime.message].filter(Boolean).join(" · ") : "확인 전");
  put("dashboardLastConfirmed", lastConfirmed ? new Date(lastConfirmed).toLocaleString("ko-KR") : "없음");
  if (error || runtime?.ready === false) document.getElementById("connectionDiagnostics").open = true;
}
