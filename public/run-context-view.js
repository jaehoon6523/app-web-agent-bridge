const REVIEW_ROLES = Object.freeze(["JUDGE", "CRITIC"]);
const PROVIDER_LABELS = Object.freeze({
  CHATGPT_WEB:"ChatGPT Web",
  CLAUDE_WEB:"Claude Web",
});

export function providerDisplayName(provider) {
  if (typeof provider !== "string" || !provider) return "서비스 확인 필요";
  return PROVIDER_LABELS[provider] ?? provider;
}

function reviewerBinding(run, role) {
  return (run?.conversationBindings ?? []).find((item) => item.role === role) ?? null;
}

function currentReviewCompleted(run, role) {
  if (!["REVIEW_RUNNING", "REPORT_REPAIR"].includes(run?.phase)) return false;
  const candidateId = run?.candidate?.candidateId ?? null;
  const manifestHash = run?.coordination?.auditManifestHash ?? null;
  if (!candidateId || !manifestHash) return false;
  return (run?.requests ?? []).some((item) =>
    item.role === role
    && item.candidateId === candidateId
    && item.auditManifestHash === manifestHash
    && item.status === "PROCESSED");
}

function candidateWasReviewed(run, role) {
  const candidateId = run?.candidate?.candidateId ?? null;
  if (!candidateId) return false;
  if ((run?.reviewArtifacts ?? []).some((item) =>
    item.role === role && item.candidateId === candidateId)) return true;
  return ["AWAITING_APPLY", "APPLIED", "REWORK", "INCONCLUSIVE", "HOLD"].includes(run?.phase)
    && (run?.reviews ?? []).some((item) => item.candidateId === candidateId);
}

export function reviewerRoleSummary(run, reviewerRuntimes, role) {
  if (!REVIEW_ROLES.includes(role)) throw new TypeError(`Unknown reviewer role: ${role}`);
  const binding = reviewerBinding(run, role);
  const runtime = reviewerRuntimes?.[role] ?? null;
  const configuredProvider = binding?.provider ?? run?.reviewers?.[role]?.provider ?? null;
  const observedProvider = runtime?.provider ?? null;
  const provider = providerDisplayName(configuredProvider ?? observedProvider);
  if (configuredProvider && observedProvider && configuredProvider !== observedProvider) {
    return Object.freeze({ role, provider, status:"서비스 연결 불일치 · 확인 필요", tone:"warn" });
  }
  const active = run?.coordination?.activeRole === role;
  if (binding?.activeDeliveryId) {
    const receipt = run.webDeliveryReceipts?.find(item => item.deliveryId === binding.activeDeliveryId);
    if (receipt?.state === "ACK_PENDING") return Object.freeze({ role, provider, status:"응답 저장됨 · ACK 확인 대기", tone:"warn" });
    if (["HOLD", "RECOVERY_REQUIRED"].includes(run.phase)) return Object.freeze({ role, provider, status:"전송 결과 확인 필요", tone:"warn" });
    return Object.freeze({ role, provider, status:"응답 대기", tone:"ok running" });
  }
  if (run?.phase === "HOLD" && run?.terminationReason === "WEB_BINDING_REQUIRED" && active) {
    return Object.freeze({ role, provider, status:"연결 확인 필요", tone:"warn" });
  }
  if (["REVIEW_RUNNING", "REPORT_REPAIR"].includes(run?.phase)) {
    if (active) {
      return Object.freeze({
        role,
        provider,
        status:run.phase === "REPORT_REPAIR" ? "응답 확인 중" : "검토 중",
        tone:"ok running",
      });
    }
    if (currentReviewCompleted(run, role)) {
      return Object.freeze({ role, provider, status:"이번 검토 완료", tone:"ok" });
    }
    return Object.freeze({ role, provider, status:"검토 대기", tone:"" });
  }
  if (candidateWasReviewed(run, role)) {
    return Object.freeze({ role, provider, status:"현재 변경사항 검토 완료", tone:"ok" });
  }
  if (run?.candidate?.candidateId) {
    return Object.freeze({ role, provider, status:"검토 대기", tone:"" });
  }
  return Object.freeze({ role, provider, status:"변경사항 대기", tone:"" });
}

export function workerRoleSummary(run, workerLabel) {
  if (run?.phase === "WORKER_RUNNING") {
    return Object.freeze({ role:"WORKER", provider:workerLabel, status:"구현 중", tone:"ok running" });
  }
  if (run?.candidate?.candidateId) {
    return Object.freeze({ role:"WORKER", provider:workerLabel, status:"변경사항 고정", tone:"ok" });
  }
  if (run?.phase === "RECOVERY_REQUIRED") {
    return Object.freeze({ role:"WORKER", provider:workerLabel, status:"확인 필요", tone:"warn" });
  }
  return Object.freeze({
    role:"WORKER",
    provider:workerLabel,
    status:["CANCELLED", "FAILED", "INCONCLUSIVE"].includes(run?.phase) ? "변경사항 없음" : "대기",
    tone:"",
  });
}

function runtimeDetail(role, runtime) {
  if (!runtime) return `${role}: 현재 runtime에서 확인되지 않음`;
  return `${role}: provider ${runtime.provider ?? "미확인"} · provider 근거 ${runtime.providerEvidence ?? "미확인"} · model ${runtime.model ?? "관측 불가"} · model 근거 ${runtime.modelEvidence ?? "UNOBSERVED"}`;
}

export function reviewerRuntimeTechnicalSummary(reviewerRuntimes, legacyReviewerRuntime = null) {
  const runtimes = reviewerRuntimes ?? (legacyReviewerRuntime ? { JUDGE:legacyReviewerRuntime } : {});
  return `Reviewer 실행 출처 · ${runtimeDetail("Judge", runtimes.JUDGE)} / ${runtimeDetail("Critic", runtimes.CRITIC)}`;
}

export function createRunContextView({ $, text, labels, terminal, folderName, workerIdentity }) {
  function renderRole(id, label, summary, run) {
    const element = $(id);
    if (!element) return;
    text(id, `${label} · ${summary.provider} · ${summary.status}`);
    element.className = `run-role health${summary.tone ? ` ${summary.tone}` : ""}`;
    const binding = reviewerBinding(run, summary.role);
    if (binding?.activeDeliveryId && element.ownerDocument?.createElement) {
      const link = element.ownerDocument.createElement("a"); link.textContent = " · 전송 상태 확인";
      link.href = "/delivery-recovery.html?" + new URLSearchParams({ currentDeliveryId: binding.activeDeliveryId,
        sessionId: binding.sessionId, runId: run.runId, conversationUrl: binding.conversationUrl });
      element.append(link);
    }
  }

  return function renderRunContextView(run, snapshot) {
    if (!run) return;
    text("runContext", run.requirements
      ? `${folderName(run.projectRef?.targetRoot)} · ${labels[run.phase] ?? run.phase} · 구현 ${run.iteration ?? 0}회`
      : `작업 기록 · ${labels[run.phase] ?? run.phase} · ${terminal.has(run.phase) ? "종료됨" : "진행 중"}`);
    const reviewerRuntimes = snapshot?.reviewerRuntimes
      ?? (snapshot?.reviewerRuntime ? { JUDGE:snapshot.reviewerRuntime } : {});
    renderRole("runWorkerRole", "Worker", workerRoleSummary(run, workerIdentity(run)));
    renderRole("runJudgeRole", "Judge", reviewerRoleSummary(run, reviewerRuntimes, "JUDGE"), run);
    renderRole("runCriticRole", "Critic", reviewerRoleSummary(run, reviewerRuntimes, "CRITIC"), run);
  };
}
