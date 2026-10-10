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
