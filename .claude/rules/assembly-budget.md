---
paths:
  - "src/assembly/**"
---

# Assembly Budget Cascade

## Full Assembly (SessionStart / Post-Compaction)

Priority-ordered cascade with budget gating. Each section only included if within remaining budget.

| Priority | Section | Notes |
|----------|---------|-------|
| P1 | Identity | From USER.md |
| P1.1 | Claudex Ready | Navigation reinforcement (~70 tokens) |
| P1.2 | Reranker Health | Cross-encoder → bi-encoder fallback notice (descriptive; bypasses budget; null on happy path) |
| P1.3 | Substrate Health | Angel heartbeat freshness + session_highlights extraction lag (Phase 13.1 Fix #5, 2026-05-15; descriptive; bypasses budget; null when both within threshold) |
| P1.5 | Experience Warnings | FTS5-matched patterns |
| P2 | Project | From PROJECT_PRIMER.md (fallback when no CLAUDE.md) |
| P2.5 | Session Continuity | ACTIVE.md frontmatter (status/phase/summary) + body inline fields + `## Operator Gates` section. Source of truth: `context/handoffs/ACTIVE.md`. Session-log "Where We Left Off" extraction removed in Phase 13.1 Fix #1 (2026-05-15) — it surfaced stale prior-session framings. |
| P2.6 | Recent Session Frames | session_highlights for current project (JOIN to sessions for project-truth filter; Fix #4, 2026-05-15). Frame Extraction Degraded health line piggybacks here. |
| P3 | Checkpoint | Loaded from DB, skipLearnings=true |
| P4 | Learnings | Top 5 cross-session learnings |
| P4.05 | Entity Summaries | Angel-generated entity knowledge |
| P4.07 | Angel Opinions | CARA insights (confidence >= 0.7) |
| P4.1 | Proven Principles | Always-applicable patterns (500 token cap) |
| P4.25 | Project Overview | Cross-project awareness (session-start only) |
| P4.5 | Rules Reminder | CLAUDE.md rules (post-compact only) |
| Flow | Session Flow | Journal entries as narrative spine |
| L2 | Reference Layer | Packed artifact summaries (metadata only) |
| L2.5 | Deliberation Surface | v6 Phase 10 — opt-in transcript-span citations + advisory narration; capped at v6.routing.token_pct_cap × budget; bi-encoder-only paths reduced by v6.routing.bi_encoder_budget_pct |
| L3 | Materialization | FTS5-selected full content |
| Codebase | Codebase Context | Relevant symbols + recent changes (session-start only, 800 token cap) |
| Predicted | Predicted Context | Proactive memory (session-start only, 2000 token cap) |
| GSD | GSD State | Planning state |

## Regular Prompt (UserPromptSubmit)

Lightweight per-turn injection:
- Proven Principles (500 token cap)
- Critical Reminders (300 token cap, decay-based TTL)
- Intent-triggered Patterns (categorical matching)
- Experience Warnings (FTS5 + vector hybrid)
- Trigger-materialized Artifacts

## Token Estimation
Use `estimateTokens()` from `src/shared/text-utils.js` for all budget calculations.
