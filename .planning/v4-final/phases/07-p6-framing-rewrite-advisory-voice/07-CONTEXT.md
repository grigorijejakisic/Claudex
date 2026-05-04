# Phase 7: P6 — Framing Rewrite (Advisory Voice) — Context

**Gathered:** 2026-04-29
**Status:** Ready for planning
**Generative axiom:** Memory should surface as observation, not command. The agent thinks WITH prior experience (kid-stove organic recall), not against rules. Imperative voice produces rule-following behavior; advisory voice produces experience-shaped reasoning.

---

<domain>
## Phase Boundary

This phase delivers three things and only these three things:

1. **Imperative-voice purge** in `src/intelligence/sections.ts` and any other surviving formatter — no `WARNING:`, no `**Correct approach:**`, no `Apply them proactively — they are always relevant`, no `supersedes CLAUDE.md on conflict`, no command-shaped phrasings
2. **Advisory-voice rewrite** for experience-warning surface (when agent explicitly queries) — descriptive observation pattern: *"Similar prior situation (session X): user wanted Y; outcome was Z."* The `<experience-data>` wrap stays for injection isolation; inner content is descriptive, not imperative.
3. **1-week behavioral A/B (loose interpretation, locked decision)** — advisory voice ships, user uses system normally for a calendar week of real sessions, end-of-week subjective scoring against memory of pre-Phase-7 behavior. No env-flag toggle (loose ≠ strict). Documented in `.planning/phases/07/07-BEHAVIORAL-AB.md`.

**Out of scope:**
- New formatters or retrieval signals
- Restructuring the `<experience-data>` wrap or surface mechanics
- Strict env-flag-based A/B with toggle (explicitly declined — loose interpretation locked)
- Reformatting MEMORY.md content (that's 4.1's territory)

**Hard gates:**
- Vesna pass rate maintained (SC#1 ≥80%)
- Manual inspection confirms zero imperative framing across all formatters
- Behavioral A/B writeup committed before phase close

</domain>

<decisions>
## Implementation Decisions

### Imperative phrases purged (non-exhaustive)

Search-and-rewrite targets:
- `WARNING:` / `IMPORTANT:` / `CRITICAL:` prefixes → drop or replace with neutral descriptor
- `**Correct approach:**` / `**Right way:**` → reframe as `**Outcome observed:**` or drop
- `Apply them proactively — they are always relevant` → drop (this whole imperative footer pattern goes)
- `supersedes CLAUDE.md on conflict` → drop (no priority hierarchy phrasing)
- `Always X` / `Never X` (in injected content, NOT in CLAUDE.md author rules) → reframe as `Prior pattern: X led to Y`
- `You should X` / `You must X` → reframe to `Past sessions did X; outcome was Y`

Planner does the systematic search-and-rewrite via grep against the formatter modules.

### Advisory voice template

Replace imperative experience-warning shapes with:

```
Similar prior situation (session {id}): user wanted {framing};
outcome was {result}; relevant context: {key details}.
```

For experience-pattern surfacing:
```
Past sessions on {pattern} ({N} times): typical outcome was {Y};
the moment that changed things was {decisive_event}.
```

The pattern: state what happened, not what should happen. Let the agent reason from observation.

### `<experience-data>` wrap

- Retained — serves as injection isolation marker
- Inner content rewritten to descriptive voice
- No imperative framing inside the wrap
- Agent treats wrap content as "observed past" not "commanded behavior"

### Loose 1-week behavioral A/B (locked)

- Advisory-voice formatters ship live
- User uses the system normally for 1 calendar week (no special protocol)
- Optional running notes during the week (helpful for end-of-week review)
- End of week: user writes subjective scoring in `.planning/phases/07/07-BEHAVIORAL-AB.md`
- Comparison is **against memory of pre-Phase-7 behavior**, not against an env-flag-toggled control
- Subjective scoring framework: weak / medium / strong evidence of advisory shift, with examples per session shape (debug, feature work, design discussion, /endsession)

### Acceptance criteria for the A/B

- **Pass**: subjective scoring identifies medium-or-stronger evidence of advisory shift, no behavioral regressions noted
- **Fail**: weak or no evidence, or active regressions (e.g., agent ignores load-bearing rules that were imperative-framed)
- **Investigate-don't-revert on weak evidence**: weak shift might be agent inertia or insufficient session diversity in the week. Extend by another 3-7 days before declaring fail.
- Hard revert only on active regressions

### Claude's Discretion (planner free to decide)

- Whether to script the imperative-phrase purge (regex-based) or do it as a manual review pass — recommendation: scripted regex pass for known phrases, manual review for borderline cases
- Exact wording of advisory-voice templates beyond the locked shape (planner refines based on actual content being rewritten)
- Whether to log per-session behavioral observations during the week (recommendation: yes, but optional for user — friction-free)
- Whether failure-mode catalog is needed (recommendation: not in 7; track ad-hoc, formalize in later phase if patterns emerge)

</decisions>

<specifics>
## Specific Ideas

- **Voice is the surface of the kid-stove principle**: the substrate (4.1) gives episodes; retrieval (6.5) surfaces them; framing (7) is what determines whether the agent treats surfaced content as experience-to-reason-with or rules-to-follow. All three are required for organic recall to actually work in production.
- **Loose A/B is honest**: the question being tested is qualitative ("does it feel organic?"). Strict env-flag A/B's marginal precision doesn't beat the cognitive cost of toggle-tracking. Subjective scoring against memory is real-world-honest.
- **Imperative purge is not advisory rewrite**: deleting WARNING prefixes alone isn't enough — the underlying sentence structure must shift from command to observation. Phase 7 ships both: purge AND rewrite.

</specifics>

<deferred>
## Deferred Ideas

- **Strict env-flag-based A/B with day-by-day toggle** — explicitly declined; cognitive cost > marginal evidence value
- **LLM-judged voice classifier** — automatic check that no formatter outputs imperative-shaped sentences. Adds dependency; manual review is enough for 7.
- **Per-formatter voice style guide** — formal style doc. Recommendation: extract during planning if needed; not a phase deliverable.
- **Behavioral observability for the A/B** (instrumented data on whether agent "uses" advisory vs imperative differently) — Phase 8.5's territory; partial overlap acceptable.

</deferred>

<artifacts>
## Reference Artifacts

- `src/intelligence/sections.ts` — primary deliverable target
- `src/intelligence/critical-reminders.ts` — already advisory-shaped for the most part, verify
- `src/intelligence/experience-patterns.ts` — surface that needs rewrite
- `src/intelligence/assembler.ts` — composes the formatters; voice changes propagate from sections.ts

</artifacts>

---

*Phase: 07-p6-framing-rewrite-advisory-voice*
*Context gathered: 2026-04-29*
*Behavioral A/B: loose interpretation locked (no env-flag toggle)*
