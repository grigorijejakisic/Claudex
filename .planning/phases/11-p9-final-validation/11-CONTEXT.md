# Phase 11: P9 — Final Validation Against SC#1-#4 — Context

**Gathered:** 2026-04-29
**Status:** Ready for planning
**Generative axiom:** v4 ships when SC#1-#4 pass. Benchmarks are an archival vibe-check at ship time, never a gate. The audit's diagnosis was that "green numbers feel like progress" — Phase 11 codifies the corrective: behavioral + structural + content-quality + continuity, all measurable, none benchmark-derived.

---

<domain>
## Phase Boundary

This phase delivers three things and only these three things:

1. **Pass all four success criteria** against the v4 codebase:
   - SC#1: Vesna probe pass ≥80% across full ~20-probe suite, every category, every active project
   - SC#2: Token budget ≤500 cache-stable (3-layer test passes)
   - SC#3: MEMORY.md content-quality ≥80% across all 5 active projects (mechanical scoring)
   - SC#4: One-turn handoff pickup verified on 3 cold-start sessions across 3 different projects (no exploratory glob/grep/Bash before first user-facing action)
2. **Ship-tagging artifacts**: `git tag v4.0.0`, `CLAUDE.md` and `README.md` updated to reflect v4 architecture (benchmark language removed; banner *"v4.0 is internal infrastructure. v4.1 = Distribution will make it installable by strangers."*)
3. **One-shot benchmark vibe-check**: run LongMemEval and LoCoMo once, record numbers in commit message for archival reference. **Numbers do not gate ship.** If they regress dramatically, investigate; otherwise log and proceed.

**Out of scope:**
- New feature work
- Bug fixes outside SC#1-#4 verification scope
- v4.1 Distribution scaffolding beyond `.planning/` next-cycle stub commit

**Hard gates:**
- All SC#1-#4 must pass — failure on any one blocks ship
- Full v3 test suite (adjusted for Phase 9 deletions) passes
- Legacy `_old` tables dropped IF zero-caller audit passes; otherwise views remain
- Benchmarks numbers logged but DO NOT gate ship per v4 rebind

</domain>

<decisions>
## Implementation Decisions

### SC#1 — Vesna probe ≥80% (full suite)

- Run full Phase 10 probe suite (~20 probes) against current v4 codebase
- Per-category pass rate must also clear ≥80% (not just aggregate) — prevents one weak category being masked by strength elsewhere
- Per-project: run subset against each of 5 active projects (claudex-v3, lacuna-betting, oracle, big-mozzy-v2, desktop-01dcc792, nexus-e53c6c93) — confirms cross-project organic recall works in practice
- Failures: document the failing probe + investigate; revert problematic phase if needed

### SC#2 — Token budget ≤500 cache-stable

- 3-layer test from Phase 5 (already specified):
  - Layer 1: tokenizer assertion — session-start ≤500 tokens (cl100k_base)
  - Layer 2: golden snapshot byte-identical across consecutive runs
  - Layer 3: invariance under volatile-state mutation (clock change, session-ID change, host-env change must not change output bytes)
- All three must pass for SC#2 acceptance

### SC#3 — MEMORY.md content-quality ≥80%

- Mechanical scoring rubric from Phase 4.1:
  - Zero parsing bugs
  - ≥80% pointers project-specific
  - Topics not session-IDs
  - Pointer density ≥1/10 lines
  - Handoff freshness (matches ACTIVE.md status)
- Run rubric against all 5 active projects' MEMORY.md
- Pass: all 5 projects ≥80% on rubric

### SC#4 — One-turn handoff pickup

- Cold-start verification on 3 different projects:
  - Open fresh session (no prior context)
  - User asks an open question matching the active handoff
  - Agent first response must address the handoff topic without exploratory glob/grep/Bash
  - "Handoff-referenced reads" allowed (reading files explicitly mentioned in ACTIVE.md)
- Pass: 3/3 projects show one-turn pickup behavior

### Ship-tagging sequence

1. Verify SC#1-#4 all pass
2. Run `bun run test` — full suite green
3. Optional: run `bun run vesna` — confirm probe suite green (CI gate from Phase 10)
4. Run one-shot benchmark vibe-check (LongMemEval + LoCoMo); log numbers in commit body
5. Update CLAUDE.md and README.md (benchmark language removed; v4 banner added)
6. `git tag v4.0.0` + push
7. Commit `.planning/` next-cycle stub for v4.1 Distribution

### Legacy `_old` table drop

- Zero-caller audit: grep for `_old` references across all source files; if zero callers → drop tables, update schema
- If non-zero: legacy views remain; document as v4 deferred cleanup

### Claude's Discretion (planner free to decide)

- Exact tooling for the SC#3 mechanical rubric (scripted or manual review with checklist)
- Commit message format for the benchmark vibe-check log
- Order of SC verification (recommendation: SC#3 first since it's mechanical and fast; SC#1 last since it requires probe suite execution)
- Whether to run Vesna probes in parallel across projects (recommendation: yes, planner picks parallelism strategy)

</decisions>

<specifics>
## Specific Ideas

- **No benchmark gate**: this is the audit's primary corrective applied at ship time. Benchmarks vibe-check, do not gate.
- **Per-category Vesna pass rate prevents masking**: aggregate ≥80% can hide a weak category. Phase 11 enforces per-category visibility.
- **One-turn handoff pickup is the user's actual experience**: not a synthetic test. If a user opens a fresh session and the agent immediately picks up where it left off — that's continuity working.

</specifics>

<deferred>
## Deferred Ideas

- **v4.1 Distribution work** — separate milestone; Phase 11 only commits a stub
- **Documentation deep-rewrite** beyond CLAUDE.md and README.md updates — Distribution milestone territory
- **Performance benchmarking** beyond the vibe-check — not part of v4 ship; if user wants performance data, separate exercise

</deferred>

<artifacts>
## Reference Artifacts

- `.planning/PROJECT.md` — Q1-Q12 decisions (ship verifies these are live)
- `.planning/ROADMAP.md` — SC#1-#4 definitions
- `.planning/REQUIREMENTS.md` — 67 active reqs (verify all completed)
- `src/benchmark/vesna/` — probe suite from Phase 10
- `CLAUDE.md` — to be updated for v4 banner
- `README.md` — to be updated for v4 banner
- `context/specs/V4_RL_ABLATION.md` — Phase 8's RL decision

</artifacts>

---

*Phase: 11-p9-final-validation*
*Context gathered: 2026-04-29*
