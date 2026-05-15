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
