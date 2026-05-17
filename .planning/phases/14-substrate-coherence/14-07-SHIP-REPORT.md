---
phase: 14-substrate-coherence
sub_phase: 14-07
ship: v7.0.0
shipped_at: 2026-05-17T12:12+02:00
tag: v7.0.0 (annotated, both remotes)
binding_gate_result: vesna_sc1 28/28 PASS (100%) — exceeds v6.6.0 baseline 27/28
---

# v7.0.0 Ship Report — Substrate Coherence

## Ship gate (binding)

Per the redesigned cutover gate (operator-confirmed 2026-05-17, matches durable `feedback_benchmarks_are_sanity_not_gates.md`):

| Gate | Type | Result | Notes |
|---|---|---|---|
| **Vesna SC#1** | Behavioral binding | **28/28 PASS** | Was 27/28 at v6.6.0 baseline; v7 exceeds. |
| `artifact_id_map` completeness | Data integrity | PASS | 10,721/10,721 mapped |
| Re-vectorization success rate | Data integrity | PASS | 12,551/12,556 (99.96%); 5 failures (0.04%) under 5% threshold |
| Build green | Operational | PASS | All 24 CC hooks smoke-tested |
| Schema version | Operational | V39 | V36→V37 (Wave 1) → V38 (LINKS) → V39 (CHR) |

LongMemEval, LoCoMo, cross-project hit-rate — moved to **informational** per the durable benchmarks-as-sanity preference. They are operator-runnable via `bun run wave1:benchmarks --full` (with extended timeout for the SOTA-chasing benchmarks).

## What shipped per wave

### Wave 0 — Foundations
- **w0a** auto-commit hooks: shipped pre-Wave-1
- **w0b** `/verify` skill: shipped pre-Wave-1
- **w0c** CLAUDE.md verify-before-done rule: shipped pre-Wave-1
- **w0d** `src/assembly/sections/` modular split (`lessons.ts` / `codebase-context.ts` / `links.ts` / `index.ts`) — 24 round-trip parity tests

### Wave 1 — Substrate unification (V36→V37)
- **14-07a** V17 unified artifact substrate, `vec_artifact_v17` vec0 table, `artifact_id_map`, `re-vectorize.ts`, `migrateV36toV37` with kind_registry schema repair (PM fix)
- **14-07b** caller migration across 5 clusters: W1 retrieval, W2 ingestion/embedding, W3 query-surface, W4 Angel writers, W5 CLI+tests + `tests/helpers/v7-unified-schema.ts`
- **14-07c** cutover CLI with binding-only gate design (Vesna + data integrity); legacy `artifacts` table read-only post-cutover

### Wave 2 — Knowledge graph (V37→V38)
- **LINKS-SCHEMA** `soft_link` + `hard_link` + `hard_link_history` tables; 9 link-writer exports; FK ON DELETE RESTRICT → `artifact(id)`; `DECAY_THRESHOLD = 3`; project denormalized at write-time
- **14-07d** soft-link autonomous writers instrumenting `handoff-writer`, `learnings-promoter`, `highlights-extractor`, `retrieval-log`; 4 site helpers in `soft-link-writers.ts`
- **14-07e** link-distance retrieval boost (flag-OFF default; `CLAUDEX_LINK_DISTANCE_BOOST`) + `claudex_trace` MCP tool for link-graph walks (`MAX_HOPS_CAP=5`)
- **14-07f** hard-link LLM proposer (flag-OFF default; `CLAUDEX_HARD_LINK_PROPOSER`; Good Child propose-confirm; 10/run, 1/min/session) + `simulate-hard-link-ux.ts` + `formatPendingReviewLinksSection` at P2.8
- **14-07g** provenance walker (`MAX_PROVENANCE_HOPS=4`, excludes `contradicts`, cycle detection) + `formatProvenanceChainSection` at P2.9 (heuristic-gated rendering)

### Wave 3 — Session-start coherence (V38→V39)
- **14-07h** MEMORY.md regenerator wipe fix; lesson `trigger:` frontmatter; `migrate-lesson-trigger.ts` CLI (dry-run default); experience-tier `same_project_only` default
- **14-07i** codebase-context annotation: `ScoredArtifact` carries `match_query` + `match_kind` (additive); `formatCodebaseContextSection` renders per-file matched-query + score
- **14-07j** link-aware lesson inline-expansion: `lesson-relevance.ts` (0.6×trigger + 0.4×link_distance); top-K=3, 400-token budget; integrates with H's lesson formatter
- **14-07k** Last-Session Synthesis (LSS): LLM-driven structured extraction over JSONL via `canonical-session-ir.fromClaudeCode` + `callLocalLLM`; V17 artifact (`kind='session_synthesis'`) UPSERT; version-pinned prompt `v1`; P0 session-start render; backfill CLI; confidence floor (reject <0.3; degraded [0.3,0.5)); silent fallback on missing
- **14-07l** Continuous Handoff Refresh (CHR): per-turn LLM decision-boundary classification (`classifyDecisionBoundary` additive on directive-detector); 60s throttle via `handoff_refresh_state`; atomic ACTIVE.md refresh on `operator_pivot` / `operator_confirm` / `agent_position` / `spec_change`; `supersedes` soft-link chain to prior handoff state; `CLAUDEX_CHR_DISABLED=1` operator override

## Tests

Wave 3 worker test counts (cluster-level; all PASS):
- 07h: 113/113
- 07i: 18/18 (+24 sections-split parity preserved, +75 existing sections.test.ts preserved)
- 07j: 37/37
- 07k: 27/27
- 07l: 35/35 (+38/38 migration tests post-V39)

Wave 2: ~140 new tests across LINKS-SCHEMA (39), 07d (~20), 07e (31), 07f (39), 07g (25).

Wave 1: ~150 new tests across 14-07a (37), 14-07b cluster suites (W1 37 + W2 37 + W3 30 + W4 51 + W5 58), 14-07c (30).

Pre-existing failures (unrelated to v7): llama-server-supervisor, llama-client (pre-existing string change), some integration tests not in v7 scope.

## Push trail

- Tag: `v7.0.0` (annotated)
- origin (Corleanus dev): `f063578..c9e85b9` master + tag pushed
- public (grigorijejakisic): `0d3e71c..c9e85b9` master + tag pushed

## Operator-runnable post-ship items (NOT blocking)

1. **Enable `CLAUDEX_HARD_LINK_PROPOSER`** — review UX simulation output captured in `14-07-WAVE2-STATUS.md`; per Good Child hybrid policy, hard-link proposer stays flag-OFF until operator approves the UX
2. **Run `migrate-lesson-trigger.ts` live** — `bun src/scripts/migrate-lesson-trigger.ts --apply` to backfill `trigger:` field in existing lesson files (dry-run shipped; live run waits for operator review)
3. **Backfill LSS for prior sessions** — `bun src/scripts/backfill-session-synthesis.ts --project <name> --since YYYY-MM-DD` to run LSS over historical JSONLs
4. **Enable `CLAUDEX_LINK_DISTANCE_BOOST=1`** if operator wants link-aware retrieval ranking in production (default OFF; allows opt-in observation of boost behavior)
5. **Full benchmark sanity run** — `bun src/scripts/run-wave1-benchmarks.ts` (without `--mode=binding-only`) runs LongMemEval + LoCoMo + cross-project hit-rate as a slow-but-honest informational check
6. **Cross-family review** — `/codex-review` or `/gemini-review` against the v7.0.0 tag for second-eyes review
7. **AC-12 live smoke for LSS** — start fresh test session; confirm `session_synthesis` artifact appears in DB; next session-start renders LSS at P0
8. **AC-11 live smoke for CHR** — fixture user-message simulating an operator pivot; confirm `ACTIVE.md` updated, `chr_boundary_detected` telemetry, `supersedes` soft-link in graph

## Qualitative ship gate

The v7.0.0 qualitative gate (per 14-07-CONTEXT.md): *"does session-start feel remembered, not read?"*

Concrete mechanism now ships:
- **LSS (14-07k)** synthesizes the prior session's decision arc and renders at session-start P0 as a first-class block — `Operator's pivots` / `Agent's positions` / `Unresolved` / `Next action`
- **CHR (14-07l)** keeps the handoff refreshed per-turn on decision-boundary events; no more stale snapshot when PC dies mid-pivot
- **Lesson inline-expansion (14-07j)** surfaces load-bearing lessons inline based on trigger + link-distance to current pivot
- **Codebase-context annotation (14-07i)** tells the agent WHY each surfaced file matched
- **Provenance chain (14-07g)** surfaces decision lineage when the current pivot mentions a decision-like signal

The 2026-05-17 morning failure mode (operator had to nudge me through my own files and memories to find the stale handoff and the actual prior-session decision) — that's the burn LSS + CHR was specced to close. Verification on tomorrow morning's first fresh session.

## Schema lineage

| Version | Wave | Change |
|---|---|---|
| V36 | (v6.6.0 baseline) | Pre-v7 starting point |
| V37 | Wave 1 (14-07a) | V17 unified `artifact` kernel + `artifact_id_map` + `vec_artifact_v17` |
| V38 | Wave 2 (LINKS-SCHEMA) | `soft_link` + `hard_link` + `hard_link_history` |
| V39 | Wave 3 (14-07l CHR) | `handoff_refresh_state` |

`TARGET_USER_VERSION = 39`.
