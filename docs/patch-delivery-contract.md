# Patch delivery contract

Every patch delivered for this repository must record the following checks.

1. Fetch the current remote default branch. Pin its full commit hash and check the remote again immediately before delivery. If the remote changed, integrate and repeat affected checks before generating the patch.
2. Compare earlier changes with that pinned commit. Preserve changes already present upstream and include only missing fixes. Deliver a single applicable patch; document its base and resulting commit/tree.
3. Inspect every changed execution path for Windows paths, file URLs, shell commands, environment variables, IPC, process/thread lifetime and SQLite handle closure. Use platform-neutral APIs for shared paths.
4. Run the bounded regression cases and the repository checks applicable to the changes. Record command, environment, exit code, pass/fail/skip counts and execution evidence.
5. Apply the final patch to a clean checkout of the pinned base with `git apply --check` and `git apply --index`. Verify that the resulting tree equals the tested candidate tree.
6. Run the relevant Windows checks on an actual Windows runner. Static review and Linux results do not establish Windows execution. If a Windows runner is unavailable, label Windows execution **UNVERIFIED** and do not claim full compatibility.

Reports must distinguish confirmed results, their scope, unverified behavior and what the results establish for the user. Changes in remote base or candidate invalidate results for affected paths. A configured CI job is an execution route, not a passing result.
