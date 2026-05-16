---
phase: 14-substrate-coherence
sub_phase: 14-07
wave: 2
role: PM coordination doc — read by all Wave 2 /auto-orchestrate workers
created_by: PM (Claude Opus 4.7) on 2026-05-16
parent_context: .planning/phases/14-substrate-coherence/14-07-CONTEXT.md
depends_on_wave: 1
---

# v7.0.0 Wave 2 Coordination Manifest — Knowledge Graph

This document is the PM-level contract that every Wave 2
/auto-orchestrate worker MUST honor. Wave 2 adds typed links between
artifacts — soft links written autonomously at write-time, hard
links proposed by an LLM and confirmed by the operator (Good Child
hybrid policy, locked in 14-07-CONTEXT.md decision 2).

The pattern is **schema-first → parallel workers** identical to
Wave 1: 14-07-LINKS-SCHEMA lands the soft + hard link tables solo;
then four workers fan out — 14-07d (soft writers), 14-07e (MCP +
retrieval boost), 14-07f (hard proposer + UX), 14-07g (Provenance
Chain assembly section).

Two workers (14-07f and 14-07g) touch `src/assembly/sections.ts`.
This manifest enforces function-level ownership so they cannot
collide.

---

## Wave 2 entry gate (must be true before this wave starts)

- Wave 1 fully shipped (14-07a + 14-07b + 14-07c all merged).
- v7.0.0-rc branch carries the Wave 1 landed state.
- Cutover applied to production DB; legacy `artifacts` is read-only
  mirror; V17 unified shape carries all live data.
- Vesna + LongMemEval + LoCoMo + cross-project hit rate verified
  non-regressed (gate-results file confirms).
- `bun run setup` reports V37 schema.

---

## Workers + plans

| Worker | Plan | Branch | Sequence |
|---|---|---|---|
| LSS | 14-07-LINKS-SCHEMA (soft + hard link tables + write helpers) | `phase-14-07/links-schema` | first — blocks all of D/E/F/G |
| D | 14-07d (soft-link autonomous writers) | `phase-14-07/d-soft-writers` | parallel after LSS lands |
| E | 14-07e (claudex_trace MCP + link-distance retrieval boost) | `phase-14-07/e-trace-mcp` | parallel after LSS lands |
| F | 14-07f (hard-link LLM proposer + Good Child UX) | `phase-14-07/f-hard-proposer` | parallel after LSS lands |
| G | 14-07g (Provenance Chain assembly surface) | `phase-14-07/g-provenance` | parallel after LSS lands |

Sequencing:
```
LSS  (solo, blocks)
   └─→ D, E, F, G  (parallel)
```

LSS is single-worker because every writer/reader of links depends on
the table shapes + write helpers it produces. Running LSS in parallel
with anything else is a race condition.

D/E/F/G fan out after LSS lands. Their file ownership is disjoint
EXCEPT for `src/assembly/sections.ts` (touched by F and G), where
function-level ownership is enforced below.

---

## File ownership table

PM (me) is the only authority for resolving boundary disputes.

### Plan 14-07-LINKS-SCHEMA (Worker LSS) owns

- `src/core/migration-steps.ts` — **adds** `migrateV37toV38` (link
  tables). No edits to prior steps.
- `src/core/migration/v17-runner.ts` — DDL extensions for `soft_link`
  + `hard_link` + `hard_link_history` tables.
- `src/core/migration/v17-triggers.ts` — FTS5 + vec0 triggers stay
  unchanged in Wave 2 (links don't have search/vector indexes in
  v7.0.0; out of scope).
- `src/core/link-writer.ts` (NEW) — `writeSoftLink`, `proposeHardLink`,
  `confirmHardLink`, `rejectHardLink`, `decayHardLink`. The
  single-source-of-truth write API for the link substrate.
- `src/tests/core/migration/links-schema.test.ts` (NEW) — schema
  migration tests.
- `src/tests/core/link-writer.test.ts` (NEW) — write-helper tests.

### Plan 14-07d (Worker D — soft-link autonomous writers) owns

- `src/intelligence/soft-link-writers.ts` (NEW) — site-specific
  helpers that wire `writeSoftLink` into:
  - handoff-writer (supersedes — new handoff supersedes prior ACTIVE.md
    snapshots)
  - lesson-promoter (promoted_to — observation → lesson promotion
    creates a link from observation to lesson)
  - frame-extractor (extracted_from — highlights extracted from a
    session frame link back to the session row)
  - retrieval-log (references — cross-artifact pointers when a
    retrieval log entry references an artifact)
- `src/angel/handoff-writer.ts` — instrumented to call
  `softLinkWriters.recordSupersedes` post-write. Additive; existing
  contract unchanged.
- `src/angel/lesson-promoter.ts` — instrumented to call
  `softLinkWriters.recordPromotedTo`.
- `src/angel/frame-extractor.ts` (or wherever frame extraction lives)
  — instrumented to call `softLinkWriters.recordExtractedFrom`.
- `src/intelligence/retrieval-log.ts` — instrumented to call
  `softLinkWriters.recordReferences` (READ-ONLY add: D does not
  re-migrate 14-07b's V17 work).
- `src/tests/intelligence/soft-link-writers.test.ts` (NEW).
- `src/tests/angel/handoff-writer.test.ts` — adds tests for
  supersedes link emission.

### Plan 14-07e (Worker E — claudex_trace MCP + retrieval boost) owns

- `src/mcp/recall-server.ts` — **adds** the `claudex_trace` tool
  registration. No edits to existing tool handlers.
- `src/mcp/tools/claudex-trace.ts` (NEW) — tool handler.
  `claudex_trace({ artifact_id, max_hops, types?, direction? })`.
  Walks the link graph from the given artifact; returns N-hop
  neighborhood.
- `src/intelligence/link-distance-boost.ts` (NEW) — link-distance
  scoring helper. Given a query artifact + candidate set, computes
  per-candidate link-distance and applies a configurable boost
  weight.
- `src/core/hybrid-retrieval.ts` — **adds** the
  link-distance boost as an optional ranking modifier behind a
  feature flag (`CLAUDEX_LINK_DISTANCE_BOOST=1`). E does NOT modify
  the existing scoring math; the boost is additive at the rerank
  step.
- `src/tests/mcp/claudex-trace.test.ts` (NEW).
- `src/tests/intelligence/link-distance-boost.test.ts` (NEW).
- `src/tests/intelligence/hybrid-retrieval-with-boost.test.ts` (NEW
  — tests the flag-on path; flag-off path stays unchanged).

### Plan 14-07f (Worker F — hard-link LLM proposer + Good Child UX) owns

- `src/intelligence/hard-link-proposer.ts` (NEW) — Angel-scheduled
  proposer. At session-end boundary, runs an LLM pass over recent
  artifacts, proposes `triggered_by`, `evidence_for`, `contradicts`
  links. Writes proposals via `proposeHardLink` from LSS.
- `src/angel/boundary-detector.ts` — hooks `runHardLinkProposer`
  into the post-session-end action sequence (Phase 14-05 already
  established the boundary detector as the single owner of
  session-end side effects). Additive.
- `src/assembly/sections.ts` — **adds** `formatPendingReviewLinksSection`
  function. Returns the "## Inferred Links Pending Review" section
  for the assembler cascade. F owns ONLY this function.
- `src/assembly/assembler.ts` — wires the new section into the
  cascade order (TBD: between P2.7 Project Knowledge and the
  Provenance Chain section that G adds; F + G coordinate on cascade
  position via integration branch).
- `src/intelligence/link-decay.ts` (NEW) — anti-link decay logic
  (after N rejections per session, the proposer should not re-suggest
  the same link).
- `src/tests/intelligence/hard-link-proposer.test.ts` (NEW).
- `src/tests/assembly/pending-review-links.test.ts` (NEW).
- `src/tests/intelligence/link-decay.test.ts` (NEW).

### Plan 14-07g (Worker G — Provenance Chain assembly surface) owns

- `src/intelligence/provenance-walker.ts` (NEW) — walks the link
  graph from a checkpoint decision (or any artifact) back to its
  source observations. Returns an ordered chain.
- `src/assembly/sections.ts` — **adds** `formatProvenanceChainSection`
  function. G owns ONLY this function.
- `src/assembly/assembler.ts` — wires the new section into the
  cascade order. Coordinates with F on position.
- `src/tests/intelligence/provenance-walker.test.ts` (NEW).
- `src/tests/assembly/provenance-chain.test.ts` (NEW).

---

## sections.ts function-level ownership

`src/assembly/sections.ts` is touched by F and G. PM enforces:

| Function | Owner |
|---|---|
| `formatPendingReviewLinksSection` | F (new) |
| `formatProvenanceChainSection` | G (new) |
| Every existing function | UNTOUCHED by Wave 2 |

Constraints:
- F does NOT modify any function other than its own new
  `formatPendingReviewLinksSection`.
- G does NOT modify any function other than its own new
  `formatProvenanceChainSection`.
- Both workers add imports at the top of the file. Imports are
  organized alphabetically; merge conflicts on import block are
  resolved by re-rebasing G onto F (or vice versa, decided by merge
  order below).
- Neither worker modifies type definitions in `sections.ts` unless
  the new type is exclusively used by their own function. Shared
  types stay UNTOUCHED.

`src/assembly/assembler.ts` is also touched by F and G — for cascade
wiring only. Constraints:
- Each worker adds ONE line of section invocation in the cascade
  order at the documented position.
- Cascade position: F's section first (`Pending Review Links` as
  P2.8), G's section second (`Provenance Chain` as P2.9). This is
  the PM-locked order. If a worker disagrees, escalate before code.

---

## Merge order

1. **LSS first** — schema migration is additive. No conflict.
2. **D, E, F, G fan out in parallel** after LSS lands. PM merges in
   this order:
   - **D first** (touches no shared files).
   - **E second** (touches no shared files outside hybrid-retrieval,
     which is gated behind feature flag).
   - **F third** (adds `formatPendingReviewLinksSection` + cascade
     wiring).
   - **G fourth** (adds `formatProvenanceChainSection` + cascade
     wiring after F's section).
3. Integration branch `phase-14-07/wave2-integration` carries the
   merged Wave 2 state.

If a worker's review (Codex / Gemini) returns NO-SIGNOFF, that
worker holds at HEAD until resolution; other workers continue.

---

## Cross-plan invariants

1. **Link tables are single-writer by LSS for SCHEMA.** D/E/F/G
   write ROWS to the tables, but do not modify the tables' DDL.

2. **`writeSoftLink` is the only public write path for soft links.**
   No worker bypasses it. Same for `proposeHardLink` / `confirmHardLink`
   / `rejectHardLink` / `decayHardLink` for hard links.

3. **No worker modifies V17 unified artifact schema.** That's done.
   Link tables reference `artifact.id`; the V17 shape is locked.

4. **Link-distance boost ships with feature flag OFF by default**
   (`CLAUDEX_LINK_DISTANCE_BOOST` unset or `=0`). Per CONTEXT
   position-unless-flagged. Operator decides flag-on after telemetry
   observation.

5. **Hard-link proposer outputs queued, not committed.** Every
   proposer output is a "pending" hard_link row with
   `confirmed_by_session = NULL`. The assembly surface (F's
   `formatPendingReviewLinksSection`) renders pending links for
   operator review; only operator action via the propose-confirm UX
   commits them.

6. **No worker auto-confirms hard links.** Even if the LLM proposer
   reports `confidence = 1.0`, operator is in the loop. Good Child
   policy locked.

7. **Provenance walker (G) and link-distance boost (E) share the
   underlying `soft_link` + `hard_link` tables**, but neither owns
   the schema. Both READ; LSS defined the SHAPE.

8. **No new session-start surfaces in Wave 2 beyond what F and G
   add.** F = Pending Review Links. G = Provenance Chain. Anything
   else is Wave 3 / out of scope.

9. **Anti-scope for Wave 2 (every worker must NOT):**
   - Touch session-start lesson surface (Wave 3 / 14-07j).
   - Touch session-start codebase-context surface (Wave 3 / 14-07i).
   - Touch MEMORY.md regenerator (Wave 3 / 14-07h).
   - Touch experience-tier project-scope filter (Wave 3 / 14-07h).
   - Change hybrid-retrieval ranking math beyond the additive
     link-distance boost (E's only change to scoring is the boost,
     gated by flag).
   - Change reranker model, embedder model, vector dimensions.

---

## Worker → PM escalation

Workers ask the PM when they hit:
- A file not in their ownership column AND not in another plan's
  ownership column.
- A schema decision not covered in their PLAN.md or this manifest.
- A cascade-position dispute (F + G coordinate on Provenance Chain
  vs Pending Review Links order — PM has locked F first, G second).
- A test failure outside their plan's scope.
- A spec ambiguity in their PLAN.md.

Workers do NOT escalate for:
- Standard implementation choices.
- Build / test re-run mechanics.
- Anything listed in their plan's `must_haves.truths` or this
  manifest's invariants.

---

## PM → PO escalation

PM escalates to PO (operator) when:
- A worker reports a fundamental contradiction between two plan ACs.
- The link-distance boost in E shows ranking-quality regression
  in tests (operator decides to ship with flag off, or to revise
  the boost).
- The hard-link proposer UX in F has shape concerns operator
  hasn't reviewed (the propose-confirm-defer flow needs operator
  eyes on the simulation before ship).
- Cross-family external review (Codex + Gemini) returns NO-SIGNOFF
  with a load-bearing concern.

---

## SIGNOFF + ship per plan

Each plan ships its own commit with:
- All AC from the plan green.
- Tests pass within plan's scope.
- Cross-family external review (Codex + Gemini) SIGNOFF.
- PM merge after order check.
- Updated `14-07-WAVE2-STATUS.md`.

After all 5 plans (LSS + D + E + F + G) land, PM kicks off Wave 3.

---

## Wave 2 gate handoff to Wave 3

When Wave 2 exits cleanly:
- All 5 plan ACs green.
- `claudex_trace` MCP tool responds correctly on test fixtures.
- Hard-link propose-confirm UX flow tested end-to-end with
  operator-simulation fixtures.
- Provenance Chain section renders correctly for synthetic decisions.
- Link-distance boost feature flag both states tested (off = current
  behavior; on = boosted behavior validated).
- Soft-link autonomous writers produce correct links at all 4 sites
  (handoff supersedes, lesson promoted_to, frame extracted_from,
  retrieval-log references).
- **Operator review of Hard-Link UX completed** — the propose-confirm-
  defer flow shape signed off before any production LLM proposer
  run.
- Wave 3's 14-07j (link-aware lesson inline-expansion) can now
  reference the link graph.

---

## What this is NOT

- Not a replacement for per-plan PLAN.mds.
- Not a substitute for git's conflict resolution.
- Not authority for scope changes — plans + CONTEXT + this manifest
  define scope.
- Not a UX design document — the propose-confirm-defer UX shape
  lives in 14-07f-PLAN.md and `memory/project_v7_hard_link_writer_is_good_child.md`.
- Not a benchmark gate — Wave 2 has no formal Vesna/LongMemEval/LoCoMo
  gate. The gates fire at v7.0.0 ship (after Wave 3). Wave 2's
  per-plan tests are the verification surface for this wave.
