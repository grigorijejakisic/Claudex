# /starthere Deprecation Notice — Phase 13 Organic Claudex

**Status:** APPROVED — apply after one-week deprecation window passes (2026-05-21 or later)
**Phase:** 13-organic-claudex
**Context:** `.planning/phases/13-organic-claudex/13-CONTEXT.md` + spec at `.planning/research/2026-05-14-phase-13-organic-claudex.md`

## Why This Skill Is Being Deleted

Phase 13 (Organic Claudex) ships the autonomous substrate that /starthere was compensating for:

1. **Sessions/ source of truth** (Plan 13-01) — per-turn fsync writes from UserPromptSubmit + Stop + (opt-in) PostToolUse to `<cwd>/Sessions/<date>_<session-id>.md`.
2. **DB-as-derived-index** (Plan 13-02) — Angel heartbeat stat()-scans Sessions/ via mtime, re-indexes new/modified files through the existing Phase 8 upsertChunk pipeline. Recovery = normal path.
3. **Highlights extraction** (Plan 13-03) — V33 session_highlights + Angel extractor (Opus 4.7 OAuth primary, local-LLM fallback with degraded-flag discipline) produces per-session frame artifacts at session boundary.
4. **Auto-orient at session-start** (Plan 13-04) — `assembleFullContext` injects `## Recent Session Frames` + `**Current time:** <ISO>` at Priority 2.6. Plus `## Frame Extraction Degraded` health line mirroring Reranker Health.

The autonomous substrate now carries what /starthere was doing manually. Retaining the skill creates a fallback excuse for the substrate to underperform.

## Pre-Committed Vesna Gate (Verified at 13-06 Close)

The Vesna gate was verified at Phase 13-06 plan close with result:

```
AGGREGATE: 100% — GATED PASS
  entity-recall: 5/5 (100%) flaky=0
  constraint-recall: 3/3 (100%) flaky=0
  handoff-pickup: 3/3 (100%) flaky=0
  cross-project: 3/3 (100%) flaky=0
  lesson-application: 3/3 (100%) flaky=0
  self-instrumented: 4/4 (100%) flaky=0
  deliberation-pipeline-fanout: 5/5 (100%) flaky=0
  deliberation-agent-engagement: 3/3 (100%) flaky=0
```

Gate condition: ≥29/29 (100%). **This condition is MET.**

## Deprecation Window Gate (One Week)

Before deleting:

1. One full week of real sessions (≥7 days from Phase 13 merge) with no operator-reported context-loss incidents.
2. `bun run vesna` ≥29/29 at the deletion-time re-verification.
3. Operator confirms: "no context-loss incidents this week."

- **Window opens:** 2026-05-14 (Phase 13 merge date)
- **Window closes:** 2026-05-21 (7 days later — adjust if merge date shifts)

## Step 1: Add Deprecation Warning to SKILL.md (Apply Now)

Open `~/.claude/skills/starthere/SKILL.md` and add the following line at the very top, before any existing content:

```
> DEPRECATED: This skill's function is now handled autonomously by the Claudex substrate (Phase 13). Deletion pending after 2026-05-21 if no context-loss incidents. Run `bun run vesna` to verify substrate quality before invoking this skill.
```

## Step 2: Delete the Skill (Apply After Window Passes)

After the deprecation window closes with no context-loss incidents and Vesna ≥29/29:

```bash
rm -r ~/.claude/skills/starthere/
```

Confirm deletion:

```bash
ls ~/.claude/skills/ | grep starthere
# Should output nothing
```

## CHANGELOG Entry (Copy Into CHANGELOG.md Under [6.x Organic Claudex] § Deferred)

```
- Deleted /starthere skill (Phase 13 close-out). Autonomous substrate carries all /starthere functionality: per-turn Sessions/ writes (13-01), DB re-indexing (13-02), Angel highlights extraction (13-03), auto-orient injection at session-start (13-04). One-week deprecation window passed with no context-loss incidents.
```

## Rollback Contract

If `bun run vesna` handoff-pickup probe drops below Phase 12 baseline (29/29) AFTER deletion:

- Plans 13-01 through 13-05 reopen for diagnosis.
- The skill is NOT restored — the failure is in the substrate, not the skill.
- A new Phase 13.1 is opened to fix the substrate gap.

The parable: if the substrate fails after deletion, that's the substrate's failure — not evidence the skill should return.

---

*Phase: 13-organic-claudex*
*Plan: 06*
*Operator-applied step. Plan executor does NOT modify ~/.claude/skills/.*
