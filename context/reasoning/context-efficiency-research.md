# Context Efficiency Research -- Findings

**Date:** 2026-03-13
**Team:** 7 workers (w1-readfiles, w2-fts5, w3-obscontent, w4-compaction, w5-assembly, w6-hooks, w7-injection)
**Verified by:** PM synthesis with independent source code verification

---

## Executive Summary

- **The handoff's post-compaction redundancy assumptions are WRONG.** Identity and project primer are NOT redundant post-compaction because `additionalContext` (session-start) and `systemMessage` (post-compaction) are different CC hook injection mechanisms. The compaction strips the former; re-injection via the latter is necessary. GSD is also needed when a phase is active (RESUME preset strips checkpoint GSD). The proposed ~900 token savings from skipping identity/primer/GSD post-compaction would cause real context loss.
- **FTS5 full mode can generate ~5,150 tokens from a 4,000-token budget.** The referenceMode trigger (`budget < 500`) is a poor proxy. When budget is 500-3,500 after priorities 1-5, full mode is attempted but typically exceeds remaining budget and the entire section is skipped -- wasting the FTS5 query, formatting work, and yielding zero observations.
- **Observation content is bounded at 2,000 chars (all 10 extractors), but this is too generous for assembly.** 10 FTS5 results at max content = 5,210 tokens, exceeding the full budget. A per-observation render-time cap of 300-400 chars would keep FTS5 within budget while preserving the full content in the DB for later retrieval.
- **Per-hook process overhead is significant.** Every hook invocation spawns a Node.js process with full bootstrap (DB open + 5 PRAGMAs + config read + 2x projects.json read). PostToolUse fires per tool call (10 tools = 10 process spawns), always returning `{}`. A 10-prompt session with 8 tools/prompt = 102 process launches with ~30-90ms fixed overhead each.
- **A confirmed bug:** `trackAfterTurn` (lifecycle.ts:158-160) does not call `tracker.persist()`, silently dropping after-turn thread state updates. `trackAfterTool` does persist. This is a data loss bug.

---

## Critical Findings (Must Fix)

### C1. `trackAfterTurn` Missing `persist()` Call -- Bug
**File:** `src/adapters/shared/lifecycle.ts:152-160`
**Worker:** W6 (verified by PM)

`trackAfterTurn` creates a `ThreadTracker`, calls `onAfterTurn()`, but never calls `tracker.persist()`. The after-turn thread state update (topic changes, summary updates from the assistant's response) is computed in memory but never written to the DB. Since each CC hook is a separate process, the state is lost immediately.

Compare with `trackAfterTool` at lines 136-146 which correctly calls `tracker.persist()`.

**Impact:** Thread topic and summary are not updated from assistant responses, only from tool calls. This means the topic-shift detector works against stale topic data and FTS5 queries (which use `checkpoint.thread.topic`) search on outdated topics.

### C2. FTS5 Mode Selection Is a Poor Proxy
**File:** `src/assembly/assembler.ts:136`
**Workers:** W2, W5 (verified by PM)

`referenceMode` is set to `true` only when `budget < 500` after priorities 1-5. This is wrong: it should be based on whether full-mode FTS5 output would fit in the remaining budget, not whether the budget is below a fixed threshold.

**Scenarios where this fails:**
- Budget = 1,500 after P1-5: referenceMode=false, full FTS5 costs ~1,650-5,150 tokens, section gets skipped entirely (zero observations). Reference mode at ~135 tokens would have been included.
- Budget = 499: referenceMode=true, reference FTS5 at ~135 tokens included. Correct outcome, wrong reason.

The "sweet spot" where reference mode would succeed but isn't selected: budget 135-500 tokens remaining. In practice, with typical section costs, this range is commonly hit.

### C3. FTS5 + Recent Observations Double-Injection
**File:** `src/assembly/sections.ts:154-190`, `src/assembly/assembler.ts:152-188`
**Worker:** W5 (verified by PM)

Observations that are recent (<24h), high-importance (>=3), AND topically relevant to the current query appear in BOTH the FTS5 section (priority 7) and the Recent section (priority 8). No deduplication exists between them.

In full FTS5 mode, one observation costs ~515 tokens in FTS5 + ~13 tokens in Recent = 528 tokens total. With 5 overlapping observations, that is ~100 tokens of pure duplication.

### C4. Checkpoint Learnings + Learnings Section Duplication
**File:** `src/checkpoint/inject.ts:110-116`, `src/assembly/assembler.ts:112-121`
**Worker:** W5 (verified by PM)

The checkpoint (priority 3) includes a `### Learnings` subsection from `checkpoint.learnings` (snapshot at checkpoint time). Priority 4 separately injects `formatLearningsSection` from live `getTopLearnings(db, project, 10)`. These share 3-8 identical strings when the session is fresh. No deduplication.

### C5. `boundary_only` Config Is Dead Code
**File:** `src/shared/constants.ts:39`
**Worker:** W7 (verified by PM with grep)

`boundary_only: true` is declared in `DEFAULT_CONFIG`, typed in `config.ts`, validated, and tested -- but never read by any assembly or hook logic. Setting it to `false` has no runtime effect. The boundary-only behavior is enforced structurally by the assembler's branching, not by this flag.

---

## Important Findings (Should Fix)

### I1. Hot Files Are Project-Scoped with No Session Boundary Reset
**File:** `src/core/pressure.ts:38-51,73-85`, `src/checkpoint/writer.ts:185`
**Worker:** W1

`pressure_scores` has no `session_id` column. Hot files from any session on the same project appear in every checkpoint. With a 7-day half-life, files from a task completed days ago persist as HOT. In multi-agent team sessions, 20 agents share the same project scope and pollute each other's hot file lists.

### I2. Read Files Query Has No Recency Ordering
**File:** `src/checkpoint/writer.ts:193-203`
**Worker:** W1

The read files query (`SELECT DISTINCT json_each.value ... LIMIT 50`) has no `ORDER BY`. SQLite returns results in arbitrary order (typically insertion order), meaning old files from early in the session dominate the 50-slot limit. Adding `ORDER BY observations.timestamp_epoch DESC` would surface the most recently touched files.

### I3. Writer Fetches More Than Renderer Displays
**File:** `src/checkpoint/writer.ts:185,195-202`, `src/checkpoint/inject.ts:68-69`
**Worker:** W1

Writer fetches 20 hot files and 50 read files. Renderer caps at MAX_HOT=15 and MAX_READ=20. The extra entries (5 hot + 30 read) are stored in the YAML checkpoint but never rendered. Caps should be at the writer, not the renderer.

### I4. Topic Shift Has No Cooldown
**File:** `src/intelligence/topic-shift.ts`
**Worker:** W7

After a topic shift is detected, there is no mechanism to suppress re-detection on subsequent turns. No `last_shift_epoch`, no turn counter. Rapid topic changes can inject on every other turn.

### I5. Jaccard Fallback Has High False-Positive Risk
**File:** `src/intelligence/topic-shift.ts:117-127`
**Worker:** W7

When embeddings are unavailable, the Jaccard layer (threshold 0.15) compares a short topic phrase (1-3 words) against the full prompt text. Long verbose prompts on the same topic routinely score below 0.15 overlap, triggering false positives. Example: topic "authentication" vs prompt "Can you help me understand how the JWT middleware validates tokens..." yields Jaccard = 0.0.

### I6. estimateTokens Underestimates Markdown by 10-20%
**File:** `src/shared/text-utils.ts:36-43`
**Worker:** W5

`Math.ceil(text.length / 4)` underestimates markdown-heavy content because markdown control characters (`##`, `**`, `###`, `-`) tokenize less efficiently than prose. With a 4,000-token budget, actual injection can exceed budget by 400-800 tokens. The formatting skeleton alone (headers, separators) costs ~100-120 estimated tokens but ~150 actual tokens.

### I7. PostToolUse Per-Tool Overhead
**File:** `src/adapters/cc-hooks/post-tool-use.ts`, `src/adapters/cc-hooks/infrastructure.ts:98-105`
**Worker:** W6

PostToolUse always returns `{}` but pays full bootstrap cost per invocation: DB open + 5 PRAGMAs + config read + 2x projects.json read + observation processing + thread tracking + checkpoint threshold check + telemetry write + DB close. At 10 tools/turn, that is 10 full process cycles.

### I8. Double projects.json Read Per Hook Invocation
**File:** `src/adapters/cc-hooks/infrastructure.ts:101-102`, `src/shared/scope-detector.ts:67`
**Worker:** W6 (verified by PM)

`bootstrapHook` calls `detectProjectScope(cwd)` then `getProjectId(cwd)`. `getProjectId` internally calls `detectProjectScope` again. This reads `projects.json` twice per invocation, across all 6 hooks.

### I9. Gauge Fires Every Turn Above Threshold
**File:** `src/assembly/assembler.ts:287-293`, `src/assembly/sections.ts:196-206`
**Worker:** W7

Once utilization exceeds 70%, gauge injects ~15 tokens on every subsequent turn until compaction. No hysteresis band, no cooldown. In long sessions this means 10-50 consecutive turns each receiving gauge injection.

### I10. EmbeddingProvider Rebuilt Fresh Every Invocation
**File:** `src/adapters/cc-hooks/user-prompt-submit.ts:32-36`, `src/adapters/shared/lifecycle.ts:195-215`
**Worker:** W6

UserPromptSubmit creates EmbeddingProvider + Ollama HTTP availability check on every user prompt. Stop's `buildDecisionClassifier` does the same on every turn end. No cross-invocation caching is possible (separate processes), but an Ollama availability TTL cache in the DB could eliminate most HTTP calls.

---

## Minor Findings (Nice to Have)

### M1. `assembleTopicPivot` Truncation Produces Zero-Payload Output
**File:** `src/assembly/assembler.ts:346-352`
**Worker:** W5

When pivot exceeds 800-token budget, it truncates to first 3 lines: `## Context Pivot`, the topic transition line, and a blank line. All learnings, files, and decisions are discarded. The result is a ~20-token injection containing only the header.

### M2. `last_action` Field Is Always Null (Dead Code)
**File:** `src/checkpoint/writer.ts:264`, `src/checkpoint/inject.ts:79`
**Worker:** W1

Checkpoint hot files have a `last_action` field that is always set to `null` by the writer. The renderer checks it but it never has a value. Structural dead code.

### M3. Gauge Uses H1 Instead of H2
**File:** `src/assembly/sections.ts:202`
**Worker:** W5

Every section uses `## H2` headers except gauge which uses `# H1`. Cosmetic inconsistency. No functional impact since gauge fires standalone (not bundled with other sections).

### M4. Tier 2 Fallback Hardcodes `## Checkpoint\n`
**File:** `src/assembly/assembler.ts:228`
**Worker:** W5

Tier 2 (checkpoint-only fallback) constructs the header manually rather than using `formatCheckpointSection`. If the header wording changes in sections.ts, Tier 2 silently diverges.

### M5. Post-Redaction Reclaim Budget Calculation
**File:** `src/assembly/assembler.ts:199`
**Worker:** W5

`reclaimBudget = remaining_budget + redaction_delta/4` adds recovered tokens to leftover budget. If remaining budget was 0 and redaction freed 400 chars (100 tokens), a 95-token skipped section gets reclaimed, potentially pushing total content slightly over the original 4,000-token budget.

### M6. Priorities 1-5 Excluded from Reclaim
**File:** `src/assembly/assembler.ts:77-133`
**Worker:** W5

Priorities 1-5 don't push to `skipped[]` when they exceed budget. Only priorities 6-8 get a second chance via post-redaction reclaim. This is an asymmetry in the reclaim mechanism.

### M7. No Defense-in-Depth Content Cap at Storage Layer
**File:** `src/core/observations.ts` (insertObservation)
**Worker:** W3

All 10 extractors correctly call `truncateText(content, 2000)`, but `insertObservation` has no secondary cap. A future extractor that omits truncation would store unbounded content.

### M8. pruneTelemetry Runs at Both Session Start and End
**File:** `src/adapters/cc-hooks/session-start.ts:25-29`, `src/adapters/shared/lifecycle.ts:301-304`
**Worker:** W6

Same pruning runs once at session start and once at session end. Only one invocation is needed.

---

## Actionable Items (Ordered by Impact)

| # | Item | File(s) | Impact | Effort |
|---|------|---------|--------|--------|
| 1 | Fix `trackAfterTurn` missing `persist()` | `lifecycle.ts:160` | Bug fix -- thread state data loss | Trivial (add one line) |
| 2 | Budget-proportional FTS5 mode selection: estimate full-mode cost first, use reference mode if it exceeds remaining budget | `assembler.ts:136,152-169` | Prevents FTS5 from being skipped when reference mode would fit | Small |
| 3 | Deduplicate FTS5 + Recent sections: pass FTS5 result IDs to Recent formatter to exclude | `assembler.ts:171-188` | Eliminates 50-500 tokens of duplication | Small |
| 4 | Deduplicate checkpoint learnings + learnings section: filter live learnings against checkpoint learnings strings | `assembler.ts:111-121` | Eliminates 50-200 tokens of duplication | Small |
| 5 | Add `ORDER BY observations.timestamp_epoch DESC` to read files query | `writer.ts:193-203` | Surfaces recent files instead of old ones | Trivial |
| 6 | Move caps to writer: `getHotFiles(db, project, 15)` and `LIMIT 20` for read files | `writer.ts:185,195-202` | Eliminates 35 dead entries from stored checkpoints | Trivial |
| 7 | Add topic-shift cooldown (3 turns or 60 seconds after last shift) | `topic-shift.ts`, `user-prompt-submit.ts` | Prevents rapid-fire shift injections | Medium |
| 8 | Fix double projects.json read: pass `detectProjectScope` result to `getProjectId` | `infrastructure.ts:101-102`, `scope-detector.ts:65-78` | Halves file I/O per hook invocation | Trivial |
| 9 | Add per-observation content cap in `formatFts5Section` (300 chars in full mode) | `sections.ts:165-168` | Caps full-mode FTS5 cost to ~1,150 tokens instead of ~5,150 | Trivial |
| 10 | Add gauge hysteresis: fire at 70%, suppress until drops to 65% | `sections.ts:196-206` or `user-prompt-submit.ts` | Prevents continuous per-turn gauge injection | Small |
| 11 | Remove or enforce `boundary_only` config flag | `constants.ts:39`, `config.ts:17`, `assembler.ts` | Clean up dead code or implement feature | Small |
| 12 | Raise Jaccard threshold to 0.10 or compare against top-5 prompt keywords | `topic-shift.ts:117-127` | Reduces false-positive shifts when embeddings unavailable | Small |
| 13 | Add defense-in-depth content cap in `insertObservation` | `observations.ts:52-78` | Prevents future extractor from storing unbounded content | Trivial |
| 14 | Defer `checkpointIfThresholdMet` to Stop only (remove from PostToolUse) | `post-tool-use.ts:55-63` | Eliminates N redundant checkpoint_tracking reads per turn | Small |
| 15 | Remove `last_action` dead code or wire it to data | `writer.ts:264`, `inject.ts:79` | Clean up dead feature | Trivial |

---

## Items Needing Usage Data

| Item | What We Need | Why We Can't Determine Without Data |
|------|-------------|-------------------------------------|
| Optimal FTS5 result count | Real distribution of FTS5 section token costs | Hardcoded `limit: 10` may be too many; 5 might suffice. Need injection telemetry. |
| Per-observation content cap value | Distribution of observation content lengths | The current 2,000-char cap may be reducible to 600-800 without losing signal. Need to measure information density at various caps. |
| Budget tuning (4,000 tokens) | Actual token costs across real sessions | Budget may need to increase (PROJECT_PRIMER crowding out later priorities) or specific section caps may be more effective. |
| Gauge threshold tuning | Token utilization trajectory curves | The 70% threshold is arbitrary. Real sessions may warrant 75% or 80%. |
| Topic-shift false positive rate | Production topic-shift telemetry with Jaccard vs embedding breakdown | The Jaccard false-positive risk is theoretical; real data would show how often it fires spuriously. |
| PostToolUse latency impact | Wall-clock timing of PostToolUse invocations | The per-tool overhead is estimated at 30-90ms fixed cost but needs measurement under load. |
| Hot file staleness window | Real pressure_scores decay curves | The 7-day half-life is theoretical. Real multi-day sessions would reveal if hot files go stale faster than expected. |

---

## Raw Worker Reports

| Worker | Key Findings | Full Report |
|--------|-------------|-------------|
| W1 (Read Files) | Hot files project-scoped with no session reset; read files query no ORDER BY; writer fetches more than renderer caps; multi-agent hot file pollution; `last_action` dead code | `context/reasoning/eff-w1-readfiles.md` |
| W2 (FTS5) | Full mode worst case 5,150 tokens (exceeds 4,000 budget); referenceMode trigger at budget<500 is poor proxy; no per-observation content cap at render time; budget check is all-or-nothing | `context/reasoning/eff-w2-fts5.md` |
| W3 (Obs Content) | All 10 extractors uniformly cap at 2,000 chars; schema has no length constraint; quality gate checks lower bounds only; no defense-in-depth at storage; Read/Write/Edit most likely to hit cap | `context/reasoning/eff-w3-obscontent.md` |
| W4 (Compaction) | Identity and project primer are NOT redundant post-compaction (different injection mechanisms); GSD not skippable when active; flag lifecycle is clean; no race conditions; topic-shift correctly skipped post-compaction | `context/reasoning/eff-w4-compaction.md` |
| W5 (Assembly) | estimateTokens underestimates markdown 10-20%; FTS5+Recent duplication; checkpoint+learnings duplication; topic pivot truncation destroys payload; priorities 1-5 excluded from reclaim; reclaim budget calculation subtle error | `context/reasoning/eff-w5-assembly.md` |
| W6 (Hooks) | trackAfterTurn missing persist() (BUG); double projects.json read per invocation; PostToolUse 10x overhead; EmbeddingProvider rebuilt every invocation; checkpointIfThresholdMet in both PostToolUse and Stop; pruneTelemetry in both SessionStart and SessionEnd | `context/reasoning/eff-w6-hooks.md` |
| W7 (Injection) | Injection types are mutually exclusive (no compounding); boundary_only config is dead code; Jaccard false-positive risk high; gauge fires every turn above 70% with no cooldown; no topic-shift cooldown; first-prompt window vulnerability | `context/reasoning/eff-w7-injection.md` |

---

## Handoff Correction

**The handoff (ACTIVE.md sections 1.3-1.4) incorrectly identifies identity, project primer, and GSD as redundant post-compaction.** W4's investigation, verified by PM, shows that:

1. **Session-start uses `additionalContext`; post-compaction uses `systemMessage`.** These are different CC hook return types. Compaction can strip `additionalContext` from the compressed context. Re-injection via `systemMessage` is a separate operation and is necessary.

2. **GSD is stripped from checkpoints by the RESUME preset.** The only source of GSD data post-compaction is the live `readGsdState()` at priority 6. When a GSD phase is active, this section is the sole orientation for the current planning phase.

The proposed 900-token savings from Changes 1-4 in section 1.4 would cause **real context loss**. The correct optimization path is:
- Fix FTS5 mode selection (items 2, 9 above) -- saves 0-500 tokens per compaction
- Deduplicate FTS5/Recent and checkpoint/learnings (items 3, 4) -- saves 50-700 tokens
- These yield comparable savings (~500-1000 tokens) without sacrificing context integrity
