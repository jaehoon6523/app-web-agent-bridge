import { externalEventRecords } from "./dashboard-model.js";
import { projectRunCommandActions } from "./dashboard-action-capabilities.js";
import { projectDashboardKnowledge } from "./dashboard-connection-state.js";

const candidateDecisions = new Map([
  ["PASS", "감사 통과"],
  ["REWORK", "수정 필요"],
  ["HOLD", "감사 보류"],
]);

const changeLabels = {ADDED:"추가", MODIFIED:"수정", DELETED:"삭제"};

function gitHeaderPaths(path) {
  const encode = value => Array.from(new TextEncoder().encode(value), byte => {
    if (byte === 34 || byte === 92) return `\\${String.fromCharCode(byte)}`;
    const named = {7:"a",8:"b",9:"t",10:"n",11:"v",12:"f",13:"r"};
    if (named[byte]) return `\\${named[byte]}`;
    return byte < 32 || byte >= 127 ? `\\${byte.toString(8).padStart(3,"0")}` : String.fromCharCode(byte);
  }).join("");
  return [`diff --git a/${path} b/${path}`, `diff --git "${encode(`a/${path}`)}" "${encode(`b/${path}`)}"`];
}

export function createDashboardAuditPresentation({
  $, text, node, time, openFindings, openEvidence, closeInspectorEvidence,
  getConnectionState, getSnapshot, getOperations,
}) {
  function evidenceLinks(container, refs, candidate = null, source = container.id, patchPath, range) {
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
      const button = node("button", candidate?.labels.get(id) ?? `근거 ${id.slice(-8)}`);
      button.type = "button";
      button.dataset.evidenceId = id;
      if (patchPath !== undefined) button.dataset.patchPath = patchPath;
      button.disabled = !actions.openEvidence || (operations.runCommand !== "IDLE");
      button.title = !actions.openEvidence ? "최신 실행 상태와 근거 조회 권한을 확인해야 합니다."
        : (operations.runCommand !== "IDLE") ? "현재 요청 처리가 끝나면 근거를 열 수 있습니다." : "근거 원문을 엽니다.";
      if (range) button.dataset.evidenceStart = String(range.startLine);
      button.addEventListener("click", () => openEvidence(id, range?.startLine ?? 1, candidate?.id, source, patchPath, range?.endLine));
      links.append(button);
    }
    container.append(links);
  }

  let inspectorEvidenceKey = "", selection = null;
  let inspectorReason = "";
  let patchIndex;
  function recordPatchPage(run, result) {
    if (result.kind !== "PATCH" || !result.evidenceId || result.candidateId !== run?.candidate?.candidateId
      || typeof result.content !== "string") return;
    const key = JSON.stringify([run.runId, result.candidateId, result.evidenceId]);
    if (patchIndex?.key !== key) {
      const headers = new Map((run.candidate.changedFiles ?? []).flatMap(path => gitHeaderPaths(path).map(header => [header,path])));
      patchIndex = {key, headers, types:new Map()};
    }
    let path = patchIndex.nextLine === result.startLine ? patchIndex.path : undefined;
    const lines = result.content.split("\n");
    for (const line of lines) {
      if (line.startsWith("diff --git ")) path = patchIndex.headers.get(line);
      else if (path) {
        if (line.startsWith("new file mode ")) patchIndex.types.set(path,"ADDED");
        else if (line.startsWith("deleted file mode ")) patchIndex.types.set(path,"DELETED");
        else if (/^(?:old mode [0-7]+$|index (?!0+\.\.)[0-9a-f]+\.\.(?!0+(?:\s|$))[0-9a-f]+(?:\s|$))/u.test(line)) {
          if (!patchIndex.types.has(path)) patchIndex.types.set(path,"MODIFIED");
        } else if (line.startsWith("@@ ") || line === "GIT binary patch") path = undefined;
      }
    }
    patchIndex.path = path;
    patchIndex.nextLine = result.endLine + 1;
    renderApplyInspector(run, inspectorReason);
  }
  $("clearApplyInspectorSelection").addEventListener("click", () => {
    closeInspectorEvidence(false);
    selection = null;
    renderApplyInspector(getSnapshot()?.run, inspectorReason);
    $("applyInspectorEvidence").querySelector("button")?.focus();
  });

  function renderApplyInspector(run, applyReason) {
    const panel = $("applyInspector");
    const candidate = run?.candidate;
    const relevant = ["HOLD", "AWAITING_APPLY", "APPLYING", "APPLIED"].includes(run?.phase)
      || (run?.phase === "RECOVERY_REQUIRED" && run.application?.candidateId === candidate?.candidateId);
    panel.hidden = !candidate?.candidateId || !relevant;
    if (selection && (selection.runId !== run?.runId || selection.candidateId !== candidate?.candidateId)) selection = null;
    if (panel.hidden) return;
    inspectorReason = applyReason;

    const lastReview = run.reviews?.at(-1);
    const review = lastReview?.candidateId === candidate.candidateId ? lastReview : null;
    const application = run.application?.candidateId === candidate.candidateId ? run.application : null;
    const status = run.phase === "AWAITING_APPLY" ? applyReason
      : run.phase === "APPLIED" && application?.status === "APPLIED" ? "서버 적용 기록 확인 완료"
        : run.phase === "APPLYING" ? "현재 후보를 적용 중입니다."
          : run.phase === "RECOVERY_REQUIRED" ? "적용 결과를 확인해야 합니다."
            : run.phase === "APPLIED" ? "실행이 적용됨 상태입니다. 후보의 적용 기록은 확인되지 않았습니다."
              : "감사 보류 상태에서는 적용할 수 없습니다.";
    text("applyInspectorStatus", status);
    text("applyInspectorCandidate", candidate.candidateId);
    text("applyInspectorReview", candidateDecisions.get(review?.decision) ?? "현재 후보의 판정 미확인");
    $("applyInspectorReceiptRow").hidden = !application?.applicationId;
    text("applyInspectorReceipt", application?.applicationId ? `${application.applicationId} · ${application.status}` : "");
    $("applyInspectorIdentity").hidden = !review?.auditManifestHash;
    text("applyInspectorManifest", review?.auditManifestHash ?? "");

    const snapshot = getSnapshot();
    const finding = selection?.kind === "finding" ? snapshot.findings?.find(item => item.findingId === selection.id) : null;
    const assessment = selection?.kind === "requirement" ? review?.report?.assessments?.find(item => item.requirementId === selection.id) : null;
    const refs = selection ? new Set((finding ?? assessment)?.evidenceRefs ?? []) : null;
    text("applyInspectorSelection", selection ? `${selection.id} · ${finding?.status ?? assessment?.verdict ?? "판정 미확인"}` : "");
    $("clearApplyInspectorSelection").hidden = !selection;
    const currentEvidence = (snapshot?.evidence ?? []).filter(item => item.candidateId === candidate.candidateId && item.valid !== false);
    const evidence = currentEvidence.filter(item => refs ? refs.has(item.evidenceId) : ["PATCH", "CODE_SNAPSHOT"].includes(item.kind));
    const files = Array.isArray(candidate.changedFiles) ? candidate.changedFiles : [];
    const patch = currentEvidence.find(item => item.kind === "PATCH");
    const types = patchIndex?.key === JSON.stringify([run.runId,candidate.candidateId,patch?.evidenceId]) ? patchIndex.types : new Map();
    const locations = [];
    if (finding) for (const supplement of run.supplementResults ?? []) {
      if (supplement.candidateId !== candidate.candidateId) continue;
      for (const result of supplement.results ?? []) {
        const proof = evidence.find(item => item.evidenceId === result.evidenceId && item.kind === "CODE_SNAPSHOT" && item.result?.path);
        if (!proof || !Number.isSafeInteger(result.startLine) || !Number.isSafeInteger(result.endLine)
          || result.startLine < 1 || result.endLine < result.startLine || result.endLine - result.startLine >= 1000) continue;
        locations.push({id:proof.evidenceId,path:proof.result.path,startLine:result.startLine,endLine:result.endLine});
      }
    }
    const evidenceKey = JSON.stringify([run.runId, candidate.candidateId, selection, evidence, files, patch?.evidenceId, [...types], locations,
      currentEvidence.filter(item => item.kind === "CODE_SNAPSHOT"),
      projectDashboardKnowledge(getConnectionState()).stateRead.currentlyAvailable,
      getOperations().runCommand, snapshot?.commandCapabilities?.includes("evidence.get")]);
    if (inspectorEvidenceKey === evidenceKey) return;
    inspectorEvidenceKey = evidenceKey;

    const host = $("applyInspectorEvidence");
    host.replaceChildren();
    const fileList = $("applyInspectorFileList");
    fileList.replaceChildren();
    $("applyInspectorFiles").hidden = !files.length;
    const typesAction = $("applyInspectorFileTypes");
    typesAction.replaceChildren();
    if (files.some(path => !types.has(path)) && patch) {
      typesAction.append(node("p", "열어 본 Diff 원문의 파일 헤더로 유형을 확인합니다.", "muted"));
      evidenceLinks(typesAction, [patch.evidenceId],
        {id:candidate.candidateId, labels:new Map([[patch.evidenceId, "파일 유형 확인용 Diff 열기"]])});
    }
    for (const path of files) {
      const row = node("li", "");
      row.append(node("code", path));
      row.append(node("span", changeLabels[types.get(path)] ?? "유형 미확인", "studio-tag"));
      if (patch) evidenceLinks(row, [patch.evidenceId],
        {id:candidate.candidateId, labels:new Map([[patch.evidenceId, "Diff 변경 위치 보기"]])}, "applyInspectorFileList", path);
      else row.append(node("p", "현재 후보의 Diff 근거가 없습니다.", "muted"));
      const proof = currentEvidence.find(item => item.kind === "CODE_SNAPSHOT" && item.result?.path === path);
      if (proof) evidenceLinks(row, [proof.evidenceId],
        {id:candidate.candidateId, labels:new Map([[proof.evidenceId, "스냅샷 열기"]])}, "applyInspectorFileList");
      fileList.append(row);
    }
    if (finding) {
      if (!locations.length) host.append(node("p", "이 지적에 연결된 정확한 코드 범위 기록이 없습니다.", "muted"));
      for (const location of locations) evidenceLinks(host, [location.id], {id:candidate.candidateId,
        labels:new Map([[location.id, `${location.path} · 근거 ${location.startLine}–${location.endLine}행`]])}, host.id, undefined, location);
    }
    if (!evidence.length) {
      host.append(node("p", selection ? "선택 항목에 연결된 현재 후보의 근거가 확인되지 않았습니다."
        : "현재 후보의 Diff 또는 코드 스냅샷이 확인되지 않았습니다.", "muted"));
      return;
    }
    const labels = new Map(evidence.map(item => [item.evidenceId,
      item.kind === "PATCH" ? "후보 Diff 열기" : item.kind === "CODE_SNAPSHOT"
        ? `코드 스냅샷${item.result?.path ? " · " + item.result.path : ""}` : `근거 ${item.kind} · ${item.evidenceId.slice(-8)}`]));
    evidenceLinks(host, [...labels.keys()], { id:candidate.candidateId, labels });
  }

  function selectInspector(run, kind, id) {
    if ($("applyInspector").hidden || !run?.candidate?.candidateId
      || getSnapshot()?.run?.runId !== run.runId
      || getSnapshot()?.run?.candidate?.candidateId !== run.candidate.candidateId) return;
    selection = { runId:run.runId, candidateId:run.candidate.candidateId, kind, id };
    closeInspectorEvidence(false);
    renderApplyInspector(getSnapshot().run, inspectorReason);
    $("clearApplyInspectorSelection").focus();
  }

  function inspectorLink(row, run, kind, id) {
    if ($("applyInspector").hidden || !run?.candidate?.candidateId) return;
    const button = node("button", `${id} · Inspector에서 보기`);
    button.type = "button";
    button.addEventListener("click", () => selectInspector(run, kind, id));
    row.append(button);
  }

  function renderCandidateHistory(run) {
    const history = $("candidateHistory");
    const list = $("candidateHistoryList");
    const candidates = [...(run?.candidates ?? [])];
    const currentId = run?.candidate?.candidateId;
    if (currentId && !candidates.some((candidate) => candidate.candidateId === currentId)) {
      candidates.push(run.candidate);
    }
    history.hidden = run?.mode !== "CODE_CHANGE";
    $("candidateHistoryEmpty").hidden = candidates.length > 0;
    list.hidden = candidates.length === 0;
    list.replaceChildren();
    if (history.hidden) return;

    const decisions = new Map((run.reviews ?? []).map(({ candidateId, decision }) => [candidateId, decision]));
    for (const candidate of candidates.reverse()) {
      const title = candidate.iteration ? `${candidate.iteration}회차 후보` : "변경 후보";
      const current = candidate.candidateId === currentId ? " · 현재 후보" : "";
      const decision = candidateDecisions.get(decisions.get(candidate.candidateId)) ?? "감사 판정 기록 없음";
      const row = node("li", "", "record");
      row.append(node("strong", `${title}${current} · ${decision}`), node("p", candidate.candidateId, "muted"));
      if (Array.isArray(candidate.changedFiles)) row.append(node("p", `변경 파일 ${candidate.changedFiles.length}개`, "muted"));
      list.append(row);
    }
  }

  function renderAudit() {
    const snapshot = getSnapshot();
    const run = snapshot?.run;
    renderCandidateHistory(run);
    const assessments = $("assessments"), findings = $("findings"), evidence = $("evidenceList");
    assessments.replaceChildren(); findings.replaceChildren(); evidence.replaceChildren();
    const latestReview = run?.reviews?.at(-1);
    for (const req of run?.requirements?.items ?? []) {
      const a = latestReview?.candidateId && latestReview.candidateId !== run.candidate?.candidateId
        ? null : snapshot.assessments?.find((item) => item.requirementId === req.requirementId);
      const row = node("article", "", "record studio-assessment");
      const title = node("header", "");
      const verdict = node("span", {SATISFIED:"충족", UNSATISFIED:"미충족", UNDETERMINED:"판단 보류"}[a?.verdict] ?? "판정 없음", "studio-tag");
      verdict.dataset.tone = {SATISFIED:"ok", UNSATISFIED:"error", UNDETERMINED:"warn"}[a?.verdict] ?? "muted";
      title.append(node("strong", `${req.requirementId} · ${req.required ? "필수" : "선택"}`), verdict);
      row.append(title, node("p", req.statement), node("p", a?.reason ?? req.acceptanceCriteria));
      if (a?.missingInformation) row.append(node("p", `부족한 정보: ${a.missingInformation}`, "muted"));
      evidenceLinks(row, a?.evidenceRefs, null, "assessments");
      inspectorLink(row, run, "requirement", req.requirementId);
      for (const suggestion of (a ? latestReview?.report?.suggestions : []) ?? []) {
        if (suggestion.requirementId === req.requirementId) row.append(node("p", `선택 개선 제안: ${suggestion.description}`, "muted"));
      }
      assessments.append(row);
    }
    if (!assessments.children.length) assessments.append(node("p", run?.requirements
      ? "아직 요구사항별 감사 결과가 없습니다." : "요구사항 기록이 없습니다. 확인 가능한 대화와 상태 변경은 ‘진행 기록’에서 확인하세요.", "muted"));
    for (const f of snapshot?.findings ?? []) {
      const row = node("article", "", "record");
      const scope = [f.requirementId, f.required === true ? "필수" : null].filter(Boolean).join(" · ");
      row.append(node("strong", `${f.findingId} · ${f.status}${f.status === "RESOLVED" && f.verifiedCandidateId !== run.candidate?.candidateId ? " · 새 후보 재검증 필요" : ""}`), node("p", f.problem), node("p", `해결 조건: ${f.resolutionCriteria}`));
      if (scope) row.append(node("p", scope, "muted"));
      evidenceLinks(row, f.evidenceRefs, null, "findings");
      inspectorLink(row, run, "finding", f.findingId);
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
      evidenceLinks(row, [e.evidenceId], null, "evidenceList"); evidence.append(row);
    }
    text("candidateDetails", JSON.stringify({ project:run?.projectRef, requirements:run?.requirements, worker:run?.worker, workerTurns:run?.workerTurns, candidate:run?.candidate, latestReview:run?.reviews?.at(-1), missingInformation:run?.missingInformation, application:run?.application, recovery:run?.recovery }, null, 2));
  }

  let renderedLog = "";
  function renderLog() {
    const snapshot = getSnapshot();
    const evidenceIds = new Set((snapshot?.evidence ?? []).map(item => item.evidenceId));
    const external = externalEventRecords(snapshot?.run, snapshot?.evidence ?? []);
    const linkState = evidenceIds.size ? [
      projectDashboardKnowledge(getConnectionState()).stateRead.currentlyAvailable,
      snapshot?.commandCapabilities?.includes("evidence.get"), getOperations().runCommand !== "IDLE"] : null;
    const key = JSON.stringify([snapshot?.run?.runId, snapshot?.events, snapshot?.messages, [...evidenceIds], external, linkState]);
    if (renderedLog === key) return;
    renderedLog = key;
    const log = $("eventLog"); log.replaceChildren();
    const records = [...(snapshot?.events ?? []).map((event) => ({ at:event.createdAt, title:event.type,
      content:JSON.stringify(event.payload), id:event.eventId,
      refs:[event.payload?.evidenceId, ...(Array.isArray(event.payload?.evidenceRefs) ? event.payload.evidenceRefs : [])]
        .filter(id => evidenceIds.has(id)),
    })),
      ...(snapshot?.messages ?? []).map((message) => ({ at:message.createdAt, title:message.fromActor ?? "CONTROLLER", content:message.content })),
      ...external].sort((a,b) => String(a.at).localeCompare(String(b.at)));
    for (const record of records) {
      const row = node("article", "", "record"); row.append(node("time", time(record.at)), node("p", record.title), node("pre", record.content));
      if (record.id) row.append(node("code", record.id, "muted"));
      if (record.refs?.length) evidenceLinks(row, [...new Set(record.refs)], null, "eventLog");
      log.append(row);
    }
    if (!records.length) log.append(node("p", "아직 수신한 실행 기록이 없습니다.", "muted"));
  }

  return { renderApplyInspector, renderAudit, renderLog, selectInspector, recordPatchPage };
}
