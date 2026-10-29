// B-APPLY-INPUT setup hooks (손 작성)
import { setupAudit } from "../../helpers/audit-fixtures.js";

function buildPayload(f, run, overrides = {}) {
  return { ...f.applyPayload(run), ...overrides };
}

async function runApply(f, run, payload) {
  const before = f.service.get(run.runId);
  try {
    await f.service.command("code.apply", payload);
    const after = f.service.get(run.runId);
    return { before, after, observed: {
      threw: false,
      actualStageAfter: after.stage,
      actualApplicationAfter: after.application ?? null,
    }};
  } catch (err) {
    const after = f.service.get(run.runId);
    return { before, after, observed: {
      threw: true,
      errorCode: err?.code ?? null,
      errorMessage: err?.message ?? null,
      stageUnchanged: before.stage === after.stage,
      applicationUnchanged: JSON.stringify(before.application ?? null) === JSON.stringify(after.application ?? null),
      actualStageAfter: after.stage,
      actualApplicationAfter: after.application ?? null,
    }};
  }
}

export const setups = {
  "A-STAGE": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    f.service.update(run.runId, { stage: "REVIEW_RUNNING" });
    const updated = f.service.get(run.runId);
    return await runApply(f, updated, buildPayload(f, updated));
  },
  "A-JOB": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    const jobs = f.service.jobs;
    if (jobs instanceof Map) jobs.set(run.runId, {});
    else if (jobs instanceof Set) jobs.add(run.runId);
    else if (typeof jobs.add === "function") jobs.add(run.runId);
    else if (typeof jobs.set === "function") jobs.set(run.runId, {});
    return await runApply(f, run, buildPayload(f, run));
  },
  "A-STOP": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    f.service.update(run.runId, { stopRequested: true });
    const updated = f.service.get(run.runId);
    return await runApply(f, updated, buildPayload(f, updated));
  },
  "B-SCHEMA": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    f.service.update(run.runId, { schemaVersion: 2 });
    const updated = f.service.get(run.runId);
    return await runApply(f, updated, buildPayload(f, updated));
  },
  "B-AUDIT": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    f.service.update(run.runId, { auditResult: "FAIL" });
    const updated = f.service.get(run.runId);
    return await runApply(f, updated, buildPayload(f, updated));
  },
  "C-CANDIDATE": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    return await runApply(f, run, buildPayload(f, run, { candidateId: "deliberately-different" }));
  },
  "C-REVIEW": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    return await runApply(f, run, buildPayload(f, run, { reviewId: "deliberately-different" }));
  },
  "C-ARTIFACT": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    return await runApply(f, run, buildPayload(f, run, { artifactHash: "deliberately-different" }));
  },
  "C-BASE": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    return await runApply(f, run, buildPayload(f, run, { baseCommit: "deliberately-different" }));
  },
  "C-VERSION": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    const v = f.service.get(run.runId).version;
    return await runApply(f, run, buildPayload(f, run, { expectedVersion: v + 1 }));
  },
  "D-PASS": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    return await runApply(f, run, buildPayload(f, run));
  },
  "E-IDEMPOTENT": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    await f.service.command("code.apply", buildPayload(f, run));
    const after1 = f.service.get(run.runId);
    return await runApply(f, after1, buildPayload(f, after1));
  },
};