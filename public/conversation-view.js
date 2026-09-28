function parseReviewerPacket(content) {
  try {
    const packet = JSON.parse(content);
    if (packet?.type === "INVALID_RESPONSE") return { kind:"INVALID_RESPONSE", packet };
    if (packet?.type === "REVIEW_ASSERTIONS") return { kind:"REVIEW_ASSERTIONS", packet };
    if (typeof packet?.type === "string" && /^[A-Z][A-Z0-9_]+$/u.test(packet.type)) return { kind:"PROTOCOL", packet };
  } catch {
    if (/"type"\s*:\s*"INVALID_RESPONSE"/u.test(content)) return { kind:"INVALID_RESPONSE", packet:null };
    if (/"type"\s*:\s*"REVIEW_ASSERTIONS"/u.test(content)) return { kind:"REVIEW_ASSERTIONS", packet:null };
  }
  return null;
}

function reviewPhaseLabel(phase) {
  if (phase === "ROUND0") return "1차 독립 검토";
  if (phase === "ROUND1") return "교차 검토";
  if (phase === "REPORT_REPAIR") return "검토 응답 확인";
  return "독립 검토";
}

function reviewerAssertionSummary(packet) {
  if (!packet || !Array.isArray(packet.assessments)) return "검토 응답을 제출했습니다. 세부 판정은 ‘감사 지적·근거’에서 확인하세요.";
  const verdicts = packet.assessments.map((item) => item?.verdict);
  const satisfied = verdicts.filter((value) => value === "SATISFIED").length;
  const unsatisfied = verdicts.filter((value) => value === "UNSATISFIED").length;
  const undetermined = verdicts.filter((value) => value === "UNDETERMINED").length;
  const requiredFindings = Array.isArray(packet.newFindings) ? packet.newFindings.filter((item) => item?.required === true).length : 0;
  const parts = [`요구사항 ${verdicts.length}개 검토`, `충족 ${satisfied}`];
  if (unsatisfied) parts.push(`미충족 ${unsatisfied}`);
  if (undetermined) parts.push(`판단 보류 ${undetermined}`);
  parts.push(requiredFindings ? `새 필수 지적 ${requiredFindings}건` : "새 필수 지적 없음");
  return parts.join(" · ");
}

function reviewDecisionLabel(decision) {
  return { PASS:"검토 통과", HOLD:"확인 필요", REWORK:"수정 필요", INCONCLUSIVE:"미해결 상태" }[decision]
    ?? (decision || "판정 확인 필요");
}

export function conversationEntryMeta(entry, time) {
  return [entry?.at ? time(entry.at) : null, entry?.detail || null].filter(Boolean).join(" · ");
}

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
    entries.push({ at:at ?? null, role, content, detail, kind, order:order++ });
  };
  for (const turn of run.preparationSnapshot?.discussion ?? []) {
    add(turn.createdAt, turn.actor === "USER" ? "사용자 · 요구사항" : "웹 설계자 · 요구사항",
      turn.content, "준비 대화");
  }
  for (const note of run.operatorNotes ?? []) {
    add(note.createdAt, note.kind === "DECISION" ? "사용자 · 결정 기록" : "사용자 · 작업 메모",
      note.text, note.phase ? `당시 상태 ${note.phase}` : "", "decision");
  }
  for (const intervention of run.userInterventions ?? []) {
    const role = intervention.kind === "QUESTION" ? "사용자 · 구현 질문" : "사용자 · 구현 참고";
    const status = intervention.status === "DELIVERED" ? "전달 확인" : intervention.status === "FAILED" ? "전달 실패" : "전달 확인 중";
    add(intervention.createdAt, role, intervention.text, `현재 Worker · ${status}`, "decision");
  }
  for (const discussion of run.reviewDiscussions ?? []) {
    const status = discussion.status === "DELIVERED" ? "답변 확인"
      : discussion.status === "UNCONFIRMED" ? "전송 결과 미확인"
      : discussion.status === "DISCARDED" ? "확인되지 않은 요청 정리"
      : discussion.status === "FAILED" ? "전송 실패" : "전송 확인 중";
    add(discussion.createdAt, `사용자 → ${discussion.role}`, discussion.text,
      `현재 변경사항 · ${status}`, "decision");
    if (typeof discussion.response === "string" && discussion.response.trim()) {
      add(discussion.updatedAt, `${discussion.role} · 자유 대화`, discussion.response,
        "감사 상태 변경 없음");
    }
  }

  const reviewerMessages = (run.messages ?? []).filter((message) => message.role === "JUDGE" || message.role === "CRITIC");
  const validReviewerRoles = new Set(reviewerMessages
    .filter((message) => parseReviewerPacket(message.content)?.kind === "REVIEW_ASSERTIONS")
    .map((message) => message.role));
  const invalidByRole = new Map();

  for (const message of run.messages ?? []) {
    const request = (run.requests ?? []).find((item) => item.requestId === message.messageId);
    const candidateId = message.candidateId ?? request?.candidateId;
    if (message.fromActor === "CODEX_AGENT" || message.fromActor === "CODE_WORKER") {
      add(message.createdAt, "구현자 보고", workerReport(message.content),
        candidateId ? "변경사항 고정 후 보고" : "변경사항 고정 전 보고", "worker");
      continue;
    }
    if (message.role !== "JUDGE" && message.role !== "CRITIC") continue;
    const role = message.role === "JUDGE" ? "Judge" : "Critic";
    const packet = parseReviewerPacket(message.content);
    const phase = reviewPhaseLabel(message.phase ?? request?.phase);
    if (packet?.kind === "INVALID_RESPONSE") {
      if (!validReviewerRoles.has(message.role)) {
        const current = invalidByRole.get(message.role) ?? { count:0, at:null, phase };
        invalidByRole.set(message.role, { count:current.count + 1, at:message.createdAt ?? current.at, phase });
      }
      continue;
    }
    if (packet?.kind === "REVIEW_ASSERTIONS") {
      add(message.createdAt, `${role} · 독립 검토`, reviewerAssertionSummary(packet.packet), phase);
      continue;
    }
    if (packet?.kind === "PROTOCOL") {
      add(message.createdAt, `${role} · 검토 제어 응답`,
        "검토 제어 응답을 기록했습니다. 세부 내용은 ‘진행 기록’에서 확인하세요.", phase);
      continue;
    }
    add(message.createdAt, `${role} 의견`, message.content, phase);
  }

  for (const [role, invalid] of invalidByRole) {
    add(invalid.at, `${role === "JUDGE" ? "Judge" : "Critic"} · 검토 응답 확인`,
      `검토 응답 형식이 올바르지 않아 결과로 사용되지 않았습니다.${invalid.count > 1 ? ` 동일 유형 ${invalid.count}회` : ""}`,
      invalid.phase);
  }

  for (const decision of run.userDecisions ?? []) {
    for (const answer of decision.responses ?? []) {
      const question = (run.missingInformation ?? []).find((item) => item.requestItemId === answer.requestItemId);
      add(decision.at, "사용자 답변", `${question?.question ?? question?.description ?? "감사자의 확인 질문"}\n${answer.answer}`,
        "감사 질문에 대한 사용자 결정", "decision");
    }
  }
  for (const review of run.reviews ?? []) {
    const assessmentCount = review.report?.assessments?.length ?? 0;
    const unresolved = (review.findings ?? []).filter((item) =>
      item?.required === true && ["OPEN", "FIX_SUBMITTED"].includes(item.status)).length;
    const detail = assessmentCount ? `요구사항 ${assessmentCount}개 · 미해결 필수 지적 ${unresolved}건` : "독립 검토 결과";
    add(review.createdAt ?? review.updatedAt ?? null, "감사 판정", reviewDecisionLabel(review.decision), detail, "outcome");
  }
  entries.sort((a, b) => a.at && b.at ? String(a.at).localeCompare(String(b.at)) || a.order - b.order : a.order - b.order);
  for (const entry of entries) {
    const row = node("article", "", `conversation-entry ${entry.kind}`.trim());
    row.append(node("strong", entry.role));
    const meta = conversationEntryMeta(entry, time);
    if (meta) row.append(node("p", meta, "muted"));
    row.append(node("p", entry.content));
    timeline.append(row);
  }
  if (!entries.length) timeline.append(node("p", "아직 표시할 대화가 없습니다. 상태와 기계 기록은 ‘진행 기록’에서 확인하세요.", "muted"));
}
