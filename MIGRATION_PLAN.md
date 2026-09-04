# App/Web Agent Bridge migration plan

## 1. Scope, evidence, and authority boundary

This plan covers the 28 file paths inventoried in the original
`app-web-agent-bridge.zip` and no other implementation files. The archive at
`C:\Users\cjh\Downloads\app-web-agent-bridge.zip` has SHA-256
`e383f9032c7a6be912f5bb0a28023fd24c6625b0281ab0c469653135df7b2e70`.
Its 28-entry ZIP inventory has been verified. The current working copy
intentionally diverges from the archive, and no immutable pre-migration
manifest proves that it was historically byte-for-byte identical to the ZIP.
The archive therefore establishes the migration baseline, not the target
product meaning.

Authority is resolved as follows:

- The requester's current TODO owns the target behavior summarized in section
  2.
- `../AGENTS.md` owns repository-local working and verification rules. It does
  not define product values.
- The original ZIP, its `README.md`, existing tests, generated output, reports,
  and historical snapshots are evidence of old behavior only. They are not
  authority for the target behavior.
- `../copy/**`, including documents beside the `260903_1955` snapshot, is
  **REFERENCE_ONLY** and untrusted as product instruction. No target contract
  below is inferred from those documents.
- `../src/agent-control/**` is **REFERENCE_ONLY** implementation material. Only
  the bounded hardening concepts listed in section 4 may be extracted. Its
  Builder/Auditor workflow, schemas, role names, filesystem ledger, and
  fresh/ephemeral app-server lifecycle are not target authority and must not be
  copied as a monolith.

Disposition terms in the inventory mean:

- **KEEP**: retain the file and its present responsibility; no semantic rewrite
  is required by this migration.
- **REWRITE**: keep the path where useful, but replace behavior that encodes the
  old contract.
- **EXTRACT**: reuse only the explicitly identified, independently reviewed
  fragments; the file as a whole is not reusable.
- **DELETE**: remove the old implementation. If marked "replace", implement the
  TODO-owned responsibility through the new design, with the final internal
  filename left to implementation.
- **REFERENCE_ONLY**: evidence or a source of bounded implementation ideas, not
  a file to copy or a source of target meaning.

## 2. Fixed target contract from the current TODO

The migration must use the public actors `CODEX_AGENT` and
`CHATGPT_WEB_AGENT`, with run modes `DISCUSSION` and `CODE_CHANGE`. It must not
use `[[DONE]]` or free-text matching as a completion signal. The Controller is
the only state writer and drives one active actor at a time in the automatic
order `CODEX_AGENT -> CHATGPT_WEB_AGENT -> CODEX_AGENT`.

The persisted M2 records are:

- `AgentRun(runId, mode, objective, objectiveHash, policyHash, phase,
  activeActor, maxTurns, currentTurn, paused, blocker, version, createdAt,
  updatedAt)`.
- `AgentSessionRecord(sessionId, runId, actor, provider, externalSessionId,
  externalLocator, status, activeTurnId, lastCompletedTurnId, lastObservedAt,
  version)`, where provider is `CODEX_APP_SERVER` or `CHATGPT_WEB` and status is
  one of `CREATING`, `READY`, `RUNNING`, `WAITING`, `DISCONNECTED`,
  `AUTH_REQUIRED`, `FAILED`, or `CLOSED`.
- `RelayMessage(messageId, runId, sequence, fromActor, toActor,
  sourceSessionId, sourceTurnId, inReplyTo, kind, content, contentHash,
  normalizedPacket, objectiveHash, policyHash, createdAt)`, where kind is one
  of `INITIAL_OBJECTIVE`, `PROPOSAL`, `CRITIQUE`, `REVISION`, `ACCEPTANCE`,
  `BLOCKER`, or `PROTOCOL_REPAIR`.

Agent output is accepted only as a strict schema with
`additionalProperties: false`:

- `PROPOSAL {type:'PROPOSAL', proposal_id, proposal_sha256, summary, body,
  assumptions:[], open_decisions:[]}`
- `CRITIQUE {type:'CRITIQUE', target_proposal_sha256,
  blocking_findings:[], non_blocking_findings:[], requested_changes:[]}`
- `ACCEPT {type:'ACCEPT', accepted_proposal_sha256, blocking_findings:[]}`
- `BLOCKED {type:'BLOCKED', reason_code:'PRODUCT_DECISION_REQUIRED',
  description, required_decisions:[]}`

`ProtocolErrorPacket` is named by the TODO, but its fields are not specified:
**UNRESOLVED — requires authority before implementation**. It must not be
invented from the old relay protocol.

Canonical JSON plus SHA-256 binding applies to the objective, policy, content,
proposal, packet, event, and `CODE_CHANGE` candidate manifest. JSON object keys
are sorted before UTF-8 serialization, as required by the current TODO. Numeric
normalization beyond JSON's own finite-number representation remains an internal
implementation constraint and must not be promoted into a new wire contract.

The M3 phases are exactly `CREATED`, `STARTING_SESSIONS`,
`CODEX_TURN_PENDING`, `CODEX_TURN_RUNNING`, `CODEX_RESPONSE_STORED`,
`CODEX_TO_WEB_PENDING`, `WEB_TURN_RUNNING`, `WEB_RESPONSE_STORED`,
`WEB_TO_CODEX_PENDING`, `CONSENSUS_CHECK`, `HUMAN_GATE`,
`RECOVERY_REQUIRED`, `COMPLETE`, `FAILED`, and `CANCELLED`.

Blockers are exactly `RUNTIME_APPROVAL{approvalId}`,
`USER_DECISION{decisionIds}`, `SESSION_AUTH{actor}`, and
`RECOVERY_CONFIRMATION{operationId}`. Consensus is checked after each completed
response. Reaching `maxTurns` produces `INCONCLUSIVE`. A pause requested while
pending prevents the next delivery; a pause requested while an actor is
running allows that response to complete and then prevents the next delivery.
Interrupt is a separate operation. Bounded limits are `maxTurns`,
`maxProtocolRepairs`, `maxDeliveryAttempts`, and
`maxConsecutiveActorFailures`.

The M4 SQLite store contains `runs`, `agent_sessions`, `relay_messages`,
`delivery_attempts`, `agent_packets`, `domain_events`, `approvals`,
`run_projections`, and `recovery_operations`. Its event chain is
`SHA256(previous_event_hash + canonical_event_json)`. Event and projection
updates are one transaction; relay-message and outbox creation are one
transaction. Delivery states are exactly `PENDING`, `DISPATCHING`, `SUBMITTED`,
`RESPONSE_STARTED`, `RESPONSE_COMPLETED`, `RELAYED`, `FAILED`, and `AMBIGUOUS`.
A crash after `SUBMITTED` must not cause an immediate retry. Projection rebuild
is required.

The Codex thread and exact ChatGPT conversation binding must survive Controller
restart and be resumed or recovered fail-closed. Extension authentication uses
HMAC. ChatGPT DOM access uses a selector registry rather than selectors embedded
as an implicit contract in one content script. The dashboard retains two
supervision panes.

SQLite DDL, transaction mechanics, one-time nonce storage and exact URL parsing
are private implementation choices as long as they preserve this contract and
do not create fallback behavior. They are not new product authority. By
contrast, the undefined `ProtocolErrorPacket` shape and the cross-contract
meanings below are observable protocol decisions and remain unresolved.

Two cross-contract gaps block a fully automatic relay but do not block the
independent infrastructure work:

- `RelayMessage.fromActor` only permits the two Agent actors, while
  `INITIAL_OBJECTIVE` originates with the user/Controller. Assigning that
  message to either Agent would falsify provenance. The owner must either add a
  non-Agent source, make the initial source representable separately, or state
  that the initial objective is not a `RelayMessage`.
- A `PROPOSAL` packet has `summary`, `body`, `assumptions`, and
  `open_decisions`, while `ProposalArtifact` has `title`, `body`,
  `assumptions`, and `decisions`. No current rule maps `summary` to `title` or
  `open_decisions` to `decisions`, and the latter are not semantically
  interchangeable. The Controller must not fabricate a ProposalArtifact from
  that packet until the projection owner is fixed.

## 3. Complete 28-file disposition

### Repository and launch files (8)

| Existing file | Disposition | Concrete reason and migration boundary |
|---|---|---|
| `.env.example` | **REWRITE** | It currently owns `EXTENSION_TOKEN`, `LOG_DIR`, `DEMO_MODE`, and `APP_*` timeout naming. Replace the example with configuration required by HMAC auth, SQLite persistence, persistent session recovery, and TODO-owned limits. Exact new variable names are unresolved; do not invent them in advance. |
| `.gitignore` | **REWRITE** | It ignores `data/*.jsonl`, which belongs to the deleted JSONL ledger. It must cover the selected SQLite database and its runtime sidecars plus local secrets after their exact configured paths are decided. |
| `LICENSE` | **KEEP** | The MIT license is independent of actor names, state, persistence, transport, and UI behavior. |
| `package.json` | **REWRITE** | The description and scripts encode the old App/Web relay and demo. The dependency/runtime declaration must support the selected SQLite implementation and new verification entry points. The SQLite library and any Node engine change are unresolved implementation choices. |
| `README.md` | **REWRITE** | It documents `APP_AGENT`/`WEB_AGENT`, `[[DONE]]`, JSONL, new/opportunistically reused tabs, and an acknowledged lack of thread resume. The separate query-token behavior is evidenced by the old implementation code, not the README. Those documented claims directly conflict with the TODO. Treat the current text only as evidence of the old system. |
| `start-demo.cmd` | **DELETE** | It enables fake agents whose responses synthesize `[[DONE]]` and fabricated sessions. Keeping it would provide a path that appears successful without the required persistent providers, strict packets, authenticated binding, or recovery semantics. |
| `start-live.cmd` | **KEEP** | It only invokes `node src/server.js`; that remains a valid thin Windows launcher while `src/server.js` is rewritten in place. |
| `data/.gitkeep` | **KEEP** | The empty placeholder carries no old semantics and preserves a local data directory suitable for the TODO-required SQLite store. It does not choose the database filename. |

### Chrome extension (6)

| Existing file | Disposition | Concrete reason and migration boundary |
|---|---|---|
| `extension/manifest.json` | **REWRITE** | The MV3 service-worker/content-script shape and ChatGPT host scope are useful, but the product name/description describes the old bridge. Revalidate the minimum permissions and CSP against the HMAC channel and exact-conversation design; add no permission without a demonstrated need. |
| `extension/background.js` | **REWRITE** | It puts a reusable token in the WebSocket query, keeps `selectedTabId` only in memory, falls back after loss to an active ChatGPT tab or the final `tabs.query` result without a recency sort, and can silently create a different conversation. Replace it with authenticated message handling and persisted, exact `externalSessionId`/`externalLocator` binding that rejects ambiguity. Its in-memory `busy` and request flow cannot be the delivery/outbox authority. |
| `extension/content.js` | **REWRITE** | Selectors are hard-coded locally, and response completion is inferred from a stop button disappearing plus 2.5 seconds of stable text. Replace this with the TODO-required selector registry, explicit observation evidence, exact conversation/turn correlation, and fail-closed ambiguity handling. Browser DOM remains an unreliable observation surface, never the Controller's state authority. |
| `extension/popup.html` | **REWRITE** | The UI asks for an "Extension token" and shows no exact bound conversation or recovery/auth state. Update it to the HMAC configuration and binding status once those unresolved protocol details are authorized. |
| `extension/popup.js` | **REWRITE** | It stores/returns `controllerToken` and reports only an in-memory tab id. Its commands and rendering must follow the authenticated extension state and persistent conversation binding, without making the popup a writer of run state. |
| `extension/popup.css` | **KEEP** | The styling is generic to popup layout, badges, inputs, and buttons; it contains no old actor, completion, persistence, or protocol semantics. New semantic states may receive additive classes later. |

### Dashboard (3)

| Existing file | Disposition | Concrete reason and migration boundary |
|---|---|---|
| `public/index.html` | **REWRITE** | It already has two panes, but exposes `APP_AGENT`/`WEB_AGENT`, a `stopOnDone` checkbox, free-form role instructions, old reset commands, and no mode, packet, blocker, persisted-session, delivery, or recovery presentation. Preserve the two-pane intent while binding controls only to TODO-owned actions and states. |
| `public/app.js` | **REWRITE** | It renders the old in-memory snapshot (`agents.app/web`, messages, approvals), uses old commands, and treats WebSocket push state as sufficient. Rebuild it as a read/projection consumer plus command client for version-checked Controller operations; it must never become another state writer. |
| `public/styles.css` | **EXTRACT** | Reuse only generic color tokens, panel primitives, accessible badges, and the two-column grid. The file also encodes `data-agent="app"`, `--app`/`--web`, old run-state classes, and old panel structure, so it cannot be retained wholesale. |

### Controller and provider adapters (8)

| Existing file | Disposition | Concrete reason and migration boundary |
|---|---|---|
| `src/orchestrator.js` | **REWRITE** | It is an in-memory alternating loop with actors `app`/`web`, arbitrary role instructions, a regex `[[DONE]]` stop, and no M2 records, exact M3 phases, strict packets, hash-bound consensus, transactional outbox, version checks, or crash recovery. Replace it with the single-writer deterministic Controller state machine. |
| `src/codex-app-server.js` | **EXTRACT** | Reuse only reviewed JSONL/JSON-RPC framing, request correlation, initialization, delta/final-answer observation, interrupt, and approval-adapter ideas. The current code launches an unpinned command through `shell: true`, inherits all of `process.env`, keeps the thread id only in memory, clears it on failure/close, and lacks a persisted thread-resume lifecycle; those parts must be replaced for persistent `CODEX_AGENT` identity and recovery. |
| `src/web-agent-gateway.js` | **REWRITE** | Its pending-request map and session snapshot are volatile, it trusts a socket after query-token upgrade, and it resolves any correlated `web.prompt.result` without persisted delivery state, exact conversation binding, packet validation, or recovery rules. Rebuild it as a transport adapter beneath Controller-owned session/outbox state. |
| `src/event-store.js` | **DELETE (replace)** | The JSONL appender has only a process-local sequence/write chain, ignores every malformed JSON line rather than only a truncated final line, and has no tables, transactions, projections, outbox, hash chain, version checks, or crash classification. Replace the responsibility with the M4 SQLite store; do not wrap or dual-write the JSONL format as a fallback. |
| `src/server.js` | **REWRITE** | It constructs all state in memory, accepts dashboard mutations without expected-version binding, authenticates the extension with a URL query token, and routes old commands directly to the old orchestrator. Rebuild composition and routes around one Controller writer, SQLite recovery, HMAC extension authentication, projection reads, and the TODO's distinct pause/interrupt behavior. |
| `src/config.js` | **REWRITE** | It defaults to an example token, exposes `dangerFullAccess`, carries demo/JSONL configuration, accepts an executable name rather than a pinned identity, and has only a single max-turn setting. Replace validation with target persistence/auth/session/limit configuration while leaving unspecified field names unresolved. |
| `src/demo-agents.js` | **DELETE** | It fabricates session ids, always reports connected, parses old actor names, and emits `[[DONE]]`. It would bypass strict provider identity, packet validation, persistence, and recovery, so it must not remain as a success path. |
| `src/utils.js` | **EXTRACT** | `deferred`, bounded timeout cleanup, string/integer validation, safe error projection, timestamps, and cryptographically random ids are separable helpers. Do not carry `redactToken` forward as the HMAC design, and do not let generic helpers define canonical JSON or hash semantics without the TODO-owned contract. |

### Existing tests (3)

| Existing file | Disposition | Concrete reason and migration boundary |
|---|---|---|
| `tests/orchestrator.test.js` | **REWRITE** | It asserts `APP -> WEB -> APP`, exact free-text relay, JSONL writes, and `[[DONE]]` termination. Replace those obsolete assertions with the exact M2/M3 state machine, one-active-actor rule, strict packets/consensus, pause versus interrupt, limits, `INCONCLUSIVE`, transactional outbox, and recovery boundaries. |
| `tests/codex-app-server.test.js` | **REWRITE** | Its two tests cover only final-answer selection and a workspace-write object. They do not distinguish `thread/start` from persistent `thread/resume`, verify external session identity, executable/env hardening, receipts, restart recovery, or mismatched notifications. |
| `tests/web-agent-gateway.test.js` | **REWRITE** | Its fake socket accepts a tab id and URL and proves only request-id correlation. Replace it with coverage that distinguishes exact conversation binding, HMAC tamper/replay failures once specified, disconnect/reconnect, delivery states, ambiguous post-`SUBMITTED` recovery, selector-registry failure, and strict packet handoff. |

Inventory total: **28 files** = 4 KEEP + 18 REWRITE + 3 EXTRACT + 3
DELETE. `REFERENCE_ONLY` applies to the external archive/reference inputs described
in section 1, not to an original file that should ship unchanged.

Per `../AGENTS.md`, changing test cases, assertions, or acceptance scope requires
the requester to approve the proposed test changes first. The current request
explicitly includes the M16 test scope and therefore authorizes the listed
replacement and additional tests within that scope; it does not authorize an
unrelated acceptance expansion.

## 4. Selective extraction from `../src/agent-control`

Do not import `controller.mjs`, `codex-app-server-runner.mjs`,
`codex-exec-runner.mjs`, or `cli.mjs` wholesale. They are coupled to
Builder/Auditor roles, `agent-control-state-v7`/`agent-message-v7`, separate Git
clones, filesystem message files, human gates different from M3, and (for the
app-server runner) a fresh process with `ephemeral: true`. That lifecycle
directly conflicts with persistent Codex thread resume.

Extract only these concepts, adapting each to the TODO-owned model:

| Concept to extract | Observed reference behavior | Target use and exclusion |
|---|---|---|
| Executable pinning | Resolves an absolute real path, rejects forbidden-root overlap, verifies executable access and SHA-256 before spawn. | Apply at the Codex process boundary. Do not copy Builder/Auditor config shapes or assume the current pin field names are public contract. |
| Environment allowlist | Builds the app-server environment from an explicit key allowlist instead of forwarding all `process.env`. | Replace the original adapter's ambient environment inheritance. The final allowed set needs security review; do not copy provider credentials or repository-specific policy blindly. |
| Execution receipts | Hash-binds command/runtime identity, prompt/policy inputs, bounded outputs, exit/termination facts, and an immutable receipt. | Record evidence needed for `CODE_CHANGE` and recovery without turning the old receipt schema into a new external contract. Exact receipt schema is unresolved. |
| Interrupted-execution marker | Leaves a marker when an agent process may have been interrupted and requires verified process-tree termination before recovery acknowledgement. | Map the safety property to `RECOVERY_REQUIRED`, `RECOVERY_CONFIRMATION{operationId}`, and `recovery_operations`. Do not copy its filesystem state machine or human-decision vocabulary. |
| Expected state/version | Rejects mutation when the expected last-message hash no longer matches current state. | Use the TODO's record `version` fields to reject stale Controller commands/observations. The wire field carrying an expected version remains unresolved. |
| Bounded iteration | Validates a positive maximum and stops retry cycles when the bound is reached. | Enforce the four TODO limits and `INCONCLUSIVE`; do not reuse the Builder/Auditor iteration meaning. |
| Git verifier | Pins Git, strips `GIT_*`, disables hooks/global/system config/lazy fetch/replace objects, checks repository topology/refs, and derives changed files from a base/candidate commit. | Reuse only reviewed verification functions for `CODE_CHANGE` evidence and candidate-manifest hashing. Do not copy worktree reservation, dual-clone ownership, branch naming, or acceptance semantics unless separately authorized. |
| Atomic/single-writer discipline | Uses an exclusive Controller lock, immutable history entries, hash linkage, and atomic state replacement. | Preserve the exclusivity and stale-write safety properties, but implement authoritative state in the M4 SQLite transactions rather than duplicating its filesystem ledger. |

## 5. Implementation order and non-negotiable gates

1. Freeze unresolved observable contract choices before code that would expose
   them: `ProtocolErrorPacket`, initial-objective provenance, Proposal packet to
   Proposal artifact projection, proposal hash scope, and non-empty
   finding/decision item shapes. No old fallback is allowed.
2. Replace persistence first: SQLite migrations, canonical hashing, transactional
   event/projection writes, relay/outbox atomicity, delivery-state recovery, and
   projection rebuild.
3. Implement the single-writer M2/M3 Controller against that store, including
   validated packets, consensus checks, limits, pause semantics, separate
   interrupt, blockers, and stale-version rejection.
4. Build the persistent Codex and ChatGPT provider adapters. Resume only the
   stored exact external identity; identity mismatch or post-`SUBMITTED`
   uncertainty enters the appropriate blocker/recovery path rather than retrying
   or silently creating a replacement conversation.
5. Add HMAC extension authentication and selector-registry-based DOM observation
   as bounded private transport mechanisms; any identity or recovery meaning
   visible outside the adapter still requires an owned contract.
6. Rebind the two-pane dashboard to read projections and issue Controller
   commands. It must not infer success from WebSocket connectivity, non-empty
   text, a URL, or a DOM-stability timeout.
7. Replace the three obsolete test suites with the requester-approved M16
   behavior, persistence/restart, negative-auth, ambiguity, and exact-state-
   transition coverage. A passing old six-test suite is not evidence that this
   migration works.

Completion requires executable evidence for the changed behavior: deterministic
state transitions, SQLite transaction/crash boundaries, hash-chain verification,
persistent Codex resume, exact ChatGPT conversation reconnection, HMAC rejection
cases, strict packet rejection, selector ambiguity, pause/interrupt behavior,
all four limits, `INCONCLUSIVE`, and browser interaction for both dashboard
panes. File existence, HTTP 2xx, a screenshot, or the old unit tests alone are
insufficient.
