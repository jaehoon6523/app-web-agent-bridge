import { externalEventRecords } from "./dashboard-model.js";
import { projectRunCommandActions } from "./dashboard-action-capabilities.js";
import { projectDashboardKnowledge } from "./dashboard-connection-state.js";

export function createDashboardAuditPresentation({
  $, text, node, time, openFindings, openEvidence,
  getConnectionState, getSnapshot, getOperations,
}) {
  function evidenceLinks(container, refs) {
    const links = node("div", "", "links");
    const snapshot = getSnapshot();
    const operations = getOperations();
    const knowledge = projectDashboardKnowledge(getConnectionState());
    const actions = projectRunCommandActions({
      stateAvailable:knowledge.stateRead.currentlyAvailable,
      runPresent:Boolean(snapshot?.run),
      commandCapabilities:snapshot?.commandCapabilities ?? [],
    });
    for (const id of refs ?? []) {
      const button = node("button", `근거 ${id.slice(-8)}`);
      button.disabled = !actions.openEvidence || (operations.runCommand !== "IDLE");
      button.title = !actions.openEvidence ? "최신 실행 상태와 근거 조회 권한을 확인해야 합니다."
        : (operations.runCommand !== "IDLE") ? "현재 요청 처리가 끝나면 근거를 열 수 있습니다." : "근거 원문을 엽니다.";
      button.addEventListener("click", () => openEvidence(id));
      links.append(button);
    }
    container.append(links);
  }

  function renderAudit() {
    const snapshot = getSnapshot();
    const run = snapshot?.run;
    const assessments = $("assessments"), findings = $("findings"), evidence = $("evidenceList");
    assessments.replaceChildren(); findings.replaceChildren(); evidence.replaceChildren();
    for (const req of run?.requirements?.items ?? []) {
      const a = snapshot.assessments?.find((item) => item.requirementId === req.requirementId);
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
      ? "아직 요구사항별 감사 결과가 없습니다." : "요구사항 기록이 없습니다. 확인 가능한 대화와 상태 변경은 ‘진행 기록’에서 확인하세요.", "muted"));
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
      ? "등록된 감사 지적이 없습니다." : "요구사항별 감사 지적 기록이 없습니다.", "muted"));
    for (const e of snapshot?.evidence ?? []) {
      const row = node("article", "", "record");
      row.append(node("strong", `${e.kind} · ${e.producer}${e.valid === false ? " · 후보 증거로 무효" : ""}`), node("p", `${e.candidateId} · ${time(e.createdAt)}`, "muted"), node("p", JSON.stringify(e.result)));
      evidenceLinks(row, [e.evidenceId]); evidence.append(row);
    }
    text("candidateDetails", JSON.stringify({ project:run?.projectRef, requirements:run?.requirements, worker:run?.worker, workerTurns:run?.workerTurns, candidate:run?.candidate, latestReview:run?.reviews?.at(-1), missingInformation:run?.missingInformation, application:run?.application, recovery:run?.recovery }, null, 2));
  }

  function renderLog() {
    const snapshot = getSnapshot();
    const log = $("eventLog"); log.replaceChildren();
    const records = [...(snapshot?.events ?? []).map((event) => ({ at:event.createdAt, title:event.type, content:JSON.stringify(event.payload) })),
      ...(snapshot?.messages ?? []).map((message) => ({ at:message.createdAt, title:message.fromActor ?? "CONTROLLER", content:message.content })),
      ...externalEventRecords(snapshot?.run, snapshot?.evidence ?? [])].sort((a,b) => String(a.at).localeCompare(String(b.at)));
    for (const record of records) {
      const row = node("article", "", "record"); row.append(node("time", time(record.at)), node("p", record.title), node("pre", record.content)); log.append(row);
    }
    if (!records.length) log.append(node("p", "아직 수신한 실행 기록이 없습니다.", "muted"));
  }

  return { renderAudit, renderLog };
}
