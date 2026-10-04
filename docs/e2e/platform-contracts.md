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
resource closed cooperatively. Production may terminate an owned upgraded
WebSocket during bounded shutdown. A production failsafe can also exit with
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
