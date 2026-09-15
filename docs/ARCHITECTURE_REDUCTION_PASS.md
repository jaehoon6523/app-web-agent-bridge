# Architecture Reduction Pass

This pass is ordered to reduce ambiguity before moving files.

## Phase 1: establish ownership

- [ ] Review `docs/CANONICAL_OWNERSHIP.md`.
- [ ] Confirm that run phase legality has exactly one definition.
- [ ] Confirm that session binding equality has exactly one canonical predicate/API.
- [ ] Confirm that delivery durable state changes use one persistence primitive.
- [ ] Confirm that terminal response uniqueness is protected by persistence, not only orchestration checks.

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
