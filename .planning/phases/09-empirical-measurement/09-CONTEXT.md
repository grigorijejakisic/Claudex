# Phase 9: Empirical measurement - Context

**Gathered:** 2026-05-08
**Status:** Ready for planning
**Type:** empirical
**Methodology gate:** ALL decisions in this CONTEXT.md are pre-committed BEFORE any measurement-run timestamps appear in `.planning/aggregates/deliberation-surfacing.{md,json}`. This file's commit timestamp is the audit anchor for methodology gate compliance (REQ ENG-05 — auditable pre-commitment).

<domain>
## Phase Boundary

Bind whether next-session task performance improves when the agent has access to verbatim historical deliberation (transcript spans) vs. summary-only baseline. Same methodology shape as v5 Phase 2/2.1 (multi-handle): pre-committed decision rule, locked corpus + harness, ≥2 bound replications, Wilson/Newcombe CI binding, descriptive-not-gating audits, negative results valid as outputs.

**Requirements covered:** ENG-01, ENG-02, ENG-03, ENG-04.

**In scope:**
- Pre-committed engagement metric (drift-detection probes — primary, locked rule below)
- Locked drift-fixture taxonomy (5 kinds × 6 fixtures = 30 probes total)
- Measurement-only A/B harness at `src/benchmark/deliberation-surfacing/` (does NOT modify production assembly; mirrors v5 `src/benchmark/episodic-density/` prior art)
- LLM-as-judge grading via deepseek-coder-v2:16b local with three-prong rubric
- ≥2 bound replications via Wilson/Newcombe CI binding on Δ(transcript − summary)
- Append-only aggregator at `.planning/aggregates/deliberation-surfacing.{md,json}`
- Verdict drives P10 branch (positive → engineering; negative → documentation/KILL receipt; inconclusive → P9.1 corpus-expansion replication)

**Out of scope (locked elsewhere or deferred):**
- Routing + assembly integration (P10 engineering branch — only ships if P9 binds positive)
- KILL receipt artifact authoring (P10 documentation branch — only ships if P9 binds negative)
- Citation density and specificity-contrast secondary signals (deferred to v6.x or v7+ — see Deferred Ideas)
- Counterfactual capability probe class (deferred — spec lists as exploratory)
- Reranker fine-tuning on conversation distribution (v7+ research direction)
- Vesna deliberation-engagement probe extensions (P10 engineering branch — 21→24+ growth, not P9)
- Production retrieval-pipeline modifications (P10's surface; P9 is measurement-only)

</domain>

<spec_locked>
## Spec-Locked Decisions (not up for discussion)

These are pre-committed by ROADMAP.md, REQUIREMENTS.md, or `.planning/research/2026-05-08-v6-deliberation-surfacing.md` and are inputs to planning, not decisions to revisit:

- **Primary metric:** Drift-detection probes — synthetic cases where current state differs from the conditions that produced a past decision. Summary-only context: agent applies the verdict generically (FAIL). Transcript context: agent surfaces the divergence (PASS). Spec Q1 answer + REQ ENG-01.
- **Decision rule shape:** Lower-CI of Δ(transcript_pass_rate − summary_pass_rate) > 0 across N probes via Wilson/Newcombe binding. REQ ENG-04.
- **Minimum kind-coverage:** ≥5 distinct kinds of condition-shift. REQ ENG-02.
- **Replication minimum:** ≥2 bound measurements (more if first run is inconclusive). REQ ENG-04.
- **Aggregator location and discipline:** `.planning/aggregates/deliberation-surfacing.{md,json}` — append-only, schema mirrors `multi-handle.{md,json}` (v5 P2/P2.1 aggregator). REQ ENG-03.
- **Locked corpus + harness across replications:** same code, same data, same probe-set across replications. REQ ENG-03.
- **Reranker baseline branches on P8 fitness verdict:** P8's `bun run reranker:fitness` (zero chunks at substrate validation time → re-run after backfill completes). PASS (top-3 overlap ≥0.60) → BGE-v2-m3 baseline; FAIL → bi-encoder-only baseline. P8 CONTEXT decision 4 — informational, not a ship blocker either way.
- **Wilson/Newcombe CI math:** reuse existing `src/benchmark/episodic-density/wilson.ts` (v5 P2/P2.1 prior art). DO NOT roll fresh CI code.
- **Methodology gates from ROADMAP §17 (mandatory for every v6 phase):** pre-committed decision rule before any empirical run; locked corpus + harness; multiple bound measurements; Wilson/Newcombe CI binding; live-wiring smoke against every production DB shape (V17-collapsed at minimum); negative results are valid outputs.

</spec_locked>

<decisions>
## Implementation Decisions (locked before any measurement run)

### 1. Drift-fixture taxonomy (REQ ENG-02)

**Lock:** 5 kinds of condition-shift × 6 fixtures each = **30 total probes**, drawn mostly from real claudex-v3 deliberation moments with limited synthetic fixtures only where distribution coverage requires it.

**The 5 kinds (locked):**

| # | Kind | What shifts | Source moments |
|---|---|---|---|
| **a** | **Sample-size shift** | Past decision at n=N; current corpus 10× larger; threshold revisit warranted? | Phase 2 KILL (n=20 Wilson lower -0.157), Phase 2.1 expansion (n=60), LongMemEval Oracle 90.6% (n=470) |
| **b** | **Threshold-source drift** | Past decision picked threshold T under specific reasoning; reasoning still valid? | Phase 2.1 density 0.30 floor pick, P8 reranker-fitness 0.60 overlap threshold pick, V17 collapse cutover threshold |
| **c** | **Scope-change drift** | Past decision applied within narrow scope; current scope expanded; verdict still apply? | Phase 7 view-mode hot-fix (V17-collapsed scope expansion), parseWrappers redaction scope (Phase 1 → Phase 8 boundary), WIR ship-gate fixture coverage |
| **d** | **Dependency-change drift** | Past decision conditioned on lib X v2; current uses v3; reasoning holds? | sqlite-vec migration (Qdrant removal session 47), arctic-embed2 vs prior embedder, Ollama version drift |
| **e** | **Assumption drift** | Past decision assumed Y; current state shows Y no longer true | Mem0-trap closure (V28/V31 trigger pattern), Critical Reminders (Session 44 — turn-1-only injection assumption falsified), v5.0.0 silent-fail (test-coverage assumption falsified) |

**Fixture authoring discipline:** each fixture is a JSON file at `.planning/phases/09-empirical-measurement/probes/{kind}-{NN}.json` with:
- `id`: stable identifier (`drift-a-01`, `drift-e-06`, etc.)
- `kind`: `a` | `b` | `c` | `d` | `e`
- `prompt`: the agent-facing query that triggers the past decision
- `past_artifact_ref`: artifact ID(s) the summary-only baseline retrieves (CONTEXT decision, learning, experience pattern, etc.)
- `transcript_anchor`: `session_id` + `turn_index_range` of the deliberation moment in `transcript_chunk_v6` (validates substrate is queryable for B-arm)
- `condition_shift`: structured description of what's now different
- `pass_criterion`: explicit rubric trigger for the LLM-as-judge (which condition the agent must surface)

**Synthetic admixture rule:** if real claudex-v3 history yields fewer than 6 fixtures for a given kind (likely for kinds (c) scope-change and (d) dependency-change), fill with synthetic constructed cases drawn from canonical software-engineering shifts (lib version bumps, scope expansions, etc.). Synthetic fixtures still require a `transcript_anchor` — generate the anchor by writing a synthetic deliberation transcript and ingesting it via `upsertChunk` into a labeled corpus partition (`source: 'synthetic'` metadata column or equivalent), so the B-arm has retrievable substrate. Synthetic fixture ratio capped at 30% per kind (≤2 of 6).

**Grading: LLM-as-judge with three-prong rubric.** Use **deepseek-coder-v2:16b local** (same model used in LongMemEval Oracle 90.6% per CLAUDE.md — free, private, no API cost, established competence on this codebase's deliberation distribution).

**Three-prong rubric (ALL three must PASS for the probe to PASS):**

1. **Surfaces the divergence:** does the agent NAME the condition-shift in its response? (e.g., "the past decision was at n=20 but the current corpus is 10× — the threshold may not hold")
2. **Cites specifically:** does the agent reference primary-source content with `session_id` + `turn_index` (or equivalent), not just summary-level paraphrase? Catches accidental prong-(1) passes by summary-only baseline (rare — summaries don't carry conditional structure — but the prong-(2) gate makes that path structurally impossible without transcript context).
3. **Concludes engagement:** does the agent recommend re-evaluation, perturbation analysis, or revisit — NOT generic verdict-application? (e.g., "re-run with the expanded corpus before applying the kill verdict")

Judge prompt template lives at `.planning/phases/09-empirical-measurement/judge-prompt.md` (committed before first measurement run; immutable thereafter for that phase).

**Reasoning for grading choice:** LLM-as-judge introduces grading variance on top of agent-response variance, but the three-prong rubric narrows the variance bandwidth (each prong is binary; combining gives a graded-but-discrete signal). Manual grading at n=30 across ≥2 replications = 60+ probes — too expensive for the empirical-phase budget. Regex-keyed grading is too brittle for a free-text engagement signal. LLM-as-judge with explicit rubric is the established compromise (LongMemEval, LoCoMo, MemBench all use it).

### 2. Probe count + replication shape (REQ ENG-03, ENG-04)

**Lock:** **n=30 per replication** (5 kinds × 6 fixtures, all fixtures used every replication — no sampling within the locked set), **≥2 replications minimum**.

**Why n=30, not n=20 (P2) or n=60 (P2.1):**
- Higher than P2's n=20 because LLM-as-judge introduces grading variance on top of agent-response variance — drift-detection is harder to grade than recall@k (which is binary against ground truth).
- Lower than P2.1's n=60 because each fixture requires a full agent invocation × 2 arms × judge call = ~6 API calls per probe; n=60 × 2 reps × 6 calls = 720 calls, prohibitive for first-pass binding. P2.1 was already corpus-expansion-on-inconclusive.
- 5 × 6 is the smallest balanced design that covers REQ ENG-02's ≥5 kinds while leaving a per-kind sample (n=6) usable for descriptive-not-gating audits (per-kind verdicts are not the gate; the pooled cross-kind verdict is).

**"Replication" definition (locked):** Fresh agent runs (different seed/call) over the **locked probe-set**. NOT fresh probe-set per replication — that confounds replication-variance with corpus-variance, exactly the conflation P2.1 was designed to AVOID (P2.1 expanded corpus only AFTER P2 was inconclusive at locked n=20). Single-source-of-variance discipline preserved.

**Fixture immutability:** once `.planning/phases/09-empirical-measurement/probes/*.json` is committed, the set is frozen for P9. Fresh probes belong to a new phase (P9.1 corpus-expansion replication if inconclusive triggers it, or a v6.x decimal phase). No goalpost-shifts via "we added one more fixture" mid-phase.

**Inconclusive escalation cadence:** if first 2 replications are inconclusive (CI brackets zero — see decision 4), Replication 3 expands to **n=50+** by adding fresh fixtures within the same 5-kind taxonomy. Same shape as P2.1's strict + relaxed tier expansion. Triggered automatically — not a goalpost shift, because the escalation rule is locked here (right now) before any measurement.

### 3. Baseline harness mechanics

**Lock:** **Measurement-only harness** at `src/benchmark/deliberation-surfacing/` — does NOT modify production assembly. Mirrors v5 P2 prior art at `src/benchmark/episodic-density/` (already in repo; reusing patterns + Wilson/Newcombe CI code path).

**Components:**

| File | Purpose |
|---|---|
| `probe-loader.ts` | Loads `.planning/phases/09-empirical-measurement/probes/*.json` |
| `harness.ts` | Orchestrates A-arm vs B-arm runs over the locked probe-set |
| `arm-summary.ts` | A-arm: agent invoked with current production assembly (no transcript injection — summaries only, the existing v4 hybrid-retrieval surface) |
| `arm-transcript.ts` | B-arm: harness queries `vec_transcript_chunks_v6` directly via the same arctic-embed2 → reranker (or bi-encoder fallback per P8 fitness verdict) → top-K-spans path P10 will use; injects spans into the probe prompt manually as labeled citations |
| `judge.ts` | LLM-as-judge call to deepseek-coder-v2:16b local with the three-prong rubric (locked judge prompt at `judge-prompt.md`) |
| `wilson.ts` | **Symlink or re-export from `src/benchmark/episodic-density/wilson.ts`** — DO NOT duplicate; existing v5 P2/P2.1 implementation is the source of truth |
| `aggregator.ts` | Append rows to `.planning/aggregates/deliberation-surfacing.{md,json}` per replication (schema mirrors `multi-handle.{md,json}`) |
| `runner.ts` | CLI entry: `bun run benchmark:deliberation-surfacing` |
| `verdict.ts` | Computes BIND POSITIVE / BIND NEGATIVE / INCONCLUSIVE per decision rule (decision 4 below) |

**B-arm retrieval-path discipline:** harness's `arm-transcript.ts` MUST use the same code path P10 will use in production assembly — `hybrid-retrieval.ts` style (semantic + FTS + reranker, with bi-encoder fallback). This makes the harness a working spec for P10's eventual routing/assembly: if P9 binds positive, P10's engineering branch replaces the harness's manual span injection with the routing+assembly integration around the same retrieval primitives. If the harness's retrieval primitives differ from production's, P9's measurement loses transferability.

**Production-assembly safety:** harness imports from production retrieval modules but does NOT register hooks, modify production retrieval-config files, or write to production caches. Operator-invoked CLI only — same stance as P8's `bun run backfill:transcripts`.

**Post-P9 lifecycle:** harness stays in repo permanently as the canonical deliberation-surfacing measurement, same way `episodic-density` stayed after v5 closed. Re-runnable for any future v6.x re-measurement on a grown corpus. NOT deleted post-P9. NOT a one-shot script.

### 4. Inconclusive escalation trigger — precise boundary

**Lock — Wilson/Newcombe CI on Δ(transcript_pass_rate − summary_pass_rate)** across N probes per replication, **pooled across replications via meta-analysis** (same shape as P2.1 strict + relaxed tier pooling; verify via `src/benchmark/episodic-density/wilson.ts` API):

- **BIND POSITIVE:** Wilson lower bound > 0
  → P10 engineering branch (routing + assembly integration + Vesna 21→24+ + v6.0.0 tag)
- **BIND NEGATIVE:** Wilson upper bound < 0
  → P10 documentation branch (KILL receipt at `.planning/reframes/2026-XX-XX-deliberation-surfacing-kill.md` in Phase-2-shape, substrate-alone ship, v6.0.0 tag with kill leading the annotation)
- **INCONCLUSIVE:** CI brackets zero (lower ≤ 0 AND upper ≥ 0)
  → P9.1 corpus-expansion replication at **n=50+** on locked fixture-set (per decision 2's escalation cadence) BEFORE final verdict

**No point-delta-without-CI verdicts.** P2 explicitly forbade this and the rule fired honestly there: P2's Δp@5 was +10pp but Wilson lower was -0.157 → KILL not BIND. Honoring that precedent is mandatory: a positive point-delta with a negative Wilson lower bound is **not** a positive bind.

**No goalpost shifts after seeing results.** This decision rule is committed (this CONTEXT.md commit timestamp = audit anchor) BEFORE the first row appears in `.planning/aggregates/deliberation-surfacing.{md,json}`. Any post-result attempt to "adjust" the BIND/INCONCLUSIVE thresholds escalates to user-approval gate.

**P9.1 trigger policy:** if Replication 1 + Replication 2 pooled CI is INCONCLUSIVE, automatically queue Replication 3 at n=50+ (no further user gate — autonomous-through-milestone-end directive applies). After Replication 3, re-pool. If still INCONCLUSIVE after Replication 3, escalate to user via SendMessage — three replications without binding is a meta-uncertainty signal worth surfacing.

### 5. Secondary signals scoping

**Lock — OUT of P9.** Citation density and specificity-contrast deferred to v6.x or v7+ as "measurement extensions."

**Reasoning:**
- P9's primary signal (drift-detection three-prong PASS) is the binding gate; secondary signals would not change the P10 branch decision.
- LLM-as-judge variance on the primary metric is already a methodology challenge — adding two quantitative axes inflates scope without changing the decision rule.
- Same carve-out shape as P8's "partial-with-flag ingestion deferred to v6.x" — surface a measurement-extension hypothesis explicitly, ship the binding decision first.
- If P9 binds positive cleanly: secondary signals add color but don't matter for ship. If inconclusive: secondary signals don't disambiguate. If negative: secondary signals don't change anything.

Both signals documented in Deferred Ideas section so P10 documentation (KILL-branch) or v6.x roadmap (positive-branch follow-up) knows they exist as future work, not lost-on-the-floor.

### Claude's Discretion (planner has flexibility on)

- Per-fixture authoring detail: which specific session_ids + turn_index_ranges from claudex-v3 history get picked for the 30 fixtures, within the 5-kind taxonomy (so long as ≥70% real, ≤30% synthetic per kind, and `transcript_anchor` is queryable in `vec_transcript_chunks_v6`).
- Synthetic-fixture seed-author voice: does the deliberation transcript get written third-person omniscient or first-person agent-style? Either fine; lean toward whichever matches the real-fixture distribution after sampling 5 real fixtures first.
- Top-K span budget for B-arm injection: starter K=5 (matches P10's anticipated routing default, pending P10 plan-phase). Tunable if first replication shows token-budget pressure.
- Judge prompt phrasing nuances: explicit rubric structure is locked (three prongs); exact prose around each prong's PASS/FAIL definition can be tuned during planning. Judge prompt commits BEFORE first measurement run; immutable thereafter.
- Aggregator row-schema fields beyond the multi-handle.{md,json} mirror: extra descriptive columns (e.g., per-kind pass rate, judge-confidence summary stat) are fine if append-only semantics preserved.
- CLI ergonomics for `bun run benchmark:deliberation-surfacing`: flag design, output verbosity, dry-run mode — match P8's CLI patterns (`--dry-run`, `--out`, `--sample`).
- Rate-limit handling for deepseek-coder-v2:16b local: queue/retry policy if Ollama saturates during a 60+-call replication run.

</decisions>

<additional_locks>
## Additional Architectural Locks

- **Methodology gate audit anchor:** this CONTEXT.md's git commit timestamp is the pre-commitment audit anchor. The first measurement-run row appended to `.planning/aggregates/deliberation-surfacing.{md,json}` MUST have a timestamp strictly after this commit's timestamp. The roadmapper's success criterion 5 (REQ ENG-05 — auditable methodology compliance) is tested by this strict-greater-than relation.
- **Probe fixtures as committed artifacts:** `.planning/phases/09-empirical-measurement/probes/*.json` are committed BEFORE first measurement run. Once committed (and CONTEXT.md amended to reference the commit hash), the fixture set is immutable for P9. Replication 3 corpus-expansion (if triggered) commits NEW fixtures under the same directory; original 30 remain bytewise unchanged.
- **Judge prompt as committed artifact:** `.planning/phases/09-empirical-measurement/judge-prompt.md` is committed BEFORE first measurement run; immutable thereafter for the phase's binding replications.
- **Aggregator append-only discipline:** `.planning/aggregates/deliberation-surfacing.{md,json}` follows the same append-only discipline as `multi-handle.{md,json}`. Prior content is preserved byte-identical; new replications prepend an "Interpretive History" section and append rows to the chronological table. Rule from `multi-handle.md` line 16: "(rows added at the bottom by future empirical phases; never modified.)"
- **Wilson/Newcombe CI math reuse:** `src/benchmark/deliberation-surfacing/wilson.ts` is a re-export OR symlink from `src/benchmark/episodic-density/wilson.ts`. NOT a copy. The whole point of the v5 standard practice is one CI implementation across all empirical phases — drift here = methodology rot.
- **Hook deadlock discipline:** harness is operator-invoked only. NOT registered as a CC hook. NOT auto-run on session-start or session-end. Multi-hour LLM-as-judge cost — operator chooses the moment, same stance as P8's `backfill-transcripts` and `reranker-fitness`.
- **WIR-01 inheritance NOT applicable to P9:** WIR-01 is mandatory for engineering phases (P8 substrate, P10 engineering branch). P9 is empirical, not engineering — measurement harness reads production code paths but does not ship a new write surface to the production DB. P10's engineering branch (if positive) inherits WIR-01 via WIR-02 phase coupling.
- **Vesna baseline preservation:** Vesna 21/21 must remain green throughout P9. P9 does NOT add Vesna probes — deliberation-engagement extensions (21→24+) are P10 engineering branch only, conditional on positive verdict.

</additional_locks>

<specifics>
## Specific Ideas

- **Pre-commitment is the methodology gate.** This CONTEXT.md's commit timestamp is the audit anchor; aggregator rows must postdate it. Same gate v5 P2/P2.1 honored — and the gate fired honestly in P2 (Δp@5 +10pp but Wilson lower -0.157 → KILL not BIND). v6 P9 inherits the discipline.
- **Reuse, don't reinvent.** Wilson/Newcombe CI lives in `src/benchmark/episodic-density/wilson.ts`. Aggregator schema lives in `multi-handle.{md,json}`. Harness shape lives in `src/benchmark/episodic-density/`. P9 builds on these primitives, not parallel to them.
- **Three-prong rubric narrows LLM-as-judge variance.** Each prong is binary; combination gives a graded-but-discrete signal. Single-prong free-text grading would inflate variance beyond what n=30 × 2 reps can absorb.
- **Real fixtures dominate; synthetic admixture is constrained.** ≥70% real per kind, ≤30% synthetic. claudex-v3's own deliberation history is the gold corpus — Phase 2 KILLs, Phase 5 drop, v5.0.0 silent-fail, Mem0-trap closure, Critical Reminders crystallization, V17 collapse cutover are concrete fixture-source candidates with rich transcripts ready to query in `transcript_chunk_v6` once backfill completes.
- **Backfill prerequisite:** P9 measurement runs require `bun run backfill:transcripts` to have completed at least once on this DB so `vec_transcript_chunks_v6` has fixture-anchor content. Status check: `transcript_chunk_v6` row count > 0 before the first replication. Likely satisfied in ordinary course (operator runs backfill during planning); planner verifies as a precondition.
- **Reranker fitness verdict drives B-arm:** P8's `bun run reranker:fitness` reports zero chunks at substrate-validation time per 08-04-SUMMARY (because backfill hadn't run yet). Re-run after backfill before P9 measurement. PASS (top-3 overlap ≥0.60) → BGE-v2-m3 baseline; FAIL → bi-encoder-only baseline. Either way is fine; the harness branches on the verdict and records the choice in the aggregator row.
- **Negative result is the deliverable, not the failure.** REQ ENG-04 + ROADMAP §17 gate 6. If P9 binds NEGATIVE, P10 documentation branch produces a Phase-2-shape KILL receipt and v6.0.0 ships substrate alone with the kill leading the annotation. That is a successful empirical-phase outcome. Framing a bind-negative as "P9 failed" is exactly the motivated-reasoning theater the methodology gate was promoted to prevent.

</specifics>

<deferred>
## Deferred Ideas

- **Citation density secondary signal.** Quantitative measure of primary-source quoted-phrase density vs paraphrase density. Listed as spec Q1 secondary candidate. Deferred to v6.x or v7+ as "measurement extension." Easy to compute (regex over response text against `transcript_chunk_v6` content) but easy to game (verbose quoting inflates density without engagement). Adds color, not binding signal.
- **Specificity contrast secondary signal.** A/B contrast: agent answers project-specific query with project context vs that context replaced by a different project's context. If answers don't meaningfully differ, agent was lazy. Deferred — novel methodology, requires distinctness metric definition + threshold pre-commitment, scope inflates.
- **Counterfactual capability probe class.** Spec Q1 fourth candidate: "what changes about decision X if condition Y were different?" Most ambitious, may not bind cleanly. Deferred to v7+ research direction or v6.x exploratory phase.
- **Reranker fine-tuning on conversation distribution.** BGE-v2-m3 trained on web/document corpora; if P8 fitness check (post-backfill) shows degradation, fine-tuning a conversation-distribution reranker is a v7+ research question. P9 baseline branches on the fitness verdict but does not address fitness itself.
- **Vesna deliberation-engagement probes.** 21→24+ probe extensions land in P10 engineering branch, NOT P9. Listed in deferred-here for cross-reference only — P10 engineering branch's plan-phase will pick these up if P9 binds positive.
- **Per-kind verdict ship gate.** Each of the 5 kinds gets a per-kind pass rate row in the aggregator (descriptive). Some operators may want to gate ship on per-kind binding (e.g., "must bind positive on at least 3 of 5 kinds"). Deferred — adds complexity without clear value at n=6 per kind. The pooled-across-kinds verdict is the gate.
- **Fixture refresh cadence on corpus growth.** If claudex-v3 history grows substantially post-v6 ship, P9 fixtures may become stale. Re-running P9 quarterly on a refreshed fixture set is operational practice, not a phase. Roadmap candidate: post-v6 operations practice.
- **Multi-judge ensemble grading.** Single-judge LLM-as-judge has known biases. Multi-judge (deepseek-coder-v2:16b + claude-sonnet-4-6 + manual spot-check) reduces variance. Deferred — additional cost, marginal variance reduction at three-prong rubric granularity.

</deferred>

---

*Phase: 09-empirical-measurement*
*Context gathered: 2026-05-08*
*Pre-commitment audit anchor: this commit's git timestamp must precede every row in `.planning/aggregates/deliberation-surfacing.{md,json}`.*
