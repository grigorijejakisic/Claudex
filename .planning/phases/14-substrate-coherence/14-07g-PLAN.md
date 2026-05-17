---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: 07g
type: execute
wave: 2
depends_on: ["07-LINKS-SCHEMA"]
files_modified:
  - src/intelligence/provenance-walker.ts (NEW)
  - src/assembly/sections/links.ts (Wave 0 w0d placeholder; G adds formatProvenanceChainSection)
  - src/assembly/sections/index.ts (add re-export of formatProvenanceChainSection)
  - src/assembly/assembler.ts
  - src/tests/intelligence/provenance-walker.test.ts (NEW)
  - src/tests/assembly/provenance-chain.test.ts (NEW)
autonomous: true
requirements: []

must_haves:
  truths:
    - "The Provenance Chain assembly section surfaces 'why this decision exists' for any active decision/checkpoint by walking backwards through the link graph to source observations. Reads soft links (extracted_from, references) and CONFIRMED hard links (triggered_by, evidence_for, contradicts) — pending hard links are NOT included."
    - "Section placement: P2.9 in the cascade, AFTER 14-07f's P2.8 Pending Review Links. Token budget cap: 800 (slightly larger than Pending Review's 600 because Provenance includes multi-hop summaries)."
    - "Walker direction is INCOMING from the decision artifact's perspective. A decision was triggered_by an observation, supported by evidence_for, extracted_from a session frame — these are the upstream links of the decision."
    - "Walker handles cycles: BFS with visited-set; a cycle bounds the walk and emits a `cycle_detected` telemetry row."
    - "Walker depth cap: max 4 hops. Reason: deeper chains become noise; the operator-relevant provenance is usually 2-4 hops (decision → observation → session frame → handoff)."
    - "Walker output is structured: ordered list of {artifact_id, kind, summary, hop_distance, via_link_type}. Sorted by hop_distance ASC, then by created_at_epoch_ms DESC at each hop level."
    - "Section is rendered ONLY when the current pivot context implies a 'decision' to walk from. Heuristic: P2.9 invoked when the assembler's pivot includes the word 'decision' or 'checkpoint', OR when an explicit decision artifact ID is passed in the cascade context. Otherwise the section is omitted."
    - "Position-unless-flagged: alternative would be to ALWAYS render Provenance Chain from the most recent decision artifact for the project. I lean on the heuristic gate (pivot-implies-decision) because always-on rendering uses budget that the operator may not need every session. If PM flags this, the always-on variant takes the same budget but eats it whether or not it's relevant."
    - "Surface formatting follows the existing P2.5/P2.6/P2.7 conventions: `## <Section Header>` + brief description + bullet list. Cite link types so operator sees the lineage."
  artifacts:
    - path: "src/intelligence/provenance-walker.ts"
      provides: "BFS walker that walks INCOMING links from a starting artifact (typically a decision). Returns an ordered provenance chain."
      contains: "walkProvenance|ProvenanceChainEntry|MAX_PROVENANCE_HOPS"
    - path: "src/assembly/sections/links.ts"
      provides: "Adds formatProvenanceChainSection function. Wave 0 w0d created this file as a placeholder; G populates it alongside F's formatPendingReviewLinksSection. Owns ONLY this new function per WAVE2-COORDINATION."
      contains: "formatProvenanceChainSection"
    - path: "src/assembly/sections/index.ts"
      provides: "Adds re-export of formatProvenanceChainSection so callers of assembly/sections.js work unchanged."
      contains: "formatProvenanceChainSection"
    - path: "src/assembly/assembler.ts"
      provides: "Wires the new section at P2.9 (after 14-07f's P2.8)."
      contains: "formatProvenanceChainSection"
    - path: "src/tests/intelligence/provenance-walker.test.ts"
      provides: "Walker tests: BFS correctness, cycle detection, hop cap, incoming-only direction, ordering"
      contains: "walkProvenance|cycle|hop_cap|incoming"
    - path: "src/tests/assembly/provenance-chain.test.ts"
      provides: "Section formatter tests: heuristic gate, budget cap, format, empty case"
      contains: "formatProvenanceChainSection|heuristic|budget|empty"
  key_links:
    - from: "src/intelligence/provenance-walker.ts"
      to: "src/core/link-writer.ts (listSoftLinks, listConfirmedHardLinks)"
      via: "Walker consumes link reads from link-writer; never writes"
      pattern: "listSoftLinks|listConfirmedHardLinks"
    - from: "src/assembly/sections/links.ts (formatProvenanceChainSection)"
      to: "src/intelligence/provenance-walker.ts (walkProvenance)"
      via: "Section formatter invokes the walker; formats result for assembler cascade"
      pattern: "walkProvenance"
---

<objective>
Two deliverables in one plan:

1. **`src/intelligence/provenance-walker.ts`** — BFS walker over INCOMING links. Walks from a decision artifact backwards through evidence_for / triggered_by / extracted_from / references links to source observations. Handles cycles, hop caps, ordering.

2. **`formatProvenanceChainSection`** — new function in `src/assembly/sections/links.ts` (Wave 0 placeholder file). Invokes the walker, formats the chain as a `## Provenance Chain` assembly section at P2.9 in the cascade. Heuristic-gated: renders only when the pivot implies a decision context.

After this plan lands:
- When operator pivots to a decision-shaped topic, the assembler surfaces the chain of artifacts that led to it.
- Walking from a checkpoint decision shows the observation lineage.
- Walking from a lesson shows the source observations it was promoted from.

| What this plan provides | Why |
|---|---|
| Provenance walker | Reusable graph walk for "what led to this?" |
| Provenance Chain section | User-facing payoff of Wave 2 linking work |
| Heuristic-gated rendering | Budget spent only when relevant |
| Cycle detection | Walker robust to malformed graphs |
| Section budget 800 tokens | Slightly larger than Pending Review for multi-hop summaries |
</objective>

<execution_context>
@C:/Users/Grigorije/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/Grigorije/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/14-substrate-coherence/14-07-CONTEXT.md
@.planning/phases/14-substrate-coherence/14-07-WAVE2-COORDINATION.md
@.planning/phases/14-substrate-coherence/14-07-LINKS-SCHEMA-PLAN.md
@.planning/phases/14-substrate-coherence/14-07f-PLAN.md
@src/core/link-writer.ts
@src/assembly/sections/links.ts
@src/assembly/sections/index.ts
@src/assembly/assembler.ts
</context>

<anti_scope>
- Do NOT include PENDING hard links in provenance. Only soft + confirmed hard.
- Do NOT modify any function in `src/assembly/sections/links.ts` other than the new `formatProvenanceChainSection`. G owns ONLY this function per WAVE2-COORDINATION. Do NOT touch `src/assembly/sections.ts` (the residual file) at all.
- Do NOT touch the existing assembler cascade order beyond inserting P2.9 after 14-07f's P2.8.
- Do NOT modify the link tables, link-writer.ts, or hybrid-retrieval.ts.
- Do NOT touch session-start lesson surface (Wave 3 territory).
- Do NOT add new MCP tools.
- Do NOT add new feature flags. The heuristic gate is in the section formatter; no env-var control needed (post-ship if operator wants explicit toggle).
- Do NOT walk OUTGOING links in this plan. Provenance is incoming-direction only (what led to this).
- Do NOT cap the hop depth via env var; the constant `MAX_PROVENANCE_HOPS = 4` is locked in this plan.
</anti_scope>

<tasks>

<task type="auto">
  <name>Task 1: provenance-walker.ts</name>
  <files>src/intelligence/provenance-walker.ts</files>
  <action>
Create new file.

```typescript
import type { Database } from 'better-sqlite3';
import { listSoftLinks, listConfirmedHardLinks } from '../core/link-writer.js';
import { emitTelemetry } from '../observability/telemetry.js';

/**
 * Phase 14-07g — Provenance walker.
 *
 * BFS over INCOMING links from a starting artifact (typically a
 * decision or checkpoint). Returns the upstream chain — what led to
 * this artifact existing.
 *
 * Bounded by MAX_PROVENANCE_HOPS. Cycle-aware via visited set.
 */

export const MAX_PROVENANCE_HOPS = 4;

export interface ProvenanceChainEntry {
  artifact_id: string;
  kind: string;
  summary: string;
  hop_distance: number;       // 0 = the starting artifact; >=1 = upstream
  via_link_type: string | null;  // null for starting artifact; otherwise the link type that reached this entry
  created_at_epoch_ms: number;
}

export interface WalkProvenanceParams {
  db: Database;
  start_artifact_id: string;
  session_id: string;
  max_hops?: number;          // default MAX_PROVENANCE_HOPS; capped at MAX_PROVENANCE_HOPS
}

export interface WalkProvenanceResult {
  start_artifact_id: string;
  chain: ProvenanceChainEntry[];
  total_reached: number;
  cycle_detected: boolean;
}

export function walkProvenance(p: WalkProvenanceParams): WalkProvenanceResult;
```

Implementation:

- BFS with visited Map (artifact_id → ProvenanceChainEntry with shortest hop_distance).
- Per node, query incoming links via `listSoftLinks(db, id, 'incoming')` + `listConfirmedHardLinks(db, id, 'incoming')`.
- Filter to relevant types: soft = {extracted_from, references}; hard = {triggered_by, evidence_for}. Skip 'contradicts' — that's a *conflict* signal, not a provenance signal; rendered elsewhere if at all (post-ship).
- For each incoming link, enqueue the SRC artifact (because incoming means src → dst, where dst = current node; so src is "upstream").
- On revisiting a node (already in visited set), emit `cycle_detected` telemetry; do NOT re-traverse.
- Return chain sorted by hop_distance ASC, then by created_at_epoch_ms DESC at each level.

Skip 'contradicts' in provenance walking: contradict links represent disagreement between artifacts, not derivation. Future plan may surface contradictions on a different section; provenance is "what led here."
  </action>
  <verification>
- walkProvenance: direct incoming link → chain length 2 (start + 1 upstream).
- walkProvenance: 4-hop chain → returns 5 entries.
- walkProvenance: max_hops=2 caps at 3 entries.
- walkProvenance: cycle (A → B → A) → visited prevents re-traversal; cycle_detected=true.
- walkProvenance: 'contradicts' links excluded.
- walkProvenance: chain sorted correctly (hop_distance ASC, created_at_epoch_ms DESC tiebreaker).
- walkProvenance: dead reference (linked artifact deleted) skipped silently.
- walkProvenance: missing start artifact returns empty chain + total_reached=0.
  </verification>
</task>

<task type="auto">
  <name>Task 2: formatProvenanceChainSection</name>
  <files>src/assembly/sections/links.ts, src/assembly/sections/index.ts, src/assembly/assembler.ts</files>
  <action>
Add new function `formatProvenanceChainSection` to `src/assembly/sections/links.ts`. This file was created as a Wave 0 placeholder; G populates it. Do NOT modify any other function.

Also add a re-export to `src/assembly/sections/index.ts`:
```typescript
export { formatProvenanceChainSection } from './links.js';
```

```typescript
import { walkProvenance } from '../../intelligence/provenance-walker.js';

export interface ProvenanceChainSectionParams {
  db: Database;
  project: string;
  session_id: string;
  pivot_topic: string;        // current session pivot (from assembler context)
  pivot_decision_artifact_id?: string;  // optional explicit decision ID
  budget_tokens: number;
}

export function formatProvenanceChainSection(p: ProvenanceChainSectionParams): string | null;
```

Implementation:

1. **Heuristic gate:** decide whether to render.
   - If `pivot_decision_artifact_id` supplied: render unconditionally with that as start.
   - Else: check if `pivot_topic.toLowerCase()` contains 'decision' or 'checkpoint' or 'we decided'. If yes, find the most recent decision/checkpoint artifact for the project (V17 artifact where `kind IN ('decision', 'checkpoint')` ORDER BY `created_at_epoch_ms DESC` LIMIT 1).
   - Else: return null (section omitted).

2. **Invoke walker:** `walkProvenance({ db, start_artifact_id, session_id })`.

3. **If chain length <= 1** (just the start; no upstream): return null (no provenance to show).

4. **Render section:**
   ```
   ## Provenance Chain

   This decision traces back to <N> upstream artifacts:

   - <kind>: <summary>  *(via <link_type>, hop <distance>)*
   - <kind>: <summary>  *(via <link_type>, hop <distance>)*
   ...
   ```

5. **Budget cap (800 tokens):** if rendering would exceed budget, truncate the chain to fit. Each entry is ~80 tokens; budget 800 → ~10 entries.

6. **Add cascade wiring** in `src/assembly/assembler.ts`:
   - Invoke `formatProvenanceChainSection` at P2.9 in the cascade (AFTER 14-07f's P2.8).
   - Pass `pivot_topic` from assembler context.
   - `budget_tokens = 800`.
   - Add `// 14-07g: P2.9 Provenance Chain` comment marker.

   **Coordination with 14-07f:** assembler.ts is touched by both F and G. F's invocation at P2.8; G's at P2.9. PM enforces order per WAVE2-COORDINATION.
  </action>
  <verification>
- Heuristic gate: returns null when pivot doesn't imply decision.
- Heuristic gate: renders when pivot mentions decision/checkpoint.
- Explicit decision ID: renders unconditionally.
- Chain length 1 (no upstream): returns null.
- Chain length > 1: section rendered with header + bullets.
- Each entry shows kind, summary, link_type, hop_distance.
- Budget cap enforced; truncation when over.
- Cascade position P2.9 (after P2.8); no other function in sections.ts modified.
  </verification>
</task>

<task type="auto">
  <name>Task 3: Tests for provenance-walker</name>
  <files>src/tests/intelligence/provenance-walker.test.ts</files>
  <action>
New test file. Tests:

1. `walkProvenance: empty graph → chain length 1 (just start)`
2. `walkProvenance: single incoming link → chain length 2`
3. `walkProvenance: 4-hop chain → chain length 5`
4. `walkProvenance: max_hops=2 → chain length 3`
5. `walkProvenance: max_hops > MAX_PROVENANCE_HOPS → clamped to 4`
6. `walkProvenance: cycle detected, no infinite loop, telemetry emitted`
7. `walkProvenance: 'contradicts' link not traversed`
8. `walkProvenance: 'extracted_from' soft link traversed`
9. `walkProvenance: 'triggered_by' hard link (confirmed) traversed`
10. `walkProvenance: 'triggered_by' hard link (pending) NOT traversed`
11. `walkProvenance: chain sorted by hop_distance ASC, created_at_epoch_ms DESC`
12. `walkProvenance: dead reference (artifact deleted) skipped silently`
13. `walkProvenance: missing start artifact → total_reached=0`
14. `walkProvenance: multiple incoming links at same hop → all included`
  </action>
  <verification>
- 14 tests pass.
  </verification>
</task>

<task type="auto">
  <name>Task 4: Tests for Provenance Chain section formatter</name>
  <files>src/tests/assembly/provenance-chain.test.ts</files>
  <action>
New test file. Tests:

1. `heuristic gate: pivot "we decided X" → renders`
2. `heuristic gate: pivot "checkpoint review" → renders`
3. `heuristic gate: pivot "general discussion" → returns null`
4. `explicit pivot_decision_artifact_id: renders unconditionally`
5. `chain length 1 (no upstream): returns null`
6. `chain length 4: section has 4 bullets`
7. `each bullet shows kind, summary, link_type, hop_distance`
8. `budget cap (800 tokens): truncates list with appended summary`
9. `header line + description line present`
10. `created_at_epoch_ms DESC tiebreaker within hop_distance group`
11. `no decision/checkpoint artifact found for project: returns null (heuristic falls through)`
  </action>
  <verification>
- 11 tests pass.
  </verification>
</task>

<task type="auto">
  <name>Task 5: Build + test sweep</name>
  <files></files>
  <action>
- `bun run build` — must succeed.
- `npx vitest run src/tests/intelligence/provenance-walker.test.ts src/tests/assembly/provenance-chain.test.ts` — 14 + 11 = 25 new tests pass.
- `npx vitest run` — full suite green.
- `bun run vesna` — SC#1 PASS (Provenance Chain section heuristic-gated; doesn't fire for most Vesna probes).
- Manual smoke: seed a project with a decision linked back to 3 observations; assemble session-start; verify Provenance Chain section renders.
  </action>
  <verification>
- Build green.
- 25 new tests pass.
- Full suite green.
- Vesna SC#1 PASS unchanged.
- Manual smoke confirms section renders.
  </verification>
</task>

</tasks>

<acceptance_criteria>
- AC-1: `provenance-walker.ts` exports `walkProvenance` with the documented signature and BFS behavior.
- AC-2: Walker traverses INCOMING links only.
- AC-3: Walker respects MAX_PROVENANCE_HOPS = 4 cap.
- AC-4: Walker detects cycles; emits telemetry; no infinite loop.
- AC-5: Walker excludes 'contradicts' links.
- AC-6: Walker excludes PENDING hard links.
- AC-7: `formatProvenanceChainSection` added to sections.ts as the ONLY new function from this plan.
- AC-8: Heuristic gate: renders only when pivot mentions decision/checkpoint OR explicit ID supplied.
- AC-9: Chain length <= 1 returns null (no section).
- AC-10: Cascade position P2.9 (after 14-07f's P2.8).
- AC-11: Budget cap (800 tokens) enforced; truncation works.
- AC-12: All 25 new tests pass.
- AC-13: No regression in v6.6.0 + Wave 1 + LINKS-SCHEMA + 14-07d + 14-07e + 14-07f baseline.
- AC-14: Manual smoke against fixture confirms end-to-end rendering.
</acceptance_criteria>

<risks>
- **Risk 1: Heuristic gate misses cases.** Decision/checkpoint pivots phrased differently won't trigger. Mitigation: heuristic is a starting point; operator-runnable explicit `pivot_decision_artifact_id` always works. Future tuning of the heuristic is post-ship.
- **Risk 2: 4-hop cap too shallow or too deep.** Mitigation: locked at 4 based on intuition; future tuning post-ship. Vesna SC#1 unaffected (heuristic-gated).
- **Risk 3: Walker performance on dense link graphs.** Project with thousands of links per artifact could slow the BFS. Mitigation: max_hops cap; indexed (dst, type) queries; v7.0.0 ship scale acceptable.
- **Risk 4: Sorting by created_at_epoch_ms can flip the chain order vs link traversal order.** Operator might expect "follow the links" ordering, not "newest first." Mitigation: primary sort is hop_distance (BFS-natural); created_at_epoch_ms is tiebreaker. Documented.
- **Risk 5: 'contradicts' exclusion may surprise operator.** Operator may want to see contradictions in provenance context. Mitigation: out-of-scope for v7.0.0; future plan can add a Contradictions section if useful. Telemetry rate of confirmed contradicts links surfaces whether this is actually needed.
- **Risk 6: Section rendered with budget but text doesn't fit visually in operator's view.** Mitigation: budget is a tokens proxy; visual fit depends on operator terminal. 800 tokens = ~3000 chars = ~30 lines at average width; fits most terminals. Tunable post-ship.
</risks>

<external_review_gate>
Codex + Gemini cross-family review focuses on:
- (a) BFS correctness — handles cycles, visited semantics?
- (b) Heuristic gate — does the pivot-string match capture the right cases?
- (c) 'contradicts' exclusion — is "provenance" the right framing to exclude contradictions, or should they surface here?
- (d) Sort order — hop_distance ASC + created_at_epoch_ms DESC tiebreaker — operator-meaningful?
- (e) Section format — does the bullet list with `(via X, hop N)` annotation read clearly?

NO-SIGNOFF triggers PM escalation.
</external_review_gate>

<methodology_gates>
1. Pre-committed AC matrix above.
2. Tests written alongside code (25 new tests).
3. Live-wiring smoke: fixture-based end-to-end rendering verified.
4. No "MVP" shortcuts — cycle-aware BFS + heuristic-gated rendering + budget cap = production-quality.
5. Negative results valid: if Vesna or operator review surfaces concerns about heuristic, revise instead of expanding scope.
6. Cross-family external review.
7. No time estimates.
</methodology_gates>
