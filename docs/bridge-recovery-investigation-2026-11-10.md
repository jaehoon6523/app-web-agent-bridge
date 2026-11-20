# Bridge recovery investigation — 2026-11-10

## Verified evidence

- Target preparation: `prep_f88d50ee-50af-4d7d-b9e9-b1c5aff844fc`.
- Target conversation: `https://chatgpt.com/c/6aeb2853-0a84-83ee-9660-b67ccbd58ee9`.
- Dashboard observed at 02:11 KST: server responds, runtime ready, extension waiting, response recheck disabled.
- Default extension storage latest file: `000288.log`, modified 01:43:16 KST Nov 10.
- Profile 1 storage latest file: `LOG`, modified Oct 6 19:47:58 KST.
- Profile 7 storage latest file: `000199.log`, modified Nov 9 19:01:30 KST.
- Secure Preferences register the same unpacked extension directory in all three profiles. Registration alone does not prove current activation.
- Read-only parsing of LevelDB log WriteBatch records found Default `agentDiagnosticLatest` observed at `2026-11-09T16:21:25.947Z` (01:21:25 KST): connected and authenticated. Its inspected tab was 132545518, page READY. This snapshot does not establish its URL or present connectivity.
- Profile 7 diagnostic observed at `2026-11-09T10:01:30.403Z`: disconnected, unauthenticated. Latest recorded occupied-controller rejection was code 4409 (`AUTHENTICATED_EXTENSION_ALREADY_CONNECTED`).
- Profile 1 had no agent diagnostic in the scanned log files; SST files were not decoded. Absence in logs is not proof of inactivity.

## Corrections to earlier conclusions

- File mtime does not prove which profile handled a request. Failed tab lookup can return an error without updating delivery storage.
- The claim that Default had no activity after 19:01 is disproved by the newer file and diagnostic record.
- Receipt `hash.input` is the incoming dashboard command, not the outbound extension `recoverSubmitted` payload. A root URL there does not prove a null recovery object.
- `json_array_length` returns zero for this receipts object. Count with `json_each`; filter by preparation identity.
- JSON object traversal rowid is not a timestamp. Persisted key ordering must not be treated as receipt insertion chronology.
- Failed reconcile can persist a receipt without modifying the preparation's `updatedAt`.
- Baseline comparison found two additional target receipts, `b0997bdc-1f80-482a-be47-769346f22068` and `e08ed1f7-5a3a-4cef-a29f-b4682ad60ed5`: both web.reconcile, FAILED, DELIVERY_RECOVERY_UNCONFIRMED. Discard identity errors inspected belonged to other preparations.
- public/app.js maps response recheck to web.reconcile and /api/preparations/web. No discard mapping defect was found.

## Remaining recovery steps

1. Restore the Default extension's authenticated connection using its existing popup Reconnect or extension reload. Inspect the current error first. Do not change credentials or overwrite extension storage.
2. Confirm the exact conversation is visible to that extension in the same Chrome profile. The in-app tab alone does not establish this.
3. Read extension diagnostics to distinguish missing/ambiguous tab from page readiness or identity validation failure. UNCONFIRMED alone does not distinguish these cases.
4. Only after connection and original conversation ownership are verified, carry out the user-authorized single recovery attempt and compare receipt key sets, binding and response.

No server restart, database modification, extension storage modification, or additional recovery click was performed during this investigation. Browser control previously failed its Windows URL verification check; do not bypass that restriction through another automation channel.
