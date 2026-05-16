---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: 07f
type: execute
wave: 2
depends_on: ["07-LINKS-SCHEMA"]
files_modified:
  - src/intelligence/hard-link-proposer.ts (NEW)
  - src/intelligence/link-decay.ts (NEW)
  - src/angel/boundary/boundary-detector.ts
  - src/assembly/sections.ts
  - src/assembly/assembler.ts
  - src/tests/intelligence/hard-link-proposer.test.ts (NEW)
  - src/tests/intelligence/link-decay.test.ts (NEW)
  - src/tests/assembly/pending-review-links.test.ts (NEW)
  - src/scripts/simulate-hard-link-ux.ts (NEW; operator-runnable)
autonomous: true
operator_review_gate: true
requirements: []

must_haves:
  truths:
    - "Hard-link proposer runs at session-end boundary (hooked into Angel boundary-detector's post-session-end action sequence, per Phase 14-05 single-owner pattern). At this boundary, the proposer invokes an LLM pass over recent artifacts and proposes `triggered_by`, `evidence_for`, `contradicts` links. Proposals go through `proposeHardLink` (LINKS-SCHEMA) which creates PENDING rows."
    - "LLM proposer uses local llama-server primary (via callLocalLLM) with cloud-fallback only on operator-set ANTHROPIC_API_KEY env var. Same pattern as Phase 14-00 (highlights-extractor) per `~/.claude/CLAUDE.md` MAX subscription rule. NEVER calls CC's CLIProxyAPI from hook context (deadlock per CLAUDE.md)."
    - "Per Good Child policy in `memory/project_v7_hard_link_writer_is_good_child.md`: NO autonomous confirmation of hard links. Operator is in the loop for every hard-link commit, regardless of LLM proposer confidence."
    - "Operator-in-loop UX: pending hard links render in a new `formatPendingReviewLinksSection` in the assembler cascade as `## Inferred Links Pending Review`. This section is LOW-PRIORITY (placed at P2.8, between P2.7 Project Knowledge and the Provenance Chain that 14-07g adds at P2.9). Token budget capped at 600. Dismissible per session via operator action."
    - "Decay-out anti-links: after 3 rejections per (src, dst, type) tuple, the proposer skips re-suggesting it. Implemented via `getDecayCount` from LINKS-SCHEMA + `link-decay.ts` helpers that wrap the threshold logic."
    - "Operator-runnable UX simulation script `src/scripts/simulate-hard-link-ux.ts` lets operator preview the propose-confirm-defer flow against a synthetic fixture BEFORE any real proposer run. CONTEXT Risk 3 mitigation."
    - "Production proposer run is operator-gated by environment flag `CLAUDEX_HARD_LINK_PROPOSER` (default OFF). Flag-off: boundary-detector skips the proposer step. Flag-on: proposer runs at every session-end boundary. Operator enables AFTER reviewing the UX simulation."
    - "Hard-link proposer respects rate limit: at most one proposer run per session per minute. Reason: prevents accidental re-proposal storm if boundary-detector fires repeatedly."
    - "Proposer rationale (the LLM's textual reasoning for the proposal) is stored in `hard_link.proposer_rationale` and rendered in the Pending Review section. Operator reads the rationale to decide confirm/reject."
    - "Pending Review section formatter excludes hard links whose `decay_count >= DECAY_THRESHOLD`. Decayed links are anti-links — they signal the proposer is wrong about this pair; operator should not have to re-look at them."
  artifacts:
    - path: "src/intelligence/hard-link-proposer.ts"
      provides: "LLM proposer: at session-end, invokes local llama with a propose-hard-links prompt over recent artifacts; calls proposeHardLink for each proposal."
      contains: "runHardLinkProposer|buildProposerPrompt|parseProposerResponse|LLM_PROPOSER_PROMPT"
    - path: "src/intelligence/link-decay.ts"
      provides: "Anti-link decay helpers wrapping LINKS-SCHEMA's getDecayCount + rejection tracking."
      contains: "isDecayed|recordDecay|skipDecayedProposals"
    - path: "src/angel/boundary/boundary-detector.ts"
      provides: "Existing boundary detector; hooks runHardLinkProposer into the post-session-end action sequence behind the CLAUDEX_HARD_LINK_PROPOSER flag."
      contains: "runHardLinkProposer"
    - path: "src/assembly/sections.ts"
      provides: "Adds formatPendingReviewLinksSection function. Owns ONLY this new function per WAVE2-COORDINATION."
      contains: "formatPendingReviewLinksSection"
    - path: "src/assembly/assembler.ts"
      provides: "Wires the new section at P2.8 in the cascade (between P2.7 Project Knowledge and 14-07g's P2.9 Provenance Chain)."
      contains: "formatPendingReviewLinksSection"
    - path: "src/scripts/simulate-hard-link-ux.ts"
      provides: "Operator-runnable simulation of propose-confirm-defer UX. Seeds a synthetic fixture, runs the proposer with mock LLM, shows what the Pending Review section would render."
      contains: "simulateProposer|mockLLMResponse|renderSectionPreview"
    - path: "src/tests/intelligence/hard-link-proposer.test.ts"
      provides: "Proposer tests: prompt construction, response parsing, decay-aware skipping, rate limit, LLM error handling"
      contains: "buildProposerPrompt|parseProposerResponse|decay_aware|rate_limit"
    - path: "src/tests/intelligence/link-decay.test.ts"
      provides: "Decay helper tests"
      contains: "isDecayed|recordDecay"
    - path: "src/tests/assembly/pending-review-links.test.ts"
      provides: "Pending Review section formatter tests"
      contains: "formatPendingReviewLinksSection|empty|budget|decayed_excluded"
  key_links:
    - from: "src/intelligence/hard-link-proposer.ts"
      to: "src/core/link-writer.ts (proposeHardLink, getDecayCount)"
      via: "Proposer calls proposeHardLink for each proposal; checks getDecayCount before proposing"
      pattern: "proposeHardLink|getDecayCount"
    - from: "src/angel/boundary/boundary-detector.ts"
      to: "src/intelligence/hard-link-proposer.ts (runHardLinkProposer)"
      via: "Boundary detector schedules proposer at post-session-end, behind flag"
      pattern: "CLAUDEX_HARD_LINK_PROPOSER"
    - from: "src/assembly/sections.ts (formatPendingReviewLinksSection)"
      to: "src/core/link-writer.ts (listPendingHardLinks)"
      via: "Section formatter reads pending hard links for the current project"
      pattern: "listPendingHardLinks"
---

<objective>
Four deliverables in one plan:

1. **Hard-link LLM proposer** (`src/intelligence/hard-link-proposer.ts`) — runs at session-end via Angel boundary detector. LLM analyzes recent artifacts, proposes `triggered_by`, `evidence_for`, `contradicts` links. Proposals enter PENDING state via `proposeHardLink`.

2. **Link-decay helpers** (`src/intelligence/link-decay.ts`) — wraps getDecayCount + rejection tracking. Proposer consults `isDecayed` before proposing to skip anti-link tuples.

3. **Pending Review assembly section** — `formatPendingReviewLinksSection` in `src/assembly/sections.ts` + cascade wiring in `assembler.ts` at P2.8. Renders pending hard links for operator review.

4. **Operator-runnable UX simulation** (`src/scripts/simulate-hard-link-ux.ts`) — lets operator preview the propose-confirm-defer flow against synthetic fixtures BEFORE enabling the production proposer flag.

After this plan lands AND the operator reviews + enables the flag:
- Session-end fires the proposer.
- Pending hard links surface in the assembly cascade at P2.8.
- Operator confirms/rejects via existing claudex helpers (confirmHardLink / rejectHardLink — surfaced through MCP or CLI in a follow-up; v7.0.0 ships the read surface; commit actions are operator-runnable via direct DB or future MCP tool).

| What this plan provides | Why |
|---|---|
| LLM proposer at session boundary | Knowledge graph populates organically |
| Decay-aware proposing | Operator doesn't see repeat rejections |
| Pending Review assembly section | Operator reviews proposals in context |
| UX simulation script | Operator validates UX shape before production |
| Production-flag-gated proposer | Conservative rollout |
</objective>

<execution_context>
@C:/Users/Grigorije/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/Grigorije/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/14-substrate-coherence/14-07-CONTEXT.md
@.planning/phases/14-substrate-coherence/14-07-WAVE2-COORDINATION.md
@.planning/phases/14-substrate-coherence/14-07-LINKS-SCHEMA-PLAN.md
@~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/project_v7_hard_link_writer_is_good_child.md
@~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/feedback_good_child_parable.md
@src/core/link-writer.ts
@src/angel/boundary/boundary-detector.ts
@src/assembly/sections.ts
@src/assembly/assembler.ts
@src/angel/highlights-extractor.ts
</context>

<anti_scope>
- Do NOT autonomously commit hard links. Every commit goes through operator confirmation per Good Child policy.
- Do NOT modify the soft-link tier — 14-07d territory.
- Do NOT touch claudex_trace MCP or link-distance boost — 14-07e territory.
- Do NOT modify any function in `src/assembly/sections.ts` other than the new `formatPendingReviewLinksSection`. F owns ONLY this function per WAVE2-COORDINATION.
- Do NOT touch session-start lesson surface (Wave 3 / 14-07j territory).
- Do NOT change boundary-detector's existing post-session-end action sequence beyond hooking the proposer at the documented position.
- Do NOT call CC's CLIProxyAPI from Angel context (deadlock). Local llama via callLocalLLM is the primary path.
- Do NOT change the assembler cascade order beyond inserting P2.8. P2.9 belongs to 14-07g (Provenance Chain) — F and G coordinate via integration branch.
- Do NOT enable the production proposer flag (`CLAUDEX_HARD_LINK_PROPOSER`) by default. Operator enables after UX simulation review.
- Do NOT add new MCP tools for confirm/reject in this plan. v7.0.0 ships the read/render surface; commit actions are operator-runnable via direct DB call (CLI helper or future MCP tool is post-ship).
</anti_scope>

<tasks>

<task type="auto">
  <name>Task 1: hard-link-proposer.ts</name>
  <files>src/intelligence/hard-link-proposer.ts</files>
  <action>
Create new file with the proposer.

```typescript
import type { Database } from 'better-sqlite3';
import { proposeHardLink, getDecayCount, DECAY_THRESHOLD } from '../core/link-writer.js';
import { callLocalLLM, callOpus } from '../angel/llm-callers.js';   // existing per 14-00
import { emitTelemetry } from '../observability/telemetry.js';

/**
 * Phase 14-07f — hard-link LLM proposer.
 *
 * Runs at session-end. Analyzes recent artifacts via LLM and
 * proposes triggered_by / evidence_for / contradicts links.
 * Proposals go through proposeHardLink (PENDING state).
 *
 * Operator confirms/rejects via separate UX surface
 * (Pending Review section, Task 3 of this plan).
 */

export interface ProposerParams {
  db: Database;
  session_id: string;
  project: string;
  recent_artifact_window_hours?: number;   // default 24
  max_proposals_per_run?: number;          // default 10
}

export interface ProposerResult {
  proposed: number;
  skipped_decayed: number;
  skipped_invalid: number;
  llm_error: boolean;
}

export async function runHardLinkProposer(p: ProposerParams): Promise<ProposerResult>;

export const LLM_PROPOSER_PROMPT = `You are analyzing a session of a developer's recent work to propose KNOWLEDGE-GRAPH LINKS between artifacts.

You will see artifacts (observations, decisions, lessons, checkpoints, handoffs) from the past N hours.

Your job: identify pairs of artifacts where one TRIGGERED the other, or one is EVIDENCE FOR another, or two CONTRADICT each other.

ONLY propose links you are reasonably confident about. False positives cost operator review time.

Output strict JSON:
{
  "proposals": [
    {
      "src_artifact_id": "<32-hex>",
      "dst_artifact_id": "<32-hex>",
      "type": "triggered_by" | "evidence_for" | "contradicts",
      "confidence": 0.0-1.0,
      "rationale": "<one-sentence reason an operator would understand>"
    }
  ]
}

Do not output any text outside the JSON object.`;
```

Implementation:

1. **Rate limit:** check telemetry for any `hard_link_proposer_run` row in the last 60 seconds for this session. If present, skip and emit `hard_link_proposer_rate_limited` telemetry.

2. **Recent artifact selection:** query V17 artifact for the project, ordered by `created_at_epoch_ms DESC`, where `created_at_epoch_ms >= now - recent_artifact_window_hours * 3600 * 1000`. Limit ~50 most recent.

3. **Build prompt:** the LLM_PROPOSER_PROMPT + a list of artifacts (id, kind, summary truncated to ~200 chars).

4. **LLM call:** call `callLocalLLM` primary. If ANTHROPIC_API_KEY env set, call `callOpus` first; on failure fall back to local.

5. **Parse response:** strict JSON parse. Each proposal validated:
   - src and dst exist in V17 artifact for this project
   - type is valid
   - confidence in [0, 1]
   - Reject invalid proposals; increment `skipped_invalid`.

6. **Decay check per proposal:** if `getDecayCount(db, src, dst, type) >= DECAY_THRESHOLD`, skip and increment `skipped_decayed`.

7. **Propose remaining:** call `proposeHardLink` per surviving proposal. Track count.

8. **Cap at `max_proposals_per_run`:** if LLM returns more, take top by confidence.

9. **Telemetry:** emit `hard_link_proposer_run` with `{ proposed, skipped_decayed, skipped_invalid, llm_error, duration_ms }`.
  </action>
  <verification>
- Rate limit prevents re-runs within 60s.
- Recent artifact selection respects window.
- Prompt construction includes all required artifacts.
- Response parsing strict; invalid proposals skipped.
- Decay-aware: skips tuples at threshold.
- max_proposals_per_run respected (top by confidence).
- LLM error caught and surfaced via `llm_error: true`; does not throw.
- Telemetry row written per run.
  </verification>
</task>

<task type="auto">
  <name>Task 2: link-decay.ts helpers</name>
  <files>src/intelligence/link-decay.ts</files>
  <action>
Create new file. Thin wrapper around LINKS-SCHEMA's getDecayCount + rejection plumbing.

```typescript
import type { Database } from 'better-sqlite3';
import { getDecayCount, DECAY_THRESHOLD } from '../core/link-writer.js';
import type { HardLinkType } from '../core/link-writer.js';

/**
 * Phase 14-07f — anti-link decay helpers.
 *
 * Wraps LINKS-SCHEMA's getDecayCount with proposer-side ergonomics.
 */

export function isDecayed(db: Database, src: string, dst: string, type: HardLinkType): boolean;

export function skipDecayedProposals(
  db: Database,
  proposals: Array<{ src: string; dst: string; type: HardLinkType }>
): { kept: typeof proposals; skipped: typeof proposals };

/**
 * Returns the threshold constant for testability.
 */
export function getDecayThreshold(): number;
```

Implementation:

- `isDecayed`: `getDecayCount(...) >= DECAY_THRESHOLD`.
- `skipDecayedProposals`: filters input list; emits a telemetry row per skipped tuple.
- `getDecayThreshold`: returns DECAY_THRESHOLD.
  </action>
  <verification>
- isDecayed returns true at threshold, false below.
- skipDecayedProposals correctly partitions input.
- Telemetry row emitted per skip.
  </verification>
</task>

<task type="auto">
  <name>Task 3: formatPendingReviewLinksSection</name>
  <files>src/assembly/sections.ts, src/assembly/assembler.ts</files>
  <action>
Add a NEW function `formatPendingReviewLinksSection` to `src/assembly/sections.ts`. Do NOT modify any other function in this file.

```typescript
import { listPendingHardLinks, getDecayCount, DECAY_THRESHOLD } from '../core/link-writer.js';

/**
 * Phase 14-07f — Pending Review Links assembly section.
 *
 * Renders pending hard links for the current project at P2.8 in the
 * cascade. Operator reads the LLM's rationale and decides
 * confirm/reject. Decayed tuples excluded.
 */

export interface PendingReviewSectionParams {
  db: Database;
  project: string;
  budget_tokens: number;
}

export function formatPendingReviewLinksSection(p: PendingReviewSectionParams): string | null;
```

Implementation:

1. Call `listPendingHardLinks(db, project)`. Returns array of pending rows.
2. Filter out decayed tuples (where decay_count >= DECAY_THRESHOLD).
3. If filtered list empty, return null (section not rendered).
4. Render header: `## Inferred Links Pending Review` followed by a brief one-line description.
5. Per pending row, render:
   ```
   - [<type>] <src_summary> → <dst_summary>
     Confidence: <NN>%. Rationale: <proposer_rationale>
     ID: <hard_link_id> · Propose date: <ISO>
   ```
6. Budget cap: if rendering exceeds `budget_tokens`, truncate the list and append "... and N more pending. Review via claudex_trace or direct DB." Each row uses ~80 tokens; budget 600 → ~7 rows max.
7. Surface end-of-section guidance: `To confirm or reject: call confirmHardLink(id) or rejectHardLink(id) via the future MCP tool, or update via direct DB.`

In `src/assembly/assembler.ts`:

- Locate the cascade section ordering (P2.x list).
- Insert `formatPendingReviewLinksSection` invocation at P2.8 between P2.7 Project Knowledge and what 14-07g will add at P2.9.
- Pass `budget_tokens = 600`.
- Add `// 14-07f: P2.8 Pending Review Links` comment marker.

**Coordination with 14-07g:** assembler.ts is also touched by G. F's invocation goes at P2.8; G's at P2.9. PM enforces order.
  </action>
  <verification>
- formatPendingReviewLinksSection returns non-null when pending rows exist.
- Returns null when no pending rows.
- Decayed tuples excluded from output.
- Budget cap enforced; truncation message appended when over.
- Cascade position P2.8 (between P2.7 and P2.9).
- No other function in sections.ts modified.
  </verification>
</task>

<task type="auto">
  <name>Task 4: Boundary-detector integration</name>
  <files>src/angel/boundary/boundary-detector.ts</files>
  <action>
Locate the post-session-end action sequence in boundary-detector (per Phase 14-05's single-owner pattern). Add `runHardLinkProposer` as a new step in the sequence.

```typescript
// In the post-end-of-session action sequence:
// 1. session_summary write (if not present)
// 2. final pattern-extractor pass
// 3. highlights extraction
// 4. MEMORY.md regeneration
// 5. lesson-pointer index update
// 6. 14-07f: hard-link proposer (NEW; flag-gated)

if (process.env.CLAUDEX_HARD_LINK_PROPOSER === '1' || process.env.CLAUDEX_HARD_LINK_PROPOSER === 'true') {
  const result = await runHardLinkProposer({
    db,
    session_id,
    project,
  });
  emitTelemetry(db, {
    event_kind: 'session_end_action',
    session_id,
    detail: { action: 'hard_link_proposer', ...result },
  });
}
```

Flag-off (default): step skipped silently; no proposer run; no telemetry.

Add `// 14-07f: hard-link proposer (flag-gated)` comment marker.
  </action>
  <verification>
- Flag-off: boundary detector does NOT invoke proposer; no telemetry row.
- Flag-on: boundary detector invokes proposer at correct position in sequence.
- Existing 5 steps unchanged in order/behavior.
  </verification>
</task>

<task type="auto">
  <name>Task 5: UX simulation script</name>
  <files>src/scripts/simulate-hard-link-ux.ts</files>
  <action>
Create operator-runnable script.

```typescript
/**
 * Phase 14-07f — operator-runnable UX simulation.
 *
 * Seeds a synthetic fixture (in-memory DB), runs the proposer with
 * a MOCK LLM response (no real LLM call), and prints what the
 * Pending Review section would render. Lets operator preview the
 * UX shape BEFORE enabling the production proposer flag.
 *
 * Usage:
 *   bun src/scripts/simulate-hard-link-ux.ts [--proposals <count>] [--include-decayed]
 */
```

Implementation:

1. Open in-memory DB; apply migrations V37 + V38.
2. Seed ~6 synthetic artifacts (mix of observation/decision/lesson/handoff).
3. Seed mock LLM response: returns a list of ~4 plausible proposals + 1 already-decayed tuple (to demonstrate skip behavior).
4. Run proposer with `_setLLMCallableForTest(mockLLM)`.
5. Call `formatPendingReviewLinksSection` with budget 600.
6. Print the rendered section to stdout.
7. Print summary: "Proposed: 4. Skipped (decayed): 1. To confirm/reject: ..." etc.
8. With `--proposals 10`, seed more proposals to demonstrate budget truncation.
9. With `--include-decayed`, show what the decayed exclusion does (toggle the filter for visualization).

This script does NOT touch the real DB. Operator runs it interactively to validate the UX shape.
  </action>
  <verification>
- Script runs against in-memory DB; no production-DB side effects.
- Output includes the rendered Pending Review section.
- --proposals flag controls fixture size.
- --include-decayed shows the difference.
  </verification>
</task>

<task type="auto">
  <name>Task 6: Tests for hard-link-proposer</name>
  <files>src/tests/intelligence/hard-link-proposer.test.ts</files>
  <action>
New test file. Tests:

1. `runHardLinkProposer: 4 valid LLM proposals → 4 proposed rows`
2. `runHardLinkProposer: rate-limited (recent run within 60s) → skipped, telemetry`
3. `runHardLinkProposer: recent_artifact_window respected`
4. `runHardLinkProposer: invalid proposal (missing src) → skipped_invalid++`
5. `runHardLinkProposer: invalid proposal (invalid type) → skipped_invalid++`
6. `runHardLinkProposer: confidence > 1.0 → skipped_invalid++`
7. `runHardLinkProposer: decayed tuple → skipped_decayed++`
8. `runHardLinkProposer: max_proposals_per_run respected (top by confidence)`
9. `runHardLinkProposer: LLM error → llm_error: true, no throw`
10. `runHardLinkProposer: ANTHROPIC_API_KEY set + Opus available → uses Opus`
11. `runHardLinkProposer: ANTHROPIC_API_KEY unset → uses local llama`
12. `runHardLinkProposer: telemetry row emitted with all counts`
13. `buildProposerPrompt: includes recent artifacts + prompt prefix`
14. `parseProposerResponse: strict JSON; rejects non-JSON; rejects malformed`
  </action>
  <verification>
- 14 tests pass.
  </verification>
</task>

<task type="auto">
  <name>Task 7: Tests for link-decay + Pending Review section</name>
  <files>src/tests/intelligence/link-decay.test.ts, src/tests/assembly/pending-review-links.test.ts</files>
  <action>
**link-decay.test.ts** — 5 tests:
1. `isDecayed: false below threshold`
2. `isDecayed: true at threshold`
3. `isDecayed: true above threshold`
4. `skipDecayedProposals: partitions correctly`
5. `skipDecayedProposals: telemetry per skip`

**pending-review-links.test.ts** — 8 tests:
1. `empty pending: returns null`
2. `one pending: section rendered with type, summary, rationale`
3. `multiple pending: sorted by proposed_at_epoch_ms DESC`
4. `decayed pending: excluded`
5. `budget cap: truncates list with appended summary`
6. `confidence formatted as percent`
7. `rationale rendered`
8. `header line + guidance line present`
  </action>
  <verification>
- 5 + 8 = 13 tests pass.
  </verification>
</task>

<task type="auto">
  <name>Task 8: Build + test sweep + UX simulation smoke</name>
  <files></files>
  <action>
- `bun run build` — must succeed.
- `npx vitest run src/tests/intelligence/hard-link-proposer.test.ts src/tests/intelligence/link-decay.test.ts src/tests/assembly/pending-review-links.test.ts` — 14 + 5 + 8 = 27 tests pass.
- `npx vitest run` — full suite green.
- **UX simulation smoke (operator-runnable):** `bun src/scripts/simulate-hard-link-ux.ts` — runs against in-memory DB; renders sample Pending Review section to stdout. Capture output in `14-07-WAVE2-STATUS.md` for operator review.
- `bun run vesna` — SC#1 PASS (flag-off; proposer not run).
  </action>
  <verification>
- Build green.
- 27 new tests pass.
- Full suite green.
- UX simulation smoke output captured.
- Vesna SC#1 PASS unchanged.
  </verification>
</task>

</tasks>

<acceptance_criteria>
- AC-1: `hard-link-proposer.ts` runs at session-end behind `CLAUDEX_HARD_LINK_PROPOSER` flag (default OFF).
- AC-2: Proposer rate limit (1/min/session) enforced.
- AC-3: Proposer uses local llama primary; cloud Opus when ANTHROPIC_API_KEY set; no CLIProxyAPI calls.
- AC-4: Invalid proposals (bad src/dst/type/confidence) skipped via skipped_invalid counter.
- AC-5: Decayed tuples (decay_count >= DECAY_THRESHOLD) skipped via skipped_decayed counter.
- AC-6: max_proposals_per_run enforced; top by confidence.
- AC-7: Per-run telemetry with all counters emitted.
- AC-8: `formatPendingReviewLinksSection` added to sections.ts as the ONLY new function in that file from this plan.
- AC-9: Cascade wired at P2.8 (between P2.7 and P2.9); F coordinates with G on P2.9 position.
- AC-10: Pending Review section renders pending rows with type, summary, confidence, rationale, id.
- AC-11: Decayed tuples excluded from section.
- AC-12: Budget cap (600 tokens) enforced; truncation message appended.
- AC-13: UX simulation script runs against in-memory DB; no production side effects.
- AC-14: Boundary-detector hooks the proposer at the correct position in the post-session-end sequence.
- AC-15: All 27 new tests pass.
- AC-16: No regression in v6.6.0 + Wave 1 + LINKS-SCHEMA + 14-07d + 14-07e baseline (flag-off mode).
</acceptance_criteria>

<risks>
- **Risk 1: LLM produces noisy proposals at high volume.** Operator drowns in pending links. Mitigation: max_proposals_per_run (default 10) + rate limit (1/min) + decay-aware skipping after 3 rejections. Configurable; tunable post-ship.
- **Risk 2: Proposer prompt is too vague; LLM produces low-quality proposals.** Mitigation: prompt is locked in this plan; operator can revise via direct file edit. UX simulation surfaces low-quality output before production.
- **Risk 3: Boundary-detector hook adds latency to session-end.** LLM call could take seconds. Mitigation: fire-and-forget at the boundary; session-end completes whether the proposer finishes or not. Tracking via telemetry.
- **Risk 4: Pending Review section becomes noise instead of signal.** If operator never confirms or rejects, the pending list grows. Mitigation: telemetry tracks confirm/reject rates; if rates are very low, session-start surfaces a "consider clearing pending" hint (Wave 3 work, not this plan).
- **Risk 5: UX simulation diverges from production proposer.** Mock LLM responses might not match real LLM behavior. Mitigation: simulation explicitly labeled as "preview UX shape"; not a behavioral test of the LLM.
- **Risk 6: Confirm/reject MCP tool not in v7.0.0.** Operator commits via direct DB or future tooling. Mitigation: documented in Pending Review section's guidance line; future plan ships the MCP tool.
- **Risk 7: Flag-on enabled accidentally before UX review.** Mitigation: CLAUDEX_HARD_LINK_PROPOSER is env-var-gated; not in any production code path by default. Operator's responsibility to enable.
</risks>

<external_review_gate>
Codex + Gemini cross-family review focuses on:
- (a) Proposer prompt quality — is the LLM_PROPOSER_PROMPT actually instructing for high-precision proposals?
- (b) Rate limit correctness — is 1/min/session the right cadence?
- (c) Decay threshold of 3 — does this generate fatigue for operators or block too many useful proposals?
- (d) Budget cap of 600 tokens — does the section format actually fit ~7 entries?
- (e) Boundary-detector integration — is the proposer step in the right position?
- (f) UX simulation completeness — does it actually demonstrate the propose-confirm-defer flow, or just the propose step?

**Operator review gate**: per CONTEXT Risk 3, operator MUST review the UX simulation output before enabling CLAUDEX_HARD_LINK_PROPOSER in production. NO-SIGNOFF on UX = PM holds the flag.

NO-SIGNOFF on Codex/Gemini triggers PM escalation per WAVE2-COORDINATION's rules.
</external_review_gate>

<methodology_gates>
1. Pre-committed AC matrix above.
2. Tests written alongside code (27 new tests + UX simulation smoke).
3. Live-wiring smoke: UX simulation runs against in-memory DB; produces visible output.
4. No "MVP" shortcuts — Good Child policy is the production-quality pattern; operator-in-loop is non-negotiable.
5. Negative results valid: if UX simulation reveals the section format is unusable, surface to PM and operator; revise BEFORE shipping.
6. Cross-family external review per the gate above.
7. No time estimates.
</methodology_gates>
