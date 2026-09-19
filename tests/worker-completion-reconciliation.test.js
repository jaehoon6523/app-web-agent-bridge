import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupAudit, reportFor } from "./helpers/audit-fixtures.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("Worker completion is reconciled by inspect when terminal notification is missed", async (t) => {
  let inspections = 0;
  const f = setupAudit(t, {
    review(data) { return reportFor(data.context); },
    createWorker: async ({ workspace, persistThreadId, persistCapture }) => {
      const completion = deferred();
      let turnId = null;
      let brief = null;
      let finished = false;
      return {
        async start() { await persistThreadId({ threadId: "reconcile-thread" }); },
        async close() {},
        async submitTurn({ text }) {
          brief = JSON.parse(text.slice(text.indexOf("\n") + 1));
          turnId = "reconcile-turn";
          return { turnId, completion: completion.promise };
        },
        async inspect() {
          inspections++;
          if (!finished && inspections >= 2) {
            finished = true;
            fs.writeFileSync(path.join(workspace.root, "file.txt"), "revision 1\n");
            const capture = workspace.capture({ allowUnchanged: true });
            await persistCapture({ threadId: "reconcile-thread", turnId, capture });
            completion.resolve({
              threadId: "reconcile-thread",
              turnId,
              status: "completed",
              text: JSON.stringify({
                summary: "Implementation claim",
                requirementClaims: brief.requirements.items.map((item) => ({
                  requirementId: item.requirementId,
                  claim: "Implemented",
                })),
                findingResponses: [],
                unverified: [],
              }),
              capture,
            });
          }
          return {
            runtimeStatus: finished ? "idle" : "active",
            activeTurnId: finished ? null : turnId,
            lastTerminalTurnId: finished ? turnId : null,
            lastTerminalStatus: finished ? "completed" : null,
          };
        },
      };
    },
  });
  const run = await f.run();
  assert.equal(run.stage, "AWAITING_APPLY", run.error);
  assert.ok(inspections >= 2);
  assert.equal(run.workerTurns.at(-1).status, "completed");
});
