# Session-state driven operation

The controller does not expose QUICK, STANDARD, STRICT, or RELEASE modes.
The current run state determines which actions and checks are available.

Acceptance criteria never change because of a user-selected mode.

## State-driven behavior

Examples:

- `CREATED` / `PROVISIONING`: bind the configured Codex and ChatGPT session.
- `WORKER_RUNNING`: only the worker may modify the candidate worktree.
- `VERIFYING`: only registered verification commands may execute.
- `REVIEW_RUNNING`: the bound ChatGPT Web session evaluates the frozen candidate and evidence.
- `EVIDENCE_SUPPLEMENT`: the controller serves bounded code/evidence requests or runs registered verification.
- `REWORK`: unresolved findings return to the Codex worker.
- `HOLD`: no automatic continuation; missing information or operator decision is required.
- `RECOVERY_REQUIRED`: no automatic resend, rerun, or apply is allowed.
- `AWAITING_APPLY`: only the exact accepted candidate can be applied.
- `APPLYING`: no competing mutation is allowed.
- `APPLIED`: the controller records the application result but does not commit, push, or deploy.

The UI is a projection of these states. It must not invent a separate operational mode.

## Additional review

Additional review should be triggered by state and evidence, not by a user-selected mode.

Examples that may justify another review of the same candidate:

- supplemental evidence was added after an earlier assessment;
- a required finding changed from `FIX_SUBMITTED` to a state requiring revalidation;
- the reviewer returned `UNDETERMINED`;
- evidence provenance changed;
- recovery reconciliation shows the previous review context is stale.

A second pass in the same ChatGPT conversation is a redundant review, not an independent review.

## New reviewer session

The browser extension may eventually support opening a new ChatGPT conversation automatically.
That operation must be treated as provisioning, not as evidence by itself.

To call the resulting review independent, the controller must establish at minimum:

1. a different conversation identifier;
2. an exact new tab/conversation binding;
3. no inherited controller message history supplied as reviewer conclusions;
4. a fresh audit prompt containing only the frozen requirements, candidate, evidence, and allowed prior facts;
5. response binding to the new conversation and requested turn;
6. persistent provenance showing which conversation produced which review.

If any of these cannot be established, the review must be labelled `REDUNDANT_SAME_SESSION`
or `REVIEW_PROVENANCE_UNCERTAIN`, never `INDEPENDENT`.

Automatic creation must also fail closed when:

- ChatGPT authentication is missing;
- multiple candidate tabs are ambiguous;
- the new-conversation UI contract changed;
- the extension cannot confirm the created conversation URL;
- the controller cannot bind the returned response to the created conversation.

No automatic session creation is required for normal code-change completion.
