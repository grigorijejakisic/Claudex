# Phase 5: P4 — Kill Legacy Injection — Context Amendment

**Amendment date:** 2026-04-29
**Original CONTEXT.md gathered:** 2026-04-26
**Reason for amendment:** v4 rebind 2026-04-27 dropped benchmarks (LongMemEval, LoCoMo, BENCH-05/06/07/09) entirely as gates. Original 05-CONTEXT.md had BENCH-09 language throughout — it is superseded by SC#1-#4 gates. Phase 5 also now depends on Phase 4.1 (which corrects Phase 4's regressions) before it can ship.

---

## What changed

**Benchmarks DROPPED entirely from v4** per the 2026-04-27 audit and rebind:
- Not gates
- Not floors
- Not sanity checks
- Harness on disk for ad-hoc + one-shot ship-time vibe-check (Phase 11), nothing else

The original 05-CONTEXT.md called this phase the "BIG BENCHMARK GATE" with BENCH-09 woven throughout the success criteria, fallback ladder, and methodology. **That framing is dead.** This amendment locks the new framing.

**New gates (replace BENCH-05/06/07/09):**
- **SC#1 — Vesna probe pass ≥80%** (behavioral, primary)
- **SC#2 — Token budget ≤500 cache-stable** (structural, hard, 3-layer test)
- **SC#3 — MEMORY.md content-quality ≥80%** (mechanical, every PR)
- **SC#4 — One-turn handoff pickup** (continuity)

## What no longer applies from the original CONTEXT.md

### BENCH-09 framing — superseded entirely

- "BENCH-09 telemetry must be capturing throughout the deletion sequence" — no, telemetry is not Phase 5's surface for go/no-go
- "Vitest must pass after every commit. LongMemEval Oracle fast-subset spot-check (~30 min) after every commit" — LongMemEval spot-check NOT a gate; vitest still required
- "BENCH-09 measurement methodology" section — entirely superseded; no longer used
- "Gate fires on the post-P4 7-day rolling median crossing below baseline N" — no, this gate is not used
- Fallback ladder L3's "log per-section contribution to LongMemEval delta" — superseded; if fallback ladder fires, attribution is via Vesna + content-quality, not LongMemEval

### Title

The phase's working title in the directory is "kill-legacy-injection-big-benchmark-gate". The "big benchmark gate" is no longer accurate — Phase 5 is the lean injection deletion + cache stability + Vesna pass, not benchmark-gated. Directory rename is out of scope (would touch references), but the **content** treats benchmark gating as superseded.

### Dependency

- **Old**: Phase 5 depended on Phase 4 (MEMORY.md curation shipped)
- **New**: Phase 5 depends on **Phase 4.1** (MEMORY.md content redesign + Lessons section). Phase 4 marked `[~]` corrective-pending; Phase 4.1 supersedes its acceptance.
- Reason: MEMORY.md must be working before injection dies, or agent has no fallback

## What still applies from the original CONTEXT.md

These sections of original 05-CONTEXT.md are still load-bearing:

- **Pre-flight safety (STOR-08, backup gate)** — unchanged
- **Deletion sequencing & bisectability** (one commit per deleted section, lowest-signal-density first) — unchanged
- **`initialUserMessage` auto-prime mechanics** — mostly unchanged, but the prime now reads from new Phase 7.5 handoff format (YAML frontmatter); planner aligns
- **Experience-warning trigger surface** — unchanged in mechanism; framing rewritten in Phase 7 (advisory voice)
- **Cache-stability verification** — fully retained as SC#2
- **Pre-work hardening (5.0 sub-tasks)** — clock leaks, session-ID strips, host-env normalization, stable tiebreakers, CRLF/BOM normalizer, STATE.md parser extension, handoff frontmatter spec — all retained

## New gate methodology (replaces BENCH-09)

### SC#1 — Vesna probe pass ≥80% at Phase 5 close

- Phase 5 ships → run Phase 10's full ~20-probe suite (or whichever subset is live when 5 ships, since Phase 10 is parallelizable per ROADMAP)
- Critical categories for Phase 5: entity recall (3 probes), constraint recall (3 probes), handoff pickup (3 probes)
- Pass rate ≥80% required (per-category 80% — no masking)

### SC#2 — Token budget + cache stability

3-layer test (already in original CONTEXT.md, retained):
- Layer 1: tokenizer assertion — session-start ≤500 tokens (cl100k_base)
- Layer 2: golden snapshot byte-identical across consecutive runs
- Layer 3: invariance under volatile-state mutation (clock change, session-ID change, host-env change)

This was always Phase 5's hard gate; SC#2 just formalizes it.

### SC#3 — MEMORY.md content-quality ≥80%

- Mechanical scoring rubric from Phase 4.1
- Phase 5 doesn't change MEMORY.md content (that's 4.1's territory) — but Phase 5 must NOT regress it
- Pass: all 5 active projects ≥80% on rubric, unchanged from pre-Phase-5 baseline

### SC#4 — One-turn handoff pickup

- Cold-start session reads ACTIVE.md (new Phase 7.5 format), agent first response addresses handoff topic
- No exploratory glob/grep/Bash before first user-facing action
- Handoff-referenced reads allowed
- Pass: 3/3 cold-start sessions across 3 different projects show one-turn pickup

## Updated fallback ladder

The original ladder L1→L4 still applies in shape, but **attribution mechanism changes** from BENCH-09 to Vesna + content-quality + cache-stability:

| Rung | Trigger (old: BENCH-09) | Trigger (new) |
|---|---|---|
| L1 | UPS budget bump | Cache snapshot diff OR token budget violation OR Vesna pass-rate <80% OR content-quality <80% |
| L2 | Keep one section | Same triggers as L1, after L1 doesn't restore |
| L3 | Dual-inject diagnostic | Same triggers, attribution via Vesna delta per section, NOT LongMemEval delta |
| L4 | Full revert to Phase 4.1 candidate | Same — preserved |

L3 attribution: "log per-section contribution to **Vesna delta**" (replacing original "LongMemEval delta"). Telemetry tooling adjusts; methodology stays "scripted not eyeball."

## Phase ordering

Per ROADMAP execution order:
- Phase 4.1 ships first (corrects Phase 4 regressions)
- Phase 5 ships after 4.1 verification
- Phase 5.5 ships after Phase 5 (curation feedback loop layered on top)

## Claude's Discretion (planner; merged)

Original discretion items still apply. Plus:
- Vesna probe subset selection for per-tier deletion verification (recommendation: minimum 5 probes per tier boundary)
- Fallback ladder L3 telemetry tooling for Vesna-delta attribution (replaces old LongMemEval-delta tooling)
- Whether to clean up BENCH-09 telemetry tables (recommendation: drop in Phase 9.X cleanup, not in 5)

## Pointer for the planner

- Read **original 05-CONTEXT.md** for the deletion sequence + cache-stability + initialUserMessage mechanics
- Read **this amendment** for the gate framing change (BENCH-09 → SC#1-#4)
- The plan structure stays: pre-flight backup → tier A deletion → tier B → tier C → close
- Per-tier verification uses Vesna + content-quality + cache-stability, NOT LongMemEval

---

*Amendment date: 2026-04-29*
*Reason: v4 rebind 2026-04-27 dropped benchmarks; SC#1-#4 are the new gates*
