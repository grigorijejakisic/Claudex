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
| P1.5 | Experience Warnings | FTS5-matched patterns |
| P2 | Project | From PROJECT_PRIMER.md (fallback when no CLAUDE.md) |
| P2.5 | Session Continuity | Handoff + latest session log |
| P3 | Checkpoint | Loaded from DB, skipLearnings=true |
| P4 | Learnings | Top 5 cross-session learnings |
| P4.05 | Entity Summaries | Angel-generated entity knowledge |
| P4.07 | Angel Opinions | CARA insights (confidence >= 0.7) |
| P4.1 | Proven Principles | Always-applicable patterns (500 token cap) |
| P4.25 | Project Overview | Cross-project awareness (session-start only) |
| P4.5 | Rules Reminder | CLAUDE.md rules (post-compact only) |
| Flow | Session Flow | Journal entries as narrative spine |
| L2 | Reference Layer | Packed artifact summaries (metadata only) |
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
