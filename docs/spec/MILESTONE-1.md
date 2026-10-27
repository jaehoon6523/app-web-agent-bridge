# MILESTONE-1: Verified Boundary Prototype

**Date**: 2026-10-27
**Status**: Prototype verified on Windows. Preservation checkpoint, not a green full verification gate.

## Verified Boundaries

| Boundary | Evidence Type | Active | Retired | Result |
|---|---|---|---|---|
| B-APPLY-INPUT | partial-integration | 12 | 3 | 12/12 PASS |
| B-APPLY-RESTART | partial-integration | 4 | 1 | 4/4 PASS |

Both use the actual service, Git and SQLite with controlled external providers. INPUT is not a pure-function isolated contract.

Revalidated locally on Windows with Node v22.14.0:

```text
node --test --experimental-test-isolation=none tests/generated/apply/B-APPLY-INPUT.gen.test.js tests/generated/apply/B-APPLY-RESTART.gen.test.js
16 tests, 16 pass, 0 fail; duration 127643 ms
```

The sandbox initially blocked temporary Git repository creation. The same command passed outside the sandbox. Existing run-gen-verify.log and run-restart-v1.log also record 12/12 and 4/4 passes; these local logs are ignored and are not part of this commit.

## Retired Transitions (documented, not deleted)

These are the recorded reasons in the current specs, not newly established proofs of impossibility.

| Boundary | Transition | Recorded reason |
|---|---|---|
| B-APPLY-INPUT | B-REVIEW | Unreachable via command(). |
| B-APPLY-INPUT | B-TREE | Public API mutation did not induce the assertion failure. |
| B-APPLY-INPUT | B-MANIFEST | Same as B-TREE. |
| B-APPLY-RESTART | RESTART-TREE-DRIFT | Recovery reads the actual Git tree; stored application.result.tree mutation has no effect. |

## Existing Infrastructure

- scripts/gen-tests.mjs generates tests from a JSON spec and handwritten setups.
- Discovery records observations and deliberately fails with SPEC_UPDATE_NEEDED / SPEC_TODO. The Git discovery currently captures 6 static and 8 instance methods; it does not test their behavior.
- __RECEIPT__ diagnostics separate observation from expectation.
- Restart setups enforce workerStarts=2 by throwing on a contract violation.
- The existing runner recursively discovers generated tests. verify:all already includes them through its discovery stage.
- test-completion-reporter.mjs stores file completion summaries. run-tests.mjs stores TAP output in latest-test.log; it does not collect structured boundary receipts.
- Existing CI invokes verify:all on Windows and Linux with Node 22.14.0 and 24. This milestone does not establish a successful remote CI run.

## Known Defects Preserved in This Checkpoint

1. Git discovery deliberately fails all 6 cases but is included in normal test discovery, preventing a green full gate.
2. Generated setup imports contain this machine's absolute checkout path. They are not portable to another checkout or CI.
3. docs/spec/contracts/apply/B-APPLY-GIT.discovery.json contains JavaScript, not JSON. The current generator cannot regenerate the Git test from it.
4. Setup execution occurs outside the receipt failure handler. Setup failures, including workerStarts violations, do not emit a FAIL boundary receipt.

These files are preserved as-is for recovery. This commit does not certify reproducibility on another machine or repair the defects above.

## Explicitly NOT Done

- Structured boundary receipt collection and completeness validation.
- Boundary registry, verify:spec command and S5 conformance gate. No dedicated spec validation schema was identified in docs/spec; schemaVersion fields alone are not a validation schema.
- Existing-test-to-boundary mapping and guarantee-set comparison for safe deletion.
- QUICK/RESUME modes; the existing verification plan supports full/minimum.
- B-APPLY-GIT behavioral verification, its proposed four-way split, and B-APPLY-RESULT.
- Full verify:all, browser verification and remote CI validation for this checkpoint.
- Generalization of the method to all requirement boundaries.

The current runner discovers 194 test files, including 3 generated files and 2 other untracked test files. There are 189 tracked test files before this commit. These are file counts, not individual test-case counts.

Unrelated dashboard/UI changes and other untracked work remain outside this commit. It preserves the spec prototype, not the entire working tree.

## Next Milestones

- **MILESTONE-2**: Repair discovery selection, portable imports and the Git spec; add minimum structured receipt collection, registry and verify:spec for the two verified boundaries, reusing the existing runner and CI.
- **MILESTONE-3**: Verify the proposed Git sub-boundaries and B-APPLY-RESULT.
- **MILESTONE-4**: Map existing tests and execute the evidence-based deletion policy.

## Method Validated (with caveat)

The recorded development history reports two spec -> discovery -> observed -> revised spec -> PASS cycles. This local review independently reproduced the final 16 PASS results; it did not replay both historical discovery cycles.

Do not generalize to all boundaries until less clearly observable review/UI boundaries are tested and existing tests are at least partially mapped. Runtime discovery inclusion already exists; semantic boundary integration remains incomplete.
