# Recovery reconciliation

`run.reconcile` is read-only. It observes persistent and local repository state and returns:

- `CONSISTENT`
- `RECOVERABLE`
- `RECOVERY_REQUIRED`
- `ORPHANED`

It never:

- resumes a provider turn;
- reruns verification;
- reapplies a patch;
- changes a run stage;
- deletes evidence.

Observed sources include:

- target HEAD and porcelain status;
- registered worktree presence;
- local controller job/worker presence;
- target application state when a capture exists.

Provider termination remains unknown unless separately confirmed. Therefore a
`RECOVERY_REQUIRED` run still needs operator inspection before `run.abandon`.

## Preparation blocked by an earlier Web delivery

Preparation retains the extension error code and delivery details: run/session/delivery
identifiers, exact conversation URL, tab identity, page reachability, tracked work, and
observed generation status. Missing observations remain unknown. A stored delivery ID
alone does not establish that a message was sent or its response completed.

The preparation UI provides inspection, targeted generation interruption, and delivery
cleanup followed by a new preparation request. Interruption requires the content script
to identify the same active request in the same conversation. Success requires a fresh
observation that both the content task and generation have stopped. Untracked generation
must be inspected in the linked conversation; it cannot be cancelled by guessing a target.

Cleanup requires the exact persisted delivery and an idle, reachable conversation.
It retires the delivery reservation, not the conversation or run evidence. It never treats
the previous output as approved. Known terminal runs may have idle reservations retired
during a new preparation request; other reservations require the explicit UI cleanup action.
An active controller run must be stopped before these preparation recovery mutations.
Old extensions without the new observations fail closed and must be reloaded, along with
the ChatGPT tab. The server must also run the updated protocol handlers.
