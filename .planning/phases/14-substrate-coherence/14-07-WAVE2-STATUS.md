---
phase: 14-substrate-coherence
sub_phase: 14-07
wave: 2
last_updated: 2026-05-17
---

# Wave 2 Status

## Worker Status

| Worker | Plan | Status | Tests | Notes |
|---|---|---|---|---|
| LSS | 14-07-LINKS-SCHEMA | SHIPPED | ✓ | soft_link + hard_link + hard_link_history tables + write helpers |
| D | 14-07d | ? | ? | soft-link autonomous writers |
| E | 14-07e | ? | ? | claudex_trace MCP + link-distance boost |
| F | 14-07f | SHIPPED | ✓ 39/39 | hard-link LLM proposer + Good Child UX — this plan |
| G | 14-07g | SHIPPED | ? | Provenance Chain section (formatProvenanceChainSection present in links.ts) |

## 14-07f Deliverables

- `src/intelligence/hard-link-proposer.ts` — LLM proposer; rate-limited; flag-gated
- `src/intelligence/link-decay.ts` — anti-link decay helpers
- `src/assembly/sections/links.ts` — `formatPendingReviewLinksSection` added (P2.8)
- `src/assembly/sections/index.ts` — re-export added
- `src/assembly/assembler.ts` — P2.8 wired between P2.7 and P2.9
- `src/angel/boundary/boundary-detector.ts` — Action 6 hooked (flag-gated)
- `src/scripts/simulate-hard-link-ux.ts` — operator-runnable UX simulation
- `src/tests/intelligence/hard-link-proposer.test.ts` — 20 tests
- `src/tests/intelligence/link-decay.test.ts` — 7 tests
- `src/tests/assembly/pending-review-links.test.ts` — 12 tests
- `build.ts` — simulate-hard-link-ux.ts added to build entry points

## UX Simulation Output (2026-05-17)

Run: `node dist/scripts/simulate-hard-link-ux.cjs`

```
╔══════════════════════════════════════════════════════════════╗
║  14-07f Hard-Link UX Simulation (in-memory DB, mock LLM)   ║
╚══════════════════════════════════════════════════════════════╝

Options: --proposals 4

Seeded 6 synthetic artifacts (observation/decision/lesson/checkpoint).
Seeded 1 decayed anti-link tuple (a3→a5 contradicts, rejected 3× by operator).
Running proposer with MOCK LLM response...

── Proposer result ──────────────────────────────────────────
  Proposed:         4
  Skipped (decayed): 0
  Skipped (invalid): 0
  LLM error:        false

── formatPendingReviewLinksSection output (budget: 600 tokens) ──

## Inferred Links Pending Review
LLM-proposed hard links awaiting operator confirm/reject. (4 pending)

- [triggered_by] observation: MEMORY.md Lessons index wiped on regeneration → decision: Fix regenerator to preserve User Notes
  Confidence: 88%. Rationale: The MEMORY.md wipe observation triggered the decision to fix the regenerator sentinel guard.
  ID: 3 · Proposed: 2026-05-17

- [evidence_for] observation: BGE reranker fell back to bi-encoder → lesson: Reranker fallback is not transparent
  Confidence: 85%. Rationale: The specific reranker fallback observation is direct evidence for the lesson about non-transparent degradation.
  ID: 4 · Proposed: 2026-05-17

- [evidence_for] checkpoint: Phase 14-07 Wave 2 in progress → decision: Add reranker health line to session-start
  Confidence: 72%. Rationale: The Phase 14-07 checkpoint references the reranker health decision as a Wave 2 dependency.
  ID: 5 · Proposed: 2026-05-17

- [triggered_by] observation: BGE reranker fell back to bi-encoder → decision: Add reranker health line to session-start
  Confidence: 91%. Rationale: The reranker degradation observation triggered the decision to add health surfacing.
  ID: 2 · Proposed: 2026-05-17

To confirm or reject: call confirmHardLink(id) or rejectHardLink(id) via the future MCP tool, or update via direct DB.

── Simulation summary ────────────────────────────────────────
  No production DB was touched. All data is in-memory only.
  Flag is OFF by default — no proposer runs without explicit opt-in.
```

## Gate Status

- Build: GREEN
- New tests: 39/39 PASS (hard-link-proposer: 20, link-decay: 7, pending-review-links: 12)
- Full suite: 19 pre-existing failures unchanged (same set as baseline)
- Vesna SC#1: 28/28 GATED PASS (100%)
- UX simulation smoke: PASS (output captured above)
- CLAUDEX_HARD_LINK_PROPOSER flag: OFF by default — operator must opt-in after reviewing UX simulation

## Operator Review Gate

Per 14-07-CONTEXT Risk 3 and 14-07f-PLAN acceptance criteria:

**OPERATOR MUST REVIEW THE UX SIMULATION OUTPUT BEFORE ENABLING CLAUDEX_HARD_LINK_PROPOSER IN PRODUCTION.**

To enable:
```
export CLAUDEX_HARD_LINK_PROPOSER=1
```

This gate is held by PM until operator sign-off on the UX shape.
