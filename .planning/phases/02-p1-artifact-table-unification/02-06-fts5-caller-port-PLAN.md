---
plan_id: 02-06
phase: 2
wave: 2
depends_on:
  - 02-04
files_modified:
  - src/core/hybrid-retrieval.ts
  - src/intelligence/experience-patterns.ts
  - src/mcp/recall-server.ts
  - src/tests/**/*.test.ts (affected call sites)
autonomous: true
requirements:
  - STOR-03
---

# Plan 02-06: Port FTS5 callers from learnings_fts / experience_patterns_fts → artifact_fts

## Objective

Rewrite every production and test MATCH query that hits the retired `learnings_fts` or `experience_patterns_fts` to use the new `artifact_fts` filtered by `kind`. `artifacts_fts` is untouched and is NOT in scope.

## Must-haves (goal-backward)

- Zero production call sites reference `learnings_fts` or `experience_patterns_fts` after this plan.
- All rewritten queries return semantically identical results (filtered by appropriate `kind`).
- Full Vitest suite green.

## Tasks

<task id="06-01-01">
  <subject>Enumerate all call sites via Grep</subject>
  <description>
Run (via Grep tool, not shell):
- `learnings_fts` across `src/`
- `experience_patterns_fts` across `src/`

For each hit, classify:
- Production code (rewrite mandatory)
- Test code (rewrite mandatory)
- Comment / doc (update for accuracy, non-blocking)

Expected hits per 02-RESEARCH.md §1.5 audit: ~4-8 call sites concentrated in `hybrid-retrieval.ts`, `experience-patterns.ts`, `recall-server.ts`, and their tests.

Write an enumerated list into this plan file (task comment) before rewriting — acts as execution checklist.
  </description>
</task>

<task id="06-01-02">
  <subject>Rewrite MATCH queries per call site</subject>
  <description>
Canonical rewrite pattern:

**Before:**
```sql
SELECT rowid FROM learnings_fts WHERE learnings_fts MATCH ?
```

**After:**
```sql
SELECT a.id FROM artifact_fts f
JOIN artifact a ON a.rowid = f.rowid
WHERE artifact_fts MATCH ? AND a.kind = 'learning'
```

Or, if the caller wants to score by bm25 rank:
```sql
SELECT a.id, bm25(artifact_fts) AS rank
FROM artifact_fts f
JOIN artifact a ON a.rowid = f.rowid
WHERE artifact_fts MATCH ? AND a.kind = 'learning'
ORDER BY rank
LIMIT ?
```

**Kind mapping:**
- `learnings_fts` callers → `artifact_fts` + `a.kind='learning'`
- `experience_patterns_fts` callers → `artifact_fts` + `a.kind='experience_pattern'`

**ID return type caveat:** `learnings` legacy tables returned INTEGER `id`. After migration, `artifact.id` is TEXT UUID. Callers that treated the returned id as INTEGER must either:
  (a) Join back through `legacy_id_map` to get the integer, OR
  (b) Switch to the TEXT UUID as the identifier going forward.

Prefer (b) since TEXT UUID is the post-P1 truth. Rewrite caller types accordingly. Flag any caller where this switch breaks downstream contracts — escalate to orchestrator before proceeding.

**`trigger_context` + `lesson` + `anti_pattern` multi-column FTS5 match:** the old `experience_patterns_fts` indexed all three. The new `artifact_fts` indexes only `title` (= `trigger_context`) and `body` (= `lesson + "\n\nWhat went wrong: " + anti_pattern`). So the combined field is already in `body`. MATCH semantics preserved.
  </description>
</task>

<task id="06-01-03">
  <subject>Update affected test files</subject>
  <description>
Any test file that:
- INSERTs into `learnings_fts` / `experience_patterns_fts` directly → remove (not needed; sync triggers handle it automatically).
- MATCH-queries them → rewrite per canonical pattern.
- Asserts existence of those FTS5 tables post-V17 → flip assertion to assert they are GONE.
  </description>
</task>

<task id="06-01-04">
  <subject>Update comments and doc lines mentioning retired FTS5 tables</subject>
  <description>
Non-blocking sweep. Grep `learnings_fts|experience_patterns_fts` in:
- `src/**/*.md`
- `.claude/rules/*.md` (especially `schema-migration.md` which currently notes V15 — add a V17 section)
- Inline JSDoc / comments in `src/core/schema.ts`, `migration-steps.ts`

Update to reference `artifact_fts` + kind filter, or note retirement.

`.claude/rules/schema-migration.md` needs a new "V17" subsection appended after V15. Keep consistent with existing V13/V14/V15 subsection format.
  </description>
</task>

## Verification

- `bun run test` → all 2020 + new tests green.
- Grep confirmation: `learnings_fts` and `experience_patterns_fts` return zero production-code hits after this plan (tests/docs may reference for retirement assertions — that's fine).

## Quality gate

- [ ] Every production query rewritten.
- [ ] No silent semantic drift — each rewrite preserves the original query's intent and result shape.
- [ ] Caller id-type switches (INTEGER → TEXT UUID) documented and propagated through types.
- [ ] No casual mentions of retired FTS5 tables left in comments.
