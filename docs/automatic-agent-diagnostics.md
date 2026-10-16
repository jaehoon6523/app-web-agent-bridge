# Automatic agent diagnostic report

## Installation baseline

This is an add-on to the delivered selector self-repair 0.2.11 source. Verification baseline: `5364e9261c18d859511e2abbc49cd3ac553e5e83` (local snapshot, not a published remote commit). Check the patch against the actual checkout; a matching manifest version alone is insufficient. Restart the controller and reload the unpacked extension after installation. Existing documents need current content scripts for document diagnostics; do not erase delivery ownership.

## One report to share

Default path: `.agent-controller/diagnostics/runtime-latest.json`. With `CONTROLLER_DATA_DIR`, the report is in its `diagnostics` subdirectory. CLI uses the same configuration path. Configuration failure falls back to the target checkout's `.agent-controller/diagnostics` directory. Server and CLI must use the same working directory/environment to share the file.

```powershell
notepad .\.agent-controller\diagnostics\runtime-latest.json
```

Share this file with an agent. Each section has its own observation time, source and diagnostic ID: `server`, `repair`, and `deliveryReview`. The last section is only available after the existing delivery status API has actually been used; null is not evidence of no delivery. In-memory merging and atomic rename avoid partially written JSON; concurrent processes may replace an older section snapshot. This latest file is not the durable approval/action journal. Per-job `selector-repair/JOB_ID/events.jsonl` remains the authoritative repair action history.

## Automatic collection

The server creates a report on startup, records connection changes immediately, and schedules read-only tab diagnostics from connection changes and existing heartbeat/manual-intervention events. Automatic reads have a 60-second minimum interval, one shared pending request, an 8-tab limit and a 10-second RPC timeout. Events during cooldown/pending work do not create a retry queue. There is no added heartbeat, prompt dispatch, injection, binding operation or repair worker launch. The authenticated existing selector diagnostics API also updates the report when used. Closing the reporter cancels its scheduled/pending inspection and removes its listeners.

Stored metadata includes Git commit/dirty status, connection readiness, document token, content/extension versions, composer readiness, selector count statistics, visible editable counts, and bounded extension storage delivery metadata. Page content, composer values, response bytes, labels, URLs, exception messages and stacks are excluded. Unknown fields are explicit; missing/failed collection never implies an empty tab list or missing server delivery.

`server.delivery.responseObserved` only records extension storage evidence. It does not prove response validation, durable persistence, successful ACK or server/extension agreement. Those remain UNKNOWN/UNVERIFIED until the existing delivery review API supplies its separate timed observation. No runtime is initialized merely to collect delivery evidence. No delivery is acknowledged, discarded or resent by this reporter.

## Repair CLI diagnostics

Use direct Node on Windows; no `node -e` quoting is needed:

```powershell
node .\scripts\repair-selectors.mjs --server http://127.0.0.1:8787 --tab 132530096
```

Use a currently existing tab ID. Stages distinguish CONFIG, HTTP, HTTP_JSON, TAB_SELECTION, REPAIR_PREFLIGHT, APPLY and INSPECT. Errors include a safe code, cause code, stage, diagnostic ID and log path. HTTP status is recorded without the response body. A READY composer produces `REPAIR_NOT_NEEDED`, exit 0 and no worker/job. Other repair prerequisites and explicit patch-hash approval remain in force. Argument parsing/import failures before CLI initialization cannot produce this report. Latest-report write errors do not hide an already-created candidate or successful application; the durable per-job journal still controls those actions. Permission/disk errors report `loggingFailure`; do not claim a log exists in that case.

## Verification

```powershell
npm run check
```

The delivered verification log is overwritten per invocation. The new regressions cover secret/body omission, single latest file replacement, event storms/coalescing, close during pending RPC, bounded ownership projection, configuration failure, HTTP 404/non-JSON diagnostics, and READY without launching a worker. Existing selector repair generation/approval/apply and real HTTP/WebSocket fixture tests are also run. Linux fixtures do not certify native Windows, installed Chrome or the user's ChatGPT delivery recovery.

## Integrated diagnostics (extension 0.2.12)

Baseline: remote `a01154601ef883909e111dff74f81f7528976412`. This revision
extends the existing latest report; it does not resend, ACK, discard, rebind,
inject content or launch a repair worker while collecting diagnostics.

The report now records original Web error codes/stages, bounded incidents with
repeat counts, transport rejection codes (including 4409), selector registry
versions and inspection error codes. An inspection error cannot be classified
as a selector mismatch. Failed delivery-review reads replace the current review
section with UNAVAILABLE instead of retaining a previous successful observation.

Automatic delivery evidence comes from separate read-only SQLite connections.
No runtime or persistence constructor is initialized, no store is created and
no migration is performed. Existing stored metadata records are not authority
to ACK: history and response/packet artifacts are explicitly NOT_VERIFIED. An
ACK_PENDING receipt means recorded persistence metadata; it is not proof of a
successful ACK. Records are bounded; missing identity, invalid schema, corrupt
or locked storage and truncation are explicit unavailable results. Preparation
and controller stores are separately timed reads, not one cross-store atomic
snapshot. Recheck identity/state before any operational action.

The standalone latest JSON also includes repair job stage, diagnostic/candidate
hashes, the four verifier results, approval and application state. Only a full
set of successful verifier records is PASSED. Live provider validation remains
NOT_CHECKED. This revision keeps the existing explicit repair CLI and exact
patch-hash application approval; it does not enable automatic candidate creation.

Latest-file writes hold a process lock over read/merge/rename and retry without
blocking the event loop. Confirmed dead writer PIDs can be reclaimed. Live,
malformed or otherwise unverifiable locks fail closed with a logging failure;
they are never silently stolen. This prevents concurrent CLI/server updates
from silently losing another successfully written section. No periodic log
files are added. Existing repair action journals remain durable audit records.

### Export without console commands

Reload the unpacked extension, restart the controller and open the extension
popup. Select **최신 로그 저장**. The extension reads current tabs without
changing ownership. If authenticated, it requests the controller's latest
report over the existing authenticated WebSocket and embeds the offline
extension observation. If disconnected, it exports its own persisted errors,
current local observations and explicit UNAVAILABLE server state. The separate
extension storage key survives service-worker recreation and never touches
session/delivery ownership keys. Chrome may suffix repeated downloaded copies;
the controller's operational `runtime-latest.json` is still one overwritten file.

Authenticated dashboard clients may also GET `/api/agent-diagnostics`. Its read
authorization is identical to the existing selector diagnostics API. Read-only
collection failure is represented in the report, rather than implying no tabs
or no delivery. Before configuration loads, server CONFIG failures use the
checkout's `.agent-controller/diagnostics` fallback; success and listen failure
are recorded in the startup section. Process crashes before JavaScript imports
or diagnostics initialization cannot be captured by this application code.

Page text, editable values, response bytes, arbitrary exception messages/stacks,
URLs, labels and credentials are excluded. Conversation identity in the report
is a hash, while internal exact comparisons retain the existing canonical
identity. Metadata remains untrusted observation data.

### Verification

Run `npm run check`. New tests cover original error preservation/repeat counts,
inspection failure classification, read-only preparation/review metadata,
server-only ownership, corrupt storage, exact ACK receipt identity, concurrent
process writes, live/dead writer locks, repair verifier summaries, offline
service-worker recreation, authenticated HTTP/WebSocket export without runtime
initialization, and server configuration failure. Local Linux fixtures do not
certify native Windows or a live ChatGPT page.

### Server responsiveness and Windows writer contention

The server's automatic path uses asynchronous `execFile` (two sequential Git
commands, 1.5 seconds each) and asynchronous filesystem calls. File sync is
`FileHandle.sync()` before atomic rename; a Promise does not wrap synchronous
Git or synchronous file writes. Repository observation uses
`--no-optional-locks` so observing dirty source does not refresh the Git index.
Startup observation is queued; it does not delay listening. Export awaits the
accepted observations and writes, and reports storage failure instead of
returning an older report as a fresh successful export. Close stops scheduling,
cancels the owned Git child and tab read, waits for child closure, and drains
accepted writes. Existing ACK and delivery ownership decisions are unchanged.

The cross-process writer retains its exclusive file lease. A Windows `EPERM`
on lock creation is retried only when inspection confirms that the lock path
already exists as a regular file. A missing, unreadable or invalid path preserves
the original error immediately. Waiting is bounded to the existing two seconds;
an expired `EPERM` is returned with operation/path/owner observations. A live or
unverifiable PID is never removed. Only an ESRCH-confirmed dead writer is
reclaimed. Its own orphan temporary output is removed, while committed report
sections are retained. Write and cleanup errors are recorded separately.

The recovery guard is a nonempty directory published by atomic rename only
after its PID/token marker is ready. A process killed immediately after
publication therefore leaves an identifiable owner. Only confirmed dead
recovery owners are reclaimed; a live or unverifiable owner remains protected.
Removal targets that owner's unique marker and uses nonrecursive `rmdir`, so
a late reaper cannot remove a newly published nonempty guard. An empty guard
means the critical work has finished and can be removed after interrupted
cleanup. Preparation directories identify their PID in the name. Each write
prunes them after confirmed death or a failed cleanup recorded by this module
instance, while retaining active preparations. An old ownerless `.lock.recovery` file
has no trustworthy PID: it stays explicitly UNVERIFIED instead of being
automatically deleted. Regressions use actual child processes interrupted
before/after publication and during release, plus concurrent restart writers
and replacement by a live recovery owner.

The existing server observer reports collection scheduling/start/completion,
each Git command and its duration/closure, queue and lock wait, and file
write/sync/rename duration. Events have UTC time and epoch-based monotonic time.
The four responsiveness incident test files retain matching server, heartbeat
and client HTTP/body-completion/timeout observations under fixed
`.agent-controller/latest-<test-file>/` directories. Each test file replaces
its previous run once; cases retain separate timelines and the aggregate keeps
any failure. Temporary diagnostic reports and server stderr are copied before
fixture removal. The normal `.agent-controller/latest-test.log` and
`latest-test-result.json` remain the overall test verdict, including the HEAD,
working-source manifest, Node version, scheduled files and completion receipts.
Heartbeat warnings and actual HTTP failures have separate counts. No request
budget, measured-loop assertion or runtime-read assertion is relaxed.

For the focused Windows gate, from the intended checkout:

```powershell
node scripts/run-tests.mjs tests/agent-diagnostics-complete.test.js tests/fault/server-response-deadline.test.js tests/fault/server-responsiveness.test.js tests/platform/code-history-http.test.js
```

A Linux result does not certify the Windows lock or responsiveness behavior.
Run the focused gate repeatedly on the same recorded source before the full
Windows `npm run check`, browser/Native gates and an actual ChatGPT delivery.
