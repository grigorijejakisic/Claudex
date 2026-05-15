# Plan 14-03 Substance Filter Audit

**Date:** 2026-05-16
**Scope:** All ad-hoc substance filters across src/ before introducing isSubstantive predicate.
**Plan:** 14-03 (isSubstantive predicate + experience-tier filter)

## Summary

No existing code uses a noise-prefix filter (e.g., `summary NOT LIKE 'Read:%'`). All existing
filters are type-allowlist or importance-threshold based. The sweep targets are clearly bounded.

---

## Site 1: experience-tier.ts — fetchCandidatePool (IN SCOPE FOR SWEEP)

**File:** `src/intelligence/experience-tier.ts`
**Line:** 103
**Filter type:** artifact_type allowlist (includes `observation`)

```sql
AND a.artifact_type IN ('learning', 'observation', 'memory_file', 'flow', 'milestone')
```

**Analysis:** This is the root-cause site for the 83% noise rate. The `observation` type is included
without any importance or length gate, so `Read: file.ts` tool-call traces with task_pattern
fingerprints become candidates.

**Action:** Replace with `substantiveSqlClause('a')` as the primary fix for AC-3. No additional
caller-side filters to preserve (no stricter constraints on top).

---

## Site 2: cross-project-search.ts — searchCrossProjectCandidates (READ-ONLY / OUT OF SCOPE)

**File:** `src/core/cross-project-search.ts`
**Line:** 111
**Filter type:** artifact_type allowlist (includes `observation`)

```sql
AND a.artifact_type IN ('learning', 'observation', 'memory_file', 'flow', 'milestone')
```

**Analysis:** Identical pattern to experience-tier. However, per anti_scope in 14-03-PLAN.md:
"Do NOT touch hybrid-retrieval ranking." cross-project-search feeds hybrid retrieval path, not
experience-tier. This site is READ-ONLY — documented exception, NOT swept in this plan.

**PM decision required if this site should be swept:** Hybrid retrieval scope change is out of
14-03's boundary. Worker documents this as exception; PM can authorize in a follow-on plan.

---

## Site 3: task-pattern-classifier.ts — backfill classifier (READ-ONLY / OUT OF SCOPE)

**File:** `src/angel/task-pattern-classifier.ts`
**Line:** 221
**Filter type:** artifact_type allowlist (includes `observation`)

```sql
AND a.artifact_type IN ('learning', 'observation', 'memory_file', 'flow', 'milestone')
```

**Analysis:** This is the classifier backfill query — it decides WHICH artifacts receive
task_pattern fingerprints. It intentionally includes `observation` rows so they can be
fingerprinted. This is correct behavior: observations are classified so that the substance filter
(which we're building) can use importance/length/prefix rules to reject noise AFTER classification.
No change warranted; documented as intentional design.

---

## Site 4: context-pull-cues.ts (READ-ONLY / OUT OF SCOPE)

**File:** `src/core/context-pull-cues.ts`
**Line:** 230
**Filter type:** artifact_type allowlist

```sql
AND artifact_type IN ('observation', 'learning', 'decision')
```

**Analysis:** context-pull-cues.ts feeds the user-prompt-submit path (not experience-tier). Per
anti_scope: only candidate selection for experience-tier changes. This site is READ-ONLY.

---

## Site 5: heartbeat.ts — embedding backfill queue (READ-ONLY / OUT OF SCOPE)

**File:** `src/angel/heartbeat.ts`
**Line:** 1579 and 1601
**Filter type:** artifact_type allowlist + importance threshold

```sql
AND artifact_type IN ('session_log', 'decision', 'learning', 'handoff', 'memory_file')
AND importance >= 2
```

**Analysis:** This governs which artifacts get embedded, not which are candidates for experience-
tier. Out of scope for this plan. The `importance >= 2` gate is already a substance check for
embedding prioritization — no change warranted.

---

## Site 6: retention-sweep.ts — pruneArtifacts (READ-ONLY / SAFE AS-IS)

**File:** `src/angel/retention-sweep.ts`
**Lines:** 175–220 (pruneArtifacts)
**Filter type:** importance threshold gates (preservation, NOT candidate selection)

```sql
-- Superseded: importance < 5 (delete superseded artifacts that are not precious)
-- Cold: importance < 3 (delete cold low-importance artifacts)
-- Ancient: importance < 4 (delete old packed artifacts below high-importance)
```

**Analysis:** These are DELETION gates, not candidate-selection filters. The plan's sweep scope is
"ad-hoc substantive filters that select candidates." Deletion thresholds serve the opposite purpose
(protecting high-importance items from deletion). No `isSubstantive` replacement applicable —
the logic is intentionally different (deletion protects importance >= 5 unconditionally; substance
filters include all high-value types regardless of importance). Document as out-of-scope.

**Also in retention-sweep.ts:**
- `pruneObservations` at lines 464–509: importance tiers for observations aging (low/med/high
  retention windows). These are deletion gates, not candidate-selection filters. Out of scope.

---

## Site 7: consolidator.ts — getUnconsolidatedObservations (NO SUBSTANCE FILTER PRESENT)

**File:** `src/angel/consolidator.ts`
**Line:** 88–98
**Filter type:** lifecycle state filter (consumed=0, consolidated_into IS NULL, not deleted)

```sql
WHERE consumed = 0
  AND consolidated_into IS NULL
  AND deleted_at_epoch_ms IS NULL
```

**Analysis:** No substance filter here — the consolidator processes ALL unconsolidated observations
regardless of content. This is by design: consolidation is a lifecycle operation, not a substance
gate. The output of consolidation (merged observations) may themselves be substance-filtered by
downstream consumers. No `isSubstantive` replacement applicable or needed.

---

## Site 8: lesson-writer.ts (NO SUBSTANCE FILTER PRESENT)

**File:** `src/angel/lesson-writer.ts`
**Analysis:** Lesson-writer is a write path. It validates frontmatter completeness and body
non-emptiness, but does not apply a "is this artifact substantive?" filter — that question is
for the reader side. The `created_at_epoch_ms >= 1e12` ms-precision guard is an epoch-shape
check, not a substance check. No `isSubstantive` replacement needed.

---

## Sweep Summary

| Site | File | Action |
|---|---|---|
| 1 | `src/intelligence/experience-tier.ts:103` | **SWEEP** — replace with `substantiveSqlClause('a')` |
| 2 | `src/core/cross-project-search.ts:111` | **EXCEPTION** — hybrid retrieval out of scope |
| 3 | `src/angel/task-pattern-classifier.ts:221` | **EXCEPTION** — classifier backfill (intentional) |
| 4 | `src/core/context-pull-cues.ts:230` | **EXCEPTION** — different surface (prompt-submit) |
| 5 | `src/angel/heartbeat.ts:1579,1601` | **EXCEPTION** — embedding backfill (different concern) |
| 6 | `src/angel/retention-sweep.ts` | **EXCEPTION** — deletion gates, not candidate selection |
| 7 | `src/angel/consolidator.ts` | **NO ACTION** — no substance filter present |
| 8 | `src/angel/lesson-writer.ts` | **NO ACTION** — write path, no substance filter present |

**Total SWEEP sites:** 1 (experience-tier.ts)
**Total EXCEPTION sites:** 5 (all documented with rationale above)
**Total NO ACTION sites:** 2 (no applicable filter exists)

## PM-Escalation Items

None. All sites are either clearly in-scope or clearly out-of-scope per the plan's anti_scope
rules. No callsite found with a filter inconsistent with the plan's predicate in a way that
requires a PM decision before proceeding.

The `cross-project-search.ts` site (Site 2) uses the same observation-inclusive pattern but
falls under anti_scope "Do NOT touch hybrid-retrieval ranking." Worker documents it here for
visibility; PM may authorize a follow-on plan to sweep it.
