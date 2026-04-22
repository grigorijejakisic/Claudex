# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-19)

**Core value:** Memory stops acting like rules — the agent thinks again, pulling curated artifacts on demand instead of blindly following injected imperatives.
**Current focus:** Phase 4: P3 — MEMORY.md curation + auto-dream guard

## Current Position

**Current Phase:** 4
**Current Phase Name:** P3 — MEMORY.md curation + auto-dream guard
**Total Phases:** 11
**Current Plan:** 0
**Total Plans in Phase:** TBD
**Status:** Phase 3 (P2 directive detector) complete (partial-ship B at joint=0.50); Phase 4 ready to plan
**Last Activity:** 2026-04-22
**Last Activity Description:** Phase 3 (P2) complete — directive detector shipped partial-B at joint_precision=0.50 on post-relabel fixture; scope precision 0.89 ship-quality for P8 consumer contract; negation_dont tunable surface deferred to P8; benchmark gate (03-06-07) and live-tick confirm (03-06-08) deferred to post-ship follow-ups.
**Progress:** [███░░░░░░░] 27%

Phase: 4 of 11 (P3 — MEMORY.md curation + auto-dream guard)
Plan: 0 of TBD in current phase
Status: Phase 3 complete; Phase 4 ready to plan
Last activity: 2026-04-22 — P2 directive detector shipped (partial-B)

Progress: [███░░░░░░░] 27%

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table. Summary of locked decisions from P0:
- **Q1 transcript chunking** — LLM topic-detected boundaries (quality over latency)
- **Q2 MEMORY.md schema** — sectioned markdown, importance-sorted, capped at 15/5/5/1/1 entries per section
- **Q3 directive threshold** — regex + LLM-confirm, starting ≥0.7 (tuned in P2)
- **Q4 project_curated_context** — migrate to `artifact(kind='mental_model')`, flag stale entries as `status='stale'`

### Pending Todos

- Human review of `project_curated_context` entries flagged `status='stale'` during the P1 migration dry-run. Known-stale keyword markers: `Gemma 4 31B`, `llama-server:8081`, `local llama-server` (all superseded by session 50's swap to Ollama Cloud `glm-5.1:cloud`).

### Blockers/Concerns

- P4 is the high-risk benchmark gate — if LoCoMo drops >2pp after removing injection sections, the pull-based model isn't strong enough and MEMORY.md curation must improve before re-attempt
- P6.5 is a deterministic gate on RL deletion; if flagged LoCoMo drops >2pp, v4 scope must adjust (keep RL or redesign scoring)
- Stale `project_curated_context` entries carry claims contradicting current state — migration must flag, not silently carry forward

## Session Continuity

Last session: 2026-04-22
Stopped at: Phase 3 (P2) complete — partial-ship B at joint=0.50
Resume file: .planning/ROADMAP.md (Phase 4 — P3 MEMORY.md curation + auto-dream guard ready to plan)

### Phase 3 (P2) completion notes — 2026-04-22

**Directive detector shipped partial-B at joint_precision=0.50 on post-relabel fixture.** Six plans landed across sessions 47-54: detector core + prompt assets + fixture corpus + Angel heartbeat wiring + precision harness + calibration-and-ship. Full iteration log in `.planning/phases/03-p2-directive-detector/03-CALIBRATION.md`.

**Calibration journey:** joint 0.353 (baseline) → 0.391 (scope few-shot) → 0.455 (prompt rewrite) → [escalation + label audit + gate lowered 0.90→0.75 + 12-case hand re-label] → 0.500 (cycle3_diag post-relabel) → 0.500 (cycle4 negation tune, reverted). Path B chosen on the evidence that scope precision 0.889 is ship-quality for P8's primary consumer contract; remaining `negation_dont` family gaps are deferred to P8 as a tunable follow-up with a held-out test set.

**What actually ships:**
- `src/intelligence/directive-detector.ts` — 2-stage (regex + LLM-confirm) directive extractor writing `artifact(kind='directive_rule', scope ∈ {session, project, universal}, polarity ∈ {prescriptive, prohibitive})` rows.
- Angel heartbeat runs the detector BEFORE the generic pattern-extractor per Plan 03-04.
- Passive annotations (`data.possible_contradicts`, `data.related_to`, `data.related_cosine`) for dedup-shortlist hits, feeding P8's supersession/contradiction logic.
- **Zero injection-path changes** — `git diff 32779b3..HEAD -- src/assembler/ src/hooks/session-start.ts src/core/sections.ts` is empty.
- Harness observability hardening (commit `3ddd183`): `harness_pid=<pid>` first-line, `--heartbeat-ms` flag, `--limit=<N>` flag, success-signal doc. Killed the 3-silent-death observer-error class permanently.

**Deferred to post-ship follow-ups (NOT blockers):**
- 03-06-07 benchmark gate (LongMemEval + LoCoMo) — blocks on task #23 (post-V17 baseline still stalled).
- 03-06-08 live-tick integration confirm — requires Angel ticks against real sessions before `directive_rule` rows appear in the live DB.
- `llama-server-supervisor.test.ts` has 20 pre-existing test failures (since commit `c84dd61`, 45+ commits before Phase 3) — not a P2 regression, tracked as separate tech-debt.

**P8 tune-queue starter set** (in CALIBRATION.md `## Follow-ups for P8`): retune `negation_dont` family with held-out test set; fixture expansion to 30 sessions; universal-scope second-pass via stubbed scope-rubric prompt; reinforcement_count distribution telemetry.

### Phase 2 (P1) completion notes — 2026-04-20

**6 legacy knowledge tables unified into a single `artifact(kind, ...)` kernel + JSON sidecar table via V17 migration.** Legacy tables survive as views + INSTEAD OF triggers; Phase B atomic-tx Phase ships a typed RunnerResult through a backup-gated + stale-review-gated + validation-gated pipeline.

**Retention notes (CRITICAL — do not drop before Phase 11/P9):**
- `learnings_old`, `decisions_old`, `experience_patterns_old`, `angel_opinions_old`, `critical_rules_old`, `project_curated_context_old` — the 6 renamed legacy tables — survive P1→P9 as migration backstops. Do NOT drop before Phase 11.
- `legacy_id_map(legacy_table, legacy_id, new_uuid)` — translation table for integer-legacy-id ↔ new UUID. Survives P1→P9 for view ↔ caller id translation. Do NOT drop before Phase 11.
- `artifacts`, `artifacts_fts`, `vec_artifacts`, `artifact_links` — untouched by P1 (Amendment 1). Entity_summary migration deferred to P5 or P9.

**Retired in P1 (Amendment 4):**
- `learnings_fts` — retired; replaced by `artifact_fts` filtered on `kind='learning'`.
- `experience_patterns_fts` — retired; replaced by `artifact_fts` filtered on `kind='experience_pattern'`.

**Dormant-storage pattern:** `migrateV16toV17` is called from `initializeSchema` and creates the artifact kernel + `artifact_fts` + `legacy_id_map` + `artifact_embeddings` vec0 as empty dormant storage. The actual data migration (rename legacy tables + copy rows + create views + flag stale + install triggers) runs only through the explicit `migrate:v17:apply` CLI path.

**Schema version:** 17 (bumped from 16 inside the runner's atomic tx; not bumped by the dormant-storage init-time call).

**Live V17 migration APPLIED 2026-04-20T10:39Z.** 1052 rows migrated across 6 kinds (191 learning + 126 decision + 76 experience_pattern + 130 angel_opinion + 81 critical_rule + 448 mental_model). 9 mental_model rows flagged stale per stale-review.md. `user_version = 17`. legacy_id_map has 976 rows (experience_patterns preserve UUID, no map entry). All 6 `{name}_old` backstop tables present with matching counts. Angel restarted (PID 7812 via session-start hook auto-respawn). End-to-end INSERT/SELECT/DELETE via legacy `learnings` view confirmed working with round-trip through INSTEAD OF triggers. Backup: `~/.claudex/backups/pre-v4-P1-1776681458021.db` (332 MB, sha256 3680d8dcd68dc396...).

**Benchmark post-migration:** Harness config fixed (commit 01e80c7 — defaults flipped to deepseek-coder-v2:16b via Ollama to match 2026-03-28 baseline conditions; env-var overrides exposed). deepseek-coder-v2:16b pulled locally (8.9 GB). Harnesses relaunched async at 2026-04-20T12:27; logs under `benchmarks/results/p1-postmigration/longmemeval-v17-*.log` and `locomo-v17-*.log`. Realistic runtime: LongMemEval ~10h, LoCoMo ~4-6h. Results will be recorded in a follow-up when they return. CLIProxy-based Claude-model path not reproducible (proxy serves only Gemini + GPT); LoCoMo 55.5% baseline not directly comparable — new deepseek anchor is the forward reference.
