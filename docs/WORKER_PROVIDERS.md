# Worker providers and telemetry

Exactly one implementation worker is active at a time in a code-change run.
Each implementation iteration creates and closes its own worker. Codex iterations
start fresh threads; they reuse the run's isolated Git worktree so rework can amend
the preceding candidate. Adapter-level exact-thread resume is not permission for
the CODE_CHANGE controller to restart an interrupted iteration automatically.
The controller does not launch Codex, DeepSeek, Claude, Qwen, and Gemini in parallel.

Supported provider identifiers:

- `codex`
- `deepseek`
- `claude`
- `qwen`
- `gemini`

Codex uses the existing native app-server adapter.
The implementation is in `src/runtime/codex/` and the capture wrapper is
`src/runtime/code-change-worker.js`. Worker/reviewer instructions and the worker
output schema are in `src/orchestration/code-change-prompts.js`; audit validation
remains in `src/domain/code-review.js`. The reviewer does not receive a worker's
conversation history, and worker claims cannot substitute for captured evidence.
The other providers use a version-neutral JSONL adapter so the controller does not depend
on unstable vendor-specific CLI flags. `CODE_WORKER_EXECUTABLE` may point to the vendor CLI
through a small shim that translates the following protocol.

## Input

One JSON object per line:

```json
{
  "type": "turn",
  "provider": "qwen",
  "model": "example-model",
  "sessionId": "qwen_...",
  "turnId": "turn_...",
  "workspaceRoot": "C:\\repo-worktree",
  "text": "controller prompt",
  "outputSchema": {}
}
```

## Completion

```json
{
  "type": "completion",
  "sessionId": "qwen_...",
  "turnId": "turn_...",
  "status": "completed",
  "model": "example-model",
  "text": "{\"summary\":\"...\"}",
  "usage": {
    "inputTokens": 1000,
    "outputTokens": 500
  }
}
```

The worker is allowed to edit only the controller-created worktree. The controller still
captures the Git candidate itself after the worker reports completion.

## Persisted telemetry

Every worker turn records:

- provider;
- model;
- provider session/thread ID;
- controller turn ID;
- started timestamp;
- finished timestamp;
- elapsed milliseconds;
- redacted input artifact reference;
- redacted output artifact reference;
- completion/failure status;
- token/usage metadata when the provider reports it;
- provider metadata when available.

The run also retains the existing controller messages, candidate captures, verification
evidence, review reports, findings, and application result. Together these provide the full
auditable conversation/work history without treating model output as proof.

## Historical performance

Provider performance is calculated from completed historical runs, not by racing providers
on the same task.

Useful statistics include:

- number of runs;
- PASS count and PASS rate;
- APPLIED count;
- average iterations before PASS;
- average worker-turn duration;
- verification pass rate;
- average required findings created;
- HOLD / INCONCLUSIVE / RECOVERY_REQUIRED rate;
- token usage when reported.

These statistics describe historical outcomes. They do not change requirement acceptance
or automatically select a winner.
