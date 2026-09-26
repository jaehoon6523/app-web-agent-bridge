const MAX_ACTIVITY_PER_RUN = 40;
const MAX_DETAIL_CHARS = 700;

function clipped(value, max = MAX_DETAIL_CHARS) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function push(records, run, at, kind, summary, detail = "", extra = {}) {
  if (typeof at !== "string" || !at) return;
  records.push({
    at,
    kind,
    summary,
    detail:clipped(detail),
    phase:extra.phase ?? null,
    status:extra.status ?? null,
    role:extra.role ?? null,
    candidateId:extra.candidateId ?? null,
    runId:run.runId ?? run.id ?? null,
  });
}

export function projectRunActivity(run) {
  if (!run || typeof run !== "object") return [];
  const records = [];
  const objective = clipped(run.objective ?? "작업");
  const parentRunId = run.followUp?.runId ?? run.parentRunId ?? null;

  push(records, run, run.createdAt,
    parentRunId ? "FOLLOW_UP_STARTED" : "RUN_STARTED",
    parentRunId ? `후속 작업 시작 · ${objective}` : `작업 시작 · ${objective}`,
    parentRunId ? `이전 작업 ${parentRunId}에서 이어짐` : "");

  for (const event of run.events ?? []) {
    if (event?.type === "STAGE_CHANGED") {
      const stage = event.payload?.stage ?? null;
      const previous = event.payload?.previous ?? null;
      push(records, run, event.createdAt, "STAGE_CHANGED",
        `${previous ?? "UNKNOWN"} → ${stage ?? "UNKNOWN"}`,
        clipped(event.payload?.reason ?? ""), { phase:stage });
    } else if (event?.type === "RUN_ARCHIVED" || event?.type === "RUN_UNARCHIVED") {
      push(records, run, event.createdAt, event.type,
        event.type === "RUN_ARCHIVED" ? "작업 기록 보관" : "작업 기록 보관 해제");
    }
  }

  for (const note of run.operatorNotes ?? []) {
    push(records, run, note.createdAt,
      note.kind === "DECISION" ? "USER_DECISION_NOTE" : "USER_NOTE",
      note.kind === "DECISION" ? "사용자 결정 기록" : "사용자 작업 메모",
      note.text, { phase:note.phase, candidateId:note.candidateId });
  }

  for (const intervention of run.userInterventions ?? []) {
    push(records, run, intervention.updatedAt ?? intervention.createdAt, "WORKER_INTERVENTION",
      `Worker ${intervention.kind === "QUESTION" ? "질문" : "방향 전달"} · ${intervention.status ?? "UNKNOWN"}`,
      intervention.text, { status:intervention.status });
  }

  for (const discussion of run.reviewDiscussions ?? []) {
    push(records, run, discussion.updatedAt ?? discussion.createdAt, "REVIEW_DISCUSSION",
      `${discussion.role ?? "REVIEWER"} 대화 · ${discussion.status ?? "UNKNOWN"}`,
      discussion.text, { role:discussion.role, status:discussion.status, candidateId:discussion.candidateId });
  }

  for (const decision of run.userDecisions ?? []) {
    const responses = Array.isArray(decision.responses) ? decision.responses : [];
    push(records, run, decision.at ?? decision.createdAt, "REVIEW_QUESTION_ANSWERED",
      `감사 확인 질문 ${responses.length}건 답변`,
      responses.map((item) => `${item.requestItemId ?? "질문"}: ${item.answer ?? ""}`).join("\n"),
      { candidateId:decision.candidateId });
  }

  records.sort((left, right) => {
    const byTime = String(left.at).localeCompare(String(right.at));
    if (byTime !== 0) return byTime;
    return String(left.kind).localeCompare(String(right.kind));
  });
  return records.slice(-MAX_ACTIVITY_PER_RUN);
}

export const PROJECT_ACTIVITY_LIMIT_PER_RUN = MAX_ACTIVITY_PER_RUN;
