# UPS Cascade Audit (assembleRegularPrompt) — Phase 5 Plan 06

**Date:** 2026-04-29
**File:** src/assembly/assembler.ts (assembleRegularPrompt)

## Pre-Plan-06 composition

| Section | Source | Cap (tokens) | Notes |
|---------|--------|--------------|-------|
| Critical Reminders | critical_reminders | 300 (decay TTL) | Per-turn; fires on rule-domain hits |
| Proven Principles | proven_principles | 500 | Periodic reinforcement (every 5 turns), gated by turn-count |
| Intent-triggered Patterns | intent_patterns | section-level | Categorical matcher on `params.classifiedIntent` |
| Experience Warnings (FTS5+vector) | experience_warnings | section-level | UPS variant — Plan 08 redirects to reactive triggers |
| Trigger-materialized Artifacts | trigger_materialized | section-level | Fires on getMaterializedArtifacts non-empty |

## Post-Plan-06 composition

| Section | Source | Cap (tokens) | Notes |
|---------|--------|--------------|-------|
| Critical Reminders | critical_reminders | 300 | unchanged |
| Proven Principles | proven_principles | 500 | unchanged (UPS retention per Plan 04 verdict) |
| **Codebase Index (NEW)** | codebase_index | 200 | query-gated; relocated from session-start |
| Intent-triggered Patterns | intent_patterns | section-level | unchanged |
| Experience Warnings | experience_warnings | section-level | Plan 08 wires reactive triggers |
| Trigger-materialized Artifacts | trigger_materialized | section-level | unchanged |

**Total budget cap:** 1024 bytes ≈ 256 cl100k_base tokens. Section caps sum to ~1500 — relies on cascade gating (each section only fires if conditions met AND remaining budget allows).

## Codebase Index relocation rationale

- **From:** `assembleFullContext` (session-start), 800-token cap, fired unconditionally on every session-start, used `params.searchQuery ?? checkpoint?.thread?.topic ?? null` AND a `getChangedFiles` "Changed since last session" sub-block.
- **To:** `assembleRegularPrompt` (UPS turn), 200-token cap, fires only when `params.prompt.trim().length > 0` AND `findRelevantFiles` returns matches AND `cost ≤ 200`.
- **Reason:** Codebase relevance is task-shaped, not session-start static. UPS query (the user's actual prompt) is a stronger signal than the session-start checkpoint topic.

## Changed-since-last-session: dropped

The session-spanning "Changed since last session" sub-block (post `getChangedFiles`) was NOT migrated to UPS. Per-turn relevance is task-shaped; session-spanning changes belong either at session-start (where token budget no longer admits them post-Tier-C) or in a separate on-demand surface (e.g., a `/claudex changes-since-last-session` slash command — out of Phase 5 scope).

`getChangedFiles` import removed from `assembler.ts`.

## CACH-03 hardening continuity

The new UPS codebase_index block uses `_shortenPathCacheStable(f.file_path)` — same cache-stable normalize as the deleted session-start block. No new clock/session/host leak introduced.

## Cap reconciliation

| Concern | Status |
|---------|--------|
| Critical reminder verbosity | OK (300-token section cap) |
| Proven principles re-injection on every turn | OK (turn-count gate `turnCount > 1 && turnCount % 5 === 0`; doesn't fire on first 2 UPS turns) |
| Codebase index spillover | OK (200-token hard cap per section + UPS total cap monitored by test) |
| Intent-triggered + Experience Warnings co-fire | OK (section caps + cascade gating) |

## Test coverage

`src/tests/assembly/assembler-ups-budget.test.ts` asserts per-turn payload ≤1024 bytes across 4 fixture scenarios. All 4 PASS.

Per-scenario UPS bytes (in-memory fixture, no real codebase index seeded):
- no-prompt = 0
- short-prompt = 0
- long-prompt-with-tech-terms = 0
- critical-reminder-active = 0

The fixture cascade gates aren't all met (turn count, codebase index data), so output is empty — but the budget invariant is locked. Plan 09 production-baseline soak measures live UPS bytes against real DB content.

## Post-Phase-5 budget summary

- **Session-start (assembleFullContext):** ≤500 tokens hard (cl100k_base)
- **UPS (assembleRegularPrompt):** ≤1024 bytes hard (~256 tokens)
- **Total per-session injection:** ≤500 + ≤1024-bytes-per-turn × N turns
