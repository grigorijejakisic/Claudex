---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: 07j
type: execute
wave: 3
depends_on: ["07-LINKS-SCHEMA", "07h"]
files_modified:
  - src/assembly/sections/lessons.ts (Wave 0 w0d split; J extends formatProvenPrinciplesSection post-H-merge)
  - src/intelligence/lesson-relevance.ts (NEW)
  - src/tests/intelligence/lesson-relevance.test.ts (NEW)
  - src/tests/assembly/lesson-inline-expansion.test.ts (NEW)
autonomous: true
requirements: []

must_haves:
  truths:
    - "Link-aware lesson inline-expansion is the deepest session-start coherence change in v7.0.0. At session-start, the top 2-3 lessons selected by relevance get their FULL body inlined into the lessons section; the rest stay as pointer lines per 14-07h's baseline rendering."
    - "Relevance score = function of: (a) trigger-match strength (how well the lesson's `trigger:` frontmatter matches the current pivot string); (b) link distance from the lesson to current pivot artifacts via Wave 2 link graph (closer = higher relevance)."
    - "Trigger-match strength uses a simple keyword overlap heuristic: count common words between the lesson's trigger and the pivot, normalized by trigger length. Score ∈ [0, 1]."
    - "Link-distance score = `1 / hop_distance` (linked at 1 hop = 1.0, 2 hops = 0.5, 3 hops = 0.33, etc.); unreachable = 0. Uses claudex_trace internals or a direct call to provenance-walker for traversal."
    - "Combined relevance = `0.6 * trigger_match + 0.4 * link_distance`. Locked weights. Tunable post-ship via env var (`CLAUDEX_LESSON_RELEVANCE_TRIGGER_WEIGHT`, default 0.6)."
    - "Position-unless-flagged on combined weights: 60/40 trigger/link is the lean because trigger-match is the direct semantic signal (operator wrote the trigger), while link distance is structural (graph topology). If PM flags this, alternatives are 50/50 (equal weight) or 80/20 (trigger-dominant)."
    - "Top-K selection: K=3 by default. Configurable via `CLAUDEX_LESSON_INLINE_K` (default 3, capped at 5 to bound budget)."
    - "Inline-expanded lesson budget: 400 tokens TOTAL across all K lessons. Per-lesson budget ~130 tokens (header + 1-3 body sentences). Lessons longer than ~130 tokens are truncated with ellipsis."
    - "This plan EXTENDS H's `formatProvenPrinciplesSection`. H ships first; J rebases onto integration branch and adds inline-expansion as additional behavior, not a rewrite. The function shape: H's signature stays; J extends the implementation."
    - "If Wave 2 link graph is sparse (early adoption), link-distance score will be 0 for most lessons; relevance falls back to trigger-match alone. This is acceptable — inline-expansion degrades gracefully to trigger-only selection."
    - "If no lesson has trigger frontmatter (transitional state pre-migration of existing lessons), relevance scoring uses truncated-body keyword overlap as the trigger proxy. Quality lower; inline-expansion still functional."
  artifacts:
    - path: "src/intelligence/lesson-relevance.ts"
      provides: "Relevance scoring: per-lesson combined score of trigger-match + link-distance to current pivot. Pure function + helpers."
      contains: "computeLessonRelevance|computeTriggerMatch|computeLinkDistanceScore|selectTopKLessons"
    - path: "src/assembly/sections/lessons.ts"
      provides: "Lessons section formatter extended (H's formatProvenPrinciplesSection, in sections/lessons.ts post-Wave-0 split) to inline-expand top-K lessons by relevance. J rebases onto H's branch and extends in-place."
      contains: "formatProvenPrinciplesSection|inlineExpandLesson"
    - path: "src/tests/intelligence/lesson-relevance.test.ts"
      provides: "Tests for relevance scoring: trigger match correctness, link distance scoring, combined weight, top-K selection"
      contains: "trigger_match|link_distance|combined|top_k"
    - path: "src/tests/assembly/lesson-inline-expansion.test.ts"
      provides: "Tests for inline-expansion: top-K inlined, rest as pointers, budget cap, sparse-link fallback"
      contains: "inline_expansion|budget|sparse_link|fallback"
  key_links:
    - from: "src/intelligence/lesson-relevance.ts (computeLinkDistanceScore)"
      to: "src/intelligence/provenance-walker.ts (walkProvenance) OR src/mcp/tools/claudex-trace.ts (handleClaudexTrace)"
      via: "Reuses Wave 2's graph walker; either provenance (directed) or trace (general); J authors decision: claudex_trace's BFS is more general for relevance scoring"
      pattern: "handleClaudexTrace|walkProvenance"
    - from: "src/assembly/sections/lessons.ts (formatProvenPrinciplesSection extended)"
      to: "src/intelligence/lesson-relevance.ts (selectTopKLessons)"
      via: "Section formatter consults relevance scorer to pick which lessons to inline"
      pattern: "selectTopKLessons"
---

<objective>
Two deliverables in one plan:

1. **`src/intelligence/lesson-relevance.ts`** — relevance scoring helpers. Per-lesson combined score of trigger-match + link-distance to current pivot artifacts. Used by the assembler to select top-K lessons to inline.

2. **Extended `formatProvenPrinciplesSection`** — H ships the baseline lessons section formatter in `sections/lessons.ts` (14-07h); J rebases onto H's branch and extends the function in `sections/lessons.ts` to inline-expand the top-K lessons by relevance. The rest of the lessons stay as pointer lines per H's rendering.

After this plan lands:
- Top 2-3 lessons relevant to the current pivot appear FULL-BODY in the assembler's lessons section.
- Other lessons remain as pointers (one-line per lesson).
- Relevance is data-driven: triggers + link graph distance.
- Sparse-link cases (early adoption when graph is empty) degrade gracefully to trigger-only selection.

| What this plan provides | Why |
|---|---|
| Trigger-match scoring | Semantic relevance via operator-written triggers |
| Link-distance scoring | Structural relevance via Wave 2 graph |
| Combined relevance score | Single ranking dimension |
| Top-K inline-expansion in lessons section | User-facing payoff — lessons feel remembered, not pointed at |
| Sparse-link fallback | Works even when link graph is empty |
| Budget cap on inline-expanded content | 400 tokens total; per-lesson cap ~130 |
</objective>

<execution_context>
@C:/Users/Grigorije/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/Grigorije/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/14-substrate-coherence/14-07-CONTEXT.md
@.planning/phases/14-substrate-coherence/14-07-WAVE3-COORDINATION.md
@.planning/phases/14-substrate-coherence/14-07h-PLAN.md
@.planning/phases/14-substrate-coherence/14-07-LINKS-SCHEMA-PLAN.md
@.planning/phases/14-substrate-coherence/14-07e-PLAN.md
@src/assembly/sections.ts
@src/core/hybrid-retrieval.ts
@src/mcp/tools/claudex-trace.ts
@src/core/link-writer.ts
</context>

<anti_scope>
- Do NOT modify H's lessons-section function shape. J EXTENDS the function; J does NOT rewrite it. Coordinate via WAVE3-COORDINATION's enforced merge order (H first, J rebases).
- Do NOT modify any other function in `src/assembly/sections.ts`. J owns ONLY the extension to formatProvenPrinciplesSection.
- Do NOT modify lesson files. Trigger frontmatter is read-only for this plan.
- Do NOT modify MEMORY.md regenerator (14-07h territory).
- Do NOT modify experience-tier filter (14-07h territory).
- Do NOT modify codebase-context formatter (14-07i territory).
- Do NOT modify link tables or link-writer.ts (Wave 2 territory).
- Do NOT modify hybrid-retrieval ranking math.
- Do NOT change the assembler cascade order.
- Do NOT inline-expand more than K lessons (default K=3, cap 5).
- Do NOT inline a lesson without trigger frontmatter unless the operator has explicitly migrated all lessons to have trigger. Transitional state: degrade to trigger-only-from-body for lessons without trigger.
</anti_scope>

<tasks>

<task type="auto">
  <name>Task 1: lesson-relevance.ts scoring helpers</name>
  <files>src/intelligence/lesson-relevance.ts</files>
  <action>
Create new file with the relevance scorer.

```typescript
import type { Database } from 'better-sqlite3';
import { handleClaudexTrace } from '../mcp/tools/claudex-trace.js';
import { readLessonTrigger } from '../angel/lesson-writer.js';

/**
 * Phase 14-07j — lesson relevance scoring.
 *
 * Combines trigger-match (lexical) with link-distance (structural)
 * for a single per-lesson score. Used by the assembler to select
 * which lessons to inline-expand at session-start.
 */

export const DEFAULT_TRIGGER_WEIGHT = 0.6;
export const DEFAULT_LINK_WEIGHT = 0.4;
export const DEFAULT_TOP_K = 3;
export const MAX_TOP_K = 5;

export interface LessonRelevanceParams {
  lesson_file_path: string;
  lesson_artifact_id?: string;   // V17 ID of lesson artifact, if present in DB
  pivot_text: string;             // The current session pivot string
  pivot_artifact_ids: string[];   // Artifact IDs for the pivot context (for link-distance)
  db: Database;
  trigger_weight?: number;        // default DEFAULT_TRIGGER_WEIGHT
}

export interface LessonRelevanceResult {
  lesson_file_path: string;
  combined_score: number;
  trigger_match_score: number;
  link_distance_score: number;
  trigger_text: string | null;   // The trigger used for matching (null = body fallback)
}

export function computeLessonRelevance(p: LessonRelevanceParams): LessonRelevanceResult;

/**
 * Compute keyword-overlap score between trigger and pivot.
 * Score = (count of common words) / (count of words in trigger).
 * Stopwords filtered. Lowercase. Score ∈ [0, 1].
 */
export function computeTriggerMatch(trigger: string, pivot: string): number;

/**
 * Compute link-distance score: 1 / shortest_hop_distance from lesson_artifact_id
 * to any pivot_artifact_id. 0 if unreachable within max_hops (default 4).
 *
 * Returns 0 when:
 *   - lesson_artifact_id missing (lesson not in V17 artifact table)
 *   - pivot_artifact_ids empty
 *   - lesson unreachable within max_hops
 */
export function computeLinkDistanceScore(
  db: Database,
  lesson_artifact_id: string | undefined,
  pivot_artifact_ids: string[],
  max_hops?: number
): number;

export interface SelectTopKParams {
  lessons: Array<{ file_path: string; artifact_id?: string }>;
  pivot_text: string;
  pivot_artifact_ids: string[];
  db: Database;
  k?: number;
  trigger_weight?: number;
}

export function selectTopKLessons(p: SelectTopKParams): LessonRelevanceResult[];
```

Implementation:

- `computeTriggerMatch`: split both trigger and pivot into lowercase words, filter stopwords (a/the/and/or/of/etc.), count overlap, divide by trigger word count. If trigger empty, return 0. If pivot empty, return 0.
- `computeLinkDistanceScore`: call `handleClaudexTrace({ artifact_id: lesson_artifact_id, max_hops: 4, direction: 'both' })`. For each pivot_artifact_id in the trace result, take the minimum hop_distance. Return `1 / min_hop_distance` (or 0 if unreachable).
- `computeLessonRelevance`: read trigger via `readLessonTrigger(lesson_file_path)`. If null, use truncated body as trigger fallback. Compute both subscores. Combined = `trigger_weight * trigger_match + (1 - trigger_weight) * link_distance`.
- `selectTopKLessons`: compute relevance for all lessons, sort desc by combined_score, return top K (capped at MAX_TOP_K). Tie-break by file_path alphabetical.
- Env var override: read `CLAUDEX_LESSON_RELEVANCE_TRIGGER_WEIGHT` for trigger_weight; `CLAUDEX_LESSON_INLINE_K` for K.
  </action>
  <verification>
- computeTriggerMatch: identical strings → score 1.0.
- computeTriggerMatch: zero overlap → score 0.0.
- computeTriggerMatch: half overlap → score 0.5.
- computeTriggerMatch: stopwords ignored.
- computeLinkDistanceScore: directly linked lesson → 1.0.
- computeLinkDistanceScore: two-hop → 0.5.
- computeLinkDistanceScore: unreachable → 0.
- computeLinkDistanceScore: missing artifact_id → 0.
- computeLessonRelevance: combined formula correct.
- computeLessonRelevance: fallback to truncated-body when trigger missing.
- selectTopKLessons: returns top K by combined score; tie-break alphabetical.
- selectTopKLessons: env var override respected.
- K capped at MAX_TOP_K.
  </verification>
</task>

<task type="auto">
  <name>Task 2: Extend formatProvenPrinciplesSection for inline-expansion</name>
  <files>src/assembly/sections.ts</files>
  <action>
Extend H's `formatProvenPrinciplesSection`. CRITICAL: this Task happens AFTER H lands (per WAVE3-COORDINATION merge order). J rebases onto integration branch and extends the function — does NOT rewrite H's shape.

Extended behavior:

1. After H's existing pointer-list generation, BEFORE returning the section string, J adds an inline-expansion step:
   - Read pivot_text and pivot_artifact_ids from section params (params extended with these fields by J — coordinate with H's signature).
   - Call `selectTopKLessons` to get top-K lessons by relevance.
   - For each top-K lesson, read the lesson's full body content.
   - Inline-expand the lesson at the TOP of the lessons section (before the pointer list).
   - The remaining lessons (not in top-K) appear as pointer lines per H's rendering.

2. Inline-expanded lesson format:
   ```
   ### [<trigger>]
   <truncated lesson body, ~130 tokens>
   *Source: <filename>*
   ```

3. Budget: 400 tokens TOTAL across all inline-expanded lessons. Per-lesson cap ~130 tokens. Truncate body with ellipsis if longer.

4. After inline-expansion block, render the pointer list for the REMAINING lessons (non-top-K).

5. If pivot_text + pivot_artifact_ids are empty/absent (early session-start with no context), skip inline-expansion entirely; render full pointer list per H's baseline. Graceful fallback.

6. If sparse link graph (no link distance signal), relevance falls back to trigger-match alone (already handled by lesson-relevance.ts).

H's function signature gets extended with optional new parameters:
```typescript
export interface LessonsSectionParams {
  db: Database;
  project: string;
  memory_dir: string;
  budget_tokens: number;
  // NEW (J extends):
  pivot_text?: string;
  pivot_artifact_ids?: string[];
  inline_top_k?: number;     // default DEFAULT_TOP_K
}
```

Add `// 14-07j: inline-expansion of top-K lessons` comment marker around the new block.

The assembler.ts call site (already wired by H) gets extended to pass pivot_text + pivot_artifact_ids from the cascade context. Coordinate with H if needed.
  </action>
  <verification>
- H's existing lessons-section behavior preserved when new params absent.
- New params present: top-K lessons inline-expanded at top of section.
- Inline-expanded lessons rendered with trigger as H3 header + body + source line.
- Remaining lessons appear as pointer lines per H's baseline.
- Budget cap (400 tokens) enforced across inline-expanded set.
- Per-lesson body truncated at ~130 tokens.
- Sparse link graph: trigger-only selection works; section still renders correctly.
- Tests pass with both pivot present and absent.
  </verification>
</task>

<task type="auto">
  <name>Task 3: Tests for lesson-relevance</name>
  <files>src/tests/intelligence/lesson-relevance.test.ts</files>
  <action>
New test file. Tests:

1. `computeTriggerMatch: identical strings → 1.0`
2. `computeTriggerMatch: zero overlap → 0.0`
3. `computeTriggerMatch: half overlap → 0.5 (approximately)`
4. `computeTriggerMatch: stopwords ignored (the/a/and/of/etc.)`
5. `computeTriggerMatch: empty trigger → 0`
6. `computeTriggerMatch: empty pivot → 0`
7. `computeTriggerMatch: case-insensitive`
8. `computeLinkDistanceScore: directly linked (1 hop) → 1.0`
9. `computeLinkDistanceScore: two-hop → 0.5`
10. `computeLinkDistanceScore: three-hop → ~0.333`
11. `computeLinkDistanceScore: unreachable within 4 hops → 0`
12. `computeLinkDistanceScore: missing lesson_artifact_id → 0`
13. `computeLinkDistanceScore: empty pivot_artifact_ids → 0`
14. `computeLessonRelevance: combined formula correct (0.6 * tm + 0.4 * ld)`
15. `computeLessonRelevance: fallback to truncated-body when no trigger frontmatter`
16. `selectTopKLessons: sorts desc by combined, returns top K`
17. `selectTopKLessons: K capped at MAX_TOP_K (5)`
18. `selectTopKLessons: env var trigger weight override`
19. `selectTopKLessons: env var K override (within MAX_TOP_K)`
20. `selectTopKLessons: tie-break alphabetical by file_path`
  </action>
  <verification>
- 20 tests pass.
  </verification>
</task>

<task type="auto">
  <name>Task 4: Tests for inline-expansion in lessons section</name>
  <files>src/tests/assembly/lesson-inline-expansion.test.ts</files>
  <action>
New test file. Tests:

1. `pivot_text + pivot_artifact_ids absent: behaves like H's baseline (pointer list)`
2. `pivot_text + pivot_artifact_ids present: top-K inline-expanded`
3. `Inline-expanded lesson has trigger as H3 header`
4. `Inline-expanded lesson body truncated at ~130 tokens`
5. `Source line includes lesson filename`
6. `Remaining lessons appear as pointer lines`
7. `Budget cap (400 tokens total) enforced across inline-expanded set`
8. `Empty memory_dir: returns null per H's existing logic`
9. `Sparse link graph (no link distance signal): trigger-only ranking`
10. `Pivot keywords matching some lessons but not others: ranked correctly`
11. `K=0 explicitly: no inline-expansion; pointer list only`
12. `Lesson with multi-paragraph body: truncated at first sentence boundary if possible`
13. `CLAUDEX_LESSON_INLINE_K env var override`
14. `Existing H tests still pass post-extension`
  </action>
  <verification>
- 14 tests pass.
- H's existing lesson-section tests still pass.
  </verification>
</task>

<task type="auto">
  <name>Task 5: Build + test sweep + v7.0.0 final ship gate</name>
  <files></files>
  <action>
- `bun run build` — must succeed.
- `npx vitest run src/tests/intelligence/lesson-relevance.test.ts src/tests/assembly/lesson-inline-expansion.test.ts` — 20 + 14 = 34 new tests pass.
- `npx vitest run` — full suite green.
- `bun run vesna` — SC#1 PASS 18/18.
- `bun run sc3` — SC#3 PASS (≥80% MEMORY.md content quality per project).
- Manual smoke: assemble session-start against a real DB with seeded lessons + a clear pivot ("discussing handoff schema"); observe top-K lessons inline-expanded; rest as pointers.
- **v7.0.0 final ship gate (operator-runnable):**
  - All AC green across Wave 1 + Wave 2 + Wave 3.
  - Vesna 18/18 PASS.
  - LongMemEval ≥ v6.6.0 baseline (90.6% Oracle).
  - LoCoMo ≥ v6.6.0 baseline (55.5% Sonnet 4.6).
  - Cross-project candidate hit rate non-regressed.
  - MEMORY.md regenerator round-trip preserves all artifacts.
  - Codebase-context section includes annotated reasons.
  - Link-aware inline-expansion surfaces correct lessons for synthetic pivots.
  - **Operator-confirmed disposition test on big-mozzy AND claudex-v3.**
  - **Operator confirms session-start feels "remembered" not "read."** ← the qualitative gate per CONTEXT.
- If all gates pass: tag `v7.0.0` annotated. Push remains operator-gated.
  </action>
  <verification>
- Build green.
- 34 new tests pass.
- Full suite green.
- Vesna SC#1 + SC#3 PASS.
- Manual smoke confirms inline-expansion behavior.
- v7.0.0 final ship gate either PASSES (tag created locally) or HOLDS with explicit reason documented.
  </verification>
</task>

</tasks>

<acceptance_criteria>
- AC-1: `lesson-relevance.ts` exports `computeLessonRelevance`, `computeTriggerMatch`, `computeLinkDistanceScore`, `selectTopKLessons` with documented signatures.
- AC-2: Trigger-match scoring: keyword overlap, stopwords ignored, case-insensitive, normalized.
- AC-3: Link-distance scoring: 1/hop_distance for reachable; 0 for unreachable.
- AC-4: Combined formula: `trigger_weight * trigger_match + (1 - trigger_weight) * link_distance`.
- AC-5: Default weights 0.6 / 0.4; env var overrides honored.
- AC-6: Top-K selection: sorts desc by combined; K default 3, cap 5.
- AC-7: H's `formatProvenPrinciplesSection` extended with inline-expansion; J does NOT rewrite H's shape.
- AC-8: Top-K lessons inline-expanded at top of section; rest as pointers.
- AC-9: Inline-expanded budget cap 400 tokens total; per-lesson cap ~130.
- AC-10: Graceful fallback when pivot params absent (renders H's baseline).
- AC-11: Sparse link graph: trigger-only selection works.
- AC-12: Missing trigger frontmatter: fallback to truncated-body for relevance scoring.
- AC-13: All 34 new tests pass.
- AC-14: Vesna SC#1 PASS 18/18; SC#3 PASS.
- AC-15: Manual smoke confirms top-K inline-expansion at session-start.
- AC-16: v7.0.0 final ship gate runs cleanly (all sub-gates green) OR holds with documented reason.
</acceptance_criteria>

<risks>
- **Risk 1: H's formatProvenPrinciplesSection shape too rigid for J's extension.** Mitigation: WAVE3-COORDINATION enforces H ships first; J rebases. H's PLAN.md documents the function shape explicitly; J authors extend rather than rewrite.
- **Risk 2: Trigger-match scoring is too crude.** Keyword overlap misses semantic relevance. Mitigation: shipping the crude version; future post-ship work can swap in embedding-based similarity. CONTEXT methodology gate: simple-first is OK if it doesn't regress.
- **Risk 3: Link-distance scoring depends on the graph being populated.** Early adoption: link graph is sparse; relevance falls back to trigger-only. Acceptable degradation.
- **Risk 4: Inline-expansion makes lessons section overwhelming.** Top-3 with 400 token budget could feel heavy. Mitigation: K configurable; budget configurable; operator can tune post-ship.
- **Risk 5: Combined weight 60/40 is wrong for some pivots.** Mitigation: env var override; tunable. Vesna runs at gate to validate quality.
- **Risk 6: Top-K selection ties on combined_score.** Tie-break is alphabetical; deterministic but not relevance-aware. Acceptable for v7.0.0.
- **Risk 7: v7.0.0 final ship gate fails on qualitative test (operator says session-start doesn't feel remembered).** Mitigation: that's WHAT THE GATE IS FOR. Hold ship, investigate, revise — do not bypass.
- **Risk 8: Vesna or LongMemEval regress because the inline-expansion changes what session-start surfaces.** Mitigation: top-K is configurable to 0 if needed (effectively disables inline-expansion at ship). Per CONTEXT, the goal is no-regression at gate.
</risks>

<external_review_gate>
Codex + Gemini cross-family review focuses on:
- (a) Relevance scoring shape — is keyword overlap the right starting point?
- (b) 60/40 weight — defensible?
- (c) Top-K + budget interaction — does the truncation actually fit visually?
- (d) H/J coordination on formatProvenPrinciplesSection — is the extension surgical?
- (e) Sparse-link fallback — does it actually degrade gracefully?
- (f) v7.0.0 ship gate — are all sub-gates the right ones?

**Final ship gate operator review:** operator runs disposition test on big-mozzy-v2 + claudex-v3; confirms qualitative gate. Per CONTEXT, this is the qualitative gate that no measurement substitutes for.

NO-SIGNOFF triggers PM escalation per WAVE3-COORDINATION's rules.
</external_review_gate>

<methodology_gates>
1. Pre-committed AC matrix above.
2. Tests written alongside code (34 new tests).
3. Live-wiring smoke: real-DB session-start with inline-expansion + Vesna SC#1 + SC#3 verified.
4. No "MVP" shortcuts — sparse-link fallback + budget caps + configurable weights = production-quality.
5. Negative results valid: if v7.0.0 final ship gate fails on qualitative test, hold ship; do not bypass.
6. Cross-family external review.
7. No time estimates.
</methodology_gates>
