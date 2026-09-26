import { projectActivityRecords } from "./dashboard-model.js";

const activityLabels = Object.freeze({
  RUN_STARTED:"작업 시작", FOLLOW_UP_STARTED:"후속 작업 시작", STAGE_CHANGED:"상태 변경",
  USER_NOTE:"사용자 메모", USER_DECISION_NOTE:"사용자 결정", WORKER_INTERVENTION:"Worker 개입",
  REVIEW_DISCUSSION:"감사자 대화", REVIEW_QUESTION_ANSWERED:"감사 질문 답변",
  RUN_ARCHIVED:"기록 보관", RUN_UNARCHIVED:"보관 해제",
});

function ensureActivityControls($, node) {
  if ($("overviewActivity")) return;
  const section = node("section", "");
  section.id = "overviewActivity";
  section.append(node("h2", "프로젝트 활동"));
  const summary = node("p", "", "muted");
  summary.id = "overviewActivitySummary";
  const list = node("div", "");
  list.id = "overviewActivityList";
  section.append(summary, list);
  $("overviewTasks")?.after(section);
}

export function renderProjectOverview({
  group, busyRun, allRuns, $, text, node, folderName, labels, runAppearance,
  terminal, time, connected, newRunDisabled, openRun,
}) {
  ensureActivityControls($, node);
  const allProjectRuns = allRuns.filter((item) =>
    (item.targetRoot ?? item.projectRef?.targetRoot ?? null) === group.targetRoot);
  const lineageFor = (runId) => {
    const current = allProjectRuns.find((item) => item.runId === runId) ?? null;
    if (!current) return null;
    const parentRunId = typeof current.parentRunId === "string" && current.parentRunId ? current.parentRunId : null;
    const parent = parentRunId ? allProjectRuns.find((item) => item.runId === parentRunId) ?? null : null;
    return {
      parentRunId,
      parentAvailable:Boolean(parent),
      parentObjective:parent?.objective ?? null,
      children:allProjectRuns.filter((item) => item.parentRunId === runId),
    };
  };

  text("overviewTitle", folderName(group.targetRoot));
  text("overviewPath", group.targetRoot);
  const tasks = group.runs;
  const attention = tasks.filter((run) => ["HOLD", "RECOVERY_REQUIRED", "AWAITING_APPLY"].includes(run.phase));
  text("overviewSummary", `기록 ${tasks.length}건 · 확인할 작업 ${attention.length}건`);
  const list = $("overviewTasks");
  list.replaceChildren();
  for (const run of tasks) {
    const card = node("article", "", "overview-task");
    card.append(node("h3", run.objective), node("strong", labels[run.phase] ?? run.phase, `health ${runAppearance(run.phase)}`));
    const guidance = run.phase === "HOLD" ? "감사 질문·판단 대기를 확인하세요."
      : run.phase === "AWAITING_APPLY" ? "통과 후보의 근거를 확인하고 별도로 적용하세요."
      : run.phase === "RECOVERY_REQUIRED" ? "진단과 외부 작업 상태를 확인하세요."
      : terminal.has(run.phase) ? "완료된 기록을 확인할 수 있습니다." : "진행 상태와 기록을 확인하세요.";
    card.append(node("p", guidance), node("p", `시작 ${time(run.createdAt)} · 변경 ${time(run.updatedAt)}`, "muted"));
    const lineage = lineageFor(run.runId);
    if (lineage?.parentRunId || lineage?.children.length) {
      const relation = [];
      if (lineage.parentRunId) relation.push(lineage.parentAvailable
        ? `이어짐: ${lineage.parentObjective}` : `이전 작업 기록 없음: ${lineage.parentRunId}`);
      if (lineage.children.length) relation.push(`후속 작업 ${lineage.children.length}건`);
      card.append(node("p", relation.join(" · "), "muted"));
    }
    const action = node("button", ["HOLD", "RECOVERY_REQUIRED", "AWAITING_APPLY"].includes(run.phase)
      ? "확인하고 조치하기" : "작업 기록 보기");
    action.addEventListener("click", () => openRun(run.runId));
    card.append(action);
    list.append(card);
  }
  if (!tasks.length) list.append(node("p", "아직 이 프로젝트의 실행 기록이 없습니다.", "muted"));

  const activity = projectActivityRecords(allProjectRuns, { limit:80 });
  const activityList = $("overviewActivityList");
  activityList.replaceChildren();
  text("overviewActivitySummary", activity.length
    ? `최근 활동 ${activity.length}건 · 보관된 작업의 기록도 포함합니다.`
    : "아직 기록된 프로젝트 활동이 없습니다.");
  for (const item of activity) {
    const decision = ["USER_NOTE", "USER_DECISION_NOTE", "REVIEW_QUESTION_ANSWERED"].includes(item.kind);
    const row = node("article", "", `conversation-entry${decision ? " decision" : ""}`);
    row.append(
      node("strong", `${activityLabels[item.kind] ?? item.kind} · ${item.objective || item.runId || "작업"}`),
      node("p", `${time(item.at)}${item.phase ? ` · ${labels[item.phase] ?? item.phase}` : ""}${item.status ? ` · ${item.status}` : ""}${item.archivedAt ? " · 보관됨" : ""}`, "muted"),
      node("p", item.summary ?? ""),
    );
    if (item.detail) row.append(node("p", item.detail, "muted"));
    if (item.runId) {
      const open = node("button", "작업 기록 보기");
      open.type = "button";
      open.addEventListener("click", () => openRun(item.runId));
      row.append(open);
    }
    activityList.append(row);
  }

  $("newProjectTask").disabled = !connected || newRunDisabled;
  $("openProjectBlocker").hidden = !busyRun;
  $("openProjectBlocker").disabled = !connected;
  text("overviewReason", !connected ? "서버에 다시 연결한 뒤 작업을 선택하세요."
    : busyRun ? `‘${busyRun.objective}’ 작업이 아직 종료되지 않았습니다. 현재 작업을 확인하세요.`
    : $("newProjectTask").disabled ? "현재 준비 또는 요청이 끝난 뒤 새 작업을 시작할 수 있습니다."
    : "새 작업은 별도 요구사항 승인과 감사·적용 절차를 거칩니다.");
}
