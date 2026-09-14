# Persisted audit checks and live verification

`npm run check` proves the automated test suite passed. It does not prove a real Codex,
browser extension, ChatGPT Web session, or code-change audit succeeded.

`npm run certify` checks one persisted audit run and does not start providers.
It cannot independently establish that the run used real providers. Even a complete
fixture run can satisfy its consistency checks; an empty `{}` evidence entry cannot.

PowerShell:

```powershell
$env:CERTIFY_RUN_ID = "code_..."
$env:BRIDGE_BASE_URL = "http://127.0.0.1:8787"
$env:DASHBOARD_TOKEN = "<static token configured for CLI/API access>"
npm run certify
```

`DASHBOARD_TOKEN` is required for this headless certification CLI because it cannot
obtain the same-origin browser session token. It is not required to start the server
or to use the local dashboard in a browser.

To require application:

```powershell
$env:CERTIFY_EXPECT_APPLIED = "1"
npm run certify
```

Certification requires:

- `npm run check`;
- a healthy bridge server and authenticated access to the persisted run;
- schemaVersion 3;
- auditResult PASS;
- a complete current candidate, capture descriptor and review;
- recomputed requirements identity and candidate/tree/patch/base binding;
- projection arrays matching the canonical run;
- re-evaluation of the review with its fixed requirements and candidate evidence;
- no unresolved required finding;
- `AWAITING_APPLY` or `APPLIED`.

Certification reads persisted audit evidence; it does not require providers to still be
running or the browser extension to still be connected. Run `npm run doctor -- --strict`
separately to check readiness for a new live run. Doctor failure does not invalidate a
previously completed audit. Configuration is loaded from `.env` as well as the environment.

The CLI reads descriptors from the API; it does not independently retrieve and hash every
artifact byte or authenticate historical provider provenance. Its PASS means persisted
audit consistency, not successful live E2E, OS sandboxing or process-tree termination.

## Automated connection checks

`npm run test:browser` connects real Codex/Web adapters, a fixture JSONL subprocess,
temporary Git/SQLite, the complete extension background/content scripts, and a real
Chromium DOM fixture. It checks two implementation iterations, candidate changes,
finding resolution, separate application, first-send navigation and document binding.
Provider responses and Chrome extension APIs remain fixtures. `npm run test:ui` checks
dashboard interactions against fixture API transitions. Neither command is live certification.

## Evidence required for a live claim

Use an explicitly selected real target/requirements/configuration and authenticated
Codex plus a configured extension and ChatGPT conversation. Follow the sequence in
[MIGRATION_PLAN](../MIGRATION_PLAN.md). Retain the run ID, per-iteration thread/turn IDs,
captured candidate and evidence hashes, persisted review requests/responses, and observed
Web document/message binding. A real REWORK followed by a fresh Worker and PASS verifies
the correction loop; an initial PASS does not verify REWORK. Crash/restart is a separate
scenario and must not be inferred from a successful ordinary run. PASS does not apply code.
