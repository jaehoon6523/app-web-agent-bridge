# MILESTONE-2 Phase B: Structured Receipts for Two Boundaries

Date: 2026-10-27 (Asia/Seoul)

## Verified scope

The standalone `npm run verify:spec` gate runs B-APPLY-INPUT and B-APPLY-RESTART using the existing runFiles runner. It collects structured receipts for all 16 active transitions and compares them with the registry and current specs. This is not certification of the entire repository or completion of S5.

| Boundary | Registry specRevision | Spec boundaryRevision | Receipts |
|---|---:|---:|---:|
| B-APPLY-INPUT | 3 | 3 | 12 |
| B-APPLY-RESTART | 1 | 1 | 4 |

`docs/spec/registry.json` maps these two generated test files and their 16 active transitions. The remaining legacy test suite has not been mapped by this work. The runner currently discovers 195 test files, including the new spec-verification test file; this number is not a count of test cases or mapped boundaries.

## Data flow and failure rules

- `scripts/test-completion-reporter.mjs` parses `__RECEIPT__:` from raw test:diagnostic events before TAP encoding. It adds boundaryReceiptSchemaVersion, boundaryReceipts and boundaryReceiptErrors to the file completion summary.
- `scripts/run-tests.mjs` preserves that summary in results[].summary in latest-test-result.json. Malformed JSON or schema-invalid receipts make the file gate fail with INVALID_BOUNDARY_RECEIPT. Ordinary files without boundary diagnostics remain valid.
- `scripts/spec-validation.mjs` uses the three schemas in docs/spec/schemas. It rejects unsafe or escaping paths, duplicate identities, mismatched active sets, retired IDs in the registry, and revision mismatches before test execution.
- `scripts/verify-spec.mjs` regenerates to a temporary directory and compares bytes after CRLF/LF normalization. It never repairs stale generated files implicitly. A mismatch fails with GENERATED_OUT_OF_DATE.
- Each invocation uses a fresh UUID and writes directly to `.agent-controller/spec-runs/<runId>/`. It does not copy a shared latest result or accept old receipts as input.
- `latest-test-result.json` holds the complete per-file summaries and structured receipts; `latest-test.log` holds TAP; `spec-result.json` holds the gate decision, counts, errors, timestamps and source identity.
- Passing requires completed successful files, exact scheduled/result file sets, all expected receipts exactly once, matching file/IDs/evidence type/revision/expectation, PASS results, current run ID, and unchanged source. Registry specRevision, spec boundaryRevision and receipt boundaryRevision must all agree.
- Domain assertions remain in generated tests. The gate checks generated freshness and real test success; it does not independently reimplement domain assertions or protect against intentionally falsified test/setup code.
- Gate exit 0 means PASS. Invalid registry/spec, missing/duplicate/foreign receipts, FAIL/SPEC_TODO receipts, source changes and execution errors produce exit 1. RUNNING evidence after interruption is not success.

The receipt schema permits revision 0 for non-PASS discovery evidence because the existing Git discovery spec has revision 0. Registered specs and PASS receipts require revision >=1. Discovery is not admitted to this gate.

## Execution evidence

Local platform: Windows, Node v22.14.0.

Task 2.5 (before reporter implementation):

- run-regression-5.log: 16 ok, pass 16, fail 0; Node exit 0.
- run-gen-test-2.log: 2 ok, pass 2, fail 0; Node exit 0.

Validation and collection tests:

- run-spec-validation.log: 6/6 PASS (generator tests plus pre-run, receipt consistency and stale-generation checks). Negative cases cover missing, duplicate, unregistered/retired IDs, wrong file/boundary, revision and expectation changes, FAIL/SPEC_TODO, incomplete summaries, malformed receipt evidence, old run IDs and source changes.
- run-boundary-storage.log: 3/3 PASS through the real reporter/runner. Verifies quoted/backslash/newline data survives without TAP re-parsing, custom-directory durable storage, malformed JSON/schema rejection and FAIL receipt preservation.
- JavaScript lint: 523 files validated.

Actual gate run:

```text
runId: ab771b22-afc4-4f1d-8e93-e6d9423bb69c
startedAt: 2026-10-27T09:00:52.393Z
finishedAt: 2026-10-27T09:03:20.608Z
TEST_GATE PASS 2/2 files
SPEC_GATE PASS expectedCount=16 observedCount=16 errors=[]
VERIFY_SPEC_EXIT=0
candidateUnchanged=true
INPUT receipts=12 receiptErrors=0 revision=3
RESTART receipts=4 receiptErrors=0 revision=1
```

Korean local time: 18:00:52 to 18:03:20. Evidence is in `.agent-controller/spec-runs/ab771b22-afc4-4f1d-8e93-e6d9423bb69c/`. This document was written after that run; the recorded source hash identifies the tested snapshot, not subsequent documentation edits. Local output files are ignored by Git.

## Known validation limitation

The broader reporter/runner regression returned 18/19 PASS outside the sandbox (run-reporter-phase-b.log). The existing test `completion receipt survives its directory moving before the reporter finishes` failed with Windows EPERM while renaming the open receipt directory. Running the same rename operation with the HEAD 530df5c runner and reporter reproduced TEST_FAILURE/EPERM. The baseline check used temporary copies with import/root paths redirected to the checkout; no tracked file was replaced. This existing platform limitation was not fixed, skipped or counted as a pass. Initial sandbox execution also blocked other temporary file renames (14/19); rerunning outside it resolved those other failures.

## Known tech debt

B-APPLY-RESTART spec is finalized at revision 1 but is named `B-APPLY-RESTART.discovery.json`. Renaming it to `.transitions.json` is deferred to Phase C.

## Explicitly not done

- No new mandatory verify:all stage and no full verify:all execution.
- No remote CI, Linux, Node 24, real-browser or Windows native-extension validation.
- No legacy-suite-wide boundary mapping or evidence-based test deletion.
- No B-APPLY-GIT behavioral validation, B-APPLY-RESULT, or additional requirement boundaries.
- No QUICK/RESUME, receipt reuse, long-term retention policy or complete S5 conformance.
- No unrelated UI/first-load changes included in this work; no commit or push performed for Phase B at this point.

Completion claim: structured collection and an independent registry/spec conformance gate are implemented and locally verified for two boundaries and 16 active transitions, subject to the existing Windows regression failure above.
