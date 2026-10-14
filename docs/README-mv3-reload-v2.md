# Minimal MV3 reload matrix v2 — diagnostic, not bridge certification

Run from the repository root (PowerShell):

```powershell
node --test .\tests\minimal-native-reload-matrix-v2.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'MATRIX REGRESSION FAILED' }
node .\scripts\minimal-native-reload-matrix-v2.mjs *> .agent-controller\latest-minimal-matrix-v2.log
$rc=$LASTEXITCODE
Get-Content .agent-controller\latest-minimal-native-reload-matrix-v2.json
Write-Host "EXIT CODE: $rc"
```

For exactly the same browser as the native suite, set `$env:UI_BROWSER_EXECUTABLE` to the **actual local Chromium executable** if Playwright's default differs. The script passes an explicit `executablePath`, records the requested path and SHA-256, CDP `Browser.getBrowserCommandLine` (including the binary reported by CDP), and browser version. It also records hashes of the generated extension's manifest, module Worker, popup, and source scripts. Verify these in the receipt before interpreting comparisons.

Each A/B/C/D case runs in a separate Node subprocess and Chrome user profile. A/B reload a freshly launched module Worker, with unsafe debugging disabled/enabled. C/D also stop/restart the Worker and navigate a fixture page before reload. The parent monitors a 35-second **trial execution deadline** by default; forced termination and bounded process-tree cleanup take additional time. It records whether child termination and matching browser-process absence could be confirmed. Failure to verify cleanup is `UNCONFIRMED`, never silently PASS. To adjust the trial deadline: `$env:MV3_TRIAL_DEADLINE_MS='35000'` (milliseconds, from 1000 through 300000).

The parent cancels pending deadline timers when a child finishes, and records each child's `childExit` (`code`, `signal`) plus `childExecution.status` (`PASS`, `FAIL`, `UNCONFIRMED`). A stored successful reload observation **does not** excuse exit code 7, watchdog SIGKILL, or a failed child process. A real descendant watchdog regression test requires the grandchild's numeric PID **and advancing heartbeat** before termination; the grandchild's Node CLI passes `--` before the Chromium-profile marker.

Receipt fields are independent:

- `execution: COMPLETE/INCOMPLETE`: observation actually completed, regardless of the result.
- `functionalRecovery: PASS/FAIL/UNVERIFIED`: popup, storage and background messaging.
- `reloadBoundaryEvidence: CONFIRMED/PARTIAL/NOT_OBSERVED`: CDP stop/delete → running and new module-worker instance.
- `reloadResult: PASS/FAIL/UNVERIFIED`: composite; **functional PASS with missing boundary evidence is UNVERIFIED, not FAIL**.
- `cleanup.status: PASS/FORCED_TERMINATED/FAIL/UNCONFIRMED`: do not overwrite earlier observations. If cleanup cannot be verified, remaining trials are withheld to prevent cross-case contamination.

Parent exit status: `0` = all four cases completed with verified ordinary cleanup **and child exits 0** (individual reload outcomes may be FAIL); `2` = one or more experiments incomplete or child-exit status unconfirmed; `3` = degraded cleanup or unconfirmed termination; `4` = any abnormal child exit, including a nonzero exit code or watchdog termination, when cleanup has been confirmed. Cleanup failures take precedence over child-execution failures. Do not equate exit 0 with native 7/7 PASS.

Output `.agent-controller/latest-minimal-native-reload-matrix-v2.json` is atomically replaced; child stage snapshots are written before dangerous operations. The parent preserves the last durable observations if it kills a stuck child.

**Limitation:** This probe has no bridge active delivery, content reinjection, native ownership, ACK or cancel state. Minimal reproduction cannot by itself establish that Chromium is defective. Compare actual executable, headless profile and launch options with the separate bridge Native suite. That suite retains its 6/7 PASS, overall FAIL unless separately independently verified.
