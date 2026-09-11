# Live certification

`npm run check` proves the automated test suite passed. It does not prove a real Codex,
browser extension, ChatGPT Web session, or code-change audit succeeded.

`npm run certify` validates one persisted live run and never creates a fake provider run.

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
- persisted assessments and evidence;
- no unresolved required finding;
- `AWAITING_APPLY` or `APPLIED`.

Certification reads persisted audit evidence; it does not require providers to still be
running or the browser extension to still be connected. Run `npm run doctor -- --strict`
separately to check readiness for a new live run. Doctor failure does not invalidate a
previously completed audit. Configuration is loaded from `.env` as well as the environment.

This does not claim OS sandboxing, child-process termination, browser behavior, or provider
behavior unless the selected RequirementsSet and persisted evidence actually prove them.
