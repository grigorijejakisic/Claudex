# Phase 12: Real v6 Structural Marks — Context

**Gathered:** 2026-05-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Nine structural marks that make the v6→v6-polish burn register as durable behavior change, not decoration. Six derive from the polish-burn audit trail; three from the 2026-05-14 Big Mozzy V2 retrieval diagnostic. Phase 12 ships once, before public push, after Phase 11 W3 close-out and v6.0.0 retag. External-review-gate dogfoods on Phase 12 itself using the cross-family pipeline 12-01 ships.

Plans: 12-01 through 12-09 across three waves + 12-CLOSE.

</domain>

<decisions>
## Implementation Decisions

### Area 1 — Cross-Family Invocation Pipeline (12-01)

**Implementation approach (operator-locked — revised):**
12-01 is a **thin wrapper module** (`src/skills/auto/cross-family-wrapper.ts`) over the existing `/codex-review` and `/gemini-review` skills. NOT a new primitive. The existing review skills already handle Windows workarounds, retry logic, and output parsing for both Codex CLI and Gemini-3-Flash (gemini-cli with Windows node-path bypass).

The wrapper provides a single function `invokeCrossFamily(prompt, options)` for auto-* skills to call. Under the hood it routes to the existing review skills with appropriate prompt-flavoring per call site. Plan 12-01 scope is ~150–300 LOC, substantially smaller than a full pipeline build.

Claude is intentionally NOT a third family in this pipeline — Claude is already present as orchestrator + teammates in the calling context; invoking Claude-via-SDK would be same-family critique, defeating the purpose.

Authorship mode: the wrapper accepts `mode: 'review' | 'authorship'`. In `authorship` mode (12-03 adversarial test authoring), the family's response is returned as `findings[].evidence` (vitest body) per the Q4 schema lock below — same invocation pattern, different prompt framing.

**Prompt-bounding discipline (operator-locked):**
Per-call-site configurable budget; wrapper-level 32K hard ceiling. If a caller exceeds the ceiling, the wrapper truncates with documented `truncated: true` flag in the structured response — never silently. Truncation strategy: lop newest content first, preserve structured prompt header + artifact-under-critique.

Initial budgets (planner refines during 12-01):
- 12-02 methodology critique: ~4–8K
- 12-03 adversarial test authoring: ~8–16K
- 12-CLOSE external-review-gate dogfood: up to 32K

Token cost is not a constraint (MAX subscription); the ceiling is about keeping cross-family signal sharp.

**Parse-failure handling (operator-locked):**
Retry once with a stricter format prompt (explicit BLOCK/FLAG/SIGNOFF schema + one short example). Persistent malformed → per-family result: `{ family: 'gemini'|'codex', degraded: true, verdict: null, raw_output: '<preserved>', reason: 'malformed' }`. Aggregate emits `degraded_mode[]` array. No synthesized verdicts from malformed output. No silent swallowing.

Calling-skill policies on degraded family:
- 12-02: degraded family → FLAG the phase, planner annotates, proceeds (single clean family is partial-but-real signal)
- 12-03: degraded family → probes from clean family ship; degraded family's probes recorded as "not produced this run"
- 12-CLOSE: BLOCK (close-out requires both families' critique)

**Structured result schema (operator-locked):**
Mirrors `scripts/external-review-gate.cjs` Phase 11 W2 pattern. Zod-validated.

```typescript
{
  family: 'gemini' | 'codex',
  verdict: 'BLOCK' | 'FLAG' | 'SIGNOFF',
  severity: 'critical' | 'major' | 'minor' | 'none',  // 'none' on SIGNOFF
  findings: Array<{
    category: string,   // e.g. 'methodology', 'silent-failure', 'metadata-starvation'
    summary: string,    // ≤ 1–2 sentences
    evidence: string,   // ≤ 8K tokens, points to specific lines/files/phrases
  }>,
  recommendation: string,  // what the family would do differently
  // degraded fields from parse-failure handling:
  degraded?: true,
  raw_output?: string,
  reason?: 'malformed' | 'unreachable' | 'timeout',
}
```

Per-finding severity drives caller-side routing: 12-02 routes BLOCK only on `severity: 'critical'`; FLAG/major → annotate-and-proceed; minor → log.

For 12-03 adversarial test authoring: same schema with `findings[].category = 'adversarial-probe'` and `findings[].evidence` containing the vitest body. `verdict` = SIGNOFF when probes produced cleanly, FLAG if authorship issues, BLOCK if family refused to author.

Zod schema lives alongside the pipeline module so all callers get type-safe parsing.

---

### Area 2 — Retrieval Ranking Rebalance (12-07)

**Fusion layer for importance-score cap (operator-locked):**
Post-rerank rescoring with a topical-distance multiplier. Cross-encoder output is input to the multiplier; not modified before that. Most surgical fix — addresses the exact symptom (high-importance items at position 0 for topically-unrelated queries) without touching RRF rank-merge or reranker semantics.

Formula:
```
effective_score = topical_score + importance_score * max(0, 1 - (topical_distance - threshold) / falloff)
```

Importance can still dominate within a topical band; cannot dominate outside it (where the big-balkan pattern manifests).

**Separate output channel (operator-locked):**
None. `claudex_search` returns a single ranked list. Topical-distance multiplier handles importance-vs-topical-relevance contention. Universal global rules continue to ship via the existing Critical Reminders Tier (decisions 106/107 from Phase 11), not via `claudex_search`.

**Threshold + falloff derivation (operator-locked):**
Empirically derived from the W3 16-search regression corpus during 12-07 plan authoring. Planner owns the derivation and documents both values in the 12-07 SUMMARY so they are auditable. The corpus is the Big Mozzy V2 sessions 39+40 diagnostic queries (8 domain-unrelated + 8 topically-related queries). Success criterion: big-balkan pattern no longer at position 0 for any of the 8 domain-unrelated queries; relevant artifacts appear in top-5 for the 8 topically-related queries.

Pre-committing a number without empirical basis would repeat the methodology error Phase 12 item 2 (methodology critique) exists to prevent.

Locked as `v6.routing.importance_topical_threshold` + `v6.routing.importance_falloff` config defaults. Telemetry signal `retrieved_but_unapplied` (item 5) provides post-ship tuning data; tuning itself is a v6.x decision.

**Bi-encoder fallback behavior (operator-locked):**
Topical-distance multiplier applies in BOTH the full pipeline (post-cross-encoder) AND the bi-encoder fallback path. Same formula, same threshold + falloff config values, different upstream scores. Arctic-embed2 cosine embeddings are already computed during bi-encoder fallback ranking — the multiplier calculation is essentially free. The big-balkan fix is not gated on reranker availability. The existing `reranker_fallback` telemetry event continues to fire independently.

---

### Area 3 — In-the-Moment Context-Pull Cues (12-08)

**Trigger detection heuristics (operator-locked — hybrid):**

*Handoff-reading (narrow, path-based):*
- Trigger: PreToolUse on `Read` where `file_path` matches glob `**/handoffs/**` OR `**/context/handoffs/*.md` OR `**/ACTIVE*.md`
- Anti-scope: do NOT pattern-match handoff content markers (SBAR, "Commander's Intent") — false-positive risk on documentation that references handoffs

*Decision-locking (narrow, tool+path-based):*
- Trigger: PreToolUse on `Write` or `Edit` where `file_path` matches any of: `**/config/**`, `**/*.config.{json,yaml,yml,ts,js}`, `**/curated-context*.md`, `**/CURATED*.md`, `**/.claudex/**`, project-root `*.yaml`/`*.json`
- Also: Bash invocations starting with `git commit` where commit message contains (case-insensitive) `decision` OR `lock` OR `pre-commit` OR `verdict`

*Wait-for-direction (broader, behavioral/keyword-based):*
- Trigger: Stop hook where assistant's final response matches any of these regex patterns (case-insensitive):
  - `\bthe handoff is (a |the )?menu\b`
  - `\bnot (a )?directive\b`
  - `\bwaiting for direction\b`
  - `\bnothing autonomous(ly)?\b`
  - `\byour call\b.*pick the lane`
  - `\b(neither|none).{0,30}without (your|operator) (input|direction)\b`
- False-positive bound: cue is advisory (does not block agent's action); telemetry `retrieved_but_unapplied` audits accept-rate post-ship; tighten keyword set in v6.x if accept-rate low

**Cue delivery mechanism (operator-locked):**
`<system-reminder>` injection via existing hook channels. No tool-result mutation; no sidecar files. Cue is advisory — never blocks the agent's action.

- Handoff-read and decision-lock: PreToolUse hooks inject into the current turn before the tool executes
- Wait-for-direction: Stop hook detects stance, queues cue that lands via next UserPromptSubmit

**Cue payload format (operator-locked — two-tier query):**
Targeted query by trigger context first; broader `claudex_search` fallback if no results. Snippets ≤200 chars per result, top-3 results, ≤1KB total cue size. Required format: `[{kind}:{id}] {title} — {snippet}`. Artifact-ID + provenance required so agent can `claudex_recall` for full content.

Per-moment query specifics:
- Handoff-reading: Tier 1 = `claudex_search` by handoff's `topic` field or filename slug; Tier 2 = `claudex_events` for latest 5 project sessions
- Decision-locking: Tier 1 = `claudex_search` by file path + diff keywords; Tier 2 = `claudex_search` by file basename + project name
- Wait-for-direction: Tier 1 = parse `context/handoffs/ACTIVE.md` for unresolved-task language; Tier 2 = `claudex_events` for latest user-framing topic in current session

**Opt-out mechanism (operator-locked — both phase-tag + config flag):**
- Phase-tag automatic suppression: cues check active phase's CONTEXT.md/PLAN.md frontmatter for `tags: [architecture|workflow|methodology]`. Any matching tag → cues fire; none → cues suppressed. Checked at hook-time, not cached.
- Operator config flag: `v6.cues.enabled` (boolean, default `true`). When `false`: all cues suppressed. Per-cue-type granular flags: `v6.cues.handoff_read.enabled`, `v6.cues.decision_lock.enabled`, `v6.cues.wait_for_direction.enabled`. Changes take effect on next hook invocation.

Suppression order: (1) `v6.cues.enabled = false` → suppress all; (2) per-cue-type flag = false → suppress that type; (3) no architecture/workflow/methodology phase tag → suppress; (4) otherwise → fire.

---

### Area 4 — Auto-* Skill Silence-Means-Escalate (12-09)

**Question classification (operator-locked — severity + fixed-category floor):**

Two classes:
- **BLOCK** = operator acknowledgment required; skill idles until response; no artifact writes while open
- **FLAG** = skill can proceed with documented default after timeout; default recorded in artifact's "Defaults Used (FLAG-class)" section

Fixed-category floor (auto-BLOCK regardless of skill's own classification):
1. Scope decisions — what's in/out of the phase; what files/components are touched
2. Methodology choices — how something gets measured, what decision rule applies, what counts as success
3. Prerequisite dependencies — what must complete before this work begins
4. Wave structure decisions — what plans parallelize vs. serialize
5. Active-conversation topics — anything the operator has surfaced in the current session's conversation log. This directly addresses the 2026-05-10 failure: operator was in conversation about gray areas; discuss-12 filled them anyway. That is now structurally impossible.

If skill's own classification says FLAG but question matches any of (1)-(5), it is auto-promoted to BLOCK.

FLAG-eligible categories: style/naming/output format, behavior preference where no wrong answer exists, implementation-level technical choices where project memory or codebase patterns provide an unambiguous answer, refinements within already-locked scope.

**Wait behavior on BLOCK question (operator-locked):**
Skill idles without writing. May send polite restate SendMessages at ~10-min intervals. After ~30 min total no-response, skill emits terminal `{ status: 'blocked_on_operator', question: <restated>, action: 'no_artifact_written' }` SendMessage and shuts down idle; orchestrator surfaces via AskUserQuestion.

What the skill MUST NOT do:
- Write any artifact (CONTEXT.md / PLAN.md / SUMMARY.md) while a BLOCK question is open
- Move to the next question while a BLOCK is open (one question at a time)
- "Eventually default" — there is no timeout that produces a default value for a BLOCK question

**Decision artifact recording (operator-locked — inline + claudex_store):**

Primary record — inline in phase artifact (CONTEXT.md / PLAN.md / SUMMARY.md):
```markdown
## Operator-Locked Answers (BLOCK-class)
- **Q [12-XX/Q1]:** [question summary]
  - Answer: [operator response]
  - Reasoning: [why]
  - Timestamp: [ISO]

## Defaults Used (FLAG-class)
- **Q [12-XX/Q2]:** [question summary]
  - Default chosen: [value]
  - Reasoning: [why safe per spec/codebase patterns]
  - Operator-override path: [how to revisit]
```

Secondary index — `claudex_store` per BLOCK-class answer only (FLAG defaults NOT stored — avoid crowding decision index with low-signal items):
- type: `decision`, importance: 4
- content: `{ phase, question_id, question_summary, operator_answer, reasoning, source_artifact_path }`

**Structural enforcement of no-write-while-BLOCK-open (operator-locked — belt + suspenders):**

Ordering discipline (process definition): questions asked BEFORE write step; write is the final step in the skill's `<process>` definition. Hard constraint documented in skill process.

Runtime question-gate at write step:
```typescript
function writeArtifact(...) {
  const openBlockers = listOpenBlockQuestions();
  if (openBlockers.length > 0) {
    sendBlockedMarker(openBlockers);
    return; // do NOT write
  }
  // proceed
}
```

Shared module `src/skills/auto/block-gate.ts` across all three auto-* skills — single source of truth, no drift.

Telemetry coupling: when the gate fires (write attempted with open BLOCK), emit `block_gate_fired` with `{ skill, phase, question_id, attempted_artifact_path }`. Repeated gate fires signal process-definition drift → actionable in v6.x.

### Claude's Discretion

No areas were left to Claude's discretion — all four gray areas received explicit operator-locked answers.

</decisions>

<specifics>
## Specific Ideas

- 12-01 scope was revised: thin wrapper over existing `/codex-review` + `/gemini-review` skills, NOT a new pipeline primitive. The spec file (`.planning/research/2026-05-10-phase-12-real-v6-structural-marks.md`) was updated to reflect this on 2026-05-14. Claude excluded from the 2-family set (Gemini-3-Flash + Codex CLI) — already present as orchestrator + teammates.
- The `feedback_good_child_parable.md` memory is directly load-bearing for items 8 and 9. The "silence-means-escalate" fix exists because the 2026-05-10 session demonstrated auto-discuss-phase filling six gray areas with defaults while operator input was in flight — operator decision then: "fold the fix into phase 12."
- The big-balkan pattern (one high-importance experience pattern crowding position 0 across 16 unrelated queries in sessions 39+40) is the concrete empirical basis for item 7. The W3 16-search corpus is the regression harness.
- Phase 12 is the last step before public push. All nine marks must close before push.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope. All four gray areas concerned implementation details of already-scoped items.

v7 design questions (pairwise Elo, telemetry verdict structure, cross-agent validation under Claude as production agent) remain explicitly deferred per the spec. Phase 12 does not re-litigate those.

</deferred>

## Operator-Locked Answers (BLOCK-class)

- **Q [12-01/Q1]:** Which families are first-class / what is the implementation approach? (REVISED 2026-05-14)
  - Answer: Thin wrapper module (`src/skills/auto/cross-family-wrapper.ts`) over existing `/codex-review` + `/gemini-review` skills. NOT a new primitive. Families = Gemini-3-Flash + Codex CLI (via existing skills). Claude excluded (already present as orchestrator + teammates). `mode: 'review'|'authorship'` parameter added for 12-03 use case.
  - Timestamp: 2026-05-14

- **Q [12-01/Q2]:** Prompt-bounding discipline?
  - Answer: Per-call-site configurable budget; 32K hard ceiling; documented truncation with `truncated: true` flag.
  - Timestamp: 2026-05-14

- **Q [12-01/Q3]:** Parse-failure handling?
  - Answer: Retry once; persistent malformed → `degraded: true, verdict: null, raw_output: <preserved>`; aggregate `degraded_mode[]`; calling skill decides BLOCK/FLAG/proceed per its own policy.
  - Timestamp: 2026-05-14

- **Q [12-01/Q4]:** Structured result schema?
  - Answer: `{ family, verdict, severity, findings[{category, summary, evidence}], recommendation, degraded?, raw_output?, reason? }`. Zod-validated. Per-finding severity drives caller routing.
  - Timestamp: 2026-05-14

- **Q [12-07/Q1]:** Where does the importance-score cap live?
  - Answer: Post-rerank rescoring with topical-distance multiplier. `effective_score = topical_score + importance_score * max(0, 1 - (topical_distance - threshold) / falloff)`. RRF and reranker untouched.
  - Timestamp: 2026-05-14

- **Q [12-07/Q2]:** Separate output channel for global rules?
  - Answer: No. Single ranked list. Universal global rules via Critical Reminders Tier (decisions 106/107).
  - Timestamp: 2026-05-14

- **Q [12-07/Q3]:** Threshold + falloff derivation?
  - Answer: Empirically derived from W3 16-search corpus during 12-07 plan authoring. Planner owns derivation; documents in SUMMARY.
  - Timestamp: 2026-05-14

- **Q [12-07/Q4]:** Multiplier in bi-encoder fallback?
  - Answer: Yes — applies in both full pipeline and bi-encoder fallback. Same formula, same config values.
  - Timestamp: 2026-05-14

- **Q [12-08/Q1]:** Trigger detection precision?
  - Answer: Hybrid — narrow path/tool-based for handoff-read and decision-lock; broader behavioral/keyword for wait-for-direction.
  - Timestamp: 2026-05-14

- **Q [12-08/Q2]:** Cue delivery mechanism?
  - Answer: `<system-reminder>` injection via existing hook channels. PreToolUse for handoff-read and decision-lock; Stop → next UserPromptSubmit for wait-for-direction.
  - Timestamp: 2026-05-14

- **Q [12-08/Q3]:** Cue payload query strategy?
  - Answer: Two-tier (targeted first, broader fallback). ≤200 chars per result, top-3, ≤1KB total. Format: `[{kind}:{id}] {title} — {snippet}`.
  - Timestamp: 2026-05-14

- **Q [12-08/Q4]:** Opt-out mechanism?
  - Answer: Both phase-tag suppression (no architecture/workflow/methodology tag → suppress) AND operator config flag `v6.cues.enabled` with per-cue-type granular flags.
  - Timestamp: 2026-05-14

- **Q [12-09/Q1]:** Question classification for explicit acknowledgment?
  - Answer: Severity-based (BLOCK/FLAG) + fixed-category floor (scope, methodology, prerequisites, wave structure, active-conversation topics auto-promote to BLOCK).
  - Timestamp: 2026-05-14

- **Q [12-09/Q2]:** Skill wait behavior on BLOCK?
  - Answer: Idle without writing. Polite restates at ~10-min intervals. Terminal `blocked_on_operator` SendMessage after ~30 min; orchestrator surfaces via AskUserQuestion. No eventual-default path.
  - Timestamp: 2026-05-14

- **Q [12-09/Q3]:** Decision artifact recording?
  - Answer: Inline in phase artifact (BLOCK-class + FLAG-class sections) AND `claudex_store` per BLOCK-class answer (type: decision, importance: 4). FLAG defaults NOT stored via claudex_store.
  - Timestamp: 2026-05-14

- **Q [12-09/Q4]:** Structural enforcement of no-write-while-BLOCK-open?
  - Answer: Belt + suspenders — ordering discipline in process definition (questions before write step) AND runtime question-gate at `writeArtifact`. Shared `src/skills/auto/block-gate.ts`. Telemetry event `block_gate_fired`.
  - Timestamp: 2026-05-14

---

*Phase: 12-real-v6-structural-marks*
*Context gathered: 2026-05-14*
