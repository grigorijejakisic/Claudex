# v4.1 — Distribution

**Status:** Stub — milestone planning starts post-v4 ship.
**Created:** 2026-04-30 (Phase 11 close, v4.0.0 ship)

## Headline

v4.0 is internal infrastructure. v4.1 makes it installable by strangers.

## Carried-forward from v4 (deferred items)

The following items remained open at v4 ship; v4.1's milestone planning should start by triaging this list.

### From REQUIREMENTS.md `[ ]` / `[~]` items still open at v4 ship

- **STOR-06** — `artifact(kind='transcript_chunk')` rows carry `session_id`, `turn_range`, `topic_label`, embedding (Phase 4.1 reach fix scope)
- **STOR-09** — task-pattern fingerprint column on artifacts of `kind ∈ {mental_model, learning, experience_pattern, workspace_fact, lesson}` — auto-classified at write time
- **EXTR-04** (partial-B) — detector precision held-out recall measurement (target ≥0.85, floor ≥0.70); `negation_dont` family tune
- **EXTR-06** — transcript chunking via LLM topic-segmentation at `/endsession` (Phase 4.1 partial)
- **INJ-01..INJ-07** — session-start composition lock-down (most wired, but a final audit at v4.1 kickoff is sensible)
- **CUR-09..CUR-15** — MEMORY.md schema redesign + writer reach + chunker reach + parsing-bug fixes (Phase 4.1 partial; some items closed via Phase 11 SC#3)
- **FRAM-05** — Behavioral A/B for 1 week of real sessions; subjective verdict scaffold lives in `.planning/phases/07-p6-framing-voice-rewrite/07-BEHAVIORAL-AB.md`; verdict due 2026-05-06
- **LIFE-01..LIFE-04** — directive lifecycle (scope detection / supersession / decay / accumulation bound)
- **DIR-CONSUMER-01..DIR-CONSUMER-02** — PreToolUse hook surface for directives + scoped applicability
- All other unticked REQUIREMENTS.md items as of commit at v4 ship

### From Phase 11 specifically

- **Live SC#4 cold-start trials** (3 placeholder files in `.planning/phases/11-p9-final-validation/11-03-cold-start-trial-{1,2,3}.md`) — operator can run at any time; Vesna synthetic counterpart already 3/3 PASS at ship
- **Per-project CWD-filtered Vesna re-runs** — accepted as v4.1 deferral per Plan 11-04 explicit decision
- **Lessons reach for big-mozzy-v2 + claudex-v3** — managed `## Lessons` empty for these projects; SC#3 still PASS at 80 each via other dimensions; v4.1 should drive lesson reader to populate
- **`phase: "unknown"`** placeholders in 3 ACTIVE.md frontmatters (Lacuna/Oracle/big-mozzy) — v4.1 to update with real phase numbers when context permits
- **Nexus ACTIVE.md handoff freshness** — currently 0/20 (no `phase:`); v4.1 to normalize all live handoffs to Phase 7.5 schema
- **LongMemEval Oracle / LoCoMo full archival re-run** — harnesses verified operational; ~60min combined wall-clock; v4.1 archival pass

## Themes (initial — to be refined when /gsd:new-milestone is run)

1. **Installability**: stranger sets up Claudex from a clone in <30 minutes with no insider knowledge.
2. **Documentation**: README is the entry point, not CLAUDE.md.
3. **Onboarding cold-start**: first-session experience is intentional, not improvised.
4. **External integrations**: Claude Code is one harness; v4.1 considers others (Cursor, Zed, etc.) — scope TBD.
5. **Open issues from v4 deferrals**: see "Carried-forward" above.
6. **Branch protection rule for the Vesna CI gate** — manual GitHub UI step from Phase 10 is a v4.1 setup item.

## Next steps

- After v4.0.0 tag pushes, run `/gsd:new-milestone` for v4.1 to start the requirements + roadmap cycle.
- Do NOT pre-plan phases here — this is a stub. v4.1 planning is its own milestone.
