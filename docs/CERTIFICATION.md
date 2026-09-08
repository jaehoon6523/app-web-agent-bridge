# Live certification

`npm run check` proves the automated test suite passed. It does not prove a real Codex,
browser extension, ChatGPT Web session, or code-change audit succeeded.

`npm run certify` validates one persisted live run and never creates a fake provider run.

PowerShell:

```powershell
$env:CERTIFY_RUN_ID = "code_..."
$env:BRIDGE_BASE_URL = "http://127.0.0.1:8787"
npm run certify
```

To require application:

```powershell
$env:CERTIFY_EXPECT_APPLIED = "1"
npm run certify
```

Certification requires:

- `npm run check`;
- strict doctor checks;
- live Codex/Web readiness;
- schemaVersion 3;
- auditResult PASS;
- persisted assessments and evidence;
- no unresolved required finding;
- `AWAITING_APPLY` or `APPLIED`.

This does not claim OS sandboxing, child-process termination, browser behavior, or provider
behavior unless the selected RequirementsSet and persisted evidence actually prove them.
