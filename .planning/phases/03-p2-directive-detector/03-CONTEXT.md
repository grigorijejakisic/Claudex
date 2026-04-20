# Phase 3: P2 — Directive detector — Context

**Gathered:** 2026-04-20
**Status:** Ready for planning
**Requirements covered:** EXTR-01, EXTR-02, EXTR-03, EXTR-04

<domain>
## Phase Boundary

Detect user directives in completed session transcripts and write them as `artifact(kind='directive_rule', scope=...)`. Detector runs in Angel extraction phase (post-session-close), before the generic ingester. **No injection-path changes in this phase.** Rules just accumulate; lifecycle (supersession, decay, contradiction resolution) is P8's job.

Success criteria (from ROADMAP §3):
1. `src/intelligence/directive-detector.ts` runs regex pass for emphasis signals then LLM confirmation at threshold ≥0.7
2. Confirmed directives written as `artifact(kind='directive_rule', scope=...)` with LLM-classified scope
3. Detector runs in Angel extraction phase before generic ingester; no injection-path changes
4. Joint precision ≥90% measured against fixture sessions; starting threshold tuned during calibration
5. No benchmark regression; 2020 tests pass

</domain>

<decisions>
## Implementation Decisions

### Area 1 — Regex signal set

- **Coverage: Moderate.** Include scope-doc emphasis signals + direct imperatives. Exclude conversational preferences ("I prefer X") — dominated by hedges, kills precision.
  - Families: `remember (this|that|to)` / `remember:`, `always ...` + negations, `never ...` + negations, `from now on`, `next time` / `in the future`, polite-imperative `please (do|don't|stop|always|never) X`, `stop (doing|using) X`, `don't X` / `do not X`, `do X instead` / `use X instead`.
  - If P2 iteration shows > ~20% fixture misses, extend families; do not extend speculatively.
- **Negation handling: regex accepts, LLM resolves polarity.** "Don't always do X" is ambiguous at regex layer; LLM has ±2 turns of context to disambiguate. No polarity filtering at regex time.
- **Case: case-insensitive match; original-case capture preserved** for LLM as an emphasis signal. "ALWAYS X" vs. "always X" influences LLM confidence but not the match decision.
- **Pre-filter: strip fenced code + user turns only.**
  - Fenced code blocks (```` ``` ```` and backtick-inline) stripped before regex pass.
  - Restrict to `conversation_turns WHERE role='user'` — assistant/tool output never scanned.
  - Quoted speech within user turns (`"user says 'always X'"`) is NOT preemptively stripped; LLM confidence drops naturally from quoting context.

### Area 2 — LLM confirmation layer

- **Model: reuse Angel's `glm-5.1:cloud`** via existing Ollama Cloud client. Single surface, no second dependency. Detector is Angel-internal — no CC CLIProxy concern.
- **Context window fed to confirmer: matched user turn + ±2 surrounding turns (5 turns total).** Role labels included. Fetched via `conversation_turns WHERE session_id=? AND turn_idx BETWEEN (match.idx-2) AND (match.idx+2)`.
- **Stateless confirmer: NO existing-rules context in prompt.** Dedup/contradiction uses a separate dedup call (Area 5), not the confirmation call. Keeps prompt cache-friendly and prompt-simple. Contradiction resolution is P8's job, not the confirmer's.
- **Output: single rich JSON per candidate.**
  ```json
  {
    "is_directive": true,
    "confidence": 0.85,
    "polarity": "prescriptive" | "prohibitive",
    "scope": "session" | "project" | "universal",
    "suggested_title": "...",     // → artifact.title
    "normalized_text": "...",     // → artifact.body
    "reasoning": "..."            // stored as provenance
  }
  ```
  Storage mapping:
  ```
  artifact.title = suggested_title
  artifact.body  = normalized_text
  artifact.kind  = 'directive_rule'
  artifact.scope = scope
  artifact.confidence = confidence
  artifact.data  = {
    polarity, reasoning,
    source_session_id, source_turn_idx, regex_family,
    reinforcement_count: 1,
    reinforcements: [{session_id, turn_idx, seen_at_epoch, regex_family}]
  }
  ```
- **Reject path: `is_directive=false` OR `confidence < 0.7` → write nothing.** No queue, no borderline tracking. Threshold tunable during P2 iteration.

### Area 3 — Scope classification policy

- **Project identity: always session's `project_id`. LLM does NOT pick a project.** 99% of directives are about the current project; cross-project routing (rare) is deferred — the `reasoning` field captures the mention and a later phase can post-process against `~/.claudex/projects.json`.
- **`scope='session'` semantics: permanent-but-contextually-narrow, not ephemeral.** Session-scoped rules persist; retrieval surfaces them when the referenced session/task is semantically close. Archival/decay is P8's job, not P2's.
- **Universal threshold: confidence ≥0.85** (higher bar than the 0.7 ≥-threshold for project/session). Universal rules leak across every project — higher blast radius earns a stricter gate.
- **Classification rubric in prompt: few-shot with real examples,** drawn from the user's actual directives (global `CLAUDE.md` + this project's `feedback_*.md`). Few-shot set lives in a JSON fixture file (NOT hardcoded in the prompt string) so P2 iteration can swap examples cheaply.

  Starter examples for the fixture (plan phase grounds these in actual corpus):
  - Session: *"for this PR, keep the refactor minimal"*, *"in this debugging session, don't commit until I say"*
  - Project: *"always use Bun for tests in this project"*, *"don't touch the legacy llama-server files"*
  - Universal: *"be concise — output displays in terminal"*, *"use Sonnet for workers, Opus only for product-defining work"*

### Area 4 — Fixture corpus + precision calibration

- **Corpus: 15 sessions (sessions 37-51).** Yields ~100 candidates at ~7-10 hits/session; ±3pp CI at p=0.9. Covers pre/post v4-crystallization. Under-powered at 7 sessions; over-sized above 15 for P2 scope.
- **Labeling: two-stage LLM labeler + team-lead review of disagreements.**
  - LLM labeler runs as a main-Claude-class model (Opus/Sonnet via CLIProxy in main Claude), **NOT** glm-5.1:cloud (avoids self-agreement bias — detector uses glm-5.1, labeler must be a different model family).
  - Labeler produces per-candidate label (is_directive, scope, polarity) + self-confidence.
  - Team-lead manually reviews: all labeler self-confidence <0.8; all labeler/detector disagreements; ~10% random spot-check of agreed-high-confidence set.
  - Estimated effort: ~30 min of human review for ~100 candidates.
- **Precision metric: per-field reported; joint precision as the gate.**
  - **Primary gate:** joint precision = (is_directive + scope + polarity all correct) / (total confirmed directives) ≥ 90%.
  - Diagnostic numbers: is_directive precision; scope precision | is_directive=correct; polarity precision | is_directive=correct.
  - Reasoning for joint gate: writing a row with wrong scope is worse than not writing it (leaks universal rule into project bucket, etc.). Silent is better than actively wrong.
- **Iteration budget:** measure → 92%+ ships; 88-92% = noise-bound, expand fixture to ~200 candidates; <88% = 3-cycle tuning budget (threshold → regex/few-shot → prompt rewrite); cycle 3 failure escalates to user. Do NOT silently lower the gate.

### Area 5 — Dedup / reinforcement at write time

- **Match detection: hybrid — embedding top-3 shortlist + LLM confirm.**
  1. Query vec0 for top-3 same-scope `directive_rule` rows by cosine similarity.
  2. If max cosine ≥ 0.80: one LLM call (glm-5.1:cloud) classifies relation for each shortlist row.
  3. If max cosine < 0.80: skip the LLM call, treat as fresh.
  - Relation enum returned by LLM: `restatement | opposite_polarity | related_but_distinct | unrelated`.
- **Write-path by relation:**
  - `restatement` → UPDATE existing row only (no new row):
    - `updated_at_epoch = now`
    - `data.reinforcement_count += 1`
    - append `{session_id, turn_idx, seen_at_epoch, regex_family}` to `data.reinforcements[]`
    - **Do NOT bump `confidence`** — confidence dynamics (reinforcement + decay) are P8's concern. Keeping symmetry at one phase.
  - `opposite_polarity` → INSERT new row + annotate `data.possible_contradicts = <old_id>` and `data.contradict_reason`. P8 reads the annotation during contradiction resolution.
  - `related_but_distinct` → INSERT new row + annotate `data.related_to = <nearest_id>`, `data.related_cosine`, `data.related_relation`. Soft graph edge for P8/retrieval.
  - `unrelated` (or no match at all) → INSERT new row standalone.

</decisions>

<specifics>
## Specific Ideas

- **Detector file path:** `src/intelligence/directive-detector.ts` (per EXTR-01).
- **Integration point:** Angel extraction phase, runs BEFORE the generic ingester. Plan phase must identify the exact hook site in Angel's heartbeat/extraction flow.
- **Prompt assets as swappable fixtures:** confirmation prompt few-shot set + scope rubric few-shot set both live as JSON files (not hardcoded). Enables P2 iteration and P8 future tuning without code change.
- **Ollama Cloud dependency already paid:** Angel uses `glm-5.1:cloud` since commit c84dd61 (session 52 swap-out of local Gemma). Reusing it adds no new ops surface.
- **Embedding + vec0 infrastructure already present:** snowflake-arctic-embed2 via Ollama + sqlite-vec vec0 virtual tables. Dedup uses same embedding pipeline; no new infra.
- **v3 parity marker:** `experience_patterns.reinforcement_count` establishes the bump-counter-on-re-occurrence pattern. Directive rules adopt the same shape inside `artifact.data`.

</specifics>

<deferred>
## Deferred Ideas

- **Cross-project directive routing.** User says "for lacuna-betting, always X" while inside CLAUDEXv3. P2 stores it as a CLAUDEXv3 rule with the cross-project mention captured only in `reasoning`. A future phase may post-process `data.reasoning` against `~/.claudex/projects.json` to reroute. Not P2 scope.
- **Confidence reinforcement dynamics.** Whether to boost `confidence` on `restatement` (and how — additive, logarithmic, recency-weighted) is deferred to P8 so decay + reinforcement can be designed coherently.
- **Supersession + contradiction resolution.** P8 owns `supersedes_id` edges, confidence decay, contradiction-driven archival. P2 only stores `data.possible_contradicts` annotations to hand off.
- **Paired recent/historical fixture for directive-voice drift detection.** Nice-to-have for characterizing how user's directive style has changed over time; defer unless P2 precision shows voice-shift issues.
- **Preference phrasings ("I prefer X", "we should X").** Dropped from P2 regex coverage due to hedge-density. Revisit if P2 post-ship reveals real directives being missed under that category.

</deferred>

<plan_phase_audit>
## Plan-Phase Audit Items

These must be resolved during `/gsd:plan-phase 3`:

1. **Angel extraction integration point** — exact hook/call site where the directive detector plugs in ahead of the generic ingester. Reference `src/angel/` heartbeat and extraction phases.
2. **Fixture corpus discovery** — identify which turn ranges in sessions 37-51 actually survive the user-turn-only + code-strip filter; budget labeling effort.
3. **Labeling agent design** — prompt, output schema, run harness. Run as a team-spawned sub-agent during P2 execution.
4. **Prompt fixture file layout** — JSON schema for the scope-rubric few-shot + confirmation prompt few-shot. Where it lives on disk; how the detector loads it.
5. **Precision test harness** — re-runnable command that measures joint precision + per-field diagnostics against the labeled fixture. Output format for iteration cycles.
6. **Iteration-cycle runbook** — codify the tuning decision tree (92% ships; 88-92% expand fixture; <88% cycle through threshold → regex → prompt; cycle-3 escalation message format).
7. **Threshold source of truth** — where `0.7` (general) and `0.85` (universal) live (env var? constant? config table?). Iteration should not require a source-code patch.
8. **Schema contract with P8** — document that P2 writes `data.possible_contradicts`, `data.related_to`, and `data.reinforcements[]` purely as passive annotations; P8 reads and acts.

</plan_phase_audit>

<gate_criteria>
## Gate Criteria (for phase completion)

- Joint precision ≥ 90% on labeled 15-session fixture (or expanded ~200-candidate set if first-pass was noise-bound).
- Per-field diagnostic numbers documented in phase completion commit.
- 2020 Vitest tests pass.
- LongMemEval Oracle ≥ 88% hard floor; no regression > 2pp from post-P1 baseline.
- LoCoMo no regression > 2pp from post-P1 baseline.
- Detector runs in Angel extraction phase; confirmed by heartbeat log inspection or explicit integration test.
- Zero injection-path changes: diff vs. post-P1 `src/assembler/*` and session-start injection code shows only `directive_rule` kind-registry addition (if needed); no new sections, no formatter changes.

</gate_criteria>

---

*Phase: 03-p2-directive-detector*
*Context gathered: 2026-04-20*
