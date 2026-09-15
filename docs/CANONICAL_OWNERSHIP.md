# Canonical Ownership Map

Status: first-pass authority map for `app-web-agent-bridge`.

This document is intentionally conservative. It distinguishes **confirmed implementation ownership**
from **target ownership**. A file name, test, or existing helper is not treated as authority by itself.

## Canonical chain

```text
Run
 └─ Session
     └─ TurnInput / Turn
         └─ Delivery
             └─ Response
```

The chain above is an attribution chain, not a blanket persistence hierarchy. Each edge must be
validated using stable IDs and versioned state where applicable.

## Ownership table

| Concern | Canonical owner | Current orchestration owner | Notes |
|---|---|---|---|
| Run phase legality | `src/domain/run-state-machine.js` | callers in orchestration | `ALLOWED_RUN_TRANSITIONS`, phase invariants, optimistic run version checks belong here. Callers must not invent alternate transition legality. |
| Run durable transition | persistence event/projection transaction | `DiscussionController.#appendTransition()` and store transaction | Domain decides whether a transition is legal; orchestration decides when it happens; persistence makes it durable. |
| Session ↔ runtime binding | `src/orchestration/discussion-session-binding.js` | `DiscussionController` / dispatcher call sites | Exact `sessionId`, version, external session identity and active turn attribution are checked here. |
| Turn input construction | `src/orchestration/discussion-turns.js` | `DiscussionController` | Initial, peer relay and protocol-repair turn inputs are materialized here. |
| Delivery claim / submit / completion | store delivery transition API | `DiscussionController.claimNext()`, `markSubmitted()`, `markResponseStarted()`, response record methods | Delivery state mutation should have one durable transition primitive. Orchestration methods should not duplicate persistence rules. |
| Runtime dispatch | `src/orchestration/discussion-dispatcher.js` | `DiscussionOutboxDispatcher` | Owns side-effect scheduling and runtime event waiting, but not durable state legality. |
| Response attribution | session + delivery + turn binding checks | `DiscussionController.recordValidResponse()` / `recordInvalidResponse()` | A response is valid only after run, delivery, session and turn bindings all agree. |
| Response semantic decision | `src/orchestration/discussion-response.js` and protocol policy | response record methods | Semantic interpretation and persistence should remain separable. |

## Required single-owner rules

1. **Run transition legality**
   - Only `run-state-machine.js` may define whether phase A may transition to phase B.
   - Orchestration may add preconditions, but must not maintain a competing transition table.

2. **Session binding equality**
   - Exact runtime session attribution must resolve through one binding predicate/API.
   - Duplicate ad-hoc comparisons of `sessionId`, `externalSessionId`, locator and version are candidates for consolidation.

3. **Delivery state mutation**
   - All durable delivery state changes must pass through one store transition primitive.
   - No direct SQL update of delivery state outside that primitive.

4. **Turn attribution**
   - `activeTurnId`, provider/external turn ID and delivery/input IDs must be checked as one attribution unit before accepting a response.

5. **Terminal response**
   - A turn input may have exactly one terminal response outcome: valid message or recorded rejection.
   - The uniqueness rule should be enforced at persistence level where possible, with orchestration checks as diagnostics rather than the sole guard.

## First-pass hotspots

These are review targets, not automatic refactor instructions.

- `src/orchestration/preparation-service.js`
- `src/orchestration/discussion-controller.js`
- `src/runtime/codex/session-adapter.js`
- `src/runtime/web/session-adapter.js`
- `src/persistence/sqlite-store.js`
- `src/server.js`
- `public/app.js`
- `extension/background.js`
- `extension/content.js`

Before splitting any hotspot, first identify:
- duplicated invariant checks,
- repeated transaction choreography,
- repeated ID/version binding logic,
- code that can be deleted because a lower-level owner already guarantees the condition.

## Refactor gate

A refactor is accepted only when at least one of these decreases without weakening evidence:

- number of files that define the same invariant,
- number of state mutation entry points,
- number of modules touched for one state transition,
- number of duplicate test behaviors,
- total branch count / responsibility count in a hotspot.

Moving code into another file without reducing one of those is not an architecture improvement.
