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
