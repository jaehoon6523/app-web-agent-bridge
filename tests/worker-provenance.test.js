import test from "node:test";
import assert from "node:assert/strict";
import { workerProvenance } from "../src/domain/worker-provenance.js";

test("configuration alone cannot become observed worker identity", () => {
  assert.deepEqual(workerProvenance({ provider:"codex", model:"requested-model" }, {}), {
    requested:{ provider:"codex", model:"requested-model" },
    reported:{ provider:null, model:null },
    evidence:{ provider:"CONFIGURED_ONLY", model:"CONFIGURED_ONLY" },
  });
  const actual = workerProvenance({ provider:"codex", model:"requested-model" }, { provider:"codex", model:"served-model" });
  assert.equal(actual.reported.model, "served-model");
  assert.equal(actual.evidence.model, "RUNTIME_REPORTED");
});
