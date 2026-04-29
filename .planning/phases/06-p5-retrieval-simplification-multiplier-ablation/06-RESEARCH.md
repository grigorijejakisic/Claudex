# Phase 6 — Research

**Date:** 2026-04-29
**Author:** plan-6 (auto-gsd-pipeline teammate)
**Phase:** P5 — Retrieval simplification + per-multiplier ablation
**Decision lock:** see `06-CONTEXT.md`

This research answers "What do I need to know to PLAN this phase well?" — it does not pre-decide which multipliers to drop. The ablation in Wave 2 is the evidence; this document scopes the surgery.

---

## RESEARCH COMPLETE

## 1. Existing scoring surface in `hybrid-retrieval.ts`

### Async path (production: `hybridSearchAsync`, line 581)

```
final = baseScore × retrievalMultiplier × noveltyMultiplier × activationFactor
        baseScore = rrfScore × (1 + threeFactor)
        threeFactor = α·recency + β·importance + γ·relevance       (default α=β=γ=1.0)
```

The 4 *outer* knobs ("multipliers") are:

| # | Name | Source | Range observed |
|---|---|---|---|
| 1 | `retrievalMultiplier` | `getRetrievalScoreMultiplier(db, artifactId)` from `src/intelligence/retrieval-feedback.js` | per-artifact, defaults to 1.0 |
| 2 | `noveltyMultiplier` | `0.5 + (artifact.novelty_score ?? 0.5)` | 0.5–1.5 (default 1.0) |
| 3 | `activationFactor` | `Math.max(0.1, artifact.activation_score ?? 1.0)` | 0.1–10.0 |
| 4 | `1 + threeFactor` | computed inline (recency + importance + relevance) | ~1–4 |

The 3 *inner* knobs (inside `threeFactor`):

| # | Name | Formula | Default weight |
|---|---|---|---|
| 5 | `recency` (α) | `exp(-0.995 × hours_since_last_access)` ∈ [0, 1] | α = 1.0 |
| 6 | `importance` (β) | `min(1, max(0, importance/5))` ∈ [0, 1] | β = 1.0 |
| 7 | `relevance` (γ) | vector cosine if available else `1/fts5_rank` else 0.1 | γ = 1.0 |

### Sync path (`hybridSearchSync`, line 454, no Qdrant/vec0, no graph walk)

Adds a 5th outer multiplier missing from the async path:

| # | Name | Source | Range |
|---|---|---|---|
| 8 | `qMultiplier` (sync only) | `0.5 + (artifact.q_value ?? 0.5)` (line 532) | 0.55–1.5 |

**Discrepancy worth flagging in the plan:** sync uses `qMultiplier`, async does NOT. The audit (line 168) named "q_value" as one of the 6 multipliers it expected to ablate. Either the async path silently dropped q_value, or the sync path is the legacy one. The ablation plan must inspect both paths.

### Channels feeding RRF

Async path actually uses **5** channels, not 3:

1. FTS5 (BM25 + proper-noun post-boost)
2. Vector (sqlite-vec / vec0; the file's filename `qdrant-client.ts` is a facade per `embeddings/qdrant-client.ts:1-30`)
3. Recency
4. Graph walk (`graphWalkFromSeeds`, 2-hop on `artifact_links`, line 644-678)
5. Temporal (rule-based time-range parser, line 617-633)

CONTEXT.md target: **`RRF(FTS5 + vec0 + recency)`** — Phase 6 must explicitly decide what to do with **graph walk** and **temporal**. Two options:
- (A) Drop both with the multipliers (treat as channels subject to ablation).
- (B) Retain as light auxiliary channels (analogous to RIF/spread) with measured Vesna value.

The CONTEXT.md "minimum RRF" target reads to me as the **floor**, not the ceiling — the planner may keep graph/temporal if ablation shows them load-bearing. **Recommendation:** ablate them too, treat as channel-level multipliers. Document the call in `06-MULTIPLIER-ABLATION.md`.

### RIF and spread activation (kept per ROADMAP/CONTEXT)

- **RIF** (`applyRetrievalInducedSuppression`, line 419-439): post-selection side-effect that decrements `activation_score` on near-miss candidates. Touches the DB; does NOT affect the current query's ranking — only future queries via the activation cascade.
- **Spread activation** (`spreadActivation`, line 997-1035): called externally (not in `hybridSearchAsync`) from materialization paths. Boosts linked artifacts via `artifact_links`.

Both are kept per design lock. Ablation may still measure their Vesna delta as a sanity check (recommended only if Vesna budget allows).

---

## 2. Cross-encoder reranker — current state vs. RETR-08 target

### Current behavior (`hybrid-retrieval.ts:743-814`)

1. After RRF + multipliers + sort, top-20 candidates are reranked.
2. **Try cross-encoder service** (POST `http://127.0.0.1:7439/rerank`, 3s timeout, 40% CE / 60% hybrid blend, normalized to maxCE).
3. **On failure / non-2xx / timeout:** silent fall to bi-encoder (Ollama `snowflake-arctic-embed2` cosine, 70% hybrid / 30% cosine blend).
4. **On both failures:** silent fall back to RRF-only scores. No telemetry, no log.

### Gap for RETR-08

- No `reranker_fallback_fired` counter exists. Search across the codebase confirms it.
- The `telemetry` table (`schema.ts:779`) has a CHECK enum for `event_kind` that does **not** include `reranker_fallback`. Adding requires a V20 migration that recreates the table (CHECK constraints can't be ALTERed in SQLite).
- "Visible at /endsession" is not currently a wired surface — `/endsession` is a global skill (`~/.claude/skills/endsession/skill.md`) that produces session logs and curated context. The skill does NOT auto-read the project DB for warnings.

### Three implementation options for the visibility surface

**Option A — telemetry event + assembly section.** Increment a telemetry row per fallback. Add a new bottom-of-context observational line surfaced by the assembler at session-start IF count > 0 in the last 24h. Cost: V20 migration + assembler section + tests. Best matches "visible" intent.

**Option B — telemetry event + Vesna SC#1 gate failure.** Same telemetry write, but the gate (`05-09-PLAN`-style) reads telemetry counts and fails if non-zero during the gate run. Cost: V20 + gate update. Simpler but only visible during a gate run.

**Option C — counter table + `/endsession` skill update.** A separate V20 `counters(name, value, last_reset_epoch)` table; the global skill reads it. Cost: V20 + skill update + cross-machine concern (skill lives in `~/.claude/`).

**Recommendation: Option A.** Project-local, deterministic, surface visible at *every* session-start (matches the spirit of "visible telemetry warning"), no global skill churn. Wave 4 plan codifies this.

### Reranker supervisor (`src/angel/reranker-supervisor.ts`)

Already implements bounded-restart, log-capture, externally-managed detection, healthcheck loop (heartbeat polls `/health` every tick — see line 27-29). To make the reranker "hard-required for production retrieval" (RETR-08), the work is **not** at the supervisor level — supervision already exists. The work is:

1. Add the fallback-fired telemetry write at the bi-encoder branch entry (~line 783 of `hybrid-retrieval.ts`).
2. Surface a session-start observational warning if any fallback fired in the last N hours.
3. Document the policy in `CLAUDE.md` and `README.md` (already partially noted but not codified as load-bearing infra).

**Out of scope for Phase 6** (per CONTEXT.md): reranker model swap, supervisor redesign, ≥99% uptime gate (gate target stated in CONTEXT.md but no code path drives it). Treat the 99%/24h target as an *aspiration* documented in `CLAUDE.md`, not a release-blocking gate this phase implements.

---

## 3. Vesna probe substrate — what exists vs. what we need

### Available probes today

- `src/tests/integration/phase-4-1-perceptual-similarity-probes.test.ts` — 4 paraphrase-recall probes (Phase 4.1 + 5 baseline).
- `src/tests/integration/phase-4-1-live-fire-behavioral.test.ts` — broader behavioral checks.
- `src/tests/angel/curation-feedback-loop.test.ts` — 6 lifecycle scenarios (Phase 5.5 SC#5).

These were enough as a **proxy** for SC#1 gates in Phase 5/5.5 because the gate threshold is absolute ≥80%, not a delta. Per-multiplier ablation needs **delta** measurement at high enough N to detect a 1pp Vesna difference. With 4 probes, one mis-rank = 25pp delta — far too noisy.

### Probe budget for Phase 6 ablation

CONTEXT.md says "minimum 10 probes spanning entity recall, constraint recall, handoff pickup". Sources for new probes:

- **Entity recall** — given a known entity ID/alias, query a paraphrase, expect the entity-summary artifact in top-K.
- **Constraint recall** — given a remembered constraint (e.g. "MAX subscription"), query a related task, expect the constraint to surface.
- **Handoff pickup** — given a session log, query the next-session prompt, expect the handoff artifact in top-K.
- **Lesson recall** — already covered by phase-4-1 perceptual-similarity probes; they apply directly.

The shape used in `phase-4-1-perceptual-similarity-probes.test.ts` is the right shape: a Vitest test that builds an in-memory DB with seeded artifacts, runs `hybridSearchAsync`, asserts the expected ID is in top-K. Ablation toggles a per-multiplier flag at the call site (or via env / options) and re-runs.

**Decision deferred to planner: where the toggle lives.** Three options:
- (a) Add a `multiplierFlags` field to `HybridSearchOptions` (cleanest, public API churn).
- (b) Process-level env var (`VESNA_DISABLE_MULTIPLIERS=novelty,activation`) read at module scope (no API churn, easy to clean up).
- (c) Per-test source-code branches gated by a constant.

**Recommendation:** (a) for the ablation harness — typed, testable, removable later if multipliers are deleted. The flags become dead code only when the multiplier they gate is deleted, which is the very next step.

### Test infrastructure pattern (from Phase 5 plan-09 verdict)

The accepted shape is: `bun run test src/tests/integration/phase-6-multiplier-ablation.test.ts` produces an output table that gets pasted into `06-MULTIPLIER-ABLATION.md`. Test runtime: low — Vesna probes are pure-JS in-memory probes, ~10s for the full set.

---

## 4. STOR-08 backup pattern (for the schema-drop hard gate)

Established by Phase 4.1 / Phase 5:

```bash
# Captured: ~/.claudex/backups/pre-v4-P5-1777478253.db
# Recipe:
TS=$(date +%s); SRC=$HOME/.claudex/db/claudex.db
cp "$SRC" "$HOME/.claudex/backups/pre-v4-P5-${TS}.db"
sqlite3 "$HOME/.claudex/backups/pre-v4-P5-${TS}.db" "PRAGMA integrity_check;"
sqlite3 "$HOME/.claudex/backups/pre-v4-P5-${TS}.db" "PRAGMA user_version; SELECT count(*) FROM artifacts;"
```

Phase 6 must do this **before** any `DROP TABLE`, `ALTER TABLE` that removes a column, or any V20 migration that recreates the `telemetry` table.

**What schema actually changes in Phase 6?** Only the `telemetry` event_kind CHECK enum (V20). Removing the `q_value` column from `artifacts` is **out of scope** even if Vesna shows the multiplier is dead — column drops ripple into every reader. Phase 6 leaves the column in place, just stops *using* it. Column cleanup tracked as future hygiene.

---

## 5. Test coverage that must not regress

`src/tests/core/hybrid-retrieval.test.ts` (510 LOC, ~50 cases) covers:
- RRF merge correctness, smoothing constant.
- Three-factor scoring formula independence.
- Channel-failure graceful degradation.
- RIF suppression behavior (Phase 14).
- ACT-R activation decay.
- Spread activation.

After multiplier deletion, these tests **must still pass** — the deletion changes only the hybrid-score formula, not the RRF merge, channel queries, RIF, or activation decay. Existing tests that assert specific score values for synthetic artifacts will break and need re-baselining; tests that assert only ordering should pass through.

**Plan call-out:** every multiplier-deletion commit re-runs the suite; any test that fails in a way that asserts ranking (not arithmetic) is a tripwire — investigate before re-baselining.

---

## 6. MCP surface (RETR-04 — must not change)

The MCP server `src/mcp/recall-server.ts` exposes:
- `claudex_search` — calls `hybridSearchAsync` under the hood.
- `claudex_recall` — pulls a specific artifact by ID/path; not affected by multiplier deletion.
- `claudex_events` — session-events readout; unaffected.
- `claudex_store` — write path; unaffected.
- `claudex_message` — cross-session messaging; unaffected.

**Verification:** every `claudex_*` MCP test must continue to pass without code change. The output of `claudex_search` may shift in *ordering* (since the score formula changed) but the response *shape* must be identical.

---

## 7. Wave-organization logic for the planner

Dependency graph:
1. **Backup + V20 migration + ablation harness** — must land first; nothing else can.
2. **Ablation runs (per multiplier)** — depends on (1). Parallelizable in measurement, but the result write into `06-MULTIPLIER-ABLATION.md` must happen before deletion.
3. **Multiplier deletion based on ablation** — depends on (2).
4. **Reranker hard-required telemetry + visibility** — independent of multipliers; can run parallel to (3) but must use the V20 migration from (1).
5. **MCP surface unchanged + RIF/spread retained verification** — gate at the end.
6. **Vesna re-baseline + SC#1 ≥80% gate** — final gate.

Recommended waves: **6 plans across 5 waves** — see plan files.

---

## 8. Open risks (planner should pre-empt)

| Risk | Mitigation in plan |
|---|---|
| Sync path's `qMultiplier` (line 532) silently makes sync results inconsistent with async — pre-existing latent bug | Wave 3 either deletes both copies or aligns behavior; document the call. |
| Bi-encoder fallback path (`fetch http://localhost:11434`) is currently silent on Ollama down — fallback-of-fallback returns RRF-only scores | Wave 4 telemetry covers cross-encoder fallback only; Ollama-down fallback gets a follow-up TODO, not blocking. |
| Vesna probe set ≤10 may miss a regression in a domain not covered by the chosen probes | Plan documents which categories are covered; gate is absolute ≥80% so a category-blind regression is detected by the gate. |
| RIF activation decrement runs even on background queries (e.g. heartbeat sweep retrieval) — ablating RIF here could un-mask side effects across the heartbeat | Wave 2 ablation runs in test-isolated DB; production RIF behavior unchanged unless Wave 3 deletes it (CONTEXT.md says retain). |
| `qdrant-client.ts` filename mismatch is a code-comprehension hazard | Out of scope — rename tracked in `context/specs/SQLITE_VEC_MIGRATION.md` Phase 5b. |

---

## Files relevant to plans

- `src/core/hybrid-retrieval.ts` — primary surgery target
- `src/core/schema.ts` — V20 telemetry CHECK enum migration
- `src/core/migration-steps.ts` — `migrateV19toV20` to add
- `src/core/migrations.ts` — bump `TARGET_VERSION` to 20
- `src/intelligence/retrieval-feedback.js` — `getRetrievalScoreMultiplier`; deleted callsite if multiplier ablated out
- `src/angel/reranker-supervisor.ts` — no code changes; CLAUDE.md docs only
- `services/reranker.py` — no code changes
- `src/tests/core/hybrid-retrieval.test.ts` — re-baseline after deletion
- `src/tests/integration/phase-6-multiplier-ablation.test.ts` — NEW (Wave 1+2)
- `src/tests/integration/phase-6-mcp-surface-unchanged.test.ts` — NEW (Wave 5 verification)
- `.planning/phases/06-p5-retrieval-simplification-multiplier-ablation/06-MULTIPLIER-ABLATION.md` — NEW (Wave 2 output)
- `CLAUDE.md` / `README.md` — RETR-08 docs update
