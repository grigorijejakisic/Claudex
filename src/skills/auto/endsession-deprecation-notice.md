# /endsession Deprecation Notice — Phase 13 Organic Claudex

**Status:** APPLIED 2026-05-14 — skill directory `~/.claude/skills/endsession/` removed via `rm -rf` after the operator-run end-to-end substrate test passed same day (planted-fact recall worked from a fresh CC session in the same project via `claudex-recall` × 4 calls). Per-turn Sessions/ writes + Angel highlights extraction now replace the manual /endsession ritual. One-week deprecation window cast away because the substrate proved out.
**Phase:** 13-organic-claudex
**Context:** `.planning/phases/13-organic-claudex/13-CONTEXT.md` + spec at `.planning/research/2026-05-14-phase-13-organic-claudex.md`

## Why This Skill Is Being Deleted

Phase 13 (Organic Claudex) ships the autonomous substrate that /endsession was compensating for:

- **Sessions/ per-turn fsync writes** (Plan 13-01) ensure the conversation is durably captured turn-by-turn — no batch-at-session-end ritual to forget.
- **Angel highlights extraction** (Plan 13-03) produces the frame artifact (mental model, open questions, reframes, tools introduced, decisions not made, posture) at session boundary. Opus 4.7 OAuth primary, local-LLM fallback with degraded-flag discipline.
- **Auto-orient at session-start** (Plan 13-04) delivers the frame from the prior 3 sessions to the next session via `assembleFullContext`'s Priority 2.6 `## Recent Session Frames` block.
- The existing session-end hooks (Plan 04-04, Phase 6 atomic close marker) already write the close marker and trigger Angel extraction. No additional skill invocation required.

/endsession existed because closing a session without the ritual lost the session's frame. Phase 13 makes frame capture automatic. Retaining the skill keeps the "emergency exit" alive and reduces the substrate's accountability.

## Pre-Committed Vesna Gate (Verified at 13-06 Close)

Same Vesna result as /starthere — see `starthere-deprecation-notice.md` § Pre-Committed Vesna Gate.

Gate condition: ≥29/29 (100%). **This condition is MET (29/29 at 100% GATED PASS).**

## Deprecation Window Gate (One Week)

Same as /starthere — see `starthere-deprecation-notice.md`.

- **Window opens:** 2026-05-14
- **Window closes:** 2026-05-21

## Step 1: Add Deprecation Warning to SKILL.md (Apply Now)

Open `~/.claude/skills/endsession/SKILL.md` and add the following line at the very top, before any existing content:

```
> DEPRECATED: This skill's function is now handled autonomously by the Claudex substrate (Phase 13). Sessions/ per-turn writes + Angel highlights extraction replace the manual /endsession ritual. Deletion pending after 2026-05-21 if no context-loss incidents.
```

## Step 2: Delete the Skill (Apply After Window Passes)

After the deprecation window closes with no context-loss incidents and Vesna ≥29/29:

```bash
rm -r ~/.claude/skills/endsession/
```

Confirm deletion:

```bash
ls ~/.claude/skills/ | grep endsession
# Should output nothing
```

## CHANGELOG Entry (Copy Into CHANGELOG.md Under [6.x Organic Claudex] § Deferred)

```
- Deleted /endsession skill (Phase 13 close-out). Autonomous substrate replaces it: per-turn Sessions/ writes (13-01), Angel highlights extraction at session-boundary (13-03), auto-orient at next session-start (13-04). One-week deprecation window passed with no context-loss incidents.
```

## Rollback Contract

If Vesna handoff-pickup drops below Phase 12 baseline after deletion:

- Plans 13-01 through 13-05 reopen.
- Skill is NOT restored — the substrate gets fixed.
- A new Phase 13.1 is opened.

---

*Phase: 13-organic-claudex*
*Plan: 06*
*Operator-applied step. Plan executor does NOT modify ~/.claude/skills/.*
