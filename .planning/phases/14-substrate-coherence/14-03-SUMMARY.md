---
phase: 14-substrate-coherence
plan: 03
subsystem: intelligence
tags: [artifact-filters, experience-tier, substance-predicate, sql-clause, noise-filtering]

# Dependency graph
requires:
  - phase: 14-01
    provides: canonical handoff schema
  - phase: 14-02
    provides: project column unification (project_id -> project)
  - phase: 14-06
    provides: epoch-ms canonicalization (timestamp_epoch_ms)
provides:
  - isSubstantive() pure predicate in src/core/artifact-filters.ts
  - substantiveSqlClause() SQL fragment for DB-layer filtering
  - Experience-tier candidate pool filtered by substance (noise 83% -> 18%)
  - JS-vs-SQL lockstep test contract
affects:
  - 14-04 (P2.7 Project Knowledge surface — consumes isSubstantive API)
  - hybrid-retrieval (cross-project-search.ts uses same pattern — documented exception)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure predicate + matching SQL clause pattern for dual-layer filtering"
    - "JS-vs-SQL lockstep test enforces equivalence on fixture set"
    - "Certified-substantive type sets (SUBSTANTIVE_TYPES_LEGACY, SUBSTANTIVE_KINDS_V17)"

key-files:
  created:
    - src/core/artifact-filters.ts
    - src/tests/core/artifact-filters.test.ts
    - .planning/phases/14-substrate-coherence/14-03-AUDIT.md
  modified:
    - src/intelligence/experience-tier.ts
    - src/tests/intelligence/experience-tier.test.ts
    - context/measurements/2026-05-15-cross-project-equivalence-hit-rate.md

key-decisions:
  - "substantiveSqlClause targets legacy artifacts table only (no `kind` column) — V17 kind support is JS-predicate only"
  - "SQL clause uses OR chain of GLOB patterns (not regex) — SQLite GLOB is parameterless and case-sensitive"
  - "flow type is certified-substantive (always passes) even though short [Pre-assembly] flows remain noise — narrowing flow is out of scope (domain affinity problem)"
  - "cross-project-search.ts (hybrid retrieval) documented as exception — anti_scope prohibits touching it"
  - "consolidator + lesson-writer + retention-sweep have no applicable substance filters to replace"

patterns-established:
  - "isSubstantive(artifact): ArtifactSubstanceShape -> boolean — single source of truth for 'is this worth surfacing?'"
  - "substantiveSqlClause(tableAlias): string — companion SQL for DB-layer candidate filtering (legacy artifacts table)"
  - "Lockstep enforcement: fixture-based test compares SQL selected IDs vs JS predicate output on same rows"

requirements-completed: []

# Metrics
duration: 120min
completed: 2026-05-16
---

# Phase 14 Plan 03: Substance Predicate + Experience Tier Filter Summary

**`isSubstantive()` predicate + `substantiveSqlClause()` SQL companion ship as single source of truth for artifact substance, dropping experience-tier noise from 83% to 18% (AC-3 PASS)**

## Performance

- **Duration:** ~120 min
- **Started:** 2026-05-16T00:20:00Z
- **Completed:** 2026-05-16T01:00:00Z
- **Tasks:** 7 (all complete)
- **Files modified:** 6 files + 2 new files

## Accomplishments

- Centralized "is this artifact substantive?" logic into one pure predicate (`isSubstantive`) and one SQL clause (`substantiveSqlClause`) — previously N ad-hoc filters scattered across the codebase
- Experience-tier candidate pool now uses `substantiveSqlClause('a')` — pool shrunk from 3,137 to 816 rows (-74%), noise rate dropped 83% → 18% (AC-3 PASS)
- 40-test suite with JS truth-table + SQL fragment structural tests + JS-vs-SQL lockstep enforcement — drift between JS and SQL is now a failing test, not a silent retrieval mistake
- Full audit of 8 filter sites across the codebase; 5 documented exceptions with rationale; 1 sweep site (experience-tier); 2 no-action sites (no applicable filter existed)

## Task Commits

1. **Task 1: Audit** - `d1c826c` (docs) — 14-03-AUDIT.md listing 8 filter sites
2. **Task 2: Build artifact-filters.ts** - `3c1ee7b` (feat) — isSubstantive + substantiveSqlClause
3. **Task 3: Tests artifact-filters.test.ts** - `b126132` (test) — 40 tests: truth table + SQL + lockstep
4. **Task 4: Apply to experience-tier** - `09fadc8` (feat) — fetchCandidatePool rewritten + 3 new experience-tier tests
5. **Task 5: Sweep retention-sweep/consolidator/lesson-writer** - `d8f2ac3` (chore) — no applicable filters found
6. **Task 6: AC-3 re-measurement** - `cfdf4b2` (docs) — noise 83% → 18%, PASS verdict appended
7. **Task 7: Build + tests + sweep** - (merged into above commits; no new commit needed)

## isSubstantive API Contract (for Worker G / Plan 14-04)

```typescript
// Location: src/core/artifact-filters.ts

export interface ArtifactSubstanceShape {
  artifact_type?: string;  // legacy artifacts table
  kind?: string;           // V17 artifact table
  summary?: string;
  importance?: number;
}

export const SUBSTANTIVE_TYPES_LEGACY: ReadonlySet<string>;
// Contains: learning, decision, memory_file, flow, milestone, entity_summary, handoff
// Excludes: observation (requires gate)

export const SUBSTANTIVE_KINDS_V17: ReadonlySet<string>;
// Extends SUBSTANTIVE_TYPES_LEGACY with: mental_model, directive_rule, critical_rule,
// angel_opinion, experience_pattern

export const NOISE_PREFIX_REGEX: RegExp;
// = /^(Read|Edit|Write|Bash|MultiEdit|Glob|Grep|NotebookEdit|TodoWrite):\s/

export function isSubstantive(artifact: ArtifactSubstanceShape): boolean;
// Pure — no DB calls, no side effects. Safe in hot paths.
// Returns true iff NOT noise-prefix AND (certified type OR observation gate)

export function substantiveSqlClause(tableAlias: string): string;
// SQL fragment for WHERE clause — targets legacy artifacts table (artifact_type column)
// Does NOT reference `kind` (not in legacy schema)
// Throws on empty or invalid alias
```

**Usage example:**
```typescript
import { isSubstantive, substantiveSqlClause } from '../core/artifact-filters.js';

// JS predicate (materialized rows):
const filtered = rows.filter(r => isSubstantive(r));

// SQL clause (DB-layer):
const sql = `SELECT * FROM artifacts a WHERE ${substantiveSqlClause('a')}`;
```

## Files Created/Modified

- `src/core/artifact-filters.ts` — NEW: isSubstantive predicate + substantiveSqlClause helper + exported constants
- `src/tests/core/artifact-filters.test.ts` — NEW: 40 tests (truth table + SQL fragment + lockstep)
- `src/intelligence/experience-tier.ts` — Modified: fetchCandidatePool uses substantiveSqlClause
- `src/tests/intelligence/experience-tier.test.ts` — Modified: 3 new substance-filter tests
- `context/measurements/2026-05-15-cross-project-equivalence-hit-rate.md` — Modified: Post-Plan-14-03 re-measurement appended
- `.planning/phases/14-substrate-coherence/14-03-AUDIT.md` — NEW: 8-site audit pre-sweep

## Decisions Made

1. **SQL clause targets legacy `artifacts` table only** — The legacy table has `artifact_type` but no `kind` column. The V17 `artifact` table has `kind` but no `artifact_type`. Since experience-tier queries the legacy table, `substantiveSqlClause` only references `artifact_type`. V17 kind support (mental_model, angel_opinion, etc.) is handled by the JS predicate only. This is a deliberate scoping decision, not a gap.

2. **`flow` type is certified-substantive** — Even though `[Pre-assembly] Can I — predicted context` flows are noise by content, they passed a promotion gate into the `flow` type. Adding a length filter specifically for `flow` would be scope creep (domain affinity problem). The 18% remaining noise consists largely of these short flows — a known, documented secondary issue.

3. **cross-project-search.ts documented as exception** — The same `artifact_type IN (..., 'observation', ...)` pattern exists in `src/core/cross-project-search.ts:111`. Anti_scope explicitly prohibits touching hybrid retrieval. Documented in AUDIT.md for visibility; deferred to a future plan.

4. **No sweep needed for consolidator/retention-sweep/lesson-writer** — consolidator uses lifecycle state filters (consumed=0), not substance filters. Retention-sweep uses importance thresholds as DELETION gates (opposite purpose). Lesson-writer is a write path. All three are correct as-is.

## Callsites with Stricter Filters (AC-9)

None. The audit found no callsite with a stricter substance filter that needed to be layered on top of `isSubstantive`. The only replaced site (experience-tier) had a looser filter (included all observations without importance gate).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] SQL clause removed `kind` column reference**
- **Found during:** Task 4 (applying substantiveSqlClause to experience-tier)
- **Issue:** Initial SQL clause included `a.kind IN (...)` but the legacy `artifacts` table has no `kind` column. The query was silently failing (caught by try/catch → returned null) causing all 10 experience-tier tests to fail.
- **Fix:** Removed `a.kind` references from `substantiveSqlClause`. Updated JSDoc to document that the clause is for legacy tables only. V17 kind support remains in the JS predicate.
- **Files modified:** `src/core/artifact-filters.ts`, `src/tests/core/artifact-filters.test.ts`
- **Verification:** All 17 experience-tier tests pass post-fix; all 40 artifact-filters tests pass.
- **Committed in:** `09fadc8` (Task 4 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** Fix was necessary for correctness. No scope creep. The design decision (SQL clause scoped to legacy schema) is documented in JSDoc and SUMMARY.

## Issues Encountered

- Fixture #16 (exactly-60-char observation boundary) required exact character count verification — the first string was 61 chars, triggering the module-load assert. Fixed by trimming to exactly 60.
- The experience-tier tests were all failing after initial `substantiveSqlClause` application because the SQL referenced `a.kind` which doesn't exist in the `artifacts` table (caught by the deviation rule above).

## Next Phase Readiness

- Worker G (Plan 14-04) can import `isSubstantive` from `src/core/artifact-filters.js` immediately — API is stable and committed.
- `substantiveSqlClause` is available for any additional query builders that need DB-layer substance filtering.
- cross-project-search.ts (hybrid retrieval) still includes `observation` in its type filter — known exception, deferred.
- Short `[Pre-assembly]` flow noise (18% of experience-tier pool) — deferred pending domain affinity work.

## Self-Check: PASSED

All created files confirmed on disk. All task commits confirmed in git log.

| Check | Result |
|---|---|
| src/core/artifact-filters.ts | FOUND |
| src/tests/core/artifact-filters.test.ts | FOUND |
| .planning/phases/14-substrate-coherence/14-03-AUDIT.md | FOUND |
| context/measurements/2026-05-15-cross-project-equivalence-hit-rate.md | FOUND |
| commit d1c826c (audit) | FOUND |
| commit 3c1ee7b (predicate) | FOUND |
| commit b126132 (tests) | FOUND |
| commit 09fadc8 (experience-tier) | FOUND |
| commit d8f2ac3 (sweep) | FOUND |
| commit cfdf4b2 (re-measurement) | FOUND |

---
*Phase: 14-substrate-coherence*
*Completed: 2026-05-16*
