# Phase 2: Multi-modal index seeds + density-at-scale check - Context

**Gathered:** 2026-05-04
**Status:** Ready for planning
**Type:** empirical

<domain>
## Phase Boundary

Build **ONE** non-semantic index on Phase 1's `episodic_events` substrate, populate it with 50–100 real Claudex episodes, and measure whether (a) the index fires correctly on similar errors, (b) RRF fusion with semantic recall improves precision/recall over semantic-only, and (c) at the scale of our episode corpus (~9K observations across projects) density is a meaningful signal or pure noise. The output is a measurement report plus a re-runnable harness. **Negative result is a valid output** — if error-fingerprint doesn't justify its complexity, scope it down or pivot before Phase 3 builds on it.

**In scope:**
- Single index implementation (error-fingerprint: token-shingle + edit-distance over stack traces)
- Sidecar inverted-index table for fast lookup + per-row shingle storage in `episodic_events.metadata_json`
- One-time backfill from accumulated `tool_result` rows (post-Phase-1) plus historical v4 observation rows whose content matches stack-trace shapes
- Automated pair-labeling harness (no manual labeling at scale; manual spot-check only)
- A/B/C measurement: semantic-only vs error-fingerprint-only vs RRF-fused
- Random-pair similarity baseline to establish noise floor
- Permanent re-runnable benchmark at `src/benchmark/episodic-density/`
- Two new Vesna probes (index correctness, fusion non-regression) gated on green-light decision
- Locked decision rule **before measurement runs** — green-light Phase 3 / scope-down to advisory / kill

**Explicitly out of scope (other phases):**
- Wiring the index into production retrieval paths — Phase 3 cuts retrieval over
- Building affect signal or structural-shape indexes — Phase 2.5 or Phase 3 if (and only if) error-fingerprint validates the multi-handle thesis
- Pattern-extractor reduction — Phase 4
- Density-based abstraction at retrieval time as a production surface — Phase 5 (Phase 2 only measures whether density *could* abstract)
- Episode-boundary semantics / `episode_id` column — Phase 6
- Any deletion / migration of v4 storage — Phase 7
- Multi-handle fusion across N>2 indexes — Phase 3 (Phase 2 measures fusion of exactly two: semantic + error-fingerprint)

</domain>

<decisions>
## Implementation Decisions

### 1. Index choice — error-fingerprint, locked

Token-shingle + edit-distance over stack traces extracted from `episodic_events` rows where `provenance='tool_result'` and content matches stack-trace patterns. This is the empirical phase's single index.

**Reasoning:**
- Tool_result rows with stack traces are the most numerous non-semantic signal we capture at write time → real corpus, no synthesis required.
- Long stack traces are exactly where semantic embedding signal degrades (token-bag noise dominates) → if any non-semantic index has measurable lift, this is it.
- Ground truth is most accessible: same fingerprint in two sessions = "should fire each other" → enables automated pair labeling without human judgment.

Affect / structural-shape are deferred to Phase 2.5 or Phase 3, conditional on this phase validating the multi-handle thesis. Locked: do not attempt them in Phase 2.

### 2. Corpus selection & ground truth

**Source:**
- Primary: real `episodic_events` rows with `type='tool_result'` written since Phase 1 ship (commit `9434ab9`, 2026-05-04). Provenance-tagged, clean.
- Secondary: backfill from v4 `artifact` rows where `kind='observation'` and content matches typical stack-trace shapes. Untagged but real.

**Target size:** 50–100 events spanning ≥3 projects. Floor is 50 — undersizing risks density measurements being too noisy to interpret. The roadmap's "30–50" lower bound is rejected: at 30, the held-out test set is below the threshold for meaningful precision-delta inference.

**Ground truth — automated pair labeling:**
Two error events form a "should-match" pair when ALL hold:
1. Same outermost exception type (e.g. `TypeError`, `KeyError`, `sqlite3.OperationalError`)
2. ≥3 frames of stack trace overlap (frame = `file:line + function name`)
3. Different `session_id`

This yields hundreds of pairs without human labeling. Manual spot-check 20 random pairs to validate the auto-labeler isn't producing garbage (audit before measurement runs).

**Train / test split:** 80/20. Hold out 20% of pairs as a test set the harness never sees during threshold tuning.

**Known limitation (deliberately accepted):** v4 `artifact` backfill rows lack Phase 1 provenance tags. Fingerprints from that subset are mixed with provenance-clean Phase 1 fingerprints. The harness MUST tag each indexed event with `corpus_origin = 'phase1_organic' | 'v4_backfill'` so post-hoc analysis can split metrics by origin if results are confusing. This is a known measurement caveat, not a blocker — but it must be visible in the results report.

### 3. Measurement protocol

**A/B/C harness:**
- A: semantic-only baseline (existing arctic-embed2 + RRF over FTS5)
- B: error-fingerprint-only (sidecar lookup, ranked by shingle-overlap score)
- C: RRF-fused (semantic + error-fingerprint, k=60 starter; learned weights as stretch)

**Metrics:**
- Quality: precision@5, recall@10, MRR
- Per-metric delta over baseline A
- Cost: latency p50 / p95 / p99 for each variant — query-time cost is a real constraint
- **Confidence intervals** on all quality metrics (Wilson score interval for proportions). At held-out test sets of ~40–60 pairs, raw point-estimate deltas can be noise. Decision rule (item 5) checks CI lower-bound, not point estimate.

**Outputs:**
- `.planning/phases/02-multi-modal-index-seeds-density-check/02-RESULTS.md` — human-readable: tables, deltas, decision-rule check, decision verdict
- `.planning/phases/02-multi-modal-index-seeds-density-check/02-results.json` — raw numbers, machine-readable, Phase 3 baseline
- Permanent harness at `src/benchmark/episodic-density/` — Phase 5 (the second empirical phase) reuses the same shape

**Vesna probes:** 2 new probes added to suite, but gated on green-light verdict — only included in `bun run vesna` if Phase 2 decides to ship.
- `episodic-fingerprint-fires`: known matched pair retrieval ≥ threshold
- `fusion-non-regression`: RRF-fused recall@10 not measurably worse than semantic-only

### 4. Density signal definition

**Noise floor — random-pair similarity baseline:**
1. Shuffle all indexed events. Compute pairwise similarity for 1000 random pairs.
2. Take the 95th percentile as the noise floor.
3. Any cluster with mean intra-cluster similarity > `noise_floor + 2σ` is "signal."

**Cluster definition:**
- Edge condition: similarity > T (threshold)
- Membership: ≥ K members
- Strength tiers: K=2 (weak cluster — could be one-off pair), K≥5 (strong cluster — recurrent pattern)

**Tuning:** T and K tuned on training pairs (80%), reported on held-out test pairs (20%).

**"Density is meaningful" decision input:**
≥30% of high-similarity pairs (above `noise_floor + 2σ`) come from the **same project's error history** — i.e., real recurrent issues, not spurious lexical overlap across unrelated projects. Below 30%, density at our scale is fundamentally project-bounded noise mixed with cross-project lexical drift.

### 5. Decision rule — locked BEFORE measurement runs

Empirical-phase discipline: this rule is committed to CONTEXT.md and PLAN.md before the harness is built. **No moving goalposts after we see results.**

**GREEN-LIGHT Phase 3 — proceed with full multi-handle retrieval cutover:**

ALL three must hold on the **held-out test set**:
1. RRF-fusion has measurable improvement over semantic-only — minimum **+5pp on either precision@5 OR recall@10**, AND the **Wilson 95% CI lower bound on the delta is ≥ 0** (i.e., the improvement is not statistically indistinguishable from zero at our sample size). The AND-CI-bound is the discipline that prevents green-lighting on noise — at n≈40-60 pairs, raw point-deltas of +5pp can be inside the CI of zero.
2. Density at scale produces signal — ≥30% of high-similarity pairs (per #4) are intra-project recurrent.
3. Latency p99 of fused retrieval < 2× semantic-only baseline. Cost discipline: a marginally-better signal that doubles tail latency is not worth shipping.

**SCOPE-DOWN to advisory — Phase 3 ships, but lighter than originally planned:**
Improvement exists on specific subsets (e.g. only Python stack traces, only one project) but not broadly. Phase 3 ships an **advisory-only surface** ("you've hit a similar error before, see episode X") without aggressive RRF fusion in the production retrieval path. Phase 5 density abstraction is de-scoped accordingly (advisory, not abstraction).

**KILL — pivot or stop:**
No measurable improvement (criteria 1 fails on held-out CI bound) OR density is pure noise (criteria 2 fails). Phase 3 plan is rewritten or the multi-handle thesis is reconsidered at the milestone level. SUMMARY.md is honest about this and explains what we'd try next: different index? semantic-with-trick (e.g. stack-trace-aware tokenization)? abandon multi-handle and lean on density alone in Phase 5? Decision is escalated to user-approval gate before Phase 3 starts.

### 6. Implementation surface — sidecar table + metadata_json mix

**Per-row storage in `episodic_events.metadata_json`:**
- Ingest-time: when `writeToolResult` writes a row whose content matches error/stack-trace patterns, it computes shingles and stores them in `metadata_json.error_fingerprint = { shingles: [...], outer_exception: 'TypeError', frame_count: N }`
- Cheap, self-contained, no ALTER TABLE on `episodic_events` (preserves Phase 1 contract)

**Sidecar table — `episodic_index_error_fingerprint` (V26 migration):**
- Inverted index: `(shingle_hash TEXT, episode_event_id INTEGER, ts_epoch INTEGER, project TEXT)`
- Fast retrieval lookup: shingle_hash → episode list, ranked by overlap count
- Indexes: `(shingle_hash)`, `(episode_event_id)`, `(project, ts_epoch)`

**Backfill — explicit one-time pass during Phase 2 setup:**
Not opportunistic at query time. One pass walks all `tool_result` rows since Phase 1 ship + the v4 `artifact` observation backfill, populates both `metadata_json` and the sidecar. Tagged with `corpus_origin` per item 2's known-limitation requirement.

**Reasoning:**
Phase 1's contract was "no readers from `episodic_events` in Phase 1." Phase 2 adds the FIRST reader (the harness) and the FIRST sidecar index. Setting the sidecar pattern now (one-table-per-modality, inverted index of `metadata_json`-derived features) informs Phase 3, which will likely build more sidecars.

### 7. Negative-result handling — keep code, flag-off, permanent learning artifact

**If decision rule lands on KILL or SCOPE-DOWN:**
- Ship the implementation **behind a feature flag, off by default** (`config.episodic_index.error_fingerprint = false`)
- Keep the measurement harness in `src/benchmark/episodic-density/` permanently — it's the regression suite for any future multi-handle attempt
- 02-SUMMARY.md is explicitly honest: "we measured X, found Y, did not justify Phase 3 fusion. Code retained at flag for future reference. Phase 3 plan revised to [scope-down or pivot details]."
- Backfilled rows in `episodic_index_error_fingerprint` retained — destructive cleanup is not the answer. Future v5.x re-runs reuse the existing index data.
- Two Vesna probes are NOT added to the gate suite (item 3) — only added on green-light.

**Reasoning:**
Empirical phases that ship "we measured and it didn't work" are NOT failed phases. The learning is the deliverable. Treating negative results as first-class outputs is what makes empirical phases an honest part of the roadmap, instead of motivated-reasoning theater.

### Claude's Discretion

The planner has flexibility on:
- Shingle algorithm specifics — token unit (whitespace? regex?), shingle width (3? 5?), hash function. Pick reasonable starter; tune during measurement.
- Edit-distance variant — Levenshtein vs token-edit vs Jaccard-on-shingles. Justify pick.
- RRF k constant — start at 60 (canonical), explore learned weights as stretch only if time permits.
- Stack-trace pattern detection regex — what counts as "looks like a stack trace" for the metadata_json fingerprinting trigger. Conservative is fine; missed fingerprints fall out of corpus, not corrupt it.
- Measurement-harness language/runner — TypeScript+vitest like the rest of the project, or Python+pytest if the math is cleaner. Lean toward TS for repo consistency unless there's a strong reason.
- Manual spot-check methodology for the 20 auto-labeled pairs — checklist? notebook? (must produce a decision artifact: "20/20 valid" or "X/20 invalid, fix Y in auto-labeler")
- Layout of v4 `artifact` backfill query (which rows match "stack-trace shapes") — heuristic regex is fine; the `corpus_origin` tag from item 2 means a sloppy heuristic only contaminates one slice, doesn't destroy the corpus.

</decisions>

<specifics>
## Specific Ideas

- **Decision rule before measurement is THE empirical-phase discipline.** Item 5 is committed in this CONTEXT.md and must be repeated verbatim in PLAN.md. Any planner attempt to "adjust" the green-light criteria after seeing initial numbers must escalate to the user-approval gate.
- **Confidence intervals on metric deltas are not optional.** At n≈40-60 pairs the +5pp threshold sits inside CI of zero for many plausible outcomes. The CI-lower-bound check is the difference between "this is real signal" and "this is the random-seed lottery."
- **Corpus origin must be visible in results.** v4 backfill mixed with Phase 1 provenance-clean rows is a known-limitation, not a defect — but the report must split metrics by `corpus_origin` so we can see whether the index works on clean data, dirty data, or both.
- **Negative result is the deliverable, not the failure.** Item 7 is the contract. If the planner or executor frames a negative result as "Phase 2 failed," push back — that framing is exactly what motivated-reasoning empirical phases die from.
- **Backfill is forbidden for legacy `conversation_turns`** (Phase 1 contract). Phase 2 backfill is from v4 `artifact` rows + accumulated post-Phase-1 `tool_result` rows. These are separate sources; don't conflate.
- **Re-runnable harness is non-negotiable.** Phase 5 (the second empirical phase) reuses this shape. Building a one-shot script and deleting it after measurement is forbidden.
- **The sidecar pattern set here informs Phase 3.** If Phase 3 builds 2-3 more indexes, they should follow the same shape: per-row metadata in `episodic_events.metadata_json`, inverted-index sidecar table with V<N> migration, explicit backfill, no ALTER TABLE on `episodic_events`.

</specifics>

<deferred>
## Deferred Ideas

- **Affect signal index** (sentiment / frustration markers from organic content) → Phase 2.5 or Phase 3, conditional on Phase 2 green-light
- **Structural-shape index** (turn-pattern hashing, intent-shift detection) → Phase 2.5 or Phase 3, conditional on Phase 2 green-light
- **Multi-handle fusion across N≥3 indexes** → Phase 3
- **Wiring the index into production retrieval (`hybrid-retrieval.ts` cutover)** → Phase 3
- **Density-based abstraction as a production surface** (not just measurement) → Phase 5
- **Learned-weight RRF (vs k=60 constant)** — stretch goal in Phase 2; full investment is Phase 3
- **Stack-trace-aware tokenizer for the semantic embedder** — listed in KILL-pivot-options for Phase 3 if Phase 2 kills error-fingerprint
- **Episode-boundary semantics** (does a "match" cross episode boundaries? right now, every event stands alone) → Phase 6
- **Cross-project pattern surfacing UI** (when ≥30% intra-project signal threshold from item 4 is HIT, do we surface it to the user? how?) → Phase 5 or Phase 7
- **Re-running Phase 2 measurement on quarterly cadence** (corpus grows; thresholds may shift) → operational practice, not a phase

</deferred>

---

*Phase: 02-multi-modal-index-seeds-density-check*
*Context gathered: 2026-05-04*
