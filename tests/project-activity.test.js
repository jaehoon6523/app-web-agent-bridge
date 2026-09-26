import assert from "node:assert/strict";
import test from "node:test";

import { projectRunActivity, PROJECT_ACTIVITY_LIMIT_PER_RUN } from "../src/orchestration/project-activity.js";
import { projectActivityRecords } from "../public/dashboard-model.js";

test("project activity projection combines lifecycle and human interaction records without mutating the run", () => {
  const run = {
    runId:"run-2", objective:"Settings", createdAt:"2026-09-26T00:00:00Z", followUp:{ runId:"run-1" },
    operatorNotes:[{ kind:"DECISION", text:"Deploy validation is separate.", phase:"AWAITING_APPLY",
      candidateId:"candidate-1", createdAt:"2026-09-26T00:10:00Z" }],
    userInterventions:[{ kind:"GUIDANCE", text:"Reuse the helper.", status:"DELIVERED",
      createdAt:"2026-09-26T00:02:00Z", updatedAt:"2026-09-26T00:03:00Z" }],
    reviewDiscussions:[{ role:"CRITIC", text:"Explain the weak evidence.", status:"DELIVERED",
      candidateId:"candidate-1", createdAt:"2026-09-26T00:05:00Z", updatedAt:"2026-09-26T00:06:00Z" }],
    userDecisions:[{ candidateId:"candidate-1", at:"2026-09-26T00:08:00Z",
      responses:[{ requestItemId:"q1", answer:"Keep the existing API." }] }],
    events:[
      { type:"STAGE_CHANGED", createdAt:"2026-09-26T00:01:00Z",
        payload:{ previous:"CREATED", stage:"WORKER_RUNNING", reason:null } },
      { type:"RUN_ARCHIVED", createdAt:"2026-09-26T00:12:00Z", payload:{} },
    ],
  };
  const before = structuredClone(run);
  const activity = projectRunActivity(run);
  assert.deepEqual(run, before);
  assert.deepEqual(activity.map((item) => item.kind), [
    "FOLLOW_UP_STARTED", "STAGE_CHANGED", "WORKER_INTERVENTION", "REVIEW_DISCUSSION",
    "REVIEW_QUESTION_ANSWERED", "USER_DECISION_NOTE", "RUN_ARCHIVED",
  ]);
  assert.match(activity.find((item) => item.kind === "FOLLOW_UP_STARTED").detail, /run-1/u);
  assert.match(activity.find((item) => item.kind === "USER_DECISION_NOTE").detail, /Deploy validation/u);
  assert.match(activity.find((item) => item.kind === "REVIEW_QUESTION_ANSWERED").detail, /Keep the existing API/u);
});

test("project activity is bounded and merges archived runs newest-first", () => {
  const events = Array.from({ length:PROJECT_ACTIVITY_LIMIT_PER_RUN + 10 }, (_, index) => ({
    type:"STAGE_CHANGED",
    createdAt:`2026-09-26T${String(Math.floor(index / 60)).padStart(2,"0")}:${String(index % 60).padStart(2,"0")}:00Z`,
    payload:{ previous:"CREATED", stage:`STATE_${index}` },
  }));
  const projected = projectRunActivity({
    runId:"bounded", objective:"Bounded", createdAt:"2026-09-25T23:59:00Z", events,
  });
  assert.equal(projected.length, PROJECT_ACTIVITY_LIMIT_PER_RUN);
  assert.equal(projected.at(-1).phase, `STATE_${PROJECT_ACTIVITY_LIMIT_PER_RUN + 9}`);

  const merged = projectActivityRecords([
    { runId:"old", objective:"Old", activity:[
      { at:"2026-09-26T01:00:00Z", kind:"USER_NOTE", summary:"old" },
    ] },
    { runId:"new", objective:"New", archivedAt:"2026-09-26T02:30:00Z", activity:[
      { at:"2026-09-26T02:00:00Z", kind:"RUN_ARCHIVED", summary:"new" },
    ] },
  ], { limit:1 });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].runId, "new");
  assert.equal(merged[0].objective, "New");
  assert.equal(merged[0].archivedAt, "2026-09-26T02:30:00Z");
});
