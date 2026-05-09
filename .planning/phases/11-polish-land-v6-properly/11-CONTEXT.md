# Phase 11: Polish — land v6 properly - Context

**Gathered:** 2026-05-09
**Status:** Ready for planning

<domain>
## Phase Boundary

**v6 isn't being regressed — it's being landed.** Phase 11 is a hybrid engineering + empirical phase that closes v6.0.0 *once*, with whatever annotation the corrected methodology produces. Three sequential internal waves:

- **W1 — Code regressions (engineering):** Fix 12+ critical findings from Gemini reviews across routing (3), assembly (4), and ingestion (6). Update tests to assert visible failures (close the v5.0.1 silent-fail pattern that recurred). Production-shape integration test added to ship gates. Vesna preserved.
- **W2 — Methodology fix (engineering):** Replace harness B-arm with direct call to `routeFromArtifact`. Fix prong-2 metadata access. Replace pooling with paired-McNemar. Wire 4-judge ensemble across families. Audit P9 probes a/c for parametric-knowledge confound (document, do not rewrite). Bake external-review gate into auto-orchestrate + auto-execute-phase as a standalone plan in W2.
- **W3 — Re-bind + conditional ship (empirical OR documentation):** Strict-serial Q1→Q2→Q3 with early-fail short-circuit per the spec's pre-committed conditional outcomes table. Tag v6.0.0 (delete + retag) with corrected annotation reflecting the actual rebound verdict.

**Not in scope (deferred / new capabilities):** GPT-5/Codex judge addition (deferred to v6.x or v7+), additional cross-corpus sites beyond big-mozzy-v2 stretch lacuna-betting-9f1d552c, push of v6.0.0 (operator-confirmed at close-out only). Phase 11 does not push the tag.

</domain>

<locked_decisions>
## Locked Decisions (Carried Forward — NOT Re-Litigated)

The 6 decisions locked at `2026-05-09 morning` (audit trail at `.planning/audits/2026-05-09-v6-gemini-reviews/`, spec at `.planning/research/2026-05-09-v6-polish.md` commit `a9fa77e`) are non-negotiable. Re-stated here as load-bearing context:

1. **Phase numbering — Phase 11.** Continues v6 milestone arc.
2. **Cross-corpus — big-mozzy-v2 primary; lacuna-betting-9f1d552c stretch-goal.** Big-mozzy-v2 chosen for cross-domain shape difference (browser-automation / scraping) vs. claudex-v3 (memory/strategy).
3. **Judge ensemble — 4-judge with 3-of-4 majority.** Models: `gemini-3-flash-preview:cloud` (via Ollama paid cloud passthrough — NOT gemini-cli, which 429'd morning of 2026-05-09), Claude Opus 4.7 (OAuth, MAX subscription, no API charge), `glm-5.1:cloud`, `kimi-k2.6:cloud`. Pre-committed fallback: drop to 3-of-3 majority on any judge with >10% probe-error rate.
4. **v6.0.0 local tag — keep until polish completes, then delete + re-tag.** Never pushed during polish.
5. **Audit trail — committed at `.planning/audits/2026-05-09-v6-gemini-reviews/` (commit `a9fa77e`).**
6. **External review gate — mandatory default, baked into `/auto-orchestrate` and `auto-execute-phase`.** Skill modification lands as part of Phase 11 (W2, standalone plan — see Implementation Decisions below).

</locked_decisions>

<decisions>
## Implementation Decisions (Resolved 2026-05-09)

### W2 — Skill modification placement (Q1)
- **External-review gate skill edit ships as a standalone plan in W2** (separate from harness/judge methodology-fix plan).
- **Rationale:** Self-contained text/JSON skill edit; lands BEFORE W3 so the rebind itself dogfoods the gate; clean commit history; if the gate fires correctly during W3 close-out it's evidence the gate works, if it fails to fire when it should the bug is caught before going-forward use.
- **Scope of skill edit:** `/auto-orchestrate` and `auto-execute-phase` skills both gain a phase close-out hook that spawns external-reviewer pass (Gemini ensemble + Codex when available) before phase-complete declaration. Reviewer findings classify as: (a) signoff close-out, (b) block close-out on critical findings, or (c) log recommended findings without blocking.

### W3 — Sub-question sequencing (Q2)
- **Strict serial with early-fail short-circuit per the spec's pre-committed conditional outcomes table** (`.planning/research/2026-05-09-v6-polish.md` lines 88-99).
  - Q1 (paired-McNemar within-corpus, 30 locked probes) runs first.
  - Q1 INCONCLUSIVE or NEGATIVE → skip Q2/Q3, ship substrate-only + KILL receipt.
  - Q1 POSITIVE → run Q2 (60 fresh disjoint probes).
  - Q1 POSITIVE + Q2 INCONCLUSIVE → P11.1 corpus expansion phase (no tag).
  - Q1 POSITIVE + Q2 NEGATIVE → ship substrate-only + KILL receipt (original bind was probe-set-specific artifact).
  - Q1 POSITIVE + Q2 POSITIVE → run Q3 (cross-corpus on big-mozzy-v2).
  - Q1 + Q2 + Q3 outcomes determine final annotation per spec table.
- **Rationale:** Saves ~3-4 days of compute on early-fail. Pre-commit table is the early-fail logic — operationalizing the lock, not re-litigating.

### W2 — Original P9 fixture handling (Q3)
- **30 P9 probes stay byte-immutable for Q1 paired-McNemar** (preserves audit-trail continuity with original P9 measurement).
- **W2 fixture audit examines kinds a/c against parametric-knowledge confound finding (Gemini Harness #5) and DOCUMENTS what it finds in 11-RESULTS.md — but does NOT rewrite the original 30 probes.**
- **Q2 authors a fresh 60-probe disjoint pool** (30 per replication, no overlap with P9 locked set). Q2's probe-authoring criteria specifically AVOID the parametric-knowledge confound by design — locked in W2 plan.
- **Audit outcome handling:** If Q1 + Q2 both bind, the a/c parametric-knowledge finding becomes a methodology footnote in 11-RESULTS.md, not a fixture rewrite. If Q1 binds but Q2 doesn't, the a/c finding may be cited as one possible explanation in the KILL receipt. Either way: audit-trail integrity preserved + methodology-clean rebind both happen.
- **Rationale:** Q1's job is "do the original probes show a bind under fixed harness/stats?" — meaningful even if some probes are imperfect. Q2's job is "does a methodology-clean probe set bind?" — that's where the parametric-knowledge confound is structurally avoided.

### W1 — Test discipline (refined edge case)
- **W1 ships BOTH the test rewrites (assert visible failures) AND the test-discipline lint in the same wave.**
- **Rationale:** W1 already touches all the affected tests in the rewrite pass; adding the lint same-commit prevents the test-codification-of-bugs pattern from recurring during W2 (which itself introduces new test code for harness modifications). One cohesive W1 change.
- **Lint scope:** Mechanical scan for `expect(...).not.toThrow()` patterns on missing-dependency tests; flag for review. Make it visible, not perfect. Lint runs in CI alongside vitest.

### W1 — Vesna preservation gate (refined edge case)
- **Vesna ≥ 26/26 throughout W1, no regression.** ≥ not =.
- **Rationale:** W1 may add probes if a regression fix specifically calls for a behavioral assertion (e.g., a probe asserting `commitEffects` callback survives the assembly fix from Gemini Assembly Finding #1). Adding probes is fine; lowering count is a regression.
- **Forward implication:** W3 may push Vesna to 30+ if rebind-related probes land.

### Assembly fallback annotation (locked from spec)
- **Header annotation wording when `bi_encoder_budget_applied = true`: `## Deliberation Surfaced (low-confidence retrieval)`** (per spec line 46, addresses Gemini Assembly Finding #3).
- **Rationale:** The "(low-confidence retrieval)" suffix surfaces the cross-encoder/bi-encoder asymmetry to the consumer LLM so it can calibrate trust in the surfaced spans. When cross-encoder confirmed, the suffix is omitted.

### Claude's Discretion
- Specific `vitest` test file names for ingestion test rewrites — assume planner identifies via current test suite when authoring W1 plans.
- Specific commit message formats for W1 fixes — defer to GSD tooling defaults.
- Whether to bundle multiple W1 fixes into one commit or split per-finding — planner judges based on logical cohesion (e.g., all 6 ingestion fixes likely one commit; routing 1-line fixes likely one commit; assembly per-finding probably separate).
- Lint implementation language (TypeScript script, eslint rule, etc.) — planner picks based on existing CI shape.

</decisions>

<specifics>
## Specific References & Anchors

### Authoritative inputs (all read by discuss; load again at plan-phase time)
- **Spec:** `.planning/research/2026-05-09-v6-polish.md` (committed `a9fa77e`) — exhaustive 175-line polish spec with full must-fix table, 3-wave structure, pre-committed conditional outcomes table.
- **Audit trail:** `.planning/audits/2026-05-09-v6-gemini-reviews/` — 5 Gemini reviews (4 grade F + 1 B-), 5 prompts, README.md with finding-to-task index. `04-harness-REVIEW.md` is the verdict-invalidating review.
- **ROADMAP:** `.planning/ROADMAP.md` — Phase 11 entry under v6 section, hybrid engineering + empirical type.
- **STATE:** `.planning/STATE.md` — Phase 11 marked STARTED 2026-05-09.

### Code paths affected (W1 fixes)
- **Routing (3 findings, all in `transcript-routing.ts`):**
  - Null-body `.substring()` throw — `(artifact.query_text ?? rows[0].body ?? '').substring(...)` coalescing fix
  - Telemetry exception bypasses bi-encoder fallback — wrap `incrementRerankerFallbackCounter` in dedicated try/catch
  - Time-window sort truncation — change `ORDER BY turn_index ASC LIMIT 20` to `ORDER BY ABS(created_at_epoch_ms - ?) ASC` with artifact's creation timestamp
- **Assembly (4 findings, primarily in `deliberation-surface.ts` + assembler integration):**
  - `appendDeliberationSurfaceToPayload` drops `commitEffects?: () => void` — return `{ ...payload, content: newContent, ... }`
  - Async/sync bleed in `assembleFullContext` — make natively async (preferred) OR split sync/async paths
  - `bi_encoder_budget_applied` flag discarded — surface as header annotation per locked wording above
  - Token-budget greedy-pack ignores header + separator overhead — pre-deduct before pack loop
- **Ingestion (6 findings, primarily in `ingest-session.ts` + chunker + `upsertChunk`):**
  - `INSERT OR IGNORE` metadata vs unconditional vec0 rewrite — switch metadata to `INSERT ... ON CONFLICT DO UPDATE`
  - No session-level cleanup before re-ingest — `DELETE FROM transcript_chunk_v6 WHERE session_id = ?` before chunk loop OR `WHERE session_id = ? AND sub_index > ?` after with max-written
  - Empty-body chunks bypass vec DELETE — always run vec DELETE for rowid before empty-body skip
  - Missing JSONL silent-success — distinguish "no turns parsed" from "file did not exist"; emit explicit telemetry; set `result.errors = -1` sentinel; rewrite test to assert visible failure
  - `body.split(/(?<=[.!?])\s+/)` destroys formatting — format-preserving sub-chunker tracking offsets, slicing original `body` at sentence boundaries
  - Single-sentence chunks > 5000 tokens silent-fail — hard-cap sub-chunks at embedder's token limit; force-split on token boundary

### Code paths affected (W2 methodology fix)
- **Harness (5 findings, in P9 harness):**
  - `arm-transcript.ts:58-76` (B-arm dense KNN) — replace with direct call to `routeFromArtifact` from production
  - `arm-summary.ts:80,98` (A-arm metadata starvation) — give A-arm same metadata access OR remove prong-2 metadata-citation requirement
  - `verdict.ts:47-48` + `wilson.ts:74` (pseudoreplication via `poolReplications`) — replace with paired McNemar on 30-probe paired pass/fail patterns OR disjoint probe pools
  - Probe-a/c parametric-knowledge audit — document findings, do NOT rewrite (per Q3 decision above)
  - Judge=agent self-grading — 4-judge ensemble (locked decision #3)

### Empirical pre-commits (W3)
- Q1 within-corpus: r1 fresh seed, r2 fresh seed, locked 30-probe set, production routing, A-arm with metadata, 4-judge ensemble. Pass: McNemar exact p < 0.05 on paired pass/fail.
- Q2 disjoint-probe: 60 fresh probes (30 per replication, no overlap with P9 locked set). Pass: Wilson lower bound > 0 on pooled n=60.
- Q3 cross-corpus: big-mozzy-v2; 30-probe drift fixtures sampled from that corpus's history. Pass: Wilson lower bound > 0 on n=30 (or paired McNemar p < 0.05 if design used).

### Operational constraints
- **Reranker is load-bearing for production retrieval (RETR-08):** BGE-v2-m3 on port 7439 must be alive throughout W1 testing. Bi-encoder fallback is a degraded mode, not transparent default. W1's assembly-fallback annotation work depends on this.
- **GLM-5.1 is currently Angel's default LLM.** During W3 rebind window, GLM-5.1 is also a judge in the 4-judge ensemble — risk of Angel and rebind contending for the same cloud model. **Decision: defer to W3 execute-time** (operational, not architectural). W3 plan-phase + execute-phase are better positioned to know Angel's load at run-time. Options when W3 plans: (a) temporary swap Angel to a different cloud model (e.g., minimax-m2.7) for the W3 window and restore after, OR (b) idle scheduling — run rebind during a window where Angel is naturally idle (overnight, no active sessions). W3 picks based on actual load profile.
- **Codex unavailable until 2026-05-14** (usage limit). External-review gate skill should support Codex as optional/skippable when unavailable; Gemini ensemble is the primary path. Skill must NOT block phase close-out when Codex is unreachable — degrade to Gemini-only with telemetry.
- **Compute budget:** Spec line 106 estimates 3-6 days of unattended GPU/Ollama compute for the worst case (Q1 + Q2 + Q3 all running). Strict serial early-fail saves cost on early-fail paths.
- **Cross-corpus probe authoring (W3):** big-mozzy-v2 drift fixtures require user-pair authoring per spec line 108 ("orchestrator can't write drift fixtures for an unfamiliar domain alone"). W3 plan-phase should flag this as a checkpoint rather than autonomous-only.
- **Sanitized DB snapshot:** Production-shape integration tests need a sanitized snapshot of the live DB (PII/secret redaction pass) committed to `.planning/fixtures/`. W1 must produce this snapshot before integration tests can run.

### Methodology gates promoted from Phase 11 (carry forward to v6+)
1. **Production-shape integration tests** — every engineering phase ships an integration test against sanitized snapshot of actual production DB.
2. **Adversarial external review** — every engineering phase close-out includes external-reviewer signoff (the gate this phase bakes in).
3. **Tests must assert visible failures** — never `not.toThrow()` on missing-dependency tests. Lint enforced.
4. **Methodology critique pre-commit** — every empirical phase's CONTEXT.md includes a "what would invalidate this measurement" section.

</specifics>

<deferred>
## Deferred Ideas

None surfaced during discussion. Discussion stayed within Phase 11 scope (the 4 spec-flagged open questions + 3 edge cases). Items deferred by the spec itself (not new from discuss):

- **GPT-5 / Codex as judge in ensemble** — deferred to v6.x or v7+ per locked decision #3 (Codex usage-limited until 2026-05-14; not waiting).
- **Additional cross-corpus sites beyond big-mozzy-v2** — lacuna-betting-9f1d552c is stretch-goal if W3 budget permits, otherwise queued for v6.x cross-corpus expansion.
- **Push of v6.0.0** — operator-confirmed at close-out only; not part of Phase 11 autonomous scope. Push happens after phase-complete declaration with operator review of the corrected annotation.
- **P9 fixture rewrite** — explicitly NOT done in Phase 11 per Q3 decision. Original 30 probes byte-immutable. If future evidence shows the parametric-knowledge confound is the dominant signal in Q1, a future fixture-redesign phase may be queued. For now: documented in 11-RESULTS.md, not rewritten.

</deferred>

<methodology_critique>
## What Would Invalidate This Measurement (Pre-Commit Per Methodology Gate #4)

Forced methodology adversarialism — what could go wrong with W3's rebind even after all corrections:

1. **4-judge ensemble convergent bias.** Even across families (Google / Anthropic / Zhipu / Moonshot), all four judges are 2026-frontier LLMs trained on overlapping web data. If they share a "engagement looks like X" prior that doesn't match human ground-truth engagement, the ensemble overstates engagement quality without self-grading bias. **Mitigation:** Document that ensemble is "frontier-LLM-judge agreement" not "ground-truth." If user has bandwidth, hand-grade a 5-probe subset to spot-check ensemble vs. human agreement. Stretch-goal, not blocking.

2. **paired-McNemar power on n=30 probes.** McNemar requires sufficient discordant pairs to be powered. If most probes are concordant (both arms pass or both fail), McNemar p-values are unstable. **Mitigation:** Pre-commit minimum-discordant-pair threshold (e.g., need ≥5 discordant pairs to call result; if <5, INCONCLUSIVE regardless of p-value). Lock in W2 plan.

3. **big-mozzy-v2 corpus authoring quality.** Drift fixtures for an unfamiliar domain (browser automation / scraping) may inadvertently encode the orchestrator's misunderstanding of the domain rather than genuine engagement-distinguishing scenarios. **Mitigation:** User-pair authoring (spec line 108); reject Q3 fixtures the user can't validate as domain-honest. If user can't validate, Q3 is INCONCLUSIVE not BIND POSITIVE.

4. **Production routing changes between W1 and W3.** W1 fixes routing; W2's harness now calls `routeFromArtifact`. If W2 lands changes to routing during methodology-fix work, harness B-arm and production drift again. **Mitigation:** W1 freezes routing API surface; W2 only modifies harness wrappers. Lock routing-API-stable contract in W2 plan.

5. **Bi-encoder fallback prevalence in measurement window.** If reranker (port 7439) is unstable during W3 runs, many probes hit bi-encoder fallback and the measurement conflates retrieval-quality with engagement-quality. **Mitigation:** Pre-flight reranker health check before each Q1/Q2/Q3 run. If fallback rate >10% during a run, INCONCLUSIVE.

6. **3-of-4 majority drops to 3-of-3 fallback masks judge-disagreement signal.** If one judge errors on >10% of probes and the ensemble drops to 3-of-3, the measurement loses the 4-way disagreement signal that catches single-judge-bias outliers. **Mitigation:** Document fallback occurrence in 11-RESULTS.md with per-judge error rates. If >1 judge errors >10%, INCONCLUSIVE (don't drop to 2-of-2).

</methodology_critique>

---

*Phase: 11-polish-land-v6-properly*
*Context gathered: 2026-05-09*
*Discuss-phase agent: discuss-11 (auto-discuss-phase variant, autonomous mode)*
*4 open questions + 3 edge cases resolved with team-lead*
*Standing user directive: autonomous through milestone end — no AskUserQuestion gates*
