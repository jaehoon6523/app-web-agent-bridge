# Content readiness failure diagnostics

Extension version `0.2.3` preserves composer inspection diagnostics through the
content ping, browser readiness timeout, root bootstrap error, and server log.
It does not change the selectors, readiness deadline, dispatch, ACK, or retry policy.

## Reproduce and capture

1. Apply the matching patch and restart the local server.
2. Reload the unpacked extension, then reload the ChatGPT tab so its content
   runtime also uses `0.2.3`.
3. Start one preparation. On failure, retain the complete
   `[bridge:preparation:failed]` entry from the server console.
4. A failed preparation remains blocked. Cancel it explicitly before another
   start; do not automatically resend the prompt.

For PowerShell, run `npm start *> server-latest.log` to overwrite one log file
with the server output. Open it with `notepad server-latest.log`. Stop the server
before another capture. This capture is optional; console output already includes
the diagnostics. No new accumulating log files are created by the application.

## Fields

The server prints the complete nested JSON, including arrays and error stacks.
For root bootstrap `LOAD` or `CREATE` failures, inspect
`details.causeDetails.readiness`:

| Field | Meaning |
| --- | --- |
| `tabUrl` | Actual URL observed by the extension tab API |
| `lastReadiness.pageUrl` | Actual URL observed inside the content document |
| `lastReadiness.runtimeVersion` | Content runtime version; compare with `details.extensionVersion` |
| `lastReadiness.composerPresent` | Whether a visible registered composer was found |
| `lastReadiness.diagnostics.composerSelectors` | Match count, visible count, and up to three style/size samples per selector |
| `lastReadiness.inspectionError` | Original exception from the latest content inspection, if any |
| `lastInspectionError` | Most recent inspection exception in this preparation, including message and stack |
| `responded`, `pingAttempts`, `missingReceiver` | Content readiness transport observations |
| `chromeDocumentId`, `contentDocumentId` | Chrome document identity and the distinct content lifetime token |

`matched=0` establishes that the selector found no element at inspection time.
`matched>0` with `visible=0` identifies matched elements rejected by visibility
checks. An `inspectionError` identifies a failed inspection, not proof of an absent
composer. A readiness timeout alone does not prove that the provider UI changed.

Only the latest readiness snapshot and latest inspection exception are retained
per preparation. Fresh preparation clears those snapshots. Diagnostics contain no
composer value, conversation body, response text, or HTML dump. Both absent and
hidden composers can time out; dependency exceptions are preserved separately.

## Validation boundary

`tests/readiness-diagnostics.test.js` exercises the actual content scripts and
provider with a controlled DOM, browser readiness polling, bootstrap wrapping,
JSON wire serialization, PreparationService persistence, and complete stderr
formatting. It covers absent, hidden, visible, and dependency-failure cases, plus
fresh preparation clearing stale exceptions. These fixtures do not establish the
cause of a failure in the user's live Chrome document.
