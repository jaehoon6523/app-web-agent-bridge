# Unified verification contract

Baseline: `bd762060eb2a41d532782460bcbfddb1b72900f8` (CI #152).

Run `npm run verify:all`. Inspect the plan without executing with
`npm run verify:all -- --list`. The workflow invokes the same catalog in
`scripts/verification-plan.mjs`; minimum Node 22.5 uses `--scope=minimum`.
OS exclusions remain visible as NOT_RUN / POLICY_EXCLUDED_OS and are not OS
observations. Native extension unavailability is required NOT_RUN and exits 2.
FAIL exits 1; only all applicable required stages PASS exits 0.

The full catalog contains dependency/browser preparation, lint, architecture,
typecheck, full discovery, integration, focused platform, cleanup, Windows
focused reproduction, platform browser, E2E, UI, browser core, tab UX, sabotage,
and native extension. Focused platform/cleanup duplicate discovery deliberately:
they preserve the prior CI contracts rather than assuming equivalence.
Browser core and tab UX are independent stages so one cannot hide the other.
The former Linux UI/browser/sabotage OS policy is retained; tab UX and native
extend verification to both OSes and are not represented by historic results.

Dependency failure blocks only its dependents. Browser preparation failure
blocks browser-dependent stages while nonbrowser checks continue. Ordinary
assertion, missing evidence, or nonzero exit preserves failure and continues
independent stages. Forced process closure, cancellation, or reported cleanup
error prevents unsafe resource reuse. The initial plan is saved before any
child starts; remaining stages keep NOT_RUN and a reason.

Evidence: `.agent-controller/latest-verification.json` and `.log` identify the
latest invocation. `verification-runs/<runId>/` contains its plan/results,
per-stage output, receipt copies and only the catalog-declared producer evidence.
Declared evidence paths are cleared before dispatch, so unrelated or previous
stage outputs are not copied into a new stage.
The exact Node, OS, source HEAD/hash and browser version (when launchable) are
recorded. Gate receipts must match stage run ID, HEAD, source hash, complete
terminal results and an unchanged candidate. The catalog freezes expected file
sets; scheduled/results must contain exactly those files without duplicates. Receipt-free legacy commands use
owned process closure plus the captured stage log as their observation; they
do not claim a producer-level assertion inventory. E2E/native/GUI/browser preparation producers embed stage run ID and before/after
source identities. E2E also records the scheduled profile IDs and each observed
outcome; the consumer checks the full expected profile set. GUI/native/E2E
cleanup uncertainty blocks subsequent resource reuse. A source change invalidates the whole run.

Cause classification remains UNKNOWN until investigated; execution status is
not a root-cause verdict. Existing process/ACK/ownership/path assertions are
retained. Product sources are not changed by this infrastructure patch.

Local successful evidence is replaced on the next invocation; failed completed
runs remain for 30 days, interrupted/unknown runs remain for inspection. CI
artifacts retain 30 days. Upload failure is a separate failing workflow step;
the local runner does not claim to verify remote upload contents.

## Open failure ledger

| ID | Observation/history | Next action | Closure evidence |
|---|---|---|---|
| B01 / F02 | UI line 197 30s timeout: #130–146 and #152 (18 runs, supplied audit) | Browser-reproduce actual error visibility and follow-up action against UI contract | Cause-specific pre/post result; no string-only workaround |
| B02 | #152 Windows 22 lifecycle 10s timeout, focused stage previously PASS | Compare setup/dispatch/close/cleanup under focused/full workload | Narrowed conditions and both results; root cause remains unconfirmed |
| B03 | #152 Linux Browser/Sabotage steps not run | Unified catalog records actual result or explicit preparation block | Separate outputs, never infer PASS from absence |
| B04 | bd76206 combines server responsiveness/Codex exit/diagnostic-lock product changes | Separate contract review; not rewritten in this patch | Per-change regression/acceptance evidence remains pending |
| B05 / F01 | Missing artifact files #112–150 (39 runs, supplied audit); #152 upload succeeded | Download and inspect actual summaries/logs | #152 all 8 archives inspected; future failure collection still requires new CI |
| B06 / F04 | Local/CI lists differ since 0229620 | Common catalog and negative runner regressions | Implementation plus local run; new Windows/CI candidate still required |
| F03a | Windows Git-root rejection: #114/#125/#128/#140 samples | Keep distinct from B02 timeout | Native-path regression evidence, not timeout nonreproduction |
| F03b | Windows expected EOF rejection absent: #100/#105/#108/#109 samples | Keep distinct from path/timeout signatures | Process contract evidence for that failure family |

Historic observations in this ledger are from the supplied two-week review,
not a new exhaustive download of all 83 historic logs. Current #152 archives
are directly inspected separately. Registration does not close a defect.

## GUI behavioral completion

The tab UX plan declares eight stable required scenario IDs in verification-gui-contract.mjs. The producer records scheduledScenarios, scenarioResults and scenarioId on each assertion. Starting a scenario and completing it are separate events: completion requires at least one successful assertion. The consumer requires exact unique scheduled/result sets, PASS on every scenario, and successful observations for every required ID. Missing, duplicate, RUNNING/NOT_RUN, unobserved or other-source scenarios cannot authorize PASS. Assertion count 85 is observational, not an approval threshold. This proves declared behavioral boundary coverage, not immunity to deliberately weakened assertions within a boundary.

Managed Linux Chromium preparation uses install --with-deps, including when a cached executable exists. Explicit UI_BROWSER_EXECUTABLE uses an external executable and records EXTERNAL_EXECUTABLE_LAUNCH_ONLY; it does not certify the managed Playwright dependency set. Browser launch/close is still required.
