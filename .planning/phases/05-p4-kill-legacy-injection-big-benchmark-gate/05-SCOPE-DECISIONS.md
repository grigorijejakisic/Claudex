# Phase 5: Scope Decisions for Ambiguous Sections

**Locked:** 2026-04-29 by team-lead via plan-5 SendMessage exchange.
**Source of truth:** This document. Plans 03-08 reference these verdicts; do not re-litigate.

## Sections Not Enumerated by ROADMAP SC#1-#2

ROADMAP SC#1 (deletions) and SC#2 (keeps) name 9 + 5 sections. The following 4 currently
appear in `src/assembly/assembler.ts`'s `assembleFullContext()` cascade and were not enumerated.

### claudex_ready (assembler.ts:281-289)
**Verdict:** KEEP.
**Rationale:** ~70 tokens, navigation reinforcement for MCP tools. No overlap with deleted v3-era sections. Cache-stable after CACH-03 hardening (no clock/session/host coupling).

### learnings (assembler.ts:363-377)
**Verdict:** KEEP.
**Rationale:** Reads from `learnings` table (promotion_count ORDER BY), separate from `experience_patterns` (which feeds Experience Warnings). Different consumer (top-5 promoted cross-session insights vs keyword-matched per-turn warnings). Distinct surface and purpose. Tiebreaker fix at `learnings.ts:60` (Plan 1 task 4) makes its order cache-stable.

### project_overview (assembler.ts:443-473)
**Verdict:** DELETE.
**Tier:** B (mid-density, lands in Plan 04).
**Rationale:** Phase 6.5 ships the principled cross-project mechanism (cross-project task-pattern recall via shape vocabulary + telemetry handles). This ad-hoc section is the v3-era "writers without consumers" pattern the audit caught. Removed in Plan 04 alongside Predicted/Opinions/Principles.

### codebase_index (assembler.ts:636-690)
**Verdict:** MOVE to UPS turn payload (≤1KB/turn).
**Plan:** 06.
**Rationale:** 800-token cap alone is half the session-start ≤500 budget — does not fit. Codebase relevance is task-shaped, not session-start static. Move to UPS in Plan 06 with proper budget split.

## Surviving session-start cascade (post-Phase 5)

Identity → claudex_ready → Project (CLAUDE.md) → Session Continuity → Checkpoint → learnings → rules_reminder (post-compact only) → GSD

All cache-stable post-CACH-03. Combined budget: target ≤500 tokens hard cap.
