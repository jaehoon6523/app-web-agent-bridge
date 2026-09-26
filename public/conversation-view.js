function workerReport(content) {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary : content;
  } catch { return content; }
}
export function renderConversation(run, timeline, node, time) {
  timeline.replaceChildren();
  if (!run) { timeline.append(node("p", "작업을 선택하면 준비 대화와 역할별 작업 기록을 볼 수 있습니다.", "muted")); return; }
  const entries = [];
  let order = 0;
  const add = (at, role, content, detail = "", kind = "") => {
    if (typeof content !== "string" || !content.trim()) return;
    entries.push({ at, role, content, detail, kind, order:order++ });
  };
  for (const turn of run.preparationSnapshot?.discussion ?? []) {
    add(turn.createdAt, turn.actor === "USER" ? "사용자 · 요구사항" : "웹 설계자 · 요구사항",
      turn.content, `준비 대화 · ${run.preparationSnapshot?.preparationId ?? "ID 없음"}`);
  }
  for (const note of run.operatorNotes ?? []) {
    add(note.createdAt, note.kind === "DECISION" ? "사용자 · 결정 기록" : "사용자 · 작업 메모",
      note.text, [`당시 상태 ${note.phase ?? "미확인"}`, note.candidateId && `후보 ${note.candidateId}`].filter(Boolean).join(" · "),
      "decision");
  }
  for (const intervention of run.userInterventions ?? []) {
    const role = intervention.kind === "QUESTION" ? "사용자 · 구현 질문" : "사용자 · 구현 참고";
    const status = intervention.status === "DELIVERED" ? "전달 확인" : intervention.status === "FAILED" ? "전달 실패" : "전달 확인 중";
    add(intervention.createdAt, role, intervention.text, `Worker turn ${intervention.turnId ?? "확인 전"} · ${status}`, "decision");
  }
  for (const discussion of run.reviewDiscussions ?? []) {
    const status = discussion.status === "DELIVERED" ? "답변 확인"
      : discussion.status === "UNCONFIRMED" ? "전송 결과 미확인"
      : discussion.status === "DISCARDED" ? "미확정 전송 폐기"
      : discussion.status === "FAILED" ? "전송 실패" : "전송 확인 중";
    add(discussion.createdAt, `사용자 → ${discussion.role}`, discussion.text,
      `후보 ${discussion.candidateId ?? "정보 없음"} · ${status}`, "decision");
    if (typeof discussion.response === "string" && discussion.response.trim()) {
      add(discussion.updatedAt, `${discussion.role} · 자유 대화`, discussion.response,
        `후보 ${discussion.candidateId ?? "정보 없음"} · 감사 상태 변경 없음`);
    }
  }
  for (const message of run.messages ?? []) {
    const request = (run.requests ?? []).find((item) => item.requestId === message.messageId);
    const candidateId = message.candidateId ?? request?.candidateId;
    const provenance = [message.phase ?? request?.phase, candidateId && `후보 ${candidateId}`,
      (message.auditManifestHash ?? request?.auditManifestHash) && `감사 기준 ${message.auditManifestHash ?? request?.auditManifestHash}`].filter(Boolean).join(" · ");
    if (message.fromActor === "CODEX_AGENT" || message.fromActor === "CODE_WORKER") {
      add(message.createdAt, "구현자 보고", workerReport(message.content), provenance || "후보 정보 없음", "worker");
    } else if (message.fromActor === "CHATGPT_WEB_AGENT") {
      add(message.createdAt, `${message.role === "JUDGE" ? "Judge" : message.role === "CRITIC" ? "Critic" : message.role ?? request?.role ?? "감사자"} 의견`, message.content,
        provenance || "후보 정보 없음");
    }
  }
  for (const decision of run.userDecisions ?? []) {
    for (const answer of decision.responses ?? []) {
      const question = (run.missingInformation ?? []).find((item) => item.requestItemId === answer.requestItemId);
      add(decision.at, "사용자 답변", `${question?.question ?? question?.description ?? answer.requestItemId}\n${answer.answer}`,
        `후보 ${decision.candidateId} · 질문 ${answer.requestItemId}`, "decision");
    }
  }
  for (const review of run.reviews ?? []) {
    add(review.createdAt, "감사 판정", `판정: ${review.decision ?? "확인 필요"}`,
      [`후보 ${review.candidateId ?? "정보 없음"}`, review.auditManifestHash && `감사 기준 ${review.auditManifestHash}`].filter(Boolean).join(" · "), "outcome");
  }
  entries.sort((a, b) => a.at && b.at ? String(a.at).localeCompare(String(b.at)) || a.order - b.order : a.order - b.order);
  for (const entry of entries) {
    const row = node("article", "", `conversation-entry ${entry.kind}`.trim());
    row.append(node("strong", entry.role), node("p", `${time(entry.at)} · ${entry.detail}`, "muted"), node("p", entry.content));
    timeline.append(row);
  }
  if (!entries.length) timeline.append(node("p", "아직 표시할 대화가 없습니다. 상태와 기계 기록은 ‘진행 기록’에서 확인하세요.", "muted"));
}
