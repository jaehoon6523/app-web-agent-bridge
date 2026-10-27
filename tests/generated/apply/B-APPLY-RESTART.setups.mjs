import { setupAudit } from "../../helpers/audit-fixtures.js";

function buildPayload(f, run) { return f.applyPayload(run); }

async function observe(f, run, opts = {}) {
  const a = f.service.get(run.runId);
  const obs = {
    threw: false,
    actualStageAfter: a.stage,
    actualApplicationAfter: a.application ? { status: a.application.status } : null,
    workerStarts: f.starts(),
    errorMessage: a.error ?? null,
  };
  if (opts.expectWorkerStarts !== undefined && obs.workerStarts !== opts.expectWorkerStarts) {
    throw new Error(`CONTRACT_VIOLATION: automatic resubmission detected. workerStarts=${obs.workerStarts}, expected ${opts.expectWorkerStarts}`);
  }
  return obs;
}

export const setups = {
  "RESTART-AFTER-APPLYING": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    await f.service.command("code.apply", buildPayload(f, run));
    f.service.update(run.runId, { stage: "APPLYING" });
    await f.reopen();
    return { observed: await observe(f, run, { expectWorkerStarts: 2 }) };
  },
  "RESTART-WORKER-RUNNING": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    f.service.update(run.runId, { stage: "WORKER_RUNNING" });
    await f.reopen();
    return { observed: await observe(f, run, { expectWorkerStarts: 2 }) };
  },
  "RESTART-AWAITING-APPLY": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    await f.reopen();
    return { observed: await observe(f, run, { expectWorkerStarts: 2 }) };
  },
  "RESTART-APPLIED": async (t) => {
    const f = setupAudit(t, { reviewVerdicts: ["UNSATISFIED", "SATISFIED"] });
    const run = await f.run();
    await f.service.command("code.apply", buildPayload(f, run));
    await f.reopen();
    return { observed: await observe(f, run, { expectWorkerStarts: 2 }) };
  },
};