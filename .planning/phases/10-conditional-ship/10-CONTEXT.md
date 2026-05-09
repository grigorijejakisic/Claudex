# Phase 10: Conditional ship — Context

**Gathered:** 2026-05-09
**Status:** Ready for planning
**Branch trigger:** P9 BIND POSITIVE (pooled n=60, Δ +0.1667, Wilson CI [+0.0038, +0.3434]) → engineering branch unlocked
**Audit anchor:** P9 09-RESULTS.md commit `b240628`; aggregator `.planning/aggregates/deliberation-surfacing.{md,json}` row `9-pooled-r1+r2`

<domain>
## Phase Boundary

Wire P9's bound-POSITIVE deliberation-surfacing primitives (artifact → transcript fan-out + assembly span citations) into production retrieval, extend Vesna with deliberation-engagement probes, pass the v6 ship-gate suite (8 gates + WIR-01 as 9th), and tag `v6.0.0` locally with the bind narrative leading the annotation.

**In-scope (engineering branch, P9 verdict locked):**
- Routing layer (ROU-01..03): artifact → transcript chunk fan-out, reranker (with bi-encoder fallback per P9 baseline), budget caps
- Assembly layer (ASM-01..03): labeled transcript span citations, advisory narration line, token budget cap
- Vesna extension: 21 → 26 probes (5 new deliberation-engagement probes, one per drift kind a-e)
- WIR-01 inheritance: production-shape integration test runs the wired routing+assembly path against V17-collapsed + base-table fresh-DB fixtures
- 8 ship gates + WIR-01 as 9th
- Local annotated `v6.0.0` tag (operator-confirmed push — NEVER push autonomously)

**Out-of-scope:**
- New retrieval algorithms (v6 reuses v4 hybrid-retrieval applied to transcript-chunk corpus)
- Extraction-time pattern creation from transcripts (V28/V31 disciplines stay closed)
- Multi-handle recall, density-based abstraction (KILLED in v5)
- Cross-encoder promotion on transcript surface (re-bind required first — see Deferred Ideas)
- Per-artifact-kind routing weights (no measurement support — see Deferred Ideas)
- Bound-negative documentation branch (P9 verdict is POSITIVE; this branch does not fire)

</domain>

<decisions>
## Implementation Decisions

### Retrieval baseline (default for v6 transcript-routing surface)

**Bi-encoder is the production primary** for transcript fan-out / reranking on the v6 surface.

- P9 binding measurement was conducted under `bi_encoder_fallback` baseline; cross-encoder fitness re-check post-backfill reported 56.0% top-3 overlap (n=47), below the 60% threshold from P9 CONTEXT decision 4.
- v5 methodology discipline: ship what was bound; do not promote unmeasured paths. Cross-encoder on web/document training distribution may underperform bi-encoder on conversation-distribution chunks — that's the hypothesis the fitness re-check supports.
- Per 09-RESULTS §"Operational Notes": "P10 routing should preserve the bi-encoder fallback path as a primary execution mode, not a degraded one — the binding measurement was conducted under it."
- Cross-encoder remains code-available behind a config flag (`v6.routing.reranker_mode`) so a future re-bind on a grown / different-distribution corpus can promote it without architectural surgery.
- Existing v4 hybrid-retrieval cross-encoder default for **non-transcript** surfaces (episodic_events, learnings, decisions, etc.) stays unchanged. This decision scopes only to the v6 transcript-routing surface.

### Routing scoring

**Artifact-kind-agnostic.** Routing relies on reranker / bi-encoder ranking only.

- P9 per-kind delta is descriptive-only per CONTEXT additional_locks ("the pooled cross-kind verdict is the gate"). The drift-detection kinds (a-e) are P9 probe taxonomy, not categorical tags carried by production artifacts.
- Per-kind weighting in production would require runtime artifact classification, add complexity, and have zero measurement support.
- Cleaner production design: uniform routing + ranker score across all artifact kinds.
- Per-kind data informs FUTURE measurement design (why did kinds a/c not lift?) — see Deferred Ideas.

### Routing defaults (locked first-principles, exposed as config for v6.x tuning)

| Key | Value | Rationale |
|-----|-------|-----------|
| `v6.routing.top_k_per_artifact` | **3** | Matches reranker top-K stdpattern; small enough to not flood when multiple artifacts fire in one assembly |
| `v6.routing.max_k_per_query` | **12** | ~4 artifact references × 3 spans = manageable for assembly tokenizer budget |
| `v6.routing.token_pct_cap` | **15%** of assembly window | Aligns with existing section caps; consistent with ASM-03 |
| `v6.routing.bi_encoder_budget_pct` | **50%** of token cap | Bi-encoder-only retrieval surfaces lower-confidence spans → reduced budget per ASM-03 + P9 baseline asymmetry |
| `v6.routing.reranker_mode` | `bi_encoder_primary` | Cross-encoder available but not default; flippable for future re-bind |

All five keys persist in `config.json` under the `v6.routing` namespace. Data-driven retune scheduled after first 2 weeks of production traffic (see Deferred Ideas).

### Vesna probe extension

**Vesna grows from 21 → 26 probes (+5 deliberation-engagement probes).**

- One probe per P9 drift kind (a sample-size, b threshold-source, c scope-change, d dependency-change, e assumption drift) at production-shape scale.
- Includes kinds a (sample-size) and c (scope-change) which were flat in P9 — they serve as **non-regression baseline**, not engagement evidence. Regression discipline requires both lifty and flat kinds covered.
- Probes reuse P9 fixture taxonomy structure but author fresh production-shape fixtures (P9 fixtures stay byte-immutable per probe-set pre-commitment lock; new probes target the wired retrieval path, not the harness).
- Pass criterion: production retrieval surface fires deliberation-surfacing path correctly per probe (mechanical wire correctness + behavioral engagement at agent level, consistent with existing Vesna probe shape).

### Ship gates

Same 8 v5/Phase 8 gates + WIR-01 as 9th gate. WIR-01 includes:
- (a) transcript spans actually retrieved when artifact reference fires
- (b) spans actually appear in assembly output
- (c) zero errors across V17-collapsed + base-table fresh-DB fixtures
- (d) advisory narration line ("## Deliberation Surfaced — N spans from M sessions") emitted

WIR-01 is **wire correctness only** — runs the exported routing+assembly functions against production-shape fixtures. NOT engagement re-measurement. (Adding a pre-ship empirical drift-probe smoke would re-litigate the P9 verdict using post-hoc data — methodology violation per "descriptive-not-gating audits" in v5 standard practice. Random variance on a small smoke could falsely block a properly-bound ship.)

### v6.0.0 tag

- **Local annotated tag only.** Operator confirms public push (same pattern as v5.0.0).
- **NEVER push autonomously.**
- Annotation leads with the bind narrative: pooled n=60, Δ +0.1667, Wilson CI [+0.0038, +0.3434], retrieval baseline `bi_encoder_fallback`, per-kind concentration in kinds b/d/e.
- CHANGELOG `[6.0.0]` entry mirrors the annotation.

### Claude's Discretion

- Plan structure (number of waves, plan splitting) — planner decides during `/gsd:plan-phase 10`.
- Specific config.json schema for `v6.routing.*` keys — implementation detail.
- Specific Vesna probe text and judge prompts (taxonomy + count locked above; authorship is implementation).
- WIR-01 fixture authorship (shape contract locked; specific fixture content is implementation).
- Code organization for routing + assembly modules (no architectural mandate beyond reusing existing reranker / bi-encoder paths).

</decisions>

<specifics>
## Specific References from Source Spec + P9 Results

- **Routing reuses BGE-reranker-v2-m3 service** (port 7439, supervised by Angel's `RerankerSupervisor`) per ROU-02; bi-encoder fallback path matches Phase 1 episodic_events pattern.
- **Assembly format example** (ASM-01): `"From session X turn 47, where Phase 2.1 KILL was decided: ..."` with `session_id` + `turn_index` for agent-level citation.
- **Advisory narration format** (ASM-02): `"## Deliberation Surfaced — N spans from M sessions"` consistent with Phase 7's "When You Recall — Narrate" discipline.
- **Artifact join key** (ROU-01): `session_id` + time window from artifact's creation timestamp.
- **Artifact kinds eligible for fan-out** (ROU-01): CONTEXT.md decision, SUMMARY.md outcome, learning, experience pattern, mental model, directive rule, critical rule.
- **WIR-01 fixture shapes** (per v5.0.1 lesson): V17-collapsed at minimum, plus base-table fresh-DB.
- **Production bug fixes from P9 prep** (commit `4e9da8c`): vec0 BigInt rowid coercion in `src/ingestion/ingest-session.ts`; JSON-extract WHERE clause in `src/cli/drain-transcripts.ts` and `src/angel/heartbeat.ts`. P10 routing inherits these fixes — do not reintroduce.
- **Embedding coverage at P9 measurement time:** 45,553/47,330 chunks = 96.2% (gap is empty-body / oversized chunks skipped by design at `src/ingestion/ingest-session.ts:241-247`).

</specifics>

<deferred>
## Deferred Ideas

Carved out of v6.0.0 scope. Re-examined at v6.x or v7+ planning.

- **Per-kind routing weight tuning** — Production artifacts don't carry drift-kind labels; runtime classification has no measurement support. Defer until "engagement-metric refinement" (v6.x or v7+) authors a fixture set that gives per-kind binding power.
- **Cross-encoder re-bind on transcript surface** — Currently fitness 56% < 60% on conversation-distribution chunks. Re-check after meaningful corpus growth or distribution shift; promote via `v6.routing.reranker_mode` flag without architectural surgery.
- **Routing default tuning from production telemetry** — First measurement-informed retune scheduled after first 2 weeks of production traffic. Candidates: `top_k_per_artifact`, `max_k_per_query`, `token_pct_cap`, `bi_encoder_budget_pct`.
- **Kind-a (sample-size) and kind-c (scope-change) null-result investigation** — Both kinds flat in P9 (Δ=0.000). Open question: probe-design artifact, retrieval-side limitation, or genuine null effect on those drift types? Informs P9 fixture refinement and any future engagement metric.
- **Retention policy / forgetting-curve layer (RET-NEW)** — Transcript volume grows unbounded. Trivial today (~1GB scale); required at ~10x current scale. v7+ scope.
- **Cross-harness transcript sources (XHN)** — Codex / Aider / Gemini-CLI transcripts via same vectoring substrate. Angel's `cross-agent-sessions` already exists; extension is a future milestone.

</deferred>

---

*Phase: 10-conditional-ship*
*Context gathered: 2026-05-09*
*Audit anchor: P9 09-RESULTS.md commit `b240628`; aggregator entry `9-pooled-r1+r2`*
