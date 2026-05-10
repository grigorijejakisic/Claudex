---
phase: 12
phase_name: real-v6-structural-marks
gathered: 2026-05-10
status: ready-for-planning
spec: .planning/research/2026-05-10-phase-12-real-v6-structural-marks.md
discussion_mode: skill-driven (auto-discuss-phase) with documented Claude's Discretion defaults
---

# Phase 12: Real v6 Structural Marks — Context

<domain>
## Phase Boundary

Phase 12 lands six structural marks derived from the v6 → v6-polish round-trip burn so the burn registers as durable behavior change rather than decoration. The marks are pre-classified A/B/C against `.planning/audits/2026-05-09-v6-gemini-reviews/`:

1. **Cross-family invocation pipeline** (foundation; consumed by items 2 and 3)
2. **(c) Methodology critique checkpoint** — `auto-plan-phase` skill addition; cross-family critique *before* pre-commitment
3. **(a) Cross-family adversarial test/fixture authoring** — `auto-plan-phase` skill addition; paired adversarial probes during the phase
4. **Vesna probe-suite polishing** — fix name-vs-implementation gaps on `lesson-application` (3 probes) and `deliberation-engagement` (5 probes)
5. **(b) Lightweight telemetry instrumentation** — hook-side signal recording, no verdict structure (verdict design deferred to v6.x/v7)
6. **(e) Mid-flight commit visibility** — PostToolUse hook + statusline + transcript-tail documentation

Phase 12 ships **once**, before public push, after Phase 11 W3 close-out and v6.0.0 retag. External-review-gate dogfoods on Phase 12 itself using the cross-family pipeline Plan 12-01 ships. Public push happens after Phase 12 close-out.

**Wave structure (locked by spec):**
- Wave 1 (1 plan): 12-01 cross-family pipeline (foundation)
- Wave 2 (3 plans, parallelizable): 12-02 methodology critique, 12-03 adversarial test authoring, 12-04 telemetry
- Wave 3 (2 plans, parallelizable with W2): 12-05 Vesna polish, 12-06 commit visibility
- 12-CLOSE: external-review-gate dogfood

**What is NOT changing in Phase 12** (per spec):
- The v6 thesis (deliberation surfacing on the parable substrate)
- Vesna's binary rubric for the 5 correctly-binary categories (entity-recall, constraint-recall, handoff-pickup, cross-project, self-instrumented)
- The W3 verdict (whatever Q1+Q2+Q3 produced gets retag-annotated *before* Phase 12 begins)
- Existing W2 external-review-gate (stays in place; Phase 12 *adds* upstream gates, doesn't replace post-hoc)
- The reranker as production path (BGE-v2-m3 on port 7439 stays load-bearing; bi-encoder fallback stays a degraded mode)

**Out of scope** (deferred to v6.x or v7 per spec):
- Pairwise Elo / actual-user-task-success replacing the binary rubric
- Telemetry verdict structure (Phase 12 collects signal only)
- Mid-flight CC harness features (e.g., live diff stream)
- Cross-AGENT validation on Claude as production agent

</domain>

<decisions>
## Implementation Decisions

All six gray areas were surfaced to team-lead during the discuss step. Team-lead did not return per-item answers within the discuss window; the next pipeline message (`task-list` routing) flagged Phase 12 plan step as next up. Per spec philosophy ("the discuss step exists to close the 'Specifics to lock' gaps the spec explicitly defers to planning"), all six items are documented here as **Claude's Discretion** with concrete defaults grounded in (a) the spec's anti-scope guidance, (b) the Phase 11 audit trail, and (c) project memory. The planner (gsd-planner / plan-12) may refine these during plan authorship; team-lead may override at any point and the planner re-renders.

### 1. Cross-family invocation pipeline (item 1, Plan 12-01)
- **First-class families:** Gemini-3-Flash (gemini-cli), Codex CLI, Claude Opus 4.7 via SDK. Same trio used as W2 ensemble in Phase 11 (`.planning/research/2026-05-09-v6-polish.md` W2 task list) — no reason to introduce a fourth family in foundation work; reuse the families that already have working invocation paths in `scripts/external-review-gate.cjs`. **Claude's Discretion:** GLM-5.1 and Kimi-K2.6 (Phase 11 W2 4-judge ensemble) are *judges* in the empirical harness, not first-class for the cross-family pipeline. If `gsd-phase-researcher` finds an invocation path already wired for them in the repo, the planner may promote them; otherwise stay at three.
- **Prompt-bounding discipline:** Hard cap on prompt size at family invocation surface (default 32K tokens; configurable per call site). Prompts must include (a) the artifact under critique, (b) a structured-rubric instruction block, (c) explicit response-format spec matching the BLOCK/FLAG/SIGNOFF schema. No conversational follow-ups in v1 — single-shot invocations only.
- **Structured-result schema:** BLOCK / FLAG / SIGNOFF, modeled on the existing `scripts/external-review-gate.cjs` classification (Phase 11 W2). Each verdict carries `severity`, `findings[]` (each with `category`, `summary`, `evidence`), and `recommendation`. Zod schema lives alongside the pipeline module so callers (items 2 and 3) get type-safe parsing.
- **Failure-mode handling:** Any one family unreachable → degrade gracefully with a `degraded_mode` field in the aggregate result; the gate that consumes the pipeline (item 2 or 3) decides whether degraded counts as block/pass per its own policy. **Anti-scope (from spec):** "this is not a multi-LLM consensus framework. It's a pipeline. Verdicts come from individual cross-family calls; aggregation logic lives in items 2 and 3." The pipeline returns N individual results; consumers aggregate.
- **CI test:** Pipeline integration test exercises each first-class family with a fixture prompt and asserts schema-conformant response. Network failures bypass the test deterministically (mock at the invocation boundary; real-family round-trips run on a separate manual-trigger CI lane to avoid flake).

### 2. Methodology critique checkpoint (item 2, Plan 12-02)
- **Trigger surface:** `auto-plan-phase` skill checks the phase's spec front-matter for `tags: [architecture | workflow | methodology]`. If any of those tags is present, the methodology-critique gate runs against the spec + the proposed pre-commitment metric/decision-rule *before* CONTEXT.md is committed. **Claude's Discretion:** Plan-frontmatter self-tag wins over auto-detection in v1 — auto-detection from phase content is too noisy and would block too many phases. The operator (team-lead) can also force the gate via `--methodology-critique` CLI flag.
- **Engineering-only opt-in:** Phases without those tags are exempt by default. Opt-in via the same `--methodology-critique` flag OR by adding the tag to the spec front-matter. Documented in the skill's help text.
- **What the gate critiques:** The methodology and decision rule, not the engineering. Specifically: (a) "is the harness measuring what production runs?" (Phase 11 W2 critique #1 against P9 harness — same code path), (b) "is the statistical method appropriate for the experimental design?" (Phase 11 W2 critique #4 — pseudoreplication), (c) "is the judge independent of the agent?" (Phase 11 W2 critique #6 — self-grading bias).
- **Verdict semantics:** BLOCK pre-commitment cannot lock until the planner addresses the finding (re-spec, re-rule, or rebut); FLAG records the concern in CONTEXT.md, planner annotates and proceeds; SIGNOFF locks pre-commitment.
- **CI:** Integration test against fixture phase plans drawn from Phase 11's known-bad set (the +0.0038 bind methodology) — gate must surface the harness/pseudoreplication/judge issues. Calibration probe set lives in `.planning/research/methodology-critique-fixtures/` (planner creates).

### 3. Cross-family adversarial test/fixture authoring (item 3, Plan 12-03)
- **Storage convention:** Adversarial probes live in `__tests__/adversarial/` mirroring the same-family test structure (e.g., `src/foo/foo.test.ts` paired with `__tests__/adversarial/foo.adversarial.test.ts`). **Claude's Discretion:** Separate file (not commingled) — keeps the audit trail for which probes came from which family clean, and lets CI lanes run them stratified if needed later.
- **CI integration:** Both layers run on every PR; both must pass for ship gates. Same severity as Vesna failures (per spec's WIR-02 phase coupling parable: structural countermeasures get top-tier gating, not soft warnings).
- **What "adversarial" means concretely:** The cross-family agent receives the production-path code under test, the same-family test file, and a prompt block of the shape: *"Read this code and these tests. The same-family agent (Claude) wrote both. List 3-5 failure modes you would test for that Claude would not have thought to test for, given how this code is shaped. Output: probe titles + test bodies in the project's vitest dialect."* The framing surfaces convergent-blind-spot bugs (the v5.0.1 silent-fail pattern).
- **Trigger condition:** Same as item 2 — phases tagged `architecture` / `workflow` / `methodology` get adversarial probes authored during the phase. Engineering-only phases default-exempt with `--adversarial-tests` opt-in.
- **Anti-scope (from spec):** "This is not a replacement for same-family tests. It's a paired addition. Both layers of probes run; both must pass."

### 4. Vesna probe-suite polishing (item 4, Plan 12-05)
- **`deliberation-engagement` (5 probes):** Apply BOTH actions per spec:
  - **(a) Rename** the existing 5 probes' category to `deliberation-pipeline-fanout` to match what the regex actually tests (`## Deliberation Surfaced` markdown emitted by the assembly pipeline). Update Vesna config + per-category gate registry.
  - **(b) Author NEW probes** under a new `deliberation-agent-engagement` category that test what the original name promised — the agent's response demonstrating engagement with surfaced context. **Claude's Discretion on probe content:** target ≥3 probes that fail when the agent restates a summary verbatim and pass when the agent (i) cites a specific transcript span by `session_id`+`turn_index`, OR (ii) surfaces a divergence between the surfaced span and current state, OR (iii) names a constraint that only appears in the verbatim transcript (not the summary). Each probe is binary (per-category gate ≥80% per spec close-out criterion).
- **`lesson-application` (3 probes):** Audit each probe's regex first.
  - If the regex is purely citation-language (e.g., `lesson|prior|experience` token match): rename category to `entity-recall` and merge with the existing `entity-recall` category (which is correctly binary per memory `project_v6_polish_residual_concerns.md`).
  - If the regex tests *directional application* (e.g., "agent applies the lesson's prescription to current input"): rename to `lesson-directional-application` and keep separate. **Claude's Discretion:** Rewrite path is preferred when the original probe intent was clearly about application — but only if the rewrite produces a binary-rubric-honest test. If the test would need pairwise-Elo to grade fairly, that's enrichment work and belongs in v7 per spec out-of-scope.
- **The other 5 categories untouched** (entity-recall, constraint-recall, handoff-pickup, cross-project, self-instrumented) — confirmed correctly binary by 2026-05-10 audit (memory: `project_v6_polish_residual_concerns.md`).
- **Per-category gate stays at ≥80%** (spec close-out criterion). Polishing must not break aggregate or any per-category gate.

### 5. Lightweight telemetry instrumentation (item 5, Plan 12-04)
- **Signals shipping in v1:** Three from the candidate set; the rest deferred to v6.x/v7 verdict design.
  - `agent_reread_after_surface` — fires when the agent reads a file within N turns after that file was surfaced via memory injection. Detects "agent re-reads what memory should have surfaced." (Highest signal for the parable: did the surfacing actually engage?)
  - `retrieval_fallback` — already partially implemented per CLAUDE.md (the `reranker_fallback` row pattern). Phase 12 extends to capture *every* fallback (bi-encoder used because cross-encoder unavailable, FTS used because vec0 empty, etc.) with `event_kind` and `detail.reason`.
  - `transcript_injection_acceptance` — fires when an L2.5 transcript-span injection lands in the assembly window AND the next agent turn's response references the span (regex match on `session_id`+`turn_index` citation OR exact-substring match on the span content). Distinguishes "surfaced and used" from "surfaced and ignored."
- **Deferred (not shipping in v1):** `hook_firing_rates_by_event_type` (interesting but volume-heavy; better as a separate dashboard pass once we have data shape from the three above).
- **Storage:** Existing `telemetry` table per CLAUDE.md. **Claude's Discretion:** Schema additions only if the three signals require columns the existing schema doesn't provide. The planner verifies during plan authorship by reading the V32 schema; if `event_kind` + `detail` JSON column suffice, no migration needed. If a column is needed, V33 migration with the same idempotent shape-agnostic discipline (V31/v5.0.1 lesson) applies.
- **Volume bounds:** Cap retention at 30 days for telemetry rows by default; cap row count to 100K (delete oldest first when threshold breached). Same defaults the existing `telemetry` table uses; Phase 12 doesn't change the policy. **Claude's Discretion:** If the existing table has different defaults, planner adopts those — this is a "match what's there" decision, not a green-field one.
- **Anti-scope (from spec):** "no verdict structure, no automated decision-making from telemetry. Phase 12 ships the signal collection only. Verdict design happens with real data in hand, not in advance."

### 6. Mid-flight commit visibility (item 6, Plan 12-06)
- **Sidecar location:** `~/.claudex/.last-commit.txt` — global per-machine (matches the spec's suggested path; the operator works across multiple projects from one machine and a global sidecar is what the statusline can read uniformly). **Claude's Discretion:** If the operator's setup turns out to need per-project, the planner may relocate to `<repo>/.claudex/.last-commit.txt` — but global is the v1 default.
- **PostToolUse hook script:** Matches `Bash` tool invocations where the command starts with `git commit` (regex `^git\s+commit\b`). On match, runs `git log -1 --format='%H %s'` in the cwd and overwrites the sidecar. Atomic write (write to `.tmp`, rename) to avoid statusline reading mid-write garbage.
- **Statusline `refreshInterval`:** 2000ms. Fast enough to surface a fresh commit within ~2s of `git commit` returning; slow enough that the statusline isn't pegged on `git log` invocations. **Claude's Discretion:** Operator may tune; 2s is the v1 default.
- **`git log -4 --oneline` depth:** HEAD~3 (4 commits total: HEAD, HEAD~1, HEAD~2, HEAD~3). Statusline displays the latest commit's subject line + a count of commits ahead of upstream. The 4-commit cache is the lookback window; the statusline shows 1 line.
- **Transcript-tail documentation:** A short operator-facing markdown doc in `docs/operator/mid-flight-visibility.md` (planner creates). Documents `tail -f ~/.claude/projects/<project>/<session-id>.jsonl` workflow, plus PowerShell equivalent (`Get-Content -Wait`) for Windows-default operators.
- **Zero leaked-source dependency** (per spec): all three mechanisms (PostToolUse hook, statusline refresh, transcript tail) are documented APIs.

### Claude's Discretion — summary

All six items have documented defaults above; the planner is empowered to refine during plan authorship if `gsd-phase-researcher` surfaces a contradiction with the codebase (e.g., the existing `telemetry` table schema, the existing statusline implementation, etc.). Defaults that "match what's already there" win over green-field choices to honor the project's `## Reference Docs` discipline.

</decisions>

<specifics>
## Specific Ideas

- **Reuse Phase 11 W2 invocation paths.** The cross-family pipeline (item 1) should not invent new invocation surfaces — `scripts/external-review-gate.cjs` already wires Gemini CLI / Codex CLI / Claude SDK for Phase 11 close-out review. Plan 12-01 should refactor that into a shared module the gate continues to consume, plus items 2 and 3.
- **Methodology-critique fixtures from Phase 11's known-bad set.** Item 2's CI test wants regression coverage against the +0.0038 bind methodology that Phase 11 W2 audited. The harness B-arm KNN ≠ production routing finding, the prong-2 metadata-starvation finding, and the pseudoreplication finding are all candidate fixtures.
- **Adversarial test framing — explicit, not implicit.** Item 3 needs the cross-family agent to *know* it's hunting for what the same-family agent missed. The prompt template should reference the v5.0.1 silent-fail recurrence as the canonical failure mode.
- **Vesna polish must preserve aggregate gate.** The `bun run vesna ≥80% aggregate` close-out criterion means renames + new probes can't drop the aggregate. Planner should compute the new aggregate against polished probe set before plan close.
- **Telemetry schema reuse.** The `reranker_fallback` event_kind already exists per CLAUDE.md. Item 5's `retrieval_fallback` is a generalization — same column shape, broader coverage. Plan 12-04 should not introduce a parallel telemetry table.
- **Statusline + sidecar pattern is platform-aware.** Windows operator (per env metadata) — sidecar path uses `$env:USERPROFILE` resolution in the hook, statusline reads the same. Cross-platform default `~/.claudex/.last-commit.txt` resolves correctly under both shells via standard tilde expansion.

</specifics>

<deferred>
## Deferred Ideas

These came up in spec review but are explicitly out-of-scope per the spec's "Out of scope — deferred to v6.x or v7" section:

- **Pairwise Elo / actual-user-task-success replacing the binary rubric.** Memory `project_v6_polish_residual_concerns.md` confirms: most of Vesna is correctly binary. Pairwise Elo would be enrichment for genuinely qualitative behaviors. v7 design.
- **Telemetry verdict structure.** Phase 12 collects signal; v6.x decides what counts as "telemetry says v6 worked" once data is in hand.
- **Mid-flight CC harness features (e.g., live diff stream).** Documented APIs cover the use case at high fidelity. If Anthropic ships native observer-mode in CC, integrate then. Until then: separate Anthropic-feedback note (out of repo scope).
- **Cross-AGENT validation on Claude as production agent.** Phase 11 W3 ensemble is deepseek-judged-by-cross-family. Production usage runs Claude. v7 work, gated on Claude API quota allowing extended runs.
- **External-review-gate calibration probe set** (residual concern #3 from `project_v6_polish_residual_concerns.md`). Item 2's methodology-critique fixtures partially address this, but a dedicated calibration set for the W2 gate's classification logic (critical→BLOCK / high→LOG / else SIGNOFF false-negatives) is v6.x or v7 work.
- **GLM-5.1 / Kimi-K2.6 as first-class cross-family pipeline members.** Phase 11 W2 used them as judges; Phase 12 v1 stays at the trio that already has invocation paths. Promotion is a future v6.x decision if dogfood reveals trio insufficient.
- **Auto-detection of `architecture`/`workflow`/`methodology` tags from phase content.** v1 uses operator-set tags; auto-detection is v7 if the operator-set discipline proves too easy to forget.

</deferred>

<methodology_gates>
## Methodology Gates Carried Forward

Per ROADMAP `Methodology gates promoted from v5 (mandatory for every v6 phase)` — Phase 12 inherits and applies:

1. **Pre-committed decision rule** — Phase 12 has none in the empirical sense (it's engineering, not empirical). The pre-commitment is the close-out criteria locked in the spec. **No goalpost shifts** — if Vesna polish (item 4) drops the aggregate below 80%, item 4 reverts; the criterion does not relax.
2. **Locked corpus and harness across replications** — N/A for engineering phase, except: Vesna probe set is a corpus, and the polished probe set must be locked before close-out so the per-category gate isn't manipulated by adding/removing probes.
3. **Multiple bound measurements before milestone-level claims** — N/A for engineering phase.
4. **Wilson/Newcombe CI binding** — N/A for engineering phase.
5. **Live-wiring smoke against every production DB shape currently in the wild (WIR-01 inheritance)** — Item 5 (telemetry) potentially adds telemetry-table writes; if so, V33 migration must run on V32-shape (current production) and any V17-collapsed remnants. Plan 12-04 must declare WIR-01 coverage explicitly.
6. **Negative results are valid outputs** — applicable to 12-CLOSE: if external-review-gate dogfood produces BLOCK and the operator addresses, that's the close-out path; if BLOCK and operator acknowledges-without-fix, that's a documented LOG (not a silent SIGNOFF).

</methodology_gates>

<pre_committed_close_out>
## Pre-committed Close-out (from spec)

Phase 12 is **DONE** when:
- All 6 plan SUMMARYs on disk (12-01 through 12-06)
- `bun run build` exits 0
- `bun run vesna` ≥80% aggregate AND ≥80% per non-empty non-buffer category (gated on the polished probe set, not the pre-polish set)
- `bun run test` (full suite) — no new regressions vs. Phase 11 baseline (3748 passes / 27 v4-debt failures / 8 skipped)
- Cross-family invocation pipeline integration test passes (each first-class family round-trips a structured BLOCK/FLAG/SIGNOFF response)
- Telemetry instrumentation emits at least one signal type when a CC session runs against the modified hooks
- Mid-flight commit visibility scripts are operator-runnable; sidecar file updates on `git commit`; statusline reads correctly
- 12-CLOSE external-review-gate dogfood produces SIGNOFF (or LOG with operator acknowledgment)
- STATE.md / ROADMAP.md / REQUIREMENTS.md updated to reflect Phase 12 close

Phase 12 is **NOT** done if:
- External-review-gate dogfood produces BLOCK and the operator has not addressed the finding
- Any plan SUMMARY missing
- Vesna polish breaks the aggregate or any per-category gate

</pre_committed_close_out>

---

*Phase: 12-real-v6-structural-marks*
*Context gathered: 2026-05-10*
*Discuss method: skill-driven via auto-discuss-phase; six gray areas surfaced to team-lead, documented as Claude's Discretion with concrete defaults grounded in spec + Phase 11 audit trail + memory*
*Spec: `.planning/research/2026-05-10-phase-12-real-v6-structural-marks.md`*
