# Windows direct Chromium diagnostics

Contract, module purposes/inputs/outputs and evidence rules: [diagnostic-modules.md](diagnostic-modules.md).
Baseline: `3ed4f937154366280dde361a40a877bafea52b7b` (v3).

Run in this checkout, with the already selected Chromium executable:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-windows-direct-reload.ps1
```

The script reuses `UI_BROWSER_EXECUTABLE`, otherwise the path from the previous A–D receipt. It runs the related regressions, the existing WebSocket/SQLite ACK tests, and independent fresh-profile A/B reload probes (unsafe OFF/ON). A missing browser or failed ACK does not prevent independent checks. No pull/reset/install or product ACK/ownership changes occur. Node entry: `npm run diagnose:windows`.

The direct probe uses Node spawn and external CDP, with no Playwright launcher. Requested DevTools UI and observed DevTools targets are recorded separately. `--headless=new` is used only when explicitly requested by `DIRECT_HEADLESS=1`; Windows is headed by default. Browser path, binary hash, actual argv, fixture hashes and comparison validity are retained. A prior Playwright receipt is optional; without it, prior comparison is UNVERIFIED. A known binary/fixture/condition mismatch invalidates comparison separately from function observations.

PowerShell opens `.agent-controller/latest-windows-diagnostics.log` and `latest-windows-diagnostics.json` in Notepad. `-NoOpen` suppresses only viewing. `-Manual` prepares isolated paths and exact popup-context steps; its result is AWAITING_MANUAL, never completed manual verification. It explicitly requires popup DevTools for the manual runtime.reload call and no external CDP.

Each run preserves raw logs, browser stdout/stderr, raw CDP JSONL, observations, stage times and receipts under `.agent-controller/latest-diagnostics/`. Latest summary/ACK/reload JSON is replaced atomically, including an initial RUNNING record. E reads its run-scoped browser result, and a shared exclusive lock rejects overlapping runs. Each new run removes the previous latest directory and legacy diagnostic-runs tree before publishing RUNNING. Missing, stale, malformed, wrong-ID/scope and nonterminal results fail receipt validation.

Verification-command and selector-repair CLI tests each initialize their latest evidence directory once per test-file invocation and hold its lease until all scenarios finish. The run's `result.json` lists `scenarios/<name>/` details; a failing scenario keeps the aggregate FAIL even when subsequent scenarios pass. Command stdout/stderr, source snapshots, verification receipts and journals remain in their scenario directories. The next invocation replaces the entire previous run rather than accumulating run directories.

This patch changes product source files `src/evidence/candidate-evidence.js` and `src/orchestration/selector-repair.js` to retain verification execution evidence and record cleanup errors separately. It does not change the ACK or delivery-ownership contract. Describing the patch as making no `src/` changes is incorrect.

`execution`, `functionalRecovery`, `reloadInvocationConfirmed`, `reloadBoundaryEvidence`, `reloadResult`, collector exit, browser exit, cleanup and comparison validity are independent. Worker stop alone is partial evidence. Popup failure with unconfirmed invocation/boundary cannot be reload FAIL. A previously observed positive response survives later connection or cleanup failure. A missing extensions management card is not proof of removal/disablement.

Direct CLI: 0 performed experiment with normal execution/cleanup (may include functional FAIL); 2 incomplete; 3 cleanup not normal; 4 collector/browser process failed; 5 known comparison mismatch. Workflow CLI: 0 requested automated contracts performed; 1 failed/incomplete stage; 2 precondition, receipt or manual-incomplete outcome. Neither CLI establishes native bridge success.

The legacy A–D reproducer and its original classifier tests remain for baseline reproduction. Its script hash is included in provenance. The new Windows entry uses the stricter A–E contract and does not promote legacy Worker-stop verdicts to a completed reload.

Validation must distinguish module/connection regression, real Windows Chromium diagnostic execution, and real bridge send/response persistence/ACK. Linux PowerShell or CDP transport tests establish only their stated scope.
