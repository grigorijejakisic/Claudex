---
phase: 14-substrate-coherence
wave: 3
role: PM coordination doc — read by Wave 3 + Wave 4 /auto-orchestrate workers
created_by: PM (Claude Opus 4.7) on 2026-05-15
predecessors:
  - Wave 1 (14-01, 14-02, 14-08) — landed clean to master
  - Wave 2 (14-06) — in flight at time of writing
---

# Wave 3 + 4 Coordination Manifest

PM-level contract for the remaining v6.6.0 plans. Smaller wave than
Wave 1 (3 plans across 2 sub-waves) but with one cross-wave
dependency that demands sequencing.

## Workers + plans

| Worker | Plan | Wave | Branch | Sequence |
|---|---|---|---|---|
| E | 14-03 (`isSubstantive` predicate + experience-tier filter) | 3 | `phase-14/03-substantive-filter` | parallel start |
| F | 14-05 (Angel boundary detector as session-end owner) | 3 | `phase-14/05-boundary-detector` | parallel start |
| G | 14-04 (P2.7 Project Knowledge surface) | 4 | `phase-14/04-project-knowledge` | starts after Worker E lands (depends on `isSubstantive`) |

**PRECONDITION:** Wave 2 (Worker D / Plan 14-06) must have shipped to
master before Wave 3 launches. Worker D's epoch-ms sweep touches
`heartbeat.ts`, `assembler.ts`, `sections.ts` — all of which Wave 3
plans also touch. Running Wave 3 in parallel with Wave 2 risks
cross-cutting collisions on the same files.

## File ownership table

PM-authoritative. Every worker reads this before touching a file.

### Plan 14-03 owns
- `src/core/artifact-filters.ts` (NEW) — `isSubstantive()` predicate + `substantiveSqlClause()` helper
- `src/intelligence/experience-tier.ts` — `fetchCandidatePool` query rewrite to consume the SQL clause
- `src/angel/consolidator.ts` — replace any ad-hoc substantive filter with `isSubstantive()`
- `src/angel/retention-sweep.ts` — same
- `src/angel/lesson-writer.ts` — promotion path uses `isSubstantive()` if it currently has a substance check (audit during Task 1)
- `src/tests/core/artifact-filters.test.ts` (NEW)
- `src/tests/intelligence/experience-tier.test.ts` — extend existing
- `src/tests/angel/consolidator.test.ts` — extend if filter behavior change is observable
- `context/measurements/2026-05-15-cross-project-equivalence-hit-rate.md` — append a re-measurement section confirming noise rate < 20% (CONTEXT decision: AC-3 of plan 14-03)

### Plan 14-04 owns
- `src/assembly/project-knowledge.ts` (NEW) — `formatProjectKnowledgeSection(db, project, query, budget)`
- `src/assembly/sections.ts` — wire P2.7 export only (NO other functions touched)
- `src/assembly/assembler.ts` — P2.7 cascade wiring between P2.6 and P3
- `src/tests/assembly/project-knowledge.test.ts` (NEW)
- `src/tests/assembly/sections.test.ts` — minimal: only P2.7 surface contract
- `src/tests/assembly/assembler.test.ts` — extend cascade-order test for P2.7 placement

### Plan 14-05 owns
- `src/angel/boundary-detector.ts` — become single writer of `status='completed'`
- `src/angel/heartbeat.ts` — orchestrate the ordered downstream actions list
- `src/adapters/cc-hooks/stop.ts` — remove `UPDATE sessions SET status='completed'` if present (audit first)
- `src/core/sessions.ts` — remove any other callers that set `status='completed'` (audit first)
- `src/observability/telemetry.ts` — add `session_end_action` event_kind to enum
- `src/tests/angel/boundary-detector.test.ts` — extend with ordered-action coverage
- `src/tests/adapters/cc-hooks/stop.test.ts` — verify completed-write is gone
- `src/tests/angel/heartbeat.test.ts` — verify ordering invariants

## Cross-plan invariants

1. **`isSubstantive` API stability.** Worker E's predicate signature is the contract Worker G consumes. Once Worker E commits the API surface (Task 2 deliverable), it freezes. Worker G's plan SHOULD reference Worker E's exported types verbatim. PM enforces by reading both 14-03-SUMMARY and 14-04-PLAN at Wave 4 launch time.

2. **No epoch-shape regressions.** Wave 2 (Plan 14-06) renamed `*_epoch` → `*_epoch_ms` everywhere. Wave 3 workers MUST NOT re-introduce bare `*_epoch` field references. PM-level Grep audit at end of Wave 3.

3. **No `project_id` regressions.** Wave 1 (Plan 14-02) renamed `project_id` → `project` on V17. Wave 3 workers MUST NOT re-introduce `project_id`.

4. **No multi-agent ACTIVE.md regressions.** Wave 1 (Plan 14-08) made `renderSessionContinuity` enumerate `ACTIVE*.md` glob. Worker G's P2.7 surface reads ACTIVE.md (single — its summary is the implicit query); should NOT enumerate `ACTIVE*.md`. The single-file primary handoff is the canonical query source.

5. **Lifecycle owner uniqueness.** After Worker F lands, only `boundary-detector.ts` writes `status='completed'`. Worker G (P2.7) reads sessions but does not modify status; that's safe.

6. **`session_end_action` telemetry enum.** Worker F adds this event_kind. Telemetry CHECK constraint update follows the same additive pattern as `handoff_parse_failed` (Worker A in 14-01).

## Merge order

Wave 3:
1. **14-05 first** — fewer file conflicts with 14-03 (only `heartbeat.ts` touched by both, on different lines).
2. **14-03 second** — builds on the lifecycle stability 14-05 establishes.

Wave 4:
3. **14-04 alone** — single plan, lands directly to master.

## Worker → PM escalation

Standard. Workers ask PM when:
- A file outside their column needs editing
- A spec ambiguity in their PLAN.md
- Test failure outside their plan's scope
- A schema/type conflict with prior wave's landed work

Workers do NOT escalate for: standard implementation choices,
build/test mechanics, anything in their `must_haves.truths`.

## PM → PO escalation

PM escalates to PO (operator) when:
- A worker reports a fundamental contradiction between two plan ACs
- The cross-plan invariants list above is violated and cannot be
  resolved without scope change
- A worker's external review returns NO-SIGNOFF on a load-bearing
  concern

## SIGNOFF + ship per plan

Each plan ships its own commit chain with:
- Plan ACs verified (numbered in PLAN.md)
- Tests pass within plan's scope
- Cross-family external review (Codex + Gemini) SIGNOFF
- PM merge per the merge order above
- 14-03 specifically: re-run the cross-project equivalence hit-rate
  measurement; AC-3 requires noise rate < 20% post-fix (currently
  84% per `2026-05-15-cross-project-equivalence-hit-rate.md`)

## After Wave 4 lands

PM closes v6.6.0 milestone:
- Update `.planning/ROADMAP.md` Phase 14 → SHIPPED
- Update `.planning/STATE.md` to reflect milestone close
- Aggregate all 6 plan SUMMARYs (14-00 + 14-01 + 14-02 + 14-03 + 14-04 + 14-05 + 14-06 + 14-08) into a Phase-14-CLOSE.md
- Tag `v6.6.0` annotated locally; push gated on operator confirmation
- 14-07 (V17 ↔ legacy migration) gets its own spec + own milestone (v7.0.0); not part of v6.6.0
