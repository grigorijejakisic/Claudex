# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-19)

**Core value:** Memory stops acting like rules — the agent thinks again, pulling curated artifacts on demand instead of blindly following injected imperatives.
**Current focus:** Phase 2: P1 — Artifact table unification

## Current Position

**Current Phase:** 2
**Current Phase Name:** P1 — Artifact table unification
**Total Phases:** 11
**Current Plan:** 7
**Total Plans in Phase:** 7
**Status:** Phase 2 complete (benchmarks in progress)
**Last Activity:** 2026-04-20
**Last Activity Description:** Phase 2 (P1) complete — V17 unified artifact kernel shipped; 7 plans across 3 waves; 37 new tests green; post-migration benchmark run in progress.
**Progress:** [██░░░░░░░░] 18%

Phase: 2 of 11 (P1 — Artifact table unification)
Plan: 7 of 7 in current phase
Status: Phase 2 complete (benchmarks in progress)
Last activity: 2026-04-20 — V17 shipped

Progress: [██░░░░░░░░] 18%

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

Last session: 2026-04-20
Stopped at: Phase 2 (P1) complete; benchmarks running in background
Resume file: .planning/ROADMAP.md (Phase 3 — P2 Directive detector ready to plan)

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

**Benchmark post-migration:** Running asynchronously — LongMemEval Oracle + LoCoMo harnesses launched at end of Phase 2 session. Logs under `benchmarks/results/p1-postmigration/`. Targets: LongMemEval Oracle ≥ 90% (baseline 90.6%); LoCoMo within 2pp of 55.5% (so ≥ 53.5%). Results to be appended to backup-manifest.md or a successor record when complete.
