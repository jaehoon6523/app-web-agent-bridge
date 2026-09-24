# Architecture Reduction Pass

This pass is ordered to reduce ambiguity before moving files.

## Phase 1: establish ownership

- [x] Review `docs/CANONICAL_OWNERSHIP.md` against the current owners below.
- [x] Confirm that run phase legality has exactly one definition: `src/domain/run-state-machine.js` owns `ALLOWED_RUN_TRANSITIONS` and `canTransitionRunState`.
- [x] Confirm that session binding equality has exactly one canonical predicate/API: `src/domain/agent-attribution.js` owns `matchesSessionBinding`; orchestration and persistence both use its `versionOffset` for submitted turns.
- [ ] Confirm that delivery durable state changes use one persistence primitive.
- [ ] Confirm that terminal response uniqueness is protected by persistence, not only orchestration checks.

| Responsibility | Current owner | Other boundary checking the rule | Decision |
|---|---|---|---|
| Run phase legality | `src/domain/run-state-machine.js` | orchestration requests and store writes | Keep one transition table; leave request preconditions with callers. |
| Session binding equality | `src/domain/agent-attribution.js` | `discussion-session-binding.js`, `turn-submission-links.js` | Use one predicate with `versionOffset: 1` for the running session. |
| Delivery claim and transition | `src/persistence/sqlite-store.js` | `claimNextDelivery` and `transitionDelivery` | Inspect both SQL updates and retry limits before merging any mutation path. |
| Terminal response uniqueness | `agent_messages.input_id` is unique; packet rejection is stored separately | response context and packet rejection integrity checks | Verify cross-table exclusivity before claiming a persistence constraint. |

This pass applies the repository's single-owner rule while evaluating the Forge/OpenBrowser/Kelruno reference patterns; it does not import their code or certify a live provider.

## Phase 2: measure before refactoring

Run:

```powershell
node scripts/architecture-audit.mjs
```

Inspect:

```text
.agent-controller/architecture-audit/
  architecture-audit.md
  architecture-audit.json
  import-graph.dot
```

The report covers:

- import cycles,
- complexity hotspots,
- spread of recurring invariants,
- duplicate normalized assertions across test files.

The report is heuristic. It must not be used to delete tests or collapse modules automatically.

## Phase 3: reduction targets

Review in this order:

1. `src/orchestration/discussion-controller.js`
2. `src/orchestration/preparation-service.js`
3. `src/persistence/sqlite-store.js`
4. `src/runtime/codex/session-adapter.js`
5. `src/runtime/web/session-adapter.js`

For each target, produce a table:

| responsibility | current owner | other files checking same rule | keep / move / delete |
|---|---|---|---|

No new helper/module should be introduced until at least one existing responsibility is removed from the hotspot.

## Phase 4: tests

Do not optimize by raw test count.

Classify duplicate-looking tests as:

- same invariant, same boundary, same failure mode → candidate merge,
- same invariant, different boundary → keep,
- same behavior, different fixture only → candidate parameterization,
- fixture-only success that claims real provider behavior → rename/re-scope,
- regression reproducing a historical P0/P1 → keep unless covered by a stronger equivalent.

## Exit criteria

This pass is complete when:

- canonical ownership is documented and matches code,
- no unexplained multi-owner state mutation remains,
- import cycles are zero or explicitly justified,
- hotspot responsibilities are reduced rather than merely redistributed,
- duplicate invariant checks are either centralized or documented as boundary defenses,
- duplicate tests are classified before any deletion.
