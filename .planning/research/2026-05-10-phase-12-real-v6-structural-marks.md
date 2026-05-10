# Phase 12 — Real v6: Structural Marks From the Polish Burn

> **v6 is good. Phase 12 makes its marks load-bearing.** The v6→v6-polish round-trip was the burn. Phase 11 closed the surface findings. Phase 12 lands the structural marks that round-trip produced — so the burn registers as durable behavior change, not as decoration.
>
> Status: pre-milestone spec (2026-05-10). Reviewable artifact. Begins after Phase 11 W3 close-out + v6.0.0 retag, lands before public push.

## TL;DR

Phase 11 polish closed the **surface findings** from the v6.0.0 Gemini consultation (13+ code regressions, 3 verdict-invalidating methodology defects). It did not close the **meta-finding**: that the orchestrator + same-family teammate flow has convergent blind spots, and that synthetic-probe ship gates don't validate real-task behavior.

Phase 12 lands six structural marks derived from that meta-finding, classified A/B/C against the audit trail at `.planning/audits/2026-05-09-v6-gemini-reviews/`:

- **C-class fix** (~10 of ~24 audit findings, the verdict-invalidating ones): cross-family methodology critique *before* pre-commitment, not post-hoc review.
- **B-class fix** (~7 findings, the v5.0.1 silent-fail recurrence): cross-family adversarial test/fixture authoring *during* the phase, not just review at the end.
- **Measurement-honesty fix** (Vesna name-vs-implementation gap on 2 categories): rename + new probes that test what the original category names promised.
- **Production-validation fix** (the "synthetic probes ≠ real tasks" gap): lightweight telemetry instrumentation collecting real-use signal during the 2-week post-push window.
- **Mid-flight visibility fix** (the gap external review caught post-hoc that real-time visibility could have caught earlier): documented-API path via PostToolUse hook + statusline + transcript tail.
- **Foundation**: cross-family invocation pipeline that two of the above consume.

**Phase 12 ships once, before public push, after Phase 11 W3 close-out and v6.0.0 retag.** External-review-gate dogfoods on Phase 12 itself (using the cross-family pipeline Phase 12 ships). Public push happens after Phase 12 close-out.

This is *completing* the v6 burn-response. v7 design questions (pairwise Elo, telemetry verdict structure, real-task-success measurement framework) remain deferred. Phase 12 is the last step before publishing v6 with its marks visible.

## Why this is Phase 12, not v7

The v6 → v6-polish round-trip was a real burn. The parable answer is that burns must register as durable marks, and the marks must be visible in the artifact for the burn to count. Phase 11 patched the engineering surface but didn't operationalize the meta-lessons. Shipping v6 publicly with Phase 11's surface fixes alone would mean:

- The engineering bugs are fixed, but the *pattern that produced them* (same-family blind spots) has no structural countermeasure.
- The methodology is corrected, but the *pattern that lets bad methodology survive pre-commitment* (no cross-family critique) has no structural countermeasure.
- The "trust the burn" framing has no observation surface — without telemetry, real-use signal can't validate or invalidate the synthetic-probe verdict.
- The mid-flight observability gap that gave Gemini a 15-minute advantage over the entire autonomous pipeline has no fix at all.

**Phase 12 makes the marks load-bearing.** Without it, v6 ships as a milestone where lessons were *recognized* but not *operationalized* — exactly the failure mode (`feedback_max_subscription.md`-style) the user has flagged repeatedly.

## Audit-trail classification (the empirical basis for scope)

The 2026-05-09 Gemini consultation produced ~24 critical findings across five reviews. Classifying each by what would have caught it:

| Class | Count | What would have caught it | Phase 12 response |
|---|---|---|---|
| **A** — same-family thorough testing would catch | ~7 | Existing W1 lint scanner + W2 external-review-gate (already shipped) | None — already covered |
| **B** — test-authorship structural blind spots (v5.0.1 pattern recurring) | ~7 | Cross-family agent authoring the *test set itself*, not just reviewing it | **(a) Cross-family adversarial test/fixture authoring** |
| **C** — methodology/architecture choices a different family wouldn't make | ~10 | Cross-family critique of the methodology *before* pre-commitment, not post-hoc | **(c) Methodology critique checkpoint** |

C-class findings are what overturned the +0.0038 bind. B-class findings are what made v5.0.1's silent-fail lesson recur in v6 ingestion. Both classes need structural countermeasures the post-hoc external-review-gate (W2) doesn't provide, because by the time the gate runs the engineering work is done and the cost-of-redo is the entire phase.

## Scope — the six marks

### 1. Cross-family invocation pipeline (foundation)

A node-side primitive that calls Gemini CLI / Codex CLI / Claude-via-SDK with bounded prompts and structured-result parsing. Shared foundation; consumed by items 2 and 3.

**Why this is foundation, not a separate item:** items 2 and 3 share the cross-family invocation surface; building it once and reusing it is the marginal-cost argument that turned α into β during the discussion (see `feedback_surface_in_weak_areas_under_autonomy.md` for the conversation-internal mark).

**Specifics to lock:** which families are first-class (Gemini Flash, Codex, Claude Opus via SDK), prompt-bounding discipline, structured-result schema (BLOCK/FLAG/SIGNOFF analogous to external-review-gate), failure-mode handling (any one family unreachable → degrade gracefully, don't block the phase).

**Anti-scope:** this is not a multi-LLM consensus framework. It's a pipeline. Verdicts come from individual cross-family calls; aggregation logic lives in items 2 and 3.

### 2. (c) Methodology critique checkpoint

`auto-plan-phase` skill addition. Phases that touch architecture / workflow / methodology require a cross-family critique pass *against the methodology* before pre-commitment locks the metric and the decision rule.

**Why C-class:** the +0.0038 bind would have been pre-empted at design time if a different family had argued against:
- Harness #1 (B-arm KNN ≠ production routing): "you're measuring a different code path than what ships."
- Harness #4 (pseudoreplication): "you can't pool r1+r2 as n=60; same probes with different seeds aren't independent."
- Harness #6 (judge=agent): "self-grading bias is documented; use a different family as judge."

These were design errors, not implementation errors. Catching them at the gate (post-hoc) means redoing the entire phase; catching them at plan-time prevents the phase from being built around the broken methodology in the first place.

**Verdict structure:** BLOCK (methodology critique surfaces a verdict-invalidating concern) / FLAG (concern noted, plan annotates and proceeds) / SIGNOFF (no concerns).

**Trigger condition:** phases tagged `architecture` / `workflow` / `methodology` in plan frontmatter. Engineering-only phases (e.g., a routing-bug-fix phase) are exempt by default but can opt in.

### 3. (a) Cross-family adversarial test/fixture authoring

`auto-plan-phase` skill addition. Test/fixture authoring tasks in flagged phases get paired adversarial probes from a different family, authored *during* the phase. Probes are stored alongside same-family tests; both run in CI.

**Why B-class:** the v5.0.1 silent-fail pattern recurred in v6 ingestion because same-family teammates wrote both the silent-failure code AND the tests that asserted "should not throw" on the silent-failure path. Cross-family review post-hoc can flag the test set as wrong, but it can't *produce a different test set*. Only authorship can.

**Specifics to lock:** how cross-family probes are stored (separate file or commingled with same-family tests), CI integration (both run on every PR or stratified), what "adversarial" means concretely (probes the same-family agent wouldn't have thought to write — flagged via a structured prompt).

**Anti-scope:** this is not a replacement for same-family tests. It's a paired addition. Both layers of probes run; both must pass.

### 4. Vesna probe-suite polishing

Standalone — does not depend on cross-family pipeline. Two specific probe categories have name-vs-implementation gaps confirmed by 2026-05-10 probe audit:

- **`lesson-application` (3 probes):** README's discriminator note acknowledges the test is borderline-equivalent to entity-recall. Audit each of the 3 shipped probes; rename to `entity-recall` if the regex is purely citation-language, or rewrite the regex to test directional application (not just citation).
- **`deliberation-engagement` (5 probes):** name reads "agent engagement"; implementation tests for `## Deliberation Surfaced` markdown emitted by the assembly pipeline (pipeline fan-out, not agent behavior). Two valid responses: (a) rename category to `deliberation-pipeline-fanout` to match what the regex tests, plus (b) author *new* probes under a `deliberation-agent-engagement` category that test what the original name promised — agent's response demonstrating engagement with surfaced context, not just pipeline injection.

**The other 5 categories (entity-recall, constraint-recall, handoff-pickup, cross-project, self-instrumented) are correctly binary; do not touch.** Discussion 2 close-out memorialized in `project_v6_polish_residual_concerns.md`.

### 5. (b) Lightweight telemetry instrumentation

Hook-side observation surface that records real-task signals without verdict structure. Verdict design deferred to v6.x or v7.

**Why this is in Phase 12 and not v6.x:** the parable answer requires a "touch the stove" mechanism. Without telemetry instrumentation lighting up at public push, the 2-week post-push window passes with no signal accumulation, and the marks Phase 12 ships are decorative — they declare we'll learn from real use without actually collecting the data to learn from. Including instrumentation in Phase 12 is the difference between "we promise to listen" and "we are listening."

**Specifics to lock:** which signals (candidate set: agent re-reads a file the memory should have surfaced, retrieval-fallback events, hook-firing rates by event type, transcript-injection acceptance rates), where they're stored (telemetry table already exists per CLAUDE.md), volume bounds (cap retention, cap row count to avoid DB bloat).

**Anti-scope:** no verdict structure, no automated decision-making from telemetry. Phase 12 ships the signal collection only. Verdict design happens with real data in hand, not in advance.

### 6. (e) Mid-flight commit visibility

Three documented-API mechanisms compose into complete coverage (per 2026-05-10 research):

- **PostToolUse hook on Bash matching `git commit *`** writes `git log -1 --format='%H %s'` to a sidecar file (e.g., `~/.claudex/.last-commit.txt`).
- **Statusline with `refreshInterval`** caches `git log -4 --oneline` and surfaces HEAD~3 in the operator's CC bar.
- **Transcript tail** (`tail -f ~/.claude/projects/<project>/<session-id>.jsonl`) for full Bash output on demand.

**Implementation size:** ~100 lines total. One hook script, one statusline script, documentation for the transcript-tail workflow.

**Zero leaked-source dependency.** Documented APIs cover the use case fully.

## Lines we hold (leaked CC source)

The 2026-03-31 leak put CC source code in the wild. Phase 12 work will *not* require touching it — item 6 (the only one where the question even came up) is buildable from documented APIs. As a standing constraint regardless of phase:

- **Will not redistribute** leaked source — copying chunks into the repo, mirroring it, etc.
- **Will not modify CC and ship a fork** — clean-room rewrites are legally distinct artifacts and not in Phase 12 scope.
- **Will reference leaked source** for legitimate interoperability work *if* documented APIs fall short — same shape as reading any docs or observing external behavior.

For Phase 12 specifically, the second clause is dormant: documented APIs cover everything. The lines are written down for future cases.

## Wave structure

**Wave 1 — Foundation (≈1 plan)**
- Plan 12-01: Cross-family invocation pipeline (item 1). Includes prompt-bounding, schema, failure-mode handling. CI test that exercises each first-class family.

**Wave 2 — Gates and observation (≈3 plans, parallelizable)**
- Plan 12-02: Methodology critique checkpoint (item 2). `auto-plan-phase` skill modification + integration tests against fixture phase plans.
- Plan 12-03: Cross-family adversarial test/fixture authoring (item 3). `auto-plan-phase` skill modification + storage convention + CI integration.
- Plan 12-04: Lightweight telemetry instrumentation (item 5). Hook-side signal recording + telemetry-table schema additions if needed.

**Wave 3 — Standalone polish (≈2 plans, parallelizable with Wave 2)**
- Plan 12-05: Vesna probe-suite polishing (item 4). Audit + rename + new probes. Per-category gate stays at ≥80%.
- Plan 12-06: Mid-flight commit visibility (item 6). PostToolUse hook script + statusline script + operator-facing documentation.

**Close-out**
- 12-CLOSE: External-review-gate dogfood on Phase 12 itself, using the cross-family pipeline Plan 12-01 ships. If the gate flags a critical finding, address before public push.

## Pre-committed close-out

Phase 12 is **DONE** when:

- All 6 plan SUMMARYs on disk (12-01 through 12-06).
- `bun run build` exits 0.
- `bun run vesna` ≥80% aggregate AND ≥80% per non-empty non-buffer category (gated on the polished probe set, not the pre-polish set).
- `bun run test` (full suite) — no new regressions vs. Phase 11 baseline (3748 passes / 27 v4-debt failures / 8 skipped).
- Cross-family invocation pipeline integration test passes (each first-class family round-trips a structured BLOCK/FLAG/SIGNOFF response).
- Telemetry instrumentation emits at least one signal type when a CC session runs against the modified hooks.
- Mid-flight commit visibility scripts are operator-runnable; sidecar file updates on `git commit`; statusline reads correctly.
- 12-CLOSE external-review-gate dogfood produces SIGNOFF (or LOG with operator acknowledgment).
- STATE.md / ROADMAP.md / REQUIREMENTS.md updated to reflect Phase 12 close.

Phase 12 is **NOT** done if:
- External-review-gate dogfood produces BLOCK and the operator has not addressed the finding.
- Any plan SUMMARY missing.
- Vesna polish breaks the aggregate or any per-category gate.

## What is NOT changing in Phase 12

- **The v6 thesis** — deliberation surfacing on the parable substrate. Unchanged from Phase 11 close-out.
- **Vesna's binary rubric for the 5 correctly-binary categories** — entity-recall, constraint-recall, handoff-pickup, cross-project, self-instrumented stay as they are. Discussion 2 close-out: most of Vesna is measuring the right thing in the right way.
- **The W3 verdict** — whatever Q1+Q2+Q3 produced gets retag-annotated before Phase 12 begins. Phase 12 doesn't re-litigate the empirical bind.
- **Existing W2 external-review-gate** — stays in place. Phase 12 *adds* upstream gates (methodology critique, adversarial test authoring); it does not replace the post-hoc gate.
- **The reranker as production path** — BGE-v2-m3 on port 7439 stays load-bearing. Bi-encoder fallback stays a degraded mode.

## Out of scope — deferred to v6.x or v7

These are real, named, and explicitly *not* in Phase 12:

- **Pairwise Elo / actual-user-task-success replacing the binary rubric.** Discussion 2 confirmed: most of Vesna is correctly binary. Pairwise Elo would be enrichment for genuinely qualitative behaviors, not a Vesna replacement. v7 design.
- **Telemetry verdict structure.** Phase 12 collects signal; Phase 12 does not decide what counts as "telemetry says v6 worked." Verdict design happens with data in hand. v6.x.
- **Mid-flight CC harness features (e.g., live diff stream).** Documented APIs cover the operator's use case at high fidelity. If Anthropic ships a native observer-mode in CC, we'd integrate then. Until then: separate Anthropic-feedback note (out of repo scope).
- **Cross-AGENT validation on Claude as production agent.** W3 ensemble is deepseek-judged-by-cross-family. Production usage runs Claude. Rebinding under Claude as agent is v7 work, gated on Claude API quota allowing extended runs. Captured in `project_v6_polish_residual_concerns.md`.

## Sequencing into the larger arc

Operator-runnable order:

1. Phase 11 W3 close-out (handoff `context/handoffs/ACTIVE.md` 11-step sequence, ending at step 9 "Update STATE/ROADMAP after retag").
2. v6.0.0 local tag retagged with W3 verdict's annotation (handoff step 8 — checkpoint:human).
3. Phase 12 begins (this spec scaffolds into `.planning/phases/12-real-v6-structural-marks/` via `/gsd:plan-phase` or equivalent).
4. Phase 12 close-out (12-CLOSE external-review-gate dogfood).
5. STATE.md / ROADMAP.md / REQUIREMENTS.md flipped to v6 milestone COMPLETE.
6. Public push (operator-confirmed; same posture as v5.0.0).

The handoff at `context/handoffs/ACTIVE.md` will need updating after Phase 11 close-out to point at this Phase 12 spec.

## Audit trail and provenance

This spec was produced by a discussion on 2026-05-10 between operator and orchestrator that:

- Started from the operator's articulated dissatisfaction with the v6 polish round being mechanical-fix-only.
- Walked the parable framing (`feedback_surface_in_weak_areas_under_autonomy.md`, `project_quality_variance_across_projects.md`).
- Resolved the measurement-framework discussion as polishing (`project_v6_polish_residual_concerns.md` updated 2026-05-10) — Vesna's binary rubric is correct for 5/7 categories.
- Resolved the test/gate authoring discussion as β (build both (a) and (c), shared pipeline) after the operator pushed back on an initial α lean that was anchored on independent-cost framing.
- Resolved the leaked-CC-source question via the lines documented above.
- Confirmed telemetry **in** for Phase 12 because the parable answer requires a touch-the-stove mechanism active during the 2-week post-push window.

Memories materialized during this discussion:
- `feedback_surface_in_weak_areas_under_autonomy.md` (updated: clean-looking analysis is one of the disguises lock takes)
- `project_quality_variance_across_projects.md` (training volume confirmed; angel cross-project promotion = "million dollar question")
- `feedback_leaked_cc_source_positional_decline_was_thin.md` (the lines, not the broad positional decline)
- `project_v6_polish_residual_concerns.md` (concern 4 narrowed: polishing, not rework)
