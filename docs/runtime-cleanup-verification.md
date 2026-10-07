# Runtime cleanup and cross-platform verification

## Scope and entry points

Base: `83fc4fdfe1f1efb5e34eaccdc771e7fd8ccd6db0` (v2 already applied).
This delta includes the v3 test corrections and completion-gate hardening.
Production shutdown policy is unchanged.

- `npm run check`: lint, architecture, typecheck, and every `tests/**/*.test.js` (also `.cjs`/`.mjs`) file.
- `npm run test:platform`: the explicit platform subset, with the same completion gate.
- `npm run test:runtime-cleanup-contract`: the two cleanup contract files, with the same gate.
- `npm run verify:all`: check, browser platform contract, and all controlled UF profiles. It continues collecting stage results after failures but exits nonzero if any stage fails.
- Browser prerequisite: `npx playwright-core install chromium`.

The auxiliary UI/browser/sabotage commands remain separate; `verify:all` does not claim real external model or production-session verification.

## Completion contract

Each selected test file runs in its own owned Node process, sequentially. The runner records the selected file list before executing it. Each process must close normally and provide a fresh completion receipt written after the reporter consumes the final test plan and finishes its stream. Exit zero without that receipt is a failure. Missing/empty execution, failed or cancelled tests, TODO, unexpected skip, and timeouts fail the gate. Linux permits only the named Windows-only certification test skip.

`RUNTIME_CLEANUP_IDS` is diagnostic-only and is rejected by the gate to prevent a filtered cleanup run from becoming full coverage evidence.

This containment and completion gate do not establish the root cause of the previously intermittent missing summaries. Do not describe file isolation as a proven Node bug fix.

## Latest run only

- `.agent-controller/latest-test.log` and `latest-test-result.json`: replaced on every test-gate invocation.
- `.agent-controller/latest-verification.log` and `latest-verification.json`: replaced on every `verify:all` invocation; contain all three stages, including failed stages.
- Interrupted runs retain `RUNNING`, never a stale PASS. Node/platform and scheduled/completed files or stages are recorded.
- Cleanup case evidence and UF artifacts keep their existing fixed-name overwrite behavior.

## Contract mapping

| Scope | Source owners | Verification |
| --- | --- | --- |
| P01–P12 / C01–C08 | Existing Store/runtime/server closure chain | T00–T24, N01–N03, repeated-close and representation tests |
| Source copy identity | Source-copy helper | POSIX/Windows separators and unauthorized file-change counterexamples |
| Native SQLite closure | Native connection | Open-handle negative control and closed-handle query rejection |
| Parent exit vs descendant/pipe closure | Inherited-pipe fixture / child observer | Live heartbeat after parent exit; actual pipe deadline; fixture PID removed only after observed termination |
| Test run completeness | Reporter / owned test runner | Exit-zero interruption, skipped/empty/failing/hanging tests, later-file continuation, latest-result replacement |
| User flows | Existing UF suite / resource owners | Full selected-profile artifacts and existing summary contract; Node/platform recorded |

## OS and runtime boundaries

The CI matrices cover Ubuntu/Windows with Node 22.14 and 24, including full check and the existing browser/UF suite. Registering jobs is not execution evidence. Windows signal values are not used as a substitute for IPC/EOF closure; Windows uses its existing process-tree containment and POSIX uses owned process groups. Fixture orphan termination treats a Linux zombie as exited, not a live process, and preserves the PID record if termination cannot be confirmed.

A Linux pass, path.win32 unit check, or successful patch application cannot close Windows verification. Actual Windows job logs and UF summaries from the final candidate are required. The minimum Node 22.5 job retains its existing SQLite scope and is not a full compatibility claim.
