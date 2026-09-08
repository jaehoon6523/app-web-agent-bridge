# Worker providers and telemetry

Exactly one implementation worker is attached to a code-change run.
The controller does not launch Codex, DeepSeek, Claude, Qwen, and Gemini in parallel.

Supported provider identifiers:

- `codex`
- `deepseek`
- `claude`
- `qwen`
- `gemini`

Codex uses the existing native app-server adapter.
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
