---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: 07h
type: execute
wave: 3
depends_on: []
files_modified:
  - src/angel/memory-md-writer.ts
  - src/angel/lesson-writer.ts
  - src/scripts/migrate-lesson-trigger.ts (NEW)
  - src/intelligence/experience-tier.ts
  - src/assembly/sections.ts
  - src/tests/angel/memory-md-writer.test.ts
  - src/tests/angel/lesson-writer.test.ts
  - src/tests/scripts/migrate-lesson-trigger.test.ts (NEW)
  - src/tests/intelligence/experience-tier-project-scope.test.ts (NEW)
  - src/tests/assembly/lessons-trigger-rendering.test.ts (NEW)
autonomous: true
operator_review_gate: true
requirements: []

must_haves:
  truths:
    - "Three concerns folded into one plan, all addressing the 2026-05-16 operator audit of session-start coherence: (1) MEMORY.md regenerator fix — preserve Lessons index + User Notes across regenerations; (2) lesson `trigger:` frontmatter field used in MEMORY.md output (replace truncated-body with trigger condition + rule); (3) **experience-tier relevance rewrite (option C per CONTEXT Locked Decision 9)** — keep cross-project transfer, raise relevance bar via per-task-pattern scoring + handle-overlap threshold lift."
    - "**MEMORY.md User Notes section is sacred.** Every regeneration MUST preserve the User Notes section byte-equivalent. The 2026-05-14 wipe regression must not recur. The regenerator's contract: regenerate everything ABOVE the `<!-- USER EDITABLE -->` marker; never touch what's below."
    - "Lesson frontmatter gains a `trigger:` field. The regenerator uses this field in MEMORY.md output instead of the truncated-body shortcut. Existing lessons get migrated via `src/scripts/migrate-lesson-trigger.ts` (operator-runnable; dry-run default). Lessons without a `trigger:` field fall back to truncated-body until migrated."
    - "Migration tool `migrate-lesson-trigger.ts` is operator-runnable per project. Dry-run by default. Two modes: (a) `--infer` infers trigger from the body's first sentence + an explicit `When [condition] → ` prefix that operator confirms; (b) `--trigger '<text>'` accepts explicit operator-supplied trigger. Refusal-on-ambiguity per Phase 14-01's pattern."
    - "**Experience-tier relevance rewrite (operator-confirmed 2026-05-16 16:21, CONTEXT Locked Decision 9):** Do NOT filter to same-project-only — that would kill the cross-project transfer that is the tier's defining purpose. Instead, raise the relevance bar via combination of: (a) **per-task-pattern relevance scoring** — match the current pivot's task-pattern fingerprint (extracted via `task-pattern-classifier.ts`) against candidate pattern; candidates with mismatched task-pattern get demoted regardless of handle overlap; (b) **handle-overlap threshold lift** — existing `stageOneHandleOverlap` from `cross-project-equivalence.ts` returns a numeric overlap; current spec uses `STAGE1_OVERLAP_BOOST_THRESHOLD = 3` (see `experience-tier.ts:33`). Lift this threshold OR convert it from boost-trigger to admission-floor: candidates below the threshold are NOT admitted to the surface (currently they're admitted but unboosted). Cross-project transfer preserved; out-of-domain noise (OAuth/Expo/bet365 in claudex-v3 sessions) removed because none of those have task-pattern overlap with claudex-v3's current pivots."
    - "Experience-tier rewrite is at `src/intelligence/experience-tier.ts`. Specific touchpoints: extend `fetchCandidatePool` query to JOIN `artifact_task_pattern` candidate's pattern against current pivot's pattern with a similarity factor; raise STAGE1_OVERLAP_BOOST_THRESHOLD (or rename to ADMISSION_FLOOR) and convert to admission gate. Document the new constant values in 14-07-WAVE3-STATUS.md after measurement against the pre-rewrite baseline. **Measurement gate:** target reduction of out-of-domain pattern surfacing from baseline by ≥60% measured against a hand-curated test query set (TBD in test fixture); cross-project transfer rate for in-domain patterns held at ≥80% of pre-rewrite baseline."
    - "Regenerator round-trip test: 10 consecutive regenerations preserve all artifacts (lesson pointers, User Notes, Handoff section, Active Projects section) byte-equivalent."
    - "User Notes section content is owned by the operator. The regenerator MUST NOT add, remove, or reorder lines in User Notes — even if it thinks the operator's content is stale. If the operator-managed marker is missing, regenerator REFUSES to write and surfaces an error (rather than silently re-creating it)."
  artifacts:
    - path: "src/angel/memory-md-writer.ts"
      provides: "Fixed regenerator that preserves User Notes byte-equivalent + uses lesson trigger frontmatter + renders Lessons index correctly. Round-trip stable."
      contains: "regenerateMemoryMd|preserveUserNotes|renderLessonPointer|trigger"
    - path: "src/angel/lesson-writer.ts"
      provides: "Lesson writer extended to emit `trigger:` field in new lesson files."
      contains: "trigger"
    - path: "src/scripts/migrate-lesson-trigger.ts"
      provides: "Operator-runnable CLI to add `trigger:` field to existing lesson files. Dry-run default; --infer mode; --trigger explicit override."
      contains: "migrateLessonTrigger|inferTriggerFromBody|atomicWrite"
    - path: "src/intelligence/experience-tier.ts"
      provides: "Experience tier relevance rewrite per CONTEXT Locked Decision 9 (option C). Adds per-task-pattern relevance scoring; raises stage-one handle-overlap from boost-trigger to admission-floor. Cross-project transfer PRESERVED; out-of-domain noise reduced via better matching."
      contains: "fetchCandidatePool|stageOneHandleOverlap|taskPatternRelevance|ADMISSION_FLOOR"
    - path: "src/assembly/sections.ts"
      provides: "Lessons section formatter (H owns this function per WAVE3-COORDINATION). Renders lesson pointers using trigger frontmatter when available; falls back to truncated-body if `trigger:` missing."
      contains: "formatProvenPrinciplesSection"
    - path: "src/tests/angel/memory-md-writer.test.ts"
      provides: "Extended with round-trip preservation test + User Notes sacred-region test"
      contains: "round_trip|preserve_user_notes|lessons_index"
    - path: "src/tests/scripts/migrate-lesson-trigger.test.ts"
      provides: "CLI tests: dry-run, --infer, --trigger override, refusal-on-ambiguity, idempotency"
      contains: "dry_run|infer|trigger_override|refuse|idempotent"
    - path: "src/tests/intelligence/experience-tier-project-scope.test.ts"
      provides: "Tests for project-scope filter: in-project surfaces; cross-project filtered out; configurable threshold"
      contains: "project_scope|in_project|cross_project_filtered"
    - path: "src/tests/assembly/lessons-trigger-rendering.test.ts"
      provides: "Tests for lessons section rendering with trigger frontmatter + truncated-body fallback"
      contains: "trigger_rendering|truncated_body_fallback"
  key_links:
    - from: "src/angel/memory-md-writer.ts (regenerateMemoryMd)"
      to: "src/angel/lesson-writer.ts (readLessonTrigger)"
      via: "Regenerator reads lesson frontmatter via lesson-writer's helper; uses trigger if present, falls back to truncated body"
      pattern: "readLessonTrigger"
    - from: "src/scripts/migrate-lesson-trigger.ts"
      to: "src/angel/lesson-writer.ts (writeLessonFrontmatter)"
      via: "Migration tool reuses lesson-writer's atomic write helper for byte-safety"
      pattern: "writeLessonFrontmatter"
---

<objective>
Three deliverables folded into one plan, all addressing session-start coherence concerns surfaced by the 2026-05-16 operator audit:

1. **Regenerator fix** — `src/angel/memory-md-writer.ts` is rewritten so User Notes section is BYTE-EQUIVALENT across regenerations. Lessons index is rendered from on-disk lesson files (not from a transient computed set that can wipe). Round-trip test enforces.

2. **Lesson `trigger:` frontmatter** — `src/angel/lesson-writer.ts` emits the new field on new lesson writes. `src/scripts/migrate-lesson-trigger.ts` is the operator-runnable CLI to add the field to existing files. Regenerator and the lessons section formatter use `trigger:` when present; fall back to truncated-body when missing (until migrated).

3. **Experience-tier project-scope filter** — `src/intelligence/experience-tier.ts` filters passive-injection cross-project patterns out. Cross-project patterns remain in the searchable index (claudex_search) but do not surface in the per-turn `## Past Experience — Relevant Patterns` block.

After this plan lands:
- MEMORY.md regenerates safely across 10+ runs without losing User Notes or Lessons index.
- Lesson section in MEMORY.md shows trigger condition + rule (when migrated), not "first N chars of body."
- Per-turn passive injection contains zero cross-project patterns (when filter is at default same-project-only).

| What this plan provides | Why |
|---|---|
| Regenerator preserves User Notes byte-equivalent | The 2026-05-14 wipe regression cannot recur |
| Lessons index regenerates from on-disk files | Single source of truth; no transient state |
| Trigger-style frontmatter | Lessons surface as triggers + rules, not truncated body |
| Migration tool for existing lessons | Operator opts in; no auto-migration |
| Project-scope passive injection | Cross-project noise eliminated from session-start |
| Configurable filter threshold | Operator can re-enable cross-project surface if needed |
</objective>

<execution_context>
@C:/Users/Grigorije/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/Grigorije/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/14-substrate-coherence/14-07-CONTEXT.md
@.planning/phases/14-substrate-coherence/14-07-WAVE3-COORDINATION.md
@src/angel/memory-md-writer.ts
@src/angel/lesson-writer.ts
@src/intelligence/experience-tier.ts
@src/assembly/sections.ts
</context>

<anti_scope>
- Do NOT modify the User Notes section content under any circumstances. Even if the operator's content looks stale, the regenerator NEVER touches it.
- Do NOT auto-migrate existing lesson files. The `migrate-lesson-trigger.ts` CLI is operator-runnable; dry-run by default.
- Do NOT change the assembler cascade order (P-numbers locked).
- Do NOT modify link tables or link-writer.ts (Wave 2 territory).
- Do NOT touch the codebase-context formatter (14-07i territory).
- Do NOT touch hybrid-retrieval ranking math.
- Do NOT change the reranker, embedder, or vector dimensions.
- Do NOT remove or hide the `## Past Experience — Relevant Patterns` section entirely; only filter to in-project.
- Do NOT inline-expand lessons in MEMORY.md or the assembler in this plan. Inline-expansion is 14-07j's territory; H establishes the lessons-section function shape that J extends.
- Do NOT add new MCP tools.
- Do NOT modify the V17 artifact schema or caller migration (Wave 1 territory).
</anti_scope>

<tasks>

<task type="auto">
  <name>Task 1: Fix MEMORY.md regenerator</name>
  <files>src/angel/memory-md-writer.ts</files>
  <action>
Audit + rewrite the regeneration logic. The 2026-05-14 wipe happened because the regenerator computed the Lessons index from a transient runtime set; if that set was empty, the section was rendered empty, overwriting the prior content.

**New invariant:** Lessons index is computed by scanning the on-disk lesson files (`memory/feedback_*.md`, `memory/project_*.md`, `memory/reference_*.md`, `memory/user_*.md`). The regenerator NEVER renders an empty Lessons section if files exist on disk.

**New invariant:** User Notes section is preserved byte-equivalent. The regenerator reads the existing MEMORY.md (if present), extracts everything from the `<!-- USER EDITABLE -->` marker to EOF, and re-emits it verbatim after regeneration.

Implementation:

```typescript
export interface RegenerateMemoryMdParams {
  db: Database;
  project: string;
  memory_dir: string;       // ~/.claude/projects/<project-key>/memory/
}

export function regenerateMemoryMd(p: RegenerateMemoryMdParams): { wrote: boolean; warnings: string[] };
```

Steps:

1. Read existing `memory/MEMORY.md` if present. Extract:
   - Lines from `<!-- CLAUDEX-MANAGED:...` to `<!-- USER EDITABLE -->` (managed section).
   - Lines from `<!-- USER EDITABLE -->` to EOF (user-editable section).

2. If the file is missing OR the `<!-- USER EDITABLE -->` marker is missing, REFUSE to write and surface an error with `warnings: ['user_editable_marker_missing']`. Operator must hand-craft the marker before regeneration can proceed.

3. Recompute managed section content:
   - **Active Projects:** existing logic.
   - **Lessons:** scan `memory_dir` for files matching `feedback_*.md`, `project_*.md`, `reference_*.md`, `user_*.md`. Per file, read frontmatter; emit one line per file with `[<description-or-trigger>](filename) — <task-pattern-or-empty>`.
   - **Handoff:** existing logic.
   - **How to Query:** existing static text.

4. Concatenate: managed section + `\n<!-- USER EDITABLE -->\n` + user-editable section (verbatim).

5. Atomic write via `tmp + rename`.

6. Round-trip safety: emit a SHA256 of the User Notes section pre/post write to telemetry (`memory_md_regen_round_trip`). If hashes differ, surface as warning.

**Critical:** the existing implementation's Lessons-rendering function MUST be replaced. The new function scans on-disk files; never uses a "current set of lessons" passed in from outside. This eliminates the wipe failure mode.
  </action>
  <verification>
- Regenerator preserves User Notes byte-equivalent across runs.
- Missing User Notes marker → refusal with warning (no wipe).
- Lessons index reflects on-disk files (count matches file count).
- 10 consecutive regenerations preserve User Notes + Lessons index identically.
- Telemetry round-trip hash row written per regeneration.
  </verification>
</task>

<task type="auto">
  <name>Task 2: Lesson trigger frontmatter</name>
  <files>src/angel/lesson-writer.ts</files>
  <action>
Extend lesson frontmatter schema to include an optional `trigger:` field.

```yaml
---
name: feedback-take-position-unless-flagged
description: ...
trigger: When facing an open design question with 2+ defensible options, take a position with reasoning rather than asking which option.
metadata:
  type: feedback
---
```

Update `writeLesson` / `writeLessonFrontmatter` (whatever the canonical write function is named) to:
- Accept `trigger?: string` in input.
- Emit `trigger: <value>` in the frontmatter when provided.
- Omit the field when not provided (existing lessons without trigger remain valid).

Add `readLessonTrigger(file_path): string | null` helper that reads a lesson file and returns the trigger field value (or null if not present). Used by the regenerator + sections formatter.

**Anti-change:** existing lessons WITHOUT a trigger field stay valid. The regenerator falls back to truncated-body for them. Migration is opt-in via Task 3.
  </action>
  <verification>
- New lessons written with `trigger: ...` field emit it correctly.
- New lessons without trigger emit valid frontmatter (no field).
- readLessonTrigger returns the field value when present.
- readLessonTrigger returns null when missing.
- Pre-existing lesson files unchanged by this Task.
  </verification>
</task>

<task type="auto">
  <name>Task 3: migrate-lesson-trigger.ts CLI</name>
  <files>src/scripts/migrate-lesson-trigger.ts</files>
  <action>
Create the operator-runnable migration tool. Pattern follows Phase 14-01's migrate-handoff.ts.

```
Usage:
  bun src/scripts/migrate-lesson-trigger.ts <memory_dir> [options]

Options:
  --dry-run             Print proposed changes; do not write.
  --infer               Infer trigger from body first sentence. Refuses on ambiguity.
  --trigger '<text>'    Use this trigger for the next matched file. Single-file mode.
  --file '<name>'       Limit to a specific lesson file.
  --skip-existing       Skip files that already have a trigger field.

Exit codes:
  0 — success / dry-run-success / idempotent
  1 — inference failed
  2 — IO error
```

Implementation:

1. Scan `<memory_dir>` for lesson files matching `feedback_*.md`, `project_*.md`, `reference_*.md`, `user_*.md`.
2. Per file:
   - Read frontmatter.
   - If `trigger:` present AND `--skip-existing` set: skip.
   - If `trigger:` present AND NOT `--skip-existing`: refuse to overwrite without an explicit `--force` flag (refusal pattern from 14-01).
   - Else: infer (via `--infer`) or use `--trigger` value (single-file mode), then write atomically.

3. Inference rule: take the body's first sentence; if it starts with "When ", use it verbatim; else prepend "When [topic] → " and use the first sentence — but if the body is empty OR the first sentence is too vague (no clear condition), REFUSE the file with an explicit reason.

4. Atomic write: tmp + rename, preserve permissions, preserve all other frontmatter fields.

5. Dry-run: print unified diff to stdout per file; do not write.

6. Verbose stderr on refusals.
  </action>
  <verification>
- CLI scans memory_dir; finds matching files.
- --dry-run prints diff; no writes.
- --infer succeeds on clear-condition body; refuses on ambiguous.
- --trigger '<text>' overrides inference for the single matched file.
- --skip-existing leaves files with `trigger:` unchanged.
- Idempotent: re-running on migrated files is a no-op.
- Original file contents preserved (only trigger field added; body unchanged).
  </verification>
</task>

<task type="auto">
  <name>Task 4: Experience-tier project-scope filter</name>
  <files>src/intelligence/experience-tier.ts</files>
  <action>
Add a project-scope filter at the passive-injection path.

```typescript
export interface ExperienceTierConfig {
  passive_injection_scope: 'same_project_only' | 'all_projects';
  // default: 'same_project_only'
}

/**
 * Filter pattern candidates by project scope at the passive injection point.
 *
 * 'same_project_only' (default): only patterns where the pattern's
 * origin project matches the current project surface.
 *
 * 'all_projects': legacy behavior (no filter).
 */
export function filterToProjectScope(
  candidates: ExperiencePattern[],
  current_project: string,
  scope: 'same_project_only' | 'all_projects'
): ExperiencePattern[];
```

Locate the call site in experience-tier.ts where `fetchCandidatePool` returns candidates for the passive injection. After the existing isSubstantive filter, apply `filterToProjectScope` with the configured scope (default `same_project_only`).

The scope is configurable via env var `CLAUDEX_EXPERIENCE_SCOPE` (values: `same_project_only` | `all_projects`). Default OFF the env var → same_project_only behavior.

Add `// 14-07h: project-scope filter` comment marker.

Telemetry: emit `experience_tier_filtered` per filter pass with `{ total_candidates, after_substantive, after_project_scope }`.
  </action>
  <verification>
- Same-project-only filter excludes cross-project patterns from passive injection candidates.
- All-projects mode preserves legacy behavior.
- Configurable via env var.
- Telemetry row emitted per filter pass.
- Existing tests pass (legacy mode = all_projects path).
- New test confirms zero cross-project patterns in default mode.
  </verification>
</task>

<task type="auto">
  <name>Task 5: Lessons section formatter in sections.ts</name>
  <files>src/assembly/sections.ts</files>
  <action>
Add (or refactor) the lessons section formatter. Per WAVE3-COORDINATION, H owns this function; J will EXTEND it later for inline-expansion.

Function name: `formatProvenPrinciplesSection` (lock the name; J extends this same function).

```typescript
import { readLessonTrigger } from '../angel/lesson-writer.js';

export interface LessonsSectionParams {
  db: Database;
  project: string;
  memory_dir: string;
  budget_tokens: number;
}

/**
 * Phase 14-07h — lessons section formatter.
 *
 * Renders the lessons pointer list at session-start. For each lesson
 * file, reads the `trigger:` frontmatter if present and uses it as
 * the display title. Falls back to truncated-body (existing behavior)
 * for lessons without the trigger field.
 *
 * 14-07j will extend this function to inline-expand the top 2-3
 * lessons by relevance. H ships this function; J extends post-merge.
 */
export function formatProvenPrinciplesSection(p: LessonsSectionParams): string | null;
```

Implementation:

1. Scan `memory_dir` for lesson files. Read each lesson's frontmatter (`name`, `description`, `trigger?`).
2. Sort by file mtime DESC (most recently updated first), tiebreak by name.
3. Per lesson, render one line:
   ```
   - [<display>] (<filename>)
   ```
   where `<display>`:
   - If `trigger:` present: use it verbatim (truncate to ~120 chars).
   - Else: use truncated body's first 60 chars + `…`.
4. Budget cap: cut the list when budget reached; append "... and N more lessons available" message.
5. Section header: `## Lessons` (note: this differs from MEMORY.md's `## Lessons` header — sections.ts is for assembler, not MEMORY.md; both happen to use the same header text).

Add `// 14-07h: lessons section formatter (J extends post-merge for inline-expansion)` comment marker.
  </action>
  <verification>
- Function returns formatted section string with one line per lesson.
- Trigger-based display when frontmatter has trigger.
- Truncated-body fallback when trigger missing.
- Budget cap enforced; truncation message appended.
- Mtime-DESC sort.
- Returns null when no lesson files found in memory_dir.
  </verification>
</task>

<task type="auto">
  <name>Task 6: Tests — regenerator round-trip</name>
  <files>src/tests/angel/memory-md-writer.test.ts</files>
  <action>
Add new describe block: `describe('Phase 14-07h regenerator round-trip + user notes preservation', ...)`.

Tests:

1. `round-trip: 10 consecutive regenerations preserve User Notes byte-equivalent`
2. `round-trip: 10 consecutive regenerations preserve Lessons index byte-equivalent`
3. `missing user-editable marker: regenerator REFUSES, returns wrote=false with warning`
4. `empty memory_dir: Lessons section is empty but section header present (no wipe regression — historical state preserved if reading from prior file)`
5. `lesson with trigger field: rendered using trigger`
6. `lesson without trigger field: rendered using truncated body`
7. `User Notes section contains custom markdown: preserved verbatim including formatting`
8. `telemetry round_trip_hash row emitted per regeneration`

Preserve all existing tests.
  </action>
  <verification>
- 8 new tests pass.
- Existing tests still pass.
  </verification>
</task>

<task type="auto">
  <name>Task 7: Tests — lesson writer, migration tool, experience-tier filter, lessons section</name>
  <files>src/tests/angel/lesson-writer.test.ts, src/tests/scripts/migrate-lesson-trigger.test.ts, src/tests/intelligence/experience-tier-project-scope.test.ts, src/tests/assembly/lessons-trigger-rendering.test.ts</files>
  <action>
**lesson-writer.test.ts** — add 4 tests:
1. `writeLesson with trigger: frontmatter contains trigger field`
2. `writeLesson without trigger: frontmatter omits trigger`
3. `readLessonTrigger returns field value when present`
4. `readLessonTrigger returns null when absent`

**migrate-lesson-trigger.test.ts** — new file, 10 tests:
1. `dry-run prints diff; no writes`
2. `--infer succeeds on clear-condition body`
3. `--infer refuses on ambiguous body`
4. `--trigger '<text>' overrides for single file`
5. `--file scopes to one filename`
6. `--skip-existing leaves migrated files alone`
7. `--force overwrites existing trigger`
8. `Idempotent: re-running with --skip-existing is a no-op`
9. `Preserves other frontmatter fields byte-equivalent`
10. `Preserves body content byte-equivalent`

**experience-tier-project-scope.test.ts** — new file, 7 tests:
1. `filterToProjectScope: same_project_only excludes cross-project candidates`
2. `filterToProjectScope: all_projects preserves all`
3. `Default scope: same_project_only`
4. `Env var override: CLAUDEX_EXPERIENCE_SCOPE=all_projects → all-projects mode`
5. `Passive injection: zero cross-project patterns in default mode`
6. `Telemetry row emitted per filter pass`
7. `Empty current_project: filter returns empty (defensive)`

**lessons-trigger-rendering.test.ts** — new file, 6 tests:
1. `formatProvenPrinciplesSection with N lessons: section has N lines`
2. `Lesson with trigger: line shows trigger`
3. `Lesson without trigger: line shows truncated-body fallback`
4. `Budget cap: truncates with "... and N more" message`
5. `Mtime-DESC sort`
6. `Empty memory_dir: returns null`
  </action>
  <verification>
- 4 + 10 + 7 + 6 = 27 new tests pass.
  </verification>
</task>

<task type="auto">
  <name>Task 8: Build + test sweep + operator-runnable migration smoke</name>
  <files></files>
  <action>
- `bun run build` — must succeed.
- `npx vitest run src/tests/angel/memory-md-writer.test.ts src/tests/angel/lesson-writer.test.ts src/tests/scripts/migrate-lesson-trigger.test.ts src/tests/intelligence/experience-tier-project-scope.test.ts src/tests/assembly/lessons-trigger-rendering.test.ts` — 8 + 4 + 10 + 7 + 6 = 35 new tests pass.
- `npx vitest run` — full suite green.
- `bun run vesna` — SC#1 PASS 18/18.
- **Operator-runnable smoke (NOT auto):** `bun src/scripts/migrate-lesson-trigger.ts ~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory --dry-run` — preview output for the existing 17+ lesson files. Document in `14-07-WAVE3-STATUS.md`.
- **Regenerator smoke:** run regenerator against the actual MEMORY.md; verify User Notes section preserved byte-equivalent.
  </action>
  <verification>
- Build green.
- 35 new tests pass.
- Full suite green.
- Vesna SC#1 PASS.
- Migration tool dry-run output reviewed.
- Regenerator smoke confirms User Notes preservation.
  </verification>
</task>

</tasks>

<acceptance_criteria>
- AC-1: Regenerator preserves User Notes section byte-equivalent across 10 consecutive runs.
- AC-2: Regenerator refuses to write when `<!-- USER EDITABLE -->` marker is missing.
- AC-3: Lessons index regenerated from on-disk files (no wipe possible from transient state).
- AC-4: Telemetry round_trip_hash row emitted per regeneration.
- AC-5: Lesson frontmatter accepts optional `trigger:` field.
- AC-6: New lessons written with trigger field emit it; existing lessons unaffected.
- AC-7: `migrate-lesson-trigger.ts` CLI exists; dry-run default; --infer + --trigger modes.
- AC-8: CLI is idempotent on already-migrated files (with --skip-existing); refuses overwrite without --force.
- AC-9: Migration tool preserves all other frontmatter fields + body content byte-equivalent.
- AC-10: Experience-tier filter excludes cross-project patterns from passive injection (default mode).
- AC-11: Filter configurable via `CLAUDEX_EXPERIENCE_SCOPE` env var.
- AC-12: `formatProvenPrinciplesSection` function added to sections.ts; H owns it; J extends post-merge.
- AC-13: Lessons section uses trigger frontmatter when present; falls back to truncated-body when missing.
- AC-14: All 35 new tests pass.
- AC-15: Vesna SC#1 PASS 18/18 unchanged.
- AC-16: Operator-runnable migration tool dry-run smoke documented.
- AC-17: Regenerator smoke against real MEMORY.md preserves User Notes byte-equivalent.
</acceptance_criteria>

<risks>
- **Risk 1: Regenerator change breaks an existing call site.** Mitigation: signature change is opt-in (new params optional with defaults). All existing callers continue to work. New round-trip test catches regressions.
- **Risk 2: Migration tool infers wrong trigger.** Bad trigger means MEMORY.md surfaces wrong cues. Mitigation: dry-run default; refusal-on-ambiguity; operator reviews output before live run. Tool re-runnable with `--trigger` override per file.
- **Risk 3: Experience-tier filter too aggressive — useful cross-project patterns blocked.** Mitigation: configurable; env var to revert; operator can claudex_search for cross-project patterns when needed.
- **Risk 4: User Notes section preservation breaks on Windows line-ending differences.** Mitigation: preservation reads raw bytes; writes raw bytes; no line-ending normalization. Test on Windows fixtures.
- **Risk 5: Lesson body truncation produces unhelpful display.** Mitigation: trigger frontmatter is the durable fix; truncated-body is the transitional fallback. Operator migrates over time.
- **Risk 6: J's later extension to formatProvenPrinciplesSection conflicts with H's shape.** Mitigation: WAVE3-COORDINATION enforces H ships first; J rebases. H's function shape is explicit (in this PLAN.md); J reads it before extending.
- **Risk 7: Existing lesson files have invalid frontmatter that breaks readLessonTrigger.** Mitigation: readLessonTrigger wraps in try/catch; returns null on parse failure; fall-back path still renders the lesson.
</risks>

<external_review_gate>
Codex + Gemini cross-family review focuses on:
- (a) Regenerator User-Notes-preservation correctness — is the byte-equivalence airtight?
- (b) Migration tool refusal-on-ambiguity — does the inference rule catch the right cases?
- (c) Experience-tier filter default — is same_project_only the right default, or should this require operator opt-in?
- (d) Lessons section function shape — is it stable enough for J to extend without breaking?
- (e) Telemetry — round_trip_hash is the right diagnostic; would experience_tier_filtered shape inform operator action?

**Operator review gate (per WAVE3-COORDINATION):** operator reviews the migration tool's dry-run output against existing lesson files BEFORE live run. NO-SIGNOFF on dry-run = tool not run on production lesson files.

NO-SIGNOFF on Codex/Gemini triggers PM escalation.
</external_review_gate>

<methodology_gates>
1. Pre-committed AC matrix above.
2. Tests written alongside code (35 new tests + smoke).
3. Live-wiring smoke: regenerator against real MEMORY.md; migration dry-run against real lesson dir.
4. No "MVP" shortcuts — User Notes preservation + refusal-on-ambiguity are the production-quality safeguards.
5. Negative results valid: if migration dry-run reveals widespread ambiguity, surface to operator before live run; do not loosen the inference rule.
6. Cross-family external review.
7. No time estimates.
</methodology_gates>
