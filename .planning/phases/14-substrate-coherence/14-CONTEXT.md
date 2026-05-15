# Phase 14: Substrate Coherence — Context

**Gathered:** 2026-05-15
**Status:** Spec ready for planning
**Predecessors:** Phase 13 (Organic Claudex shipped 2026-05-14), Phase 13.1 (substrate-readout fixes #1–#7 shipped 2026-05-15)
**Inputs:**
- `context/measurements/2026-05-15-substrate-readout-test.md` (gap diagnosis)
- `context/measurements/2026-05-15-big-mozzy-substrate-audit.md` (cross-project case)
- `context/measurements/2026-05-15-cross-project-equivalence-hit-rate.md` (precision = 0%)
- `context/measurements/2026-05-15-substrate-contract-matrix.md` (12 conflicts mapped)
- `context/measurements/2026-05-15-substrate-rcas.md` (3 RCAs)

## Phase thesis

Claudex grew organically over 13 phases without contract enforcement.
Every surface works in isolation; together the surfaces have no
shared definition of what a session, handoff, learning, observation,
or project actually is. **claudex-v3 happens to satisfy enough
unwritten conventions to land coherent; big-mozzy-v2 uses different
but-valid conventions and gets silently degraded across half the
surfaces.**

Phase 14 is the contract-enforcement phase. Each of nine sub-plans
defines one contract per concept and rewires every read/write site
to honor it. Cumulatively, this fixes:

1. The **global Opus rate-limit failure** (RCA-2) that has caused
   100% of session_highlights extractions to be fallback-quality
   since the feature shipped on 2026-05-14.
2. **Schema-mismatched handoffs** that render claudex/handoff v1
   schemas (big-mozzy, lacuna-betting, oracle, nexus) invisible to
   every session-start surface.
3. **Cross-project candidate noise** (84% of injections are
   `Read: file.ts`-shaped tool-call traces).
4. **Same-project context starvation** at session-start when
   highlights extraction fails or no session has been highlighted.
5. **Project-naming collisions** (`project` vs `project_id`).
6. **Epoch-shape disagreements** (sec / ms / ISO).
7. **Multi-agent ACTIVE.md invisibility**.
8. **Lifecycle-owner ambiguity** for "session ended."
9. **V17 vs legacy `artifacts` co-residence** with no documented authority.

This is **not** about adding features. Every fix is contract-
hardening over existing functionality. The substrate's behavior
becomes more *predictable*, not richer.

## Out of scope

- New surfaces / new tiers / new sections in the assembler beyond
  what the contracts require (P2.7 Project Knowledge in 14-04 is
  a contract requirement, not a feature).
- Anything that changes hybrid-retrieval ranking math.
- Anything that changes embedder model or reranker model.
- Per-project glossary / lexical normalization (the "soil density"
  hypothesis from `project_quality_variance_across_projects.md` was
  killed by the substrate audit — it's plumbing, not soil).
- Persona / character work — that is `~/.claude/CLAUDE.md` and is
  on a separate manual track.

## Wave structure

```
Wave 0 (immediate, blocking nothing):
  14-00 — RCA-2 Opus rate-limit hybrid (1 file + tests, ~1 day)

Wave 1 (foundation contracts — no inter-dependencies):
  14-01 — Handoff schema (one + automated migration)
  14-02 — Project naming column unification
  14-06 — Epoch-shape canonicalization

Wave 2 (depends on Wave 1):
  14-03 — isSubstantive() predicate + experience-tier filter
  14-08 — Multi-agent ACTIVE*.md visibility

Wave 3 (depends on Wave 2):
  14-04 — P2.7 Project Knowledge surface
  14-05 — Angel boundary detector as session-end owner

Wave 4 (its own sub-phase, 8-12 days):
  14-07 — V17 ↔ legacy `artifacts` migration
```

Sub-plans 14-00 through 14-08 ship as one milestone (`v6.6.0`).
Sub-plan 14-07 ships as its own milestone (`v7.0.0`) because its
blast radius is large enough that bundling it with the others would
risk masking regressions.

---

## Plan 14-00 — RCA-2 Opus rate-limit hybrid

**Status:** HIGHEST PRIORITY (global substrate failure since 2026-05-14)

### Problem

Every Opus call from `highlights-extractor.ts` returns HTTP 429
`rate_limit_error`. The MAX subscription's OAuth token (in
`~/.claude/.credentials.json`) is rate-limited for programmatic
non-CC API access. Interactive CC sessions consume the same token
through CC's own client and don't hit the limit; Angel calling
`api.anthropic.com` directly gets 429 every time. Result: 100% of
`session_highlights` rows in production are `degraded=1`,
falling back to `glm-5.1:cloud` (cloud fallback). Zero non-degraded
highlights exist in the entire DB.

### Goal

Angel-driven LLM extractions are *self-sufficient on locally-
available resources*, with optional opt-in to Opus via explicit env
var. Eliminate the silent-degradation path for every project.

### Acceptance criteria

- AC-1: With `ANTHROPIC_API_KEY` env var unset, the extractor uses
  the Angel-supervised local llama-server as primary path with no
  Opus call, no 429, no degraded=1.
- AC-2: With `ANTHROPIC_API_KEY` env var set to a working API key
  (NOT the OAuth token), Opus is the primary path. On Opus
  success: degraded=0, model captured. On Opus failure: degraded=1,
  fall back to local.
- AC-3: `frame_extraction_fallback` telemetry rows include the
  HTTP status code in `detail` (currently lost) so future
  debugging doesn't require manual reproduction.
- AC-4: An existing degraded session can be re-extracted under each
  configuration; the new row replaces the old (Phase 13.1 Fix #4
  upsert behavior already supports this).
- AC-5: No regression to fallback path for projects on cold-start
  DBs (no API key, no OAuth, fresh install).

### Implementation

`src/angel/highlights-extractor.ts`:
- Read `process.env.ANTHROPIC_API_KEY` at function entry. If set
  AND non-empty, use it for the Authorization header (`Bearer <key>`)
  with the standard `x-api-key` header convention. If unset, skip
  Opus entirely and call `callLocalLLM` directly.
- The OAuth path (reading `~/.claude/.credentials.json`) is
  REMOVED — it is the source of the 429s and there is no
  configuration in which it should be the chosen path.
- HTTP status code captured in error before throw; passed via
  `recordFrameExtractionFallback` `detail` JSON.

`src/core/telemetry-signals.ts` (`recordFrameExtractionFallback`):
- Accept and persist `http_status?: number` field in `detail`.

### Tests

`src/tests/angel/highlights-extractor.test.ts`:
- Existing tests already mock the callables; extend to:
  - `env-var-unset goes straight to local without touching opus path`
  - `env-var-set with key uses opus, x-api-key header set`
  - `env-var-set with empty string treated as unset`
  - `429 from opus captured in telemetry detail.http_status`
  - `non-2xx with no http_status defaults to 'unknown'`

### Migration / rollback

Migration: zero — no schema changes; only behavior change is removal
of OAuth path.

Rollback: revert one file. The fallback model already worked
(`glm-5.1:cloud`) so any in-flight extractions complete during
rollback.

### Verification gate

Re-run `extractHighlightsForSession` against an existing
`session_highlights` row with `degraded=1` and confirm new row has
`degraded=0` (when API key set) OR is produced by local llama
without degraded=1 (when API key unset).

### Estimated cost

~1 day. Single-file production change + ~5 new tests + one manual
re-extraction verification.

---

## Plan 14-01 — Handoff schema (one + automated migration)

### Problem

Two handoff schemas exist in production. `parseHandoffHeader`
requires `status` AND `phase`. claudex-v3 satisfies; big-mozzy-v2's
`claudex/handoff` v1 schema (with `handoff_id`, `supersedes`,
`origin_session_id`, ISO `created_at`, no `phase`) is rejected.
Affects: `renderSessionContinuity` (P2.5), `curateMemoryMd`
(MEMORY.md `## Handoff` line), `computeInitialUserMessage` (INJ-06
prime), Fix #6 freshness floor.

### Goal

One canonical handoff schema enforced at every read site. Existing
projects on the older schema migrate cleanly via an automated tool
that preserves operator content verbatim and adds the missing
machine-readable fields.

### Acceptance criteria

- AC-1: `parseHandoffHeader` accepts the canonical schema only;
  rejection reason is logged to telemetry instead of silent null.
- AC-2: Migration tool `scripts/migrate-handoff.ts` reads any
  ACTIVE.md, infers `phase` from operator content (heading parse,
  date stamp, or operator prompt), adds `created_at_epoch_ms`,
  preserves all body content verbatim, writes atomically.
- AC-3: `claudex-v3/context/handoffs/ACTIVE.md` is unchanged after
  running the tool (idempotent on already-canonical files).
- AC-4: `big-mozzy-v2/context/handoffs/ACTIVE.md` after migration
  satisfies `parseHandoffHeader`, surfaces in P2.5, surfaces in
  MEMORY.md `## Handoff`, activates Fix #6 freshness floor.
- AC-5: Migration tool dry-run mode prints intended changes
  without writing.
- AC-6: Tool refuses to write if the inferred values look wrong
  (e.g., extracted `phase` is empty or non-numeric); operator
  must supply explicitly.

### Implementation

`src/scripts/migrate-handoff.ts` (new CLI):
- `bun src/scripts/migrate-handoff.ts <projectDir> [--dry-run]
  [--phase <phase>] [--epoch-ms <ms>]`.
- Reads `<projectDir>/context/handoffs/ACTIVE.md`.
- If frontmatter parses canonical → exit success (idempotent).
- Else: extract operator content, infer fields, prompt operator on
  ambiguity, write canonical version atomically (tmp + rename).
- Preserves `handoff_id`, `supersedes`, `origin_session_id`, ISO
  `created_at` as **comment lines** in the canonical body so no
  operator information is lost. Operator can prune later.

`src/angel/handoff-writer.ts`:
- `parseHandoffHeader` unchanged in shape, but wrap the `null`
  return in a telemetry call so rejected reads are visible
  (event_kind=`handoff_parse_failed`, detail records the reason —
  missing phase / no frontmatter / invalid status).

### Tests

`src/tests/scripts/migrate-handoff.test.ts` (new):
- migrates a `claudex/handoff` v1 sample to canonical
- idempotent on already-canonical sample
- dry-run prints diff but doesn't write
- `--phase` flag overrides inference
- `--epoch-ms` flag overrides inference
- preserves operator body content byte-for-byte (excluding
  preserved-as-comment legacy fields)
- refuses to write on inference failure

### Migration / rollback

Migration is operator-driven (run the tool). Per-project. Rollback
= revert ACTIVE.md from git history.

### Estimated cost

~2 days. CLI + comprehensive tests + actually run on big-mozzy-v2
to verify end-to-end.

---

## Plan 14-02 — Project naming column unification

### Problem

The same identifier (`big-mozzy-v2`, `claudex-v3`) lives in two
column names: `project` (TEXT) on most tables; `project_id` (TEXT)
on V17 `artifact` and `transcript_chunk_v6`. Cross-table queries
hand-write the disagreement; bugs slip in (we caught one in this
session — `WHERE project='X'` against V17 returned no rows).

### Goal

One canonical column name across all project-scoped tables. Choice:
**`project`** (smaller blast radius — V17 only has 2 tables vs the
8 legacy tables).

### Acceptance criteria

- AC-1: V17 `artifact.project_id` renamed to `project` via
  migration.
- AC-2: `transcript_chunk_v6.project_id` renamed to `project`.
- AC-3: All callers updated; no `project_id` references remain in
  production code.
- AC-4: Tests still pass after migration.
- AC-5: Rollback migration in `migration-steps.ts` reverses the
  rename if ever needed.

### Implementation

New migration `migrateV33toV34` (or whatever the next migration
number is):
- `ALTER TABLE artifact RENAME COLUMN project_id TO project`
- `ALTER TABLE transcript_chunk_v6 RENAME COLUMN project_id TO
  project`
- Update `artifact_fts` content-table reference (FTS5 trigger
  re-create)
- Update any indexes that reference `project_id`

Caller sweep:
- `src/intelligence/directive-detector.ts`
- `src/intelligence/retrieval-log.ts`
- `src/angel/transcript-chunker.ts`
- `src/angel/memory-md-writer.ts`
- `src/core/migration/v17-runner.ts` + `v17-triggers.ts`
- All test fixtures

### Tests

New unit test: query both old and new column names against a
fresh-migrated DB — old name must throw, new name must work.

Existing tests: must continue to pass after caller updates.

### Migration / rollback

`ALTER TABLE ... RENAME COLUMN` is reversible. Add the reverse
migration as `migrateV34toV33` for symmetry.

### Estimated cost

~1 day. Migration + caller sweep + test updates.

---

## Plan 14-03 — `isSubstantive()` predicate + experience-tier filter

### Problem

The cross-project candidate pool (`fetchCandidatePool` in
`experience-tier.ts`) includes `artifact_type='observation'` rows.
Single-action `Read: file.ts` observations have a `task_pattern`
classification (because the classifier runs on every artifact
regardless of substance) and become legitimate candidates. Result:
84% of injections are noise. The same "is this substantive?"
question appears in retention-sweep, consolidator, lesson-promoter
— each with its own filter.

### Goal

One `isSubstantive(artifact)` predicate, used at every site that
asks the question. Predicate definition is centralized; surfaces
that need different thresholds parameterize, not re-implement.

### Acceptance criteria

- AC-1: `isSubstantive(artifact)` predicate in
  `src/core/artifact-filters.ts`.
- AC-2: Predicate rules:
  - `artifact_type` not in {`observation`} (legacy) /
    `kind` not in {`observation`} (V17) — UNLESS `importance >=
    4` AND `LENGTH(summary) >= 60`.
  - Summary is not a single tool-call trace
    (regex: `^(Read|Edit|Write|Bash|MultiEdit|Glob|Grep):`).
  - For lessons / decisions / memory_files: always substantive.
- AC-3: Experience Tier candidate pool filtered through
  `isSubstantive`. Verified: re-running the
  `cross-project-equivalence-hit-rate` measurement after the change
  drops noise rate below 20%.
- AC-4: Retention sweep, consolidator, lesson-promoter use
  `isSubstantive` for candidate selection where they currently
  have ad-hoc filters.

### Implementation

`src/core/artifact-filters.ts` (new):
- Pure function `isSubstantive(artifact: { artifact_type?: string;
  kind?: string; summary?: string; importance?: number }): boolean`.
- Companion: `substantiveSqlClause(tableAlias: string): string`
  that returns the SQL fragment so query builders can apply at the
  DB layer (avoids materializing noise rows).

`src/intelligence/experience-tier.ts`:
- `fetchCandidatePool` query uses `substantiveSqlClause('a')` in
  the WHERE clause.

Sweep retention-sweep, consolidator, lesson-promoter for ad-hoc
substantive filters; replace.

### Tests

`src/tests/core/artifact-filters.test.ts` (new):
- predicate classifies known noise / known substance correctly
- predicate parameterized importance threshold
- SQL clause produces correct WHERE fragment

`src/tests/intelligence/experience-tier.test.ts`:
- candidate pool excludes raw observations of `Read: file.ts`
  shape
- candidate pool includes high-importance long-summary
  observations (e.g., post-tool-use captures of error stack traces)

### Migration / rollback

No DB changes. Pure code. Rollback = revert the predicate file.

### Estimated cost

~1.5 days. Predicate + SQL clause + 4-5 caller updates + tests.

---

## Plan 14-04 — P2.7 Project Knowledge surface

### Problem

Experience Tier explicitly excludes same-project. Recent Session
Frames (P2.6) is supposed to fill the gap but depends on
`session_highlights` extraction succeeding. With Plan 14-00 fixing
extraction, P2.6 will start carrying weight — but for projects
where no session has been highlighted yet (cold start, fresh
project), session-start has no proactive same-project surface.

### Goal

A new P2.7 `## Project Knowledge` section that surfaces the top-K
*substantive* same-project artifacts at session-start, routed
through hybrid retrieval against the handoff summary as the
implicit query.

### Acceptance criteria

- AC-1: New section P2.7 in the assembler cascade between P2.6
  and P3.
- AC-2: Section reads ACTIVE.md `summary` (Plan 14-01 canonical)
  as the query. If no summary, falls back to handoff body topic.
- AC-3: Hybrid retrieval against the project's `artifact` rows
  filtered by `isSubstantive` (Plan 14-03), top 3, ranked.
- AC-4: Token cap: 800 (between Recent Frames and Checkpoint in
  the budget order).
- AC-5: Returns null if ACTIVE.md missing or handoff has no
  summary content.
- AC-6: Cache stable — same inputs → same output (CACH-02).

### Implementation

`src/assembly/sections.ts`:
- `formatProjectKnowledgeSection(db, project, handoffSummary,
  budgetTokens)` — wraps hybrid retrieval, formats top-K rows
  as a budget-capped Markdown section.

`src/assembly/assembler.ts`:
- Wire P2.7 between P2.6 and P3.
- Pass `header.summary` from the same `parseHandoffHeader` read
  used by P2.5 to avoid double-parsing.

### Tests

`src/tests/assembly/project-knowledge.test.ts` (new):
- happy path returns top-K substantive artifacts
- returns null when ACTIVE.md missing
- returns null when summary empty
- excludes raw observations (uses isSubstantive)
- respects budget cap

`src/tests/assembly/sections.test.ts`:
- update P2.7 ordering test in cascade

### Migration / rollback

No DB changes. Pure code.

### Estimated cost

~1.5 days.

---

## Plan 14-05 — Angel boundary detector as single session-end owner

### Problem

Today: session-start sets `status='active'`. UPS heartbeats
`last_heartbeat_ts`. Stop hook may write a session_summary
(platform-dependent). Angel boundary detector reads
`last_heartbeat_ts` and decides ALIVE/DORMANT/TERMINATED. Sessions/
writer fires on UPS + Stop. Highlights extraction fires when
status becomes `'completed'`. **No single owner of the
"session ended" event** — pieces of the lifecycle happen on
different cadences with different triggers; some don't happen at
all for some projects.

### Goal

The Angel boundary detector is the **sole writer** of
`status='completed'` + `ended_at_epoch`. When it fires, every
end-of-session side effect runs in a known order. No surface
besides the boundary detector ever sets `status='completed'`.

### Acceptance criteria

- AC-1: All `UPDATE sessions SET status='completed'` writes
  outside the boundary detector are removed.
- AC-2: Boundary detector emits a single `session_ended`
  episodic_event when it fires.
- AC-3: Triggered downstream actions in order:
  1. session_summary write (if not already present)
  2. final pattern-extractor pass over the session
  3. highlights extraction (already wired, now reliable thanks
     to 14-00)
  4. MEMORY.md regeneration
  5. lesson-pointer index update
- AC-4: Each downstream action is logged with telemetry
  `session_end_action` so order + success can be audited.
- AC-5: An idle session crossing the TERMINATED threshold
  triggers the same path as a clean stop.

### Implementation

`src/angel/boundary-detector.ts` (existing):
- Become the single writer of `status='completed'`.
- After write, fire the ordered downstream actions list with
  per-action telemetry.

`src/adapters/cc-hooks/stop.ts`:
- Remove `UPDATE sessions SET status='completed'` if present.
- Stop hook still writes session_summary, but does NOT mark
  session as completed. Boundary detector promotes status when
  heartbeat conditions are met.

Wherever else `status='completed'` is set, refactor to use
boundary detector as the funnel.

### Tests

`src/tests/angel/boundary-detector.test.ts`:
- on TERMINATED transition, all 5 downstream actions fire in
  order
- each action has a telemetry row
- repeated TERMINATED transitions for the same session don't
  duplicate work (idempotent)

### Migration / rollback

No DB changes. Behavioral refactor.

### Estimated cost

~2 days. Refactor + careful testing of the lifecycle ordering.

---

## Plan 14-06 — Epoch-shape canonicalization (all ms)

### Problem

Three different epoch shapes in active use:
- `*_epoch_ms` (handoff frontmatter, session_highlights,
  transcript_chunk_v6) — milliseconds
- `*_epoch` (checkpoint_meta, observations, sessions, learnings,
  V17 artifact) — seconds
- ISO 8601 (lesson frontmatter, big-mozzy ACTIVE.md `created_at`)

Fix #6 (today) reads `created_at_epoch_ms` and converts to seconds
for checkpoint — only fires when the ms field is present. The mix
of shapes invites silent bugs.

### Goal

All DB columns store milliseconds. All file frontmatter writes
milliseconds. ISO is reserved for human-facing display only.
A single typed accessor `epoch.ts` provides safe conversions with
explicit `_ms` and `_sec` variants for transitional code.

### Acceptance criteria

- AC-1: All `*_epoch` columns renamed to `*_epoch_ms` via
  migration, values multiplied by 1000.
- AC-2: All callers reading `*_epoch` updated.
- AC-3: `src/core/epoch.ts` provides `toMs`, `toSec`, `fromIso`,
  `toIso` helpers; production code uses these instead of
  `Math.floor(x / 1000)` ad-hoc.
- AC-4: Lesson frontmatter `created_at_epoch` field renamed to
  `created_at_epoch_ms`. Migration tool for existing lesson files.
- AC-5: ACTIVE.md migration tool (Plan 14-01) writes
  `created_at_epoch_ms`, not `created_at_epoch`.

### Implementation

`migrateV34toV35` (or next):
- Rename + multiply for every `*_epoch` column on:
  `sessions.created_at_epoch`, `sessions.ended_at_epoch`,
  `observations.timestamp_epoch`,
  `learnings.first_seen_epoch / last_promoted_epoch / updated_at_epoch`,
  `checkpoint_meta.created_at_epoch / updated_at_epoch`,
  `artifact.created_at_epoch / updated_at_epoch`,
  `episodic_events.ts_epoch`,
  `telemetry.timestamp_epoch`,
  `pressure_scores.last_touched_epoch`,
  etc.
- All sidecar indexes recreated.

`src/core/epoch.ts` (new): typed conversion helpers.

Caller sweep across the entire codebase.

### Tests

`src/tests/core/epoch.test.ts` — helper coverage.

Existing tests continue to pass after caller updates.

### Migration / rollback

Reversible: new migration that divides by 1000 and renames back.
Risk: callers that expect the old shape break loudly (good — they
get caught immediately).

### Estimated cost

~3 days. This is the largest single Wave-1 plan; touches many
tables and many callers. Worth doing because it eliminates a
whole class of silent bugs.

---

## Plan 14-07 — V17 ↔ legacy `artifacts` migration (Phase 14.7)

### Status: HIGH-COST, OWN MILESTONE

Per RCA-3: ~8-12 days of focused engineering across DDL, data
migration, 22 caller updates, test reconciliation, and benchmark
protection. **Specced as its own sub-phase**, ships independently
as `v7.0.0`. Detailed spec lives at
`.planning/phases/14-substrate-coherence/14-07-SPEC.md` (to be
written after 14-00 through 14-06 ship).

Headline goals:
- Single source of truth for knowledge artifacts
- Eliminate naming collisions (resolved by 14-02 in advance)
- Eliminate sidecar duplication (artifact_fts, vec_artifacts)
- All callers read V17 only

Headline risks:
- Hybrid retrieval ranking regression — protected by Vesna +
  LongMemEval + LoCoMo benchmark gates
- Activation score / state lifecycle migration to V17 `data` JSON
  is the trickiest piece
- Embedding storage shape change requires re-embed pass

Sequencing: starts AFTER 14-00 through 14-06 ship as v6.6.0.

---

## Plan 14-08 — Multi-agent `ACTIVE*.md` visibility

### Problem

Assembler reads only `ACTIVE.md`. Big-mozzy has `ACTIVE-agent2.md`
for parallel-agent work — permanently invisible.

### Goal

`renderSessionContinuity` reads all `ACTIVE*.md` files in
`<projectDir>/context/handoffs/` and renders each as a distinct
continuity block tagged with the agent identifier.

### Acceptance criteria

- AC-1: Multiple `ACTIVE*.md` files surface as multiple
  Session Continuity blocks, each labeled `### Agent <id>`.
- AC-2: Single `ACTIVE.md` renders unchanged from today's
  output (backwards-compatible).
- AC-3: Agent identifier extracted from filename
  (`ACTIVE-agent2.md` → `agent2`); `ACTIVE.md` → no agent tag.
- AC-4: Token budget shared across all blocks; older agent
  handoffs (by `created_at_epoch_ms`) get truncated first.

### Implementation

`src/assembly/sections.ts`:
- `renderSessionContinuity` enumerates `ACTIVE*.md`, parses each,
  renders multi-block.

### Tests

`src/tests/assembly/sections.test.ts`:
- single ACTIVE.md unchanged behavior
- ACTIVE.md + ACTIVE-agent2.md produces 2 blocks
- 4 agents truncate by age when over budget

### Migration / rollback

None. Pure code.

### Estimated cost

~1 day.

---

## Methodology gates (inherited from v5/v6)

Every Phase 14 sub-plan honors:
1. Pre-committed acceptance criteria in this CONTEXT before any
   measurement
2. Tests written alongside or before the change (no implementation
   without test)
3. Live-wiring smoke against current production DB shape
4. No "MVP" shortcuts — production tests, real error handling,
   architecture that holds
5. Negative results are valid outputs (if a plan's AC turns out
   to be wrong, document and revise)
6. Cross-family external review (Codex + Gemini) before milestone
   ship

## Ship sequencing

```
v6.6.0 (this milestone):
  - Plan 14-00 (RCA-2 Opus fix)
  - Plan 14-01 (handoff schema)
  - Plan 14-02 (project naming)
  - Plan 14-03 (isSubstantive)
  - Plan 14-04 (P2.7 surface)
  - Plan 14-05 (boundary detector ownership)
  - Plan 14-06 (epoch ms)
  - Plan 14-08 (multi-agent ACTIVE)

v7.0.0 (next milestone, after v6.6.0 ships):
  - Plan 14-07 (V17 migration — own spec)
```

Total estimated cost for v6.6.0: ~13 days (parallel execution
where waves allow). v7.0.0 adds ~8-12 days. **Roadmap commitment,
not a single session.**

## Verification at milestone ship

Each ship requires:
- All ACs from each plan green
- Vesna behavioral probes 18/18 PASS
- LongMemEval + LoCoMo non-regression
- Cross-family external review SIGNOFF
- Operator-confirmed disposition test on big-mozzy AND claudex-v3
  (does session-start carry the right context?)

## What this is NOT

- Not a feature phase — every change is contract-hardening.
- Not a one-session sprint — production quality across 13+ days.
- Not a rewrite — every existing surface keeps working through
  the migration; deprecation is gated on caller-completion.
- Not optional — RCA-2 alone (Plan 14-00) is fixing a global
  silent failure. The rest is paying down the contract debt that
  caused the operator to say "the system is not systematic about
  session and learnings from it, handoff or anything else."
