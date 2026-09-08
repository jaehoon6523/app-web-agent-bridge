# Capability model

Implementation, judgment, enforcement, and target mutation are separate authorities.

| Capability | Codex worker | ChatGPT reviewer | Controller | Local operator |
|---|---:|---:|---:|---:|
| Read frozen requirements | yes | yes | yes | yes |
| Read candidate code | yes | yes | yes | yes |
| Modify candidate worktree | yes | no | no | operator action only |
| Request registered verification | no | yes | executes | yes |
| Execute registered verification | no | no | yes | through controller |
| Create requirement assessment | claim only | yes | validates | no |
| Create or resolve finding | response only | proposes | enforces lifecycle | no direct bypass |
| Stop a run | no | no | yes | authenticated request |
| Reconcile recovery state | no | no | yes, read-only | authenticated request |
| Abandon recovery-required run | no | no | validates | attests and requests |
| Apply accepted candidate | no | no | yes | authenticated request |

Stable controller capabilities include:

- `state.get`
- `evidence.export`
- `evidence.get`
- `run.start`
- `run.stop`
- `run.reconcile`
- `run.abandon`
- `code.apply`

The following invariant must remain true:

```text
worker claim
  != captured candidate
  != verification execution
  != result artifact
  != reviewer assessment
  != controller PASS
  != target application
```
