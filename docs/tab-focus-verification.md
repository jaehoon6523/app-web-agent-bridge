# Tab focus integration and Windows verification

## Scope and provenance

Base: `06e5e3034e7ae8e67f6af4104097ef9bb952de75`.
The 2026-10-24 handoff includes both the v2/followup bundle and the earlier
14-file submission. They are alternative full patches, not sequential patches.
This integration uses v2 plus its deadline tests and ports the earlier
submission's expiry and extension occupancy protections into the existing path.
It retains v2's version-bound UI observations, separate server/tab reads,
confirmed-but-inapplicable results, connection replacement cleanup and response
target validation. It does not introduce the alternative `web.tab.inspect`
protocol, capability negotiation, or its dedicated HTTP inspection endpoint.
Read-only recovery continues to use `/api/selector-diagnostics`.

The supplied three acceptance tests failed before the changes (0/3) and passed
afterwards (3/3), without changing their assertions. They are included in
`tests/tab-focus-guards.test.js` and `tests/helpers/tab-focus-selection.js`.
Additional tests exercise the actual background message-dispatch function in a
VM with the real turn gate, expiry during activation, existing Web occupancy,
failure cleanup, connection replacement and subsequent success. UI tests cover
preselected candidates, rerenders, stale handlers and recovery before rebind.

## Execution contract

| Boundary | Owner and invariant |
| --- | --- |
| Dispatch | Server adds `expiresAt` with the existing 10-second budget. |
| Extension receipt and lookup return | Reject expired requests or changed requesting connections before mutation. |
| Tab/window mutation | Recheck immediately before each call; after a mutation starts, uncertainty remains UNKNOWN. Already-started Chrome promises are not cancelled. |
| Occupancy | Module focus occupancy plus the existing turn gate; only actual operation settlement releases its own reservation. Server timeout or socket replacement does not release it. |
| UI selection/send | The same unconfirmed-target set guards view, radio, send state and event handlers. Server snapshot success alone does not unlock that target. |
| Recovery | A matching current preparation/target/version observation unlocks the target. It proves a current observation, not historical execution. No automatic mutation retry. |

An unresolved Chrome API holds the extension gate until it settles. This is an
intentional exclusion boundary, not proof of cancellation or successful recovery.
Requests from legacy servers without expiresAt retain compatibility; deploy the
server and extension together. Server and Chrome run on the same localhost host;
absolute deadlines use its wall clock and are not a distributed-clock protocol.

## Automated verification

Run from this checkout in PowerShell. Dependencies must already be installed
(`npm ci` if necessary). The same test command works on Linux.

```powershell
New-Item -ItemType Directory -Force .agent-controller | Out-Null
node scripts/run-tests.mjs tests/tab-focus-guards.test.js tests/tab-focus-extension-gate.test.js tests/tab-focus-lifecycle.test.js tests/tab-focus-ui.test.js tests/tab-focus-http.test.js tests/preparation-tab-focus.test.js tests/preparation-tab-choice.test.js tests/public/workflow-runtime.test.js tests/web-runtime-core.new.test.js tests/preparation-stale-tab-integration.test.js tests/flexible-tab-recovery.test.js tests/preparation-api.test.js tests/preparation-service.test.js tests/web-extension-turn-guard.new.test.js tests/web-delivery-recovery.test.js tests/selector-diagnostics-http.test.js tests/delivery-ack-restart.test.js tests/audit-review-contract.test.js tests/code-change-service.test.js *> .agent-controller\latest-tab-focus-check.log
if ($LASTEXITCODE -ne 0) { throw 'Tab focus verification failed; inspect latest-tab-focus-check.log.' }
$r = Get-Content .agent-controller\latest-test-result.json -Raw | ConvertFrom-Json
$passed = ($r.results | ForEach-Object { $_.summary.passed } | Measure-Object -Sum).Sum
"status=$($r.status) unchanged=$($r.candidateUnchanged) passed=$passed files=$($r.results.Count)/19 terminal=$($r.terminal)"
if ($r.status -ne 'PASS' -or -not $r.terminal -or -not $r.candidateUnchanged -or $r.results.Count -ne 19) { throw 'Incomplete or invalid result receipt.' }
npm run lint
npm run architecture:check
npm run typecheck
git diff --check
```

The existing runner replaces latest-test.log/latest-test-result.json. The command
above replaces latest-tab-focus-check.log; it does not accumulate prior runs.
The three real deadline tests take approximately 70 seconds in total. They use
Node timers/fetch/HTTP and the actual UI code with a mock DOM. Other Chrome calls
are mocked. None of these are installed-Chrome or Windows execution evidence.

## Installed Windows/Chrome: one attempt, then controlled recovery

1. Record `git rev-parse HEAD`, `git status --short`, `node --version` and the
   verification result. Stop the previous server normally in its own terminal.
   Check `Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue`.
   If still occupied, identify its owner before starting another server; do not
   kill an unidentified process. Start from the verified checkout:

```powershell
New-Item -ItemType Directory -Force .agent-controller | Out-Null
'' | Set-Content .agent-controller\latest-tab-focus-server.log
node --experimental-sqlite src/server.js 2>&1 | ForEach-Object { if ($_ -match '\[bridge:tab-focus\]') { $_ | Tee-Object -FilePath .agent-controller\latest-tab-focus-server.log -Append } else { $_ } }
```

2. Record the new listening PID, Chrome version from `chrome://version`, extension
   ID/version/path from `chrome://extensions`. Reload the extension from this
   checkout's `extension` directory and refresh the dashboard. Confirm connection
   in the popup. A 4409 rejection requires resolving the duplicate connection.
   Version 0.2.22 alone does not identify the patched code. Compare local
   `Get-FileHash extension\background.js,extension\runtime\tab-diagnostics.js`
   against the loaded package in the worker console:

```javascript
console.log({extensionId:chrome.runtime.id,version:chrome.runtime.getManifest().version});
await Promise.all(['background.js','runtime/tab-diagnostics.js'].map(async file=>{
  const bytes=await (await fetch(chrome.runtime.getURL(file))).arrayBuffer();
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  console.log({file,sha256});
}));
```

3. Record that worker DevTools is open (it can affect worker lifetime). Clear its
   console and filter `[bridge:tab-focus]`; clear dashboard Network. Check the
   candidate and click “탭 화면 보기” once. Collect only phase/requestId/tabId/code/
   extensionVersion, HTTP status/code/executionOutcome/applicable/duration, actual
   tab/window movement and button state. Do not export authentication headers,
   tokens, conversation text, full URLs or a full HAR. Save filtered worker lines
   to latest-tab-focus-extension.txt, replacing its previous contents.

| Last observed boundary | Interpretation and next check |
| --- | --- |
| HTTP rejection without dispatch | Preparation/ownership/pre-dispatch rejection or missing observation; inspect HTTP code. |
| dispatch without socket-send-returned | Local connection/send boundary. |
| socket-send-returned without extension-received | Delivery, loaded handler or worker observation boundary; send is not remote receipt. |
| tab-query-started without completion | Chrome lookup unresolved; after expiry it must not start new mutations. |
| TAB_FOCUS_EXPIRED before mutation | This request did not begin browser changes. |
| tab-activation-started without completion | API may already execute; outcome remains unknown, occupancy stays held. |
| tab-activation-completed then error/expiry | Partial execution possible; no subsequent window mutation after expiry. |
| extension-result then response-not-sent/failed | Result exists but reply could not be delivered; inspect connection. |
| response-send-returned without response-matched | Delivery/protocol/connection/pending expiry boundary; compare the same requestId. |
| SUCCEEDED with applicable=false | Execution confirmed but preparation changed; UI must retain that distinction. |

4. If unknown, inspect the actual tab/window before deciding on another move.
   Restore connection if needed, then click “최신 상태 조회” once. `/api/state`
   and `/api/selector-diagnostics` must start independently. The collector expires
   after 10 seconds of no extension response; stalled HTTP headers/body are
   bounded by the UI's existing 30-second active-time timeout. Report work may
   delay HTTP after collection. These are not wall-clock guarantees during page
   suspension or event-loop stalls.
5. When reads settle, refresh must be available again. Failed inspection must
   keep the target's view, selection and send blocked; a different valid target
   may be available. A successful current observation unlocks only its target.
   After an intentional next move, verify a new requestId, HTTP 200 with opened
   true and the expected tabId, actual tab/window movement and released UI busy
   state. If the old Chrome task is still pending, WEB_SESSION_BUSY is correct;
   do not repeatedly retry or assume reconnect cancels that task.
6. Replace latest-tab-focus-manual.txt with execution identity, initial result,
   last observed phase, two recovery GET results, button states and subsequent
   intentional move result. A repeated stall ends this single-attempt procedure:
   preserve that boundary evidence and investigate it rather than blindly retrying.

The original Windows timeout cause and installed-extension recovery remain
unverified until this procedure is actually performed. Code regression results
and remote publication do not establish resolution of the original incident.
