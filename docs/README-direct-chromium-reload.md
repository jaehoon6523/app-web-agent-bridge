# Windows direct Chromium MV3 comparison (e331ea8)

Purpose: compare fresh A (unsafe OFF) and B (unsafe ON) against the earlier Playwright MV3 experiment, **without Playwright**. This is a diagnostic, not a bridge product fix or an end-to-end delivery/ACK verification. No bridge product files are modified by this patch.

## Preconditions

* Checkout the intended source. The script records `git rev-parse HEAD` and the PowerShell runner records worktree changes; it does not pull/reset/checkout.
* Use Windows, Node 22.14 or later with built-in `WebSocket`, and the **exact Chromium executable from the previous Windows A–D receipt**. The PowerShell runner automatically selects the path in `.agent-controller/latest-minimal-native-reload-matrix-headed.json`, or falls back to `...v2.json` if no override is set. `UI_BROWSER_EXECUTABLE` can explicitly select that same binary.
* Prior A–D receipt is mandatory; its executable SHA-256 is compared against the direct Chromium executable SHA-256 before the experiment. The minimal extension source file hashes are pinned to the e331ea8 A–D fixture and checked by the child before launching.
* The baseline A–D experiment started Chromium with Playwright `launchPersistentContext`, `headless` true/false and Playwright default flags. This direct experiment starts `chrome.exe` via Node `spawn` with a fresh profile and remote CDP endpoint, **headless OFF by default**. No Playwright API or Playwright launcher is used. These differences are reported; they are not assumed causative.

## Run from repository root (PowerShell)

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-windows-direct-reload.ps1
```

The runner performs the independent SQLite/ACK contract regression tests first, even if the browser reload is still broken; then it executes direct Chromium A/B. Actual Chromium process command lines are collected from `Win32_Process.CommandLine`. CDP is used **only as a protocol observer and to invoke `chrome.runtime.reload()`**, so the result cannot exclude the effects of CDP. It does exclude Playwright's launcher and Playwright-specific browser-control code. This is not an observer-free manual comparison.

Receipt/log files are replaced each run:

* `.agent-controller/latest-direct-chromium-environment.json` — worktree, binary/hash and differences
* `.agent-controller/latest-ack-windows.log` — ACK contract test output
* `.agent-controller/latest-ack-windows-result.json` — independent ACK test receipt
* `.agent-controller/latest-direct-chromium-reload.log` — direct Chromium execution log
* `.agent-controller/latest-direct-chromium-reload.json` — direct A/B raw evidence

Open with:

```powershell
notepad.exe .agent-controller\latest-direct-chromium-reload.log
notepad.exe .agent-controller\latest-direct-chromium-reload.json
```

The direct test records CDP worker lifecycle transitions, popup accessibility, storage sentinel retention, background ping and instance ID, `chrome://extensions` UI state if observable, and browser process arguments. An inaccessible internal extensions UI remains `UNVERIFIED` rather than being interpreted as disabled. `execution=COMPLETE` and CLI exit 0 mean **experiments completed**, not successful reload. `functionalRecovery`, `reloadBoundaryEvidence`, `reloadResult`, child exit and cleanup are separate. A setup failure is `INCOMPLETE/UNVERIFIED`, not a reload failure.

## Limitations and next comparison

This patch cannot prove `chrome.runtime.reload()` behavior without *all* CDP observation; the direct test necessarily uses a CDP session for messaging and inspection. If A/B outcomes differ from the Playwright baseline, compare the captured process arguments, headed/headless, CDP attach topology and extension loader. If both fail, repeat with a human-operated, observer-free Chromium only after preserving this environment record. Do not use these tests to assert delivery, persistence, ACK or ownership correctness.
