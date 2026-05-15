---
date: 2026-05-15
target_project: big-mozzy-v2
auditor_session: b5e053ba-8406-47cf-8045-34daab62ee93
mode: read-only — one-time characterization (option a)
companion: 2026-05-15-big-mozzy-substrate-audit.md
---

# Cross-project equivalence hit-rate — 2026-05-15

One-time characterization of the cross-project experience-tier
injection mechanism (`src/core/cross-project-equivalence.ts` +
Experience Tier scorer, shipped commit `66fe3cb`). Question: when an
agent lands in big-mozzy-v2, what is the precision of the
"Past Experience — Relevant Patterns" surface that gets injected at
session-start and per-turn?

**Headline:** the surface fires at high rate but its **operational
precision is effectively 0%** for big-mozzy-v2. 83% of injections are
literal-noise observations (`Read: file.ts`, `Edit: x.ts`); the
remaining 17% are claudex-v3 self-knowledge memories with no domain
relevance to bet365 / Mozzart / FL365 work.

## Volume

`session_events` table, `event_type='experience_tier_injected'`,
project breakdown:

| Target project | Injection count |
|---|---|
| `big-mozzy-v2` | **2,515** |
| `claudex-v3` | 458 |
| `kompas-98604047` | 15 |
| `desktop-01dcc792` | 3 |

big-mozzy-v2 receives **5.5× more injections** than claudex-v3. The
mechanism is firing aggressively in exactly the project the operator
reports as having the worst session-start context.

## Sample (N=100, latest injections into big-mozzy-v2)

### Source-project breakdown

| Source project | N | Noise rate |
|---|---|---|
| `desktop-01dcc792` | 72 | **100%** (72/72) |
| `claudex-v3` | 27 | 37% (10/27) |
| `context-097edcef` | 1 | 100% (1/1) |
| `big-mozzy-v2` (same-project) | **0** | n/a |

### Artifact-type breakdown

| Type | N | Note |
|---|---|---|
| `observation` | 84 | mostly tool-call traces (`Read:`, `Edit:`, `Write:`, `Bash:`) |
| `memory_file` | 13 | only substantive type at scale |
| `flow` | 2 | session-flow descriptions |
| `learning` | 1 | one substantive learning |

### Noise rate

**83% (83/100)** match the noise pattern: starts with
`Read|Edit|Write|Bash|MultiEdit|Glob|Grep:` OR length < 60 chars.

Sample noise injections (verbatim):
- `Read: config.ts` (desktop-01dcc792)
- `Edit: auth-extract.ts` (desktop-01dcc792)
- `Write: drift-d-01.json` (desktop-01dcc792)
- `Edit: install-watchdog.ps1` (desktop-01dcc792)
- `WebSearch: Claude Code statusline custom refresh rate data documentation 2026` (claudex-v3)
- `Bash: for p in 09-01 09-02 09-03 09-04; do echo ...` (desktop-01dcc792)

These are tool-call traces from sister projects. Importance is
typically 3–5 (high enough to clear the tier threshold), but the
content itself carries no transferable knowledge.

## Substantive sample — manual relevance judgment (N=17)

Of the 17 non-noise injections into big-mozzy-v2 sessions, every
single one came from `claudex-v3` and every single one was
**claudex-v3 self-knowledge** with **zero domain relevance** to
big-mozzy-v2's operational work (bet365 / Mozzart / FL365):

| # | Source artifact | Domain-relevant to big-mozzy? |
|---|---|---|
| 1 | `# DONE 2026-05-14 — /starthere + /endsession deleted` | No (claudex meta) |
| 2 | `# Persona-tuning of behavioral rules — manual track, post-Phase-13` | No (claudex meta) |
| 3 | `Tell the desktop session to run claudex_session with action: "list"...` | No (claudex tool debug) |
| 4 | `**Good child / bad child / same burn / different signal**` | No (claudex pedagogy) |
| 5 | `WebSearch: Claude Code statusline...` | No (noise that slipped through length check — was 60+ chars) |
| 6 | `v6 polish (Phase 11) engineering scope SHIPPED 2026-05-09...` | No (claudex meta) |
| 7 | `The autonomous orchestration pattern... does NOT provide adversarial review` | Marginal (general engineering — would be useful but is noise-buried) |
| 8 | `# Reach for memory on memory-shaped questions` | No (claudex pedagogy) |
| 9–17 | duplicates of #1, #4, #6, #7, #8 (re-surfacing on different sessions) + 2 generic flow entries | No |

**Domain-relevant injections: 0/100.** **Operational-precision: 0%.**

## What's missing — recall analysis

The big-mozzy-v2 substrate has 30+ memory files with rich
project-specific knowledge that *should* be surfacing same-project
when the agent is debugging cascade work:

- `bet365-cascade-precursor.md`
- `bet365-zap-protocol.md`
- `betboom-cascade-investigation-pending.md`
- `cascade-losses-as-camouflage.md`
- `cascade_per_line_pnl_pattern.md`
- `fastlane365-built.md`
- `fl365-passive-architecture.md`
- `mozzart-nightly-pause.md`
- `supervisor-architecture.md`
- `betstop-fire-gating.md`
- `30min-reload-heartbeat.md`
- `pipeline-startup-runbook.md`
- (~20 more)

**These never appear in the experience-tier surface.** The N=100
sample shows 0 same-project injections. Either:
- Same-project patterns are routed through a different surface (not
  the experience-tier mechanism — possibly Recent Session Frames or
  the L3 materialization layer); the experience-tier surface is
  designed exclusively for cross-project equivalence; OR
- The tier scorer is choosing cross-project candidates over
  same-project ones; OR
- Same-project memory files aren't being indexed into the
  experience-tier candidate set at all.

This is the next investigation surface. The audit doesn't go that
deep — would need to read `cross-project-equivalence.ts` +
`tier-utils` and trace the candidate-selection path.

## Diagnosis

The cross-project equivalence machinery is doing what its scoring
function tells it to do. The scoring function appears to optimize for
**something**, but not for "knowledge that helps the agent solve the
target session's domain problem." Two diagnoses:

1. **Importance threshold is too low.** Single-action `Read:`/`Edit:`
   observations are recorded with importance 3–5 (because the
   ingestion pipeline doesn't know they're noise). Raising the
   experience-tier candidate threshold to `importance >= 4 AND
   artifact_type IN ('learning', 'decision', 'memory_file', 'experience_pattern')`
   would drop the desktop-project floods entirely.
2. **No domain-affinity signal.** The scorer treats all
   cross-project artifacts as equivalent at-rank-time. A
   project-domain affinity signal — even a coarse one like "betting
   projects pull from betting projects, infrastructure projects pull
   from infrastructure projects" — would route claudex-v3 lessons to
   claudex-v3 work and big-mozzy lessons to big-mozzy work. The
   `cross-project-equivalence` machinery is supposed to do this via
   handle-set overlap; either it isn't running or its handle sets
   don't capture the domain split.

## Recommended actions

Tracked here for follow-up; not for this session.

- **Cheapest fix (1 line):** raise the artifact-type filter on
  experience-tier candidates to exclude raw `observation` rows.
  Closes 84% of the noise.
- **Medium fix:** raise the importance floor to `>= 4` AND require
  `length(summary) >= 60`. Closes ~95% of noise without losing the
  substantive memory_files (which are typically importance 3 but
  long).
- **Real fix:** investigate why `cross-project-equivalence.ts`
  handle-set overlap isn't routing same-project candidates first.
  This is a phase-shaped piece of work; do not start this session.
- **Diagnostic:** add a per-project "experience injection precision"
  score to the dashboard so we can track this number over time as
  the substrate evolves. Bench-style.

## Caveats

- Sample size 100, single project, single point in time. Precision
  bound is wide; the 0/100 result is striking enough that wider
  sampling would be confirmation, not discovery.
- "Domain relevance" judgment is mine, not adjudicated. A second
  judge would refine the precision number but is unlikely to change
  the conclusion that 0 of the surfaced injections were
  bet365/Mozzart/FL365-specific.
- "Recall" analysis is qualitative — I listed memory files I
  expected to see; I didn't quantify how many same-project memory
  files exist that would be candidates for the surface.

---

## Post-Plan-14-03 Re-measurement (2026-05-16)

**Auditor session:** executor-subagent (Plan 14-03 implementation)
**DB:** `~/.claudex/db/claudex.db` (V36, same DB as original)
**Target project:** big-mozzy-v2 (excluded from candidate pool per design)
**Method:** Query the NEW candidate pool (with `substantiveSqlClause('a')`) directly,
sample top-100 by recency, classify noise using the plan's definition.

**Change shipped:** `fetchCandidatePool` in `experience-tier.ts` now uses `substantiveSqlClause('a')`
instead of `artifact_type IN ('learning', 'observation', 'memory_file', 'flow', 'milestone')`.

### Candidate pool size comparison

| Pool | Size |
|---|---|
| Old (with observations) | 3,137 |
| New (substantive only) | 816 |

Pool reduced by **74%**. Experience tier now selects from a denser, more signal-rich pool.

### Source-project breakdown (N=100)

| Source project | N | Noise rate |
|---|---|---|
| `claudex-v3` | 41 | ~5% (2/41) |
| `lacuna-betting-9f1d552c` | 35 | ~37% (13/35 — mostly short `[Pre-assembly]` flows) |
| `kompas-98604047` | 4 | ~50% (2/4) |
| `big-mozzart-clean` | 4 | 0% |
| other (combined) | 16 | ~0% |
| `big-mozzy-v2` (same-project) | **0** | n/a |

### Artifact-type breakdown

| Type | N | Note |
|---|---|---|
| `flow` | 42 | Pre-assembly/Reflection flows; ~38% are short < 60 chars (plan-definition noise) |
| `memory_file` | 24 | Substantive — all pass length gate comfortably |
| `learning` | 19 | Mostly substantive; ~2 short `[Reflection]` summaries |
| `observation` | 15 | All passed importance >= 4 AND length >= 60 (the gate worked) |

### Noise rate

**18% (18/100)** match the plan-definition noise pattern:
- 14 `flow` artifacts with summaries < 60 chars (`[Pre-assembly] ...` session flows)
- 2 `learning` artifacts with `[Reflection]` prefix + < 60 char summary
- 2 other short-summary certified-substantive artifacts

**Original noise rate (pre-fix): 83% (83/100)**

The remaining 18% noise is a different failure mode than the original:
- Before: single-tool-call observations (`Read: file.ts`, `Edit: auth.ts`) — raw CC tool traces
- After: short session-flow artifacts (`[Pre-assembly] Can I — predicted context`) — certified-substantive type (`flow`) but content not transferable

The `flow` noise is a secondary concern deferred per anti_scope: "Do NOT add a domain affinity signal" and "Do NOT modify the scoring weights." A follow-on plan may add a length filter or classify `[Pre-assembly]` flows differently.

### Comparison

| Metric | Original (pre-fix) | Post-Plan-14-03 | Delta |
|---|---|---|---|
| Noise rate (plan def.) | 83% (83/100) | 18% (18/100) | **-65pp** |
| Same-project share | 0/100 | 0/100 | 0 (by design) |
| Substantive (non-noise) | 17/100 | 82/100 | **+65pp** |
| Candidate pool size | 3,137 | 816 | -74% (denser) |

### Verdict

**PASS** — Noise rate 18% < 20% threshold (AC-3).

### Sample of remaining noise (verbatim)

Short session-flow artifacts that passed the substance filter (type=`flow`, certified-substantive)
but contain < 60 chars of content:

- `[flow] lacuna-betting-9f1d552c: [Pre-assembly] Can I — predicted context`
- `[flow] lacuna-betting-9f1d552c: [Pre-assembly] I completely agree — predicted context`
- `[flow] lacuna-betting-9f1d552c: [Pre-assembly] 1 — predicted context`
- `[flow] kompas-98604047: [Pre-assembly] leave next session — predicted context`
- `[learning] desktop-01dcc792: [Reflection] oauth, refresh, token — 2 learnings`

These are not tool-call traces; they are legitimate flow records from the session-flow writer.
Filtering them would require either (a) a length requirement on `flow` type (narrower than the plan
scope), or (b) a domain-affinity signal to prefer lacuna-betting flows in lacuna-betting sessions,
not in big-mozzy sessions.

### Sample of substantive injections (first 10)

| # | Source | Summary (truncated) |
|---|---|---|
| 1 | `[learning] claudex-v3` | Root cause inside Phase 2 not yet identified — needs deeper per-session instrume… |
| 2 | `[learning] claudex-v3` | The root cause inside that one Ollama call is bounded follow-up — likely a promp… |
| 3 | `[memory_file] claudex-v3` | # DONE 2026-05-14 — /starthere + /endsession deleted… |
| 4 | `[memory_file] claudex-v3` | # Reach for memory on memory-shaped questions… |
| 5 | `[memory_file] claudex-v3` | # Persona-tuning of behavioral rules — manual track, post-Phase-13… |
| 6 | `[learning] claudex-v3` | claudex_search had flat ranking because all non-artifact sources used hardcoded… |
| 7 | `[learning] claudex-v3` | Session 39 subsystem audit results: (1) Assembly — excellent, all 17 sections ac… |
| 8 | `[learning] claudex-v3` | FEEDBACK CRITICAL: User explicitly manages context window usage… |
| 9 | `[observation] lacuna-betting-9f1d552c` | (long, substantive investigative observation — passed importance + length gate) |
| 10 | `[memory_file] lacuna-betting-9f1d552c` | (betting domain memory file — domain-relevant) |

Note: "substantive" here means non-noise per the plan's definition. Domain-relevance to big-mozzy
specifically is a separate concern (domain affinity) not addressed by this plan.

### Caveats

- Measurement queries the static candidate pool at the time of measurement (2026-05-16), not
  live session injection events. This is the methodologically correct approach: the fix changes
  what CAN be selected, not what was historically injected.
- The 18% remaining noise is structurally different from the original 83%: it comes from
  certified-substantive types (`flow`, `learning`) with short summaries, not raw tool-call traces.
- The production DB is at V36 using `timestamp_epoch` (seconds) — the query used `timestamp_epoch`
  for ordering consistency with the production system state.
