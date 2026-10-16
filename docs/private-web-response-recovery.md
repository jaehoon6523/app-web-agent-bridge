# Private Web response recovery

This change separates exact recovery evidence from the material exposed through
the dashboard and evidence export. It does not change the ACK or apply authority
contract.

## Storage and ACK boundary

Before ACK, the controller writes an immutable private record containing the
adapter's original wire text, parsed packet, body, packet text and exact delivery
identity. The receipt binds its content hash to the existing SQLite history.
An unavailable private store prevents ACK and preserves the delivery owner.
ACK confirmation and ownership release still commit together.

Private records live under `private-web-responses` inside the configured artifact
directory. Normal artifact reads cannot address this namespace. Private files
are not served by an HTTP route. Dashboard snapshots, command responses,
durable command replay and evidence export omit `privateResponseRef`.

These files contain unredacted local plaintext. They are not encrypted backups.
Directories and files use owner-only POSIX modes where supported. On Windows,
the configured data directory inherits the account's existing ACL; this patch
does not establish or certify a new Windows ACL. Keep the data directory outside
the web root and version control, and exclude private records from shared
diagnostic bundles and backups intended for sharing.

## Recovery and public copies

Recovery verifies the private record against its receipt, historical delivery
identity and independently saved adapter packet. It parses the untouched wire,
not a masked approximation. It verifies existing public artifact hashes as well;
corruption is refused rather than silently overwritten. Invalid wire and
duplicate JSON members cannot become review authority. Startup sends no prompt,
ACK or patch application. Explicit continuation reuses the original logical
review turns.

Public response and report artifacts remain masked derivatives. Unparseable
wire is replaced with a fixed omission notice in public evidence. Parser errors
do not echo raw fragments. Format repair receives the public derivative rather
than the private original. Redaction preserves Markdown and controller boundary
lines while still masking credential values placed on the next line.

Existing receipts without a private reference retain the legacy verification
path. Their hashes and historical receipt identity are not rewritten. Already
damaged or ambiguous legacy evidence is refused. This is not an automatic
cleanup of previously exposed or malformed historical artifacts.

Deleting a completed run through the dashboard removes its referenced private
artifacts when no remaining history references them. Files orphaned by a process
termination before the receipt commit are not automatically garbage-collected.
Do not expose or share the private directory to collect diagnostics.

## Validation boundary

Local tests cover private storage isolation, content hashes, public projections,
durable command replay, rejected malformed wire, storage failure before ACK,
legacy presentation repair, logical request reuse and actual child-process
termination after ACK. Linux verification does not establish Windows filesystem
permissions or real ChatGPT/browser delivery success.

## Crash probe and file budgets

The crash child publishes a synchronous, atomically renamed checkpoint before
parking its main thread at the exact persistence call. It does not use an IPC
message that needs that same thread to drain. Each checkpoint belongs to one
isolated directory, invocation token and child PID. The parent waits at most
15 seconds for the boundary, requests abrupt termination, and separately waits
at most 5 seconds for process and stdio closure. Existing forced-cleanup code
can add its bounded containment period after that deadline; this remains a
failure. Normal exit, missing evidence, stale identity and cleanup errors cannot
be converted into crash-recovery PASS. Diagnostic lines record the reached
boundary and observed closure without including the saved snapshot or wire.

The original 79 cases are retained in three independently scheduled files:

- `tests/audit-ack-recovery.test.js`: 37 recovery and refusal cases.
- `tests/audit-ack-private-recovery.test.js`: 38 public/private evidence cases.
- `tests/audit-ack-crash-recovery.test.js`: 4 actual abrupt-termination cases.

The existing 180-second file budget is unchanged. This separates accumulated
fixture work from an individual crash-probe hang. No assertions or test names
were removed. `tests/audit-crash-harness.test.js` adds 5 protocol regressions,
including an 8 MiB synchronous checkpoint and bounded cleanup on failure.

First check the Windows crash path and private storage with:

```powershell
node .\scripts\run-tests.mjs .\tests\audit-crash-harness.test.js .\tests\audit-ack-crash-recovery.test.js .\tests\private-web-response.test.js
$rc = $LASTEXITCODE
Write-Host "EXIT CODE: $rc"
notepad.exe .\.agent-controller\latest-test.log
```

This selection has 12 tests. All related cases are covered by the three
recovery files, the harness file and the private-storage file: 5 files and
87 tests in total. Supply each path once. The registered file runner replaces its latest log and receipt on
each invocation. These are local contract tests, not real ChatGPT requests.
