# Independent Windows diagnostics: contract and responsibility map

Baseline: `3ed4f937154366280dde361a40a877bafea52b7b` (v3).
Goal: locate Windows bridge failures using attributable evidence. These probes do not prove native bridge delivery, response persistence or ACK completion. The combined patch changes `src/evidence/candidate-evidence.js` and `src/orchestration/selector-repair.js` to preserve verification evidence and record cleanup failures separately. The ACK and delivery-ownership contract, `extension/` and `public/` remain unchanged.

| Module / existing code | Purpose / input | Output / failure boundary |
| --- | --- | --- |
| A: `diagnostics/environment.mjs`, `mv3-reload-core.mjs` | Requested executable, condition, uniquely owned profile and child command. Reuse v3 fixture bytes and supervisor. | OS/Node/source and changed-file hashes; resolved browser/hash; requested and observed argv; PID; CDP readiness separately; watchdog, child exit and cleanup. Unknown argv stays UNVERIFIED; mismatches invalidate comparison. Only owned tree/profile can be cleaned; orphan descendants without the profile argument are also checked (Windows ancestry, POSIX owned process group). |
| B: `direct-mv3-identity.mjs` | Candidate targets/events and popup probe within SETUP budget. Reuse v3 full-window discovery and exact URL scoping. | Exactly one verified extension ID, worker URL/version and registration scope/IDs, initial popup/response/storage and execution context. Marker alone, wrong URL/runtime.id or missing API means SETUP incomplete; reload is blocked. |
| C: `diagnostics/reload-observer.mjs` | B's verified identity, CDP connection and observation budget. Extract v3 CDP transport, popup and management UI observations. | Raw timestamped protocol events, target-owned subset, before/after responses and storage, invocation attempted/returned/interrupted, observation start/end/reason. No verdict. Missing management card is only a UI observation. |
| D: `diagnostics/reload-result.mjs`, `ack-windows-result.mjs` | Immutable observations, identity, execution and cleanup receipts; no browser I/O. Reuse v3 target filtering/classification and fresh ACK receipt checking. | Independent execution/function/invocation/boundary/process/cleanup/comparison verdicts, explicit evidence references, atomic run-scoped and latest JSON. Worker stop alone proves neither full reload nor invocation. Invalid/missing/wrong-run/wrong-scope receipt is never an old PASS. |
| E: `windows-diagnostics.mjs`, `run-windows-direct-reload.ps1`, `direct-chromium-reload-compare.mjs` | Repository location, existing browser selection (environment or prior receipt), optional manual-preparation flag. | Preconditions, related regressions, independent ACK and browser stages, next action, per-run logs/receipts and latest summary. ACK failure cannot skip the browser stage. PowerShell opens current latest log/JSON in Notepad. |

## Shared record

`verificationRunId`, `scope`, `source.commit` and file SHA-256 (including modified/untracked diagnostic files), `environment` (OS, Node executable/hash, browser real path/hash or explicit error), requested/observed conditions, stage start/end timestamps, observations/errors, and separate verdicts accompany a run. Regular files use byte hashes; symlinks use their link-target text hash and explicit `fileKinds`, without following directory links. Per-file hash errors never erase an observed source commit. Raw events and stdout/stderr are retained in the run directory before temporary resources are removed. `evidenceUsed` names the exact JSON paths/event sequence IDs used by D. Latest is atomically replaced first with RUNNING, then with that run's terminal record; receipts must match run ID, scope, generation timestamps and terminal state. E consumes the run-scoped browser result; shared latest files are for viewing.

## Verdict rules

- `functionalRecovery=PASS`: actual popup context, message reply/instance and retained storage observed. A static marker or exit 0 is insufficient. Negative functional verdict requires a completed observation window; interrupted observation is UNVERIFIED unless a positive result was already observed.
- `reloadInvocationConfirmed`: the context-checked `runtime.reload()` expression returned its invocation receipt. An interrupted call is recorded as such, never silently converted into a returned call.
- Reload PASS additionally requires target-owned lifecycle boundary, a changed instance and resumed worker. Worker stop alone is PARTIAL evidence. Without a returned invocation or target registration deletion, popup failure cannot become reload FAIL.
- Observation in progress/disconnected/incomplete setup cannot be final experiment COMPLETE. Cleanup and process failure preserve prior positive functional evidence.
- Comparison is VALID only when actual argv and binary/fixture hashes match requested conditions and required reference conditions. No prior comparison receipt means prior comparison UNVERIFIED, not an operational block on the independent ACK test.
- Direct CLI: 0 = experiment performed with confirmed normal child/cleanup (may contain functional FAIL); 2 = incomplete experiment/receipt; 3 = cleanup not normal; 4 = collector/browser execution failure; 5 = known comparison mismatch. Windows workflow CLI: 0 = requested automated stages executed and their contracts passed, **not native bridge success**; 1 = a stage failed/incomplete; 2 = precondition/receipt failure. Manual preparation is `AWAITING_MANUAL`, never manual completion.

## Windows use

From this checkout (including a subdirectory):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-windows-direct-reload.ps1
```

The already selected `UI_BROWSER_EXECUTABLE` is reused. Otherwise the recorded prior A–D browser path is reused. If neither exists, ACK/regressions still run and the browser precondition is recorded with the exact missing setting. No automatic install, checkout, reset or product configuration changes occur.

`-Manual` prepares exact isolated profile/extension/window/page instructions and records AWAITING_MANUAL; it does not certify a human action. The automatic probe uses Node spawn (no Playwright launcher), external CDP attached, no requested DevTools UI. CDP attached and DevTools UI use are separate fields; lack of observed UI evidence remains UNVERIFIED.

Only the latest run is retained. An exclusive lease rejects concurrent writers, including standalone reload experiments; a reload child joins its matching parent lease. The lease uses a native SQLite transaction and reuses one small database and owner metadata file per workflow. Process exit releases the operating-system lock; an old owner marker cannot block the next invocation. Legacy diagnostic-runs directories are removed under that lease. Run artifacts live under `.agent-controller/latest-diagnostics/`; `latest-windows-diagnostics.log` and `latest-windows-diagnostics.json` point in their content to this run. The PowerShell script opens those two files. ACK uses the existing real WebSocket/SQLite/artifact tests, whose cleanup order remains WebSocket → current SQLite connection → temporary directory with all cleanup errors retained. Browser reload probes use a minimal extension with pinned v3 fixture hashes, not the bridge extension.

## Verification boundaries

Report separately: (1) module and connected-runner regression, (2) real Windows Chromium diagnostics, (3) real bridge function. Linux browser smoke and non-Windows PowerShell execution can verify wiring but cannot establish (2) or (3). Test seams inject transport/process failures only at I/O boundaries; they do not replace the production diagnosis functions being tested.
