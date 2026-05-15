---
date: 2026-05-15
project_audited: big-mozzy-v2
auditor_session: b5e053ba-8406-47cf-8045-34daab62ee93
mode: read-only — no edits to big-mozzy-v2
---

# Big-mozzy-v2 substrate audit — 2026-05-15

Read-only inventory of the big-mozzy-v2 substrate (filesystem + DB) to
diagnose why the operator reports "lack of context on the matter" when
landing fresh sessions there. Companion to
[2026-05-15-cross-project-equivalence-hit-rate.md].

The headline: big-mozzy-v2 has **comparable substrate density** to
claudex-v3, but **most of its session-start surfaces are silently
broken or schema-mismatched** with the assembler's expectations.
Today's Phase 13.1 fixes (#1, #2, #6) help projects whose ACTIVE.md
follows the claudex-v3 schema; big-mozzy-v2's does not, so the fixes
are dead-weight for it specifically.

## Substrate density (artifacts / observations / memory)

Counts from `~/.claudex/db/claudex.db` as of 2026-05-15 16:35:

| Surface | big-mozzy-v2 | claudex-v3 | Ratio |
|---|---|---|---|
| `artifact` (V17 kernel) — `mental_model` | 204 | 142 | 1.4× |
| `artifact` — `transcript_chunk` | 172 | 12 | 14× |
| `artifact` — `directive_rule` | 74 | 40 | 1.85× |
| `artifact` — `learning` | 34 | 50 | 0.68× |
| `artifact` — `decision` | 7 | 71 | 0.10× |
| `artifact` — `experience_pattern` | 5 | 13 | 0.38× |
| `artifact` — `critical_rule` | 3 | 9 | 0.33× |
| `artifacts` (legacy) — `observation` | 610 | 2,970 | 0.21× |
| `artifacts` — `memory_file` | 33 | 19 | 1.74× |
| `artifacts` — `session_log` | 30 | 64 | 0.47× |
| `artifacts` — `flow` | 30 | 256 | 0.12× |
| Memory files on disk (`~/.claude/projects/.../memory/*.md`) | 30+ | 27 | ~1× |
| Sessions/ transcripts on disk | **4** | 7 | 0.57× |

**Reading:** the *knowledge* density (mental_model, directive_rule,
memory_file) is on par with or higher than claudex-v3. The *trace*
density (observations, flows, session_logs) is much lower. The
4-Sessions-on-disk number is the worrying one — the Phase 13
per-turn writer should be producing one file per session and big-mozzy
clearly isn't. Either the writer isn't firing for that project or
sessions are not being completed enough for the file to land.

## ACTIVE.md hygiene

`big-mozzy-v2/context/handoffs/ACTIVE.md` exists, **status: active**,
119 lines, last `updated_at: 2026-05-15T00:16:00+02:00`. Content is
**operator-quality** — bot state, outage forensics, next-session
actions with shell commands. The hygiene problem is structural, not
content:

| Field | claudex-v3 schema (assembler expects) | big-mozzy-v2 has |
|---|---|---|
| `created_at_epoch_ms` | required for Fix #6 freshness floor | **missing** — only ISO `created_at` |
| `topic` (frontmatter) | rendered as Topic line | **missing** |
| `summary` (frontmatter) | rendered as Summary line | **missing** — body has free-form headers instead |
| `**What's next:**` (body inline field) | extracted by Fix #1 | **missing** — has `## Next session — first actions` instead |
| `**Where to look:**` (body inline field) | extracted by Fix #1 | **missing** |
| `## Operator Gates` (body section) | bullets surfaced into session-start | **missing** |
| `parseHandoffHeader` accepts schema | required | **untested for `claudex/handoff` v1 schema** |

**Net effect:** when an agent lands fresh in big-mozzy-v2, today's
`renderSessionContinuity` produces a degraded section (missing topic,
summary, what's-next, where-to-look) — or returns null entirely if
`parseHandoffHeader` rejects the unfamiliar schema. The 119-line
operator-written handoff is invisible at session-start.

## Parallel-handoff invisibility

`big-mozzy-v2/context/handoffs/ACTIVE-agent2.md` exists for multi-agent
work (Agent 2 add-ons: VAR-tolerant tracker, daily-cap, score-change
LA). The assembler reads only `ACTIVE.md` — Agent 2's handoff is
permanently invisible. This is a real substrate gap for
multi-agent projects, not a big-mozzy-specific bug.

## MEMORY.md handoff pointer broken

big-mozzy-v2's MEMORY.md `## Handoff` says **"No active handoff"**
while `ACTIVE.md` exists with `status: active`. Same shape as
Blocker #2 from this morning's claudex-v3 substrate-readout — but
worse: the regenerator doesn't detect big-mozzy's handoff *at all*
(claudex-v3's pointer was stale-but-present). Likely cause: the
regenerator's parser looks for fields specific to the `claudex/v4` /
`claudex/handoff/v1` (claudex-v3) schema, not the `claudex/handoff` v1
schema big-mozzy uses. Today's Fix #2 (defensive `curateMemoryMd` in
session-start) **does not help** — the regenerator runs, but its
parser still fails to detect the handoff.

## Frame extraction is 100% degraded

```
session_highlights for big-mozzy-v2: 4 rows total, 4 degraded
```

Every single session_highlights extraction for big-mozzy-v2 fell back
to the fallback model (Opus unavailable). `readLastHighlightsEpochMs`
filters degraded=0 → returns null → Substrate Health (Fix #5) cannot
diagnose this as "extraction lagging" because the cold-start gate
fires (no non-degraded rows to compare against). The Frame Extraction
Degraded health line (Phase 13 Plan 04 P1.6) **will** fire when the
agent loads big-mozzy at session-start because the latest 3 rows are
all `degraded=1`. That surfaces correctly today.

## Cross-project injection drowns substrate

Detail in [2026-05-15-cross-project-equivalence-hit-rate.md].
Headline: big-mozzy-v2 receives **2,515 experience_tier_injected
events** (5× more than claudex-v3's 458). The last 30 sampled were
**0/30 same-project** and **22/30 noise** (single-action `Read: x.ts`
/ `Edit: y.ts` observations from sister projects). This is the
"lack of context" the operator reports — the cross-project surface is
not failing to fire, it's firing on shallow noise.

## Project rules (CLAUDE.md) — healthy

`big-mozzy-v2/CLAUDE.md` is 263 lines, content-rich (strategy,
arming model, architecture, two-phase pay-ticket). Not a character
file (that's the global one) — project-rules style, appropriate for
the domain. **Not a gap.** It does what CLAUDE.md should do.

## Memory file density — healthy

30+ memory files under `~/.claude/projects/.../memory/`, with the
project's canonical vocabulary present as filenames:
`bet365-cascade-precursor.md`, `bet365-zap-protocol.md`,
`betboom-cascade-investigation-pending.md`,
`fl365-passive-architecture.md`, `mozzart-nightly-pause.md`,
`supervisor-architecture.md`, etc. This is **better** lexical density
than claudex-v3 has (per-file, not per-token). MEMORY.md `## Lessons`
section is populated with 18 pointers. **Not a gap.**

## Diagnosis ranked by impact

The substrate is rich; the *plumbing* between substrate and
session-start is what's broken. Fixes ranked by impact on
"agent lands and has context":

1. **Schema-mismatched ACTIVE.md** (highest impact). Operator writes a
   119-line handoff every session; the agent sees a stub. Two
   plausible paths:
   - **(A)** Adapt big-mozzy-v2's ACTIVE.md to the claudex-v3 schema
     (add `created_at_epoch_ms`, `topic`, `summary`, body inline
     fields). Project-side change.
   - **(B)** Make `renderSessionContinuity` (Fix #1) tolerate the
     `claudex/handoff` v1 schema — fall back to body section
     headings (`## Bot state`, `## Next session — first actions`)
     when the locked-schema fields are absent. Substrate-side change,
     helps every project that uses the older schema.
2. **Cross-project injection noise** (high impact). 73% noise rate
   crowds out substantive cross-project knowledge. Fix is in
   `cross-project-equivalence.ts` — filter out single-action
   observations (`Read:`, `Edit:`, `Write:`, `Bash:` prefix +
   length < 60) at scoring time, OR raise the importance threshold
   from `>= 3` to `>= 4` for cross-project candidates.
3. **MEMORY.md regenerator parser** (medium impact). Same shape as
   today's Blocker #2 fix but worse — needs to detect `claudex/handoff`
   v1 schema as a valid handoff and regenerate the `## Handoff` line.
4. **Multi-agent handoff visibility** (medium impact). Assembler
   should read all `ACTIVE*.md` files, not just `ACTIVE.md`. Affects
   any project running parallel-agent work.
5. **Frame extraction 100% degraded** (medium impact). Opus
   extraction failures mean no substantive Recent Session Frames.
   Investigation needed: are the failures rate-limit, transient, or
   prompt-shape rejections?
6. **Sessions/ writer underfiring** (low-medium impact). Only 4
   transcript files exist for a project doing 474 edits in 7d.
   Per-turn writer may not be wired correctly for big-mozzy.
7. **No `created_at_epoch_ms`** (low impact, follows from #1).
   Fix #6 freshness floor cannot fire — pre-pivot frames + checkpoints
   surface unbounded.

## What is NOT broken

To avoid over-correcting:

- ACTIVE.md *content* quality is operator-grade — better than most
  claudex-v3 handoffs.
- Memory file density is fine.
- CLAUDE.md is fine.
- V17 artifact density is fine.
- Frame Extraction Degraded health line surfaces correctly.

## Recommended next steps

If we want big-mozzy session-start to actually carry context:

- **Quick win, project-side:** add `created_at_epoch_ms` +
  `topic` + `summary` to big-mozzy ACTIVE.md frontmatter (no schema
  conflict — additive). Operator does this manually or we add a small
  helper. Closes 50% of the gap immediately.
- **Quick win, substrate-side:** change `renderSessionContinuity`
  body extractors to fall back to `##` heading sections when
  `**Field:**` inline fields are absent. ~30 lines of code in
  `sections.ts`. Closes another 30% of the gap and helps every
  project that uses the older schema.
- **Deferred:** cross-project injection noise filter, MEMORY.md
  regenerator schema-tolerance, parallel-handoff visibility,
  Sessions/ writer audit, Opus-extraction failure investigation.
  Each is a separate phase-shaped piece of work; none is one-turn.

None of these are things this session should *do*. The audit is
the deliverable; the operator picks the next move.
