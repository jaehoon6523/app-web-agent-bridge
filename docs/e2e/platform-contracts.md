# Platform lifecycle contracts

UFs verify OS-neutral user behavior through the production spine. Repeated OS
differences belong at the lowest shared process, filesystem, persistence,
network or browser boundary that owns the behavior. A platform contract is a
small reproduction of that boundary's invariant, not a relaxed UF oracle.

## Current categories and evidence

- NetworkLifecycle / TCP half-close: the final test in
  `tests/e2e/graceful-shutdown.test.js` uses a real WebSocket upgrade, a masked
  close frame and an `allowHalfOpen` TCP peer. Production shutdown must finish
  within its existing deadline and the process must exit with code 0 without
  harness containment. The filename is retained to avoid unrelated moves.
- NetworkLifecycle / HTTP header observation:
  `tests/contract/network-lifecycle/http-headers.test.js` checks fragmentation,
  incomplete EOF, socket errors, idle deadlines and the header size limit over
  real TCP sockets. `tests/helpers/socket-headers.mjs` waits for `\r\n\r\n`,
  rather than treating the first `data` event as a complete upgrade response.
- NetworkLifecycle / socket observation:
  `tests/contract/network-lifecycle/socket-observation.test.js` covers a real
  pre-request TCP connection, HTTP keep-alive reuse and an unfinished response,
  accepted extension WebSocket ownership, an upgrade rejected during shutdown,
  and diagnostic sink/error isolation without consuming socket data.
- NetworkLifecycle / unrequested TCP shutdown:
  `tests/contract/network-lifecycle/http-unrequested-shutdown.test.js` holds a
  real accepted TCP connection open without sending HTTP bytes. Production IPC
  shutdown must close it and exit naturally, without harness containment. The
  same close policy must work without a diagnostic sink and must preserve
  partially received headers and active request bodies until they complete.
- ProcessLifecycle: `tests/e2e/graceful-shutdown.test.js` and
  `tests/e2e/active-worker-cleanup.test.js` cover IPC shutdown, persistent child
  EOF cleanup and failing/stuck children. `tests/platform/runner.test.js`
  checks bounded failure containment by the runner.
- CleanupOwnership: `tests/platform/lifecycle.test.js` checks that rejection
  or a deadline does not skip later resources, errors retain their causes,
  independent evidence writes continue after another file fails, and cleanup
  failure remains FAIL.
- Persistence: `tests/platform/persistence.test.js` exercises real external
  SQLite writer locks, recovery and close-before-delete ownership.
- BrowserObservation: `tests/platform/browser.contract.mjs` exercises response
  observation across real browser navigation rather than replacing responses.

New network lifecycle cases belong in `tests/contract/network-lifecycle/`.
HTTP keep-alive, unfinished requests, WS OPEN/CLOSING and upgrades during
shutdown are coverage candidates; this document does not claim each has a
dedicated contract yet. Keep user-visible assertions in existing UFs.

## Shutdown evidence has a precise scope

The E2E process result's `forced` flag records harness containment after failed
process or stdio closure. `forced:false` does not prove that every subordinate
resource closed cooperatively. Production may terminate an owned silent TCP
connection or upgraded WebSocket during bounded shutdown. A production failsafe can also exit with
code 1 while `forced:false`; the exit code still makes the contract fail.

`lifecycleClosed` means the registered finalizers completed successfully. It
does not prove that all external or unregistered descendant resources closed.
Resource finalizers run in ownership order, preserving each failure in an
aggregate. Each diagnostic file is registered separately, so failure writing
stdout cannot skip stderr, boundary evidence or the final failure result.

## Adding a regression

1. Reduce a failing UF to an observed boundary invariant without changing its
   canonical state or user oracle.
2. Add it to the existing category, or define a new category when necessary.
3. Fix the shared owning boundary, preserving bounded failure and diagnostics.
4. Run the small contracts, then the affected UFs; use full regression for
   changes whose scope requires it.
5. Report actual OS executions separately from proposed matrix coverage and
   controlled reproductions. A Linux reproduction is not Windows root-cause
   evidence.

## CI and unresolved Windows evidence

`bridge-gates.yml` configures Linux and Windows jobs with platform contracts,
browser observation and full UF E2E. Matrix configuration is not proof that
both operating systems passed.

For the reported Windows shutdown failure, run the smallest affected UF and
inspect `shutdown.stage.start/done/error` for dashboard, preparation service,
web session, runtime, worker registry, Codex process, extension WebSocket and
HTTP close. Retain process/stdio and IPC evidence. Diagnose the missing done
or the rejecting stage before another production shutdown change. The TCP
half-close contract alone does not establish the Windows failure's cause.

## Diagnosing the remaining HTTP socket

The server observer assigns a stable `socketId` when TCP is accepted. IDs are
local to the server process; correlate them with the event's `pid`. It retains
the accepted timestamp and local/remote ports, HTTP request count and active
response state, upgrade outcome and WebSocket state. Routes use fixed labels;
queries, arbitrary paths, headers, bodies, WebSocket payloads and error messages
are excluded.

`shutdown.http.inventory` includes `socketDetails` at `shutdown-start`,
`http-close-start`, `http-close-callback` and the production `deadline`.
During shutdown, `shutdown.socket.event` records accepted/request/upgrade,
response finish/close, TCP end/finish/close/error and WebSocket close/error.
Each open TCP connection retains at most 16 recent events; closed connections
are removed from the active inventory. The observer adds no timers, data
readers, end/destroy calls or ordinary error handlers. `errorMonitor` observes
an error without changing whether it is handled.

An HTTP close callback can run before the socket observer's close listeners.
Rows with `destroyed:true` can therefore briefly remain in its callback inventory;
use the later TCP close events and deadline snapshot rather than row count alone.

Start with the deadline's remaining socket ID, then trace that same ID in the
earlier inventory and shutdown events:

- `http-server-unclassified`, zero HTTP requests and no upgrade: TCP was
  accepted but no parsed HTTP request or upgrade was observed. `bytesRead`
  distinguishes no received bytes from received bytes that did not produce a
  request. This is not proof of a browser preconnect or TCP half-close.
- `http-server`: inspect active requests, request completion and response
  headers/writable-ended/writable-finished state. A finished keep-alive response
  and an unfinished response must remain distinguishable.
- `http-upgrade`: inspect PENDING/REJECTED and the controlled rejection status.
- `extension-websocket`: inspect ACCEPTED, the WebSocket state and the raw TCP
  close event. A WebSocket callback alone is not proof of all TCP closure.

`shutdown.websocket.close.callback` and `shutdown.http.close.callback` retain
only a sanitized callback error code. The instrumentation preserves existing
callback success/failure policy; observing an error does not convert it into
a new shutdown outcome. In particular, the current WebSocket close wrapper's
fulfilled promise must not be treated as proof of a null callback error.

The existing five-second production failsafe, process result oracle and UF
cleanup ordering are unchanged. After collecting actual Windows UF-04 evidence,
reduce the observed remaining-socket path to its own lifecycle contract before
changing ownership or termination policy.

## Observed unrequested TCP failure

The supplied Windows UF-04 diagnostic log leaves one accepted connection with
zero requests, no upgrade, and zero bytes read or written at the deadline.
Only `HTTP server close` remains pending. Holding the same kind of real TCP
connection open reproduces the five-second production exit-1 failure on Linux
Node 24.19.0. This is a shared HTTP ownership defect; the log does not identify
the client as Chromium or establish the same cause for every other UF.

The HTTP server tracks unrequested connections independently of diagnostics.
After stopping acceptance, it destroys only unrequested connections whose
`bytesRead` is zero. Received partial headers and parsed HTTP requests retain
the existing drain policy; upgraded sockets retain their protocol owner.
The production deadline and failure oracle are unchanged. Windows execution
of this correction remains required before claiming the Windows UF is fixed.
