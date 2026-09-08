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
