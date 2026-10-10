# Logged selector repair (extension 0.2.11)

This is an explicit CLI-triggered repair workflow. One command collects current
DOM diagnostics from the authenticated extension, gives a fixed repair objective
and constraints to the configured local code worker, captures one candidate in a
separate Git worktree, and runs controller-selected verification. It does not
depend on the broken ChatGPT composer as a reviewer. It does not run automatically
on every heartbeat or error. There is no popup repair button in this version.

## Baseline and installation

The add-on patch targets the reviewed 0.2.10 source: remote master e7ef442 plus
diagnostic-safety-full-e7ef442(1).patch and korean-composer-0.2.9-to-0.2.10.patch.
The local verification snapshot is 092e560403c190c1c6066a82034334910f6ac6ba;
it is a local snapshot, not a published remote commit.

From a clean, committed 0.2.10 checkout, with the patch outside the repository:

```powershell
git apply --check --index ..\selector-self-repair-0.2.10.patch
if ($LASTEXITCODE -eq 0) { git apply --index ..\selector-self-repair-0.2.10.patch }
```

Review and commit the patch changes before launching repair. The worker starts
from committed HEAD; existing target changes or untracked files cause refusal.
Restart the controller and reload the extension. Use a fresh ChatGPT document
for diagnostics if old content is still loaded. Preserve unresolved delivery
records and verify generation has ended before reloading any existing page.
Check extension/content 0.2.11 and selector registry 2026-10-10.4.

## Configuration and execution

Use the existing CODE_WORKER_PROVIDER, CODE_WORKER_EXECUTABLE, CODE_WORKER_ARGS
and CODE_WORKER_MODEL configuration. The codex provider uses CODEX_EXECUTABLE
and the existing Codex adapter. This feature does not install an agent or supply
credentials. Provider availability and the cost of a real worker invocation
remain properties of the selected local configuration.

Set the existing DASHBOARD_TOKEN to the same strong value for controller and
CLI, usually through the repository .env, then restart the controller. This is
the existing automation credential, distinct from WEB_EXTENSION_SHARED_SECRET.
The CLI does not impersonate a browser or bypass the dashboard session guard.
Do not print or share either token.

```powershell
npm run repair:selectors -- --server http://127.0.0.1:8787 --tab 132530096
```

Omit --tab only if exactly one inspected tab has the relevant failure. With
multiple failures, the command reports tab IDs and requires a choice. Collection
is bounded to eight ChatGPT tabs; use the popup to identify the target tab and
close unrelated tabs if the target is outside that bounded snapshot.

The extension collects tags, roles, selected attributes, up to eight ancestors
and sixteen buttons per editable sample. It does not collect element text,
input values, page HTML, prompts, responses or credentials. Control labels and
IDs are untrusted metadata, not instructions. Existing projection depth, node,
array and character limits still apply. Metadata can be truncated; missing
evidence is not authorization to widen dispatch or select a guessed editor.

Extension and content versions must agree with the target manifest. A version
match is not proof of identical source bytes; the captured target commit and
local/live verification boundaries remain explicit. Navigation URL mismatch
also blocks repair.

No worker is launched for a missing, busy, generating, ready or uninspectable
tab, or when there is no visible editable sample. The process makes one repair
attempt; it never automatically retries, sends a ChatGPT prompt, rebinds a tab,
acknowledges or discards a delivery.

The permitted candidate paths are extension/selectors/*.js,
extension/runtime/providers/chatgpt-page.js and NEW
tests/selector-repair-*.test.js. A new regression is required. Existing tests,
delivery owners, ACK/recovery code, server runtime and shutdown policy cannot be
changed by an accepted candidate. A worktree and approval policy constrain the
workflow; they are not an operating-system sandbox for an arbitrary executable.

## Verification and approval

The worker is closed before verification. The controller runs lint,
architecture checks, typecheck and the existing composer, readiness and
diagnostic-safety regressions plus the new regression files. The completion
reporter rejects missing/incomplete test execution and unexpected skips. The
candidate is rechecked after verification. Dependencies must already exist in
the target node_modules; no package install hooks are run.

The command returns jobId, files, patchHash, patchFile and logFile. A passing
local gate creates AWAITING_APPROVAL, not proof of live ChatGPT correctness.
Inspect the patch file and limitations before approving its exact hash:

```powershell
npm run repair:selectors -- --inspect JOB_ID
npm run repair:selectors -- --apply JOB_ID --approve sha256:EXACT_RETURNED_HASH
```

Application uses captured bytes. It refuses a changed target, changed worker
candidate, different hash or non-approved job phase. It updates the target files
and index without committing, pushing, hot-reloading or resending anything.
Review/commit the applied change and reload the extension separately.

## Logs and interrupted work

Each job stores its state, artifacts and append-only events under
.agent-controller/selector-repair/JOB_ID/. The event file is events.jsonl.
REPAIR_STARTED is fsynced before worktree/worker execution. Candidate events
record paths and patch hash. Verification events record exit/timeout/closure
facts. APPLY_STARTED is fsynced and saved before application; APPLIED is written
after success. Application failure or a lost receipt requires inspection and
never an automatic second application.

Logs exclude snapshots, control labels, command text, worker prose, output
deltas, response bodies and secrets. Codex tool-start/tool-completion events are
recorded only as tool kinds; a generic worker without such events still records
the overall repair intent and captured changed-file list.

Only one generation or application owns a target at a time. Cancellation waits
for owned work to close before releasing the lease. Unknown worker cleanup
retains active.lock and blocks later workers. A process crash can also leave the
lease behind. Inspect its job and confirm the process and worker have stopped
before manually removing that lock; never infer that from elapsed time alone.

Useful controlled failures include DASHBOARD_TOKEN_REQUIRED,
REPAIR_TARGET_NOT_CLEAN, SELECTOR_REPAIR_BUSY,
REPAIR_DIAGNOSTIC_NOT_ACTIONABLE, REPAIR_SCOPE_VIOLATION,
REGRESSION_TEST_REQUIRED, REPAIR_VERIFICATION_FAILED and
REPAIR_APPROVAL_REQUIRED. Errors do not clear or retry existing deliveries.

## Verification boundaries

Tests cover durable intent failure, target preservation, wrong hash, target and
candidate drift, existing-test changes, duplicate requests, cancellation,
timeout, lost application receipt, authenticated HTTP/WebSocket collection and
the actual CLI/registered JSONL process/verification/apply chain. The worker in
the process test is a deterministic fixture, not a live language model.
Chromium DOM fixtures use production scripts with mocked Chrome APIs and HTML.
Native Chrome extension loading, the user's live DOM, live model execution and
Windows execution are separate acceptance checks.

Run the complete static/unit gate with one overwritten latest console log:

```powershell
npm run check *> .\test-latest.log; $checkExit = $LASTEXITCODE; Get-Content .\test-latest.log -Tail 25; if ($checkExit -ne 0) { throw "check failed ($checkExit)" }
```

The repair event journal intentionally preserves history; the verification log
above intentionally overwrites the previous run.
