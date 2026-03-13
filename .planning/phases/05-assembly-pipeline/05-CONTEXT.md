# Phase 5: Assembly Pipeline - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

The assembly pipeline is the output layer of Claudex v3. Everything built in prior phases (extraction, intelligence, checkpoints, gauge, decay, GSD) produces data. Phase 5 decides **what** to inject into the LLM's context and **when**.

The core principle is **boundary-only injection**: full context assembly fires only at session-start and post-compaction. Most turns get zero injection, eliminating 90%+ of per-turn overhead.

Target modules:
- New: `src/assembly/assembler.ts` (priority-budgeted assembly orchestrator)
- New: `src/assembly/sections.ts` (section formatters for each priority level)
- New: `src/assembly/token-estimator.ts` (token count estimation)
- Existing: `src/checkpoint/inject.ts` (Phase 6 -- `renderCheckpointMarkdown()` for checkpoint section)
- Existing: `src/checkpoint/loader.ts` (Phase 6 -- `loadCheckpoint()`, `loadFromFile()` for recovery)
- Existing: `src/core/learnings.ts` (Phase 1 -- `getTopLearnings()` for learnings section)
- Existing: `src/core/pressure.ts` (Phase 1 -- `getHotFiles()` for HOT files section)
- Existing: `src/core/observations.ts` (Phase 1 -- `searchObservations()` for FTS5 section)
- Existing: `src/gsd/state-reader.ts` (Phase 7 -- `readGsdState()` for GSD section)
- Existing: `src/gauge/token-gauge.ts` (Phase 7 -- `getTokenGauge()` for gauge injection)
- Existing: `src/intelligence/topic-shift.ts` (Phase 4 -- `TopicShiftDetector` for pivot detection)
- Existing: `src/extraction/redaction.ts` (Phase 2 -- `redactText()` for post-assembly redaction)
- Existing: `src/shared/types.ts` (InjectPayload, TokenUsage, RuntimeCapabilities)
- Existing: `src/shared/config.ts` (ClaudexConfig with injection.budget_tokens, injection.gauge_threshold, injection.topic_shift_budget)
- Existing: `src/shared/paths.ts` (getIdentityDir, getHandoffsDir for file reads)

</domain>

<decisions>
## Implementation Decisions

### Boundary-Only Injection (ASMB-01, ASMB-06)
- Full assembly fires ONLY at session-start (`session_init`) and post-compaction (`before_prompt` with `isPostCompaction=true`)
- Regular `before_prompt` turns: check for topic-shift -> gauge injection -> zero injection
- Most turns produce zero injection (empty InjectPayload with `content: ''`, `tokenEstimate: 0`, `sources: []`)
- Background work (decision capture, thread update, checkpoint threshold check) is NOT assembly's job -- adapters handle that in Phase 8/9

### Priority-Budgeted Full Assembly (ASMB-03)
- Default budget: 4000 tokens (configurable via `config.injection.budget_tokens`)
- Token estimation: `Math.ceil(text.length / 4)`
- 8 priority sections assembled in cascading order:
  1. Identity (USER.md from `~/.claudex/identity/`) -- ~100 tokens, always fits, skip if missing
  2. Project context (PROJECT_PRIMER.md + context/handoffs/ACTIVE.md) -- ~200-500 tokens, skip if global scope
  3. Checkpoint resume (via `renderCheckpointMarkdown()`) -- ~300-600 tokens, skip if no checkpoint
  4. Cross-session learnings (top 10 via `getTopLearnings()`) -- ~200-400 tokens
  5. HOT files (pressure >= 0.851 via `getHotFiles()`) -- ~100-300 tokens
  6. GSD phase state (via `readGsdState()`) -- ~200-400 tokens, skip if no GSD active
  7. FTS5 search (prompt-relevant observations via `searchObservations()`) -- up to remaining budget
  8. Recent high-quality observations (importance >= 3, last 24h) -- only if budget remains
- Each section is added only if the remaining budget allows it
- Reference mode: when remaining budget < 500 tokens after priority 5, subsequent sections switch to compact one-line summaries

### Post-Redaction Budget Reclaim (ASMB-05)
- Observations are pre-redacted at storage time (Phase 2 extraction pipeline)
- Non-extraction sources (USER.md, PROJECT_PRIMER.md, ACTIVE.md, checkpoint YAML, GSD state) are NOT pre-redacted
- Flow: assemble all sections -> apply `redactText()` to assembled output -> if shorter after redaction, reclaim freed tokens -> re-attempt previously-skipped lower-priority sections with freed budget
- Redaction uses the existing `redactText()` from `src/extraction/redaction.ts`

### Topic-Shift Micro-Injection (ASMB-02)
- Max 800 tokens (configurable via `config.injection.topic_shift_budget`)
- Triggered by `TopicShiftDetector.detectTopicShift()` returning `{ shifted: true }`
- Pivot block content:
  1. Topic transition marker: "Switching context: {oldTopic} -> {newTopic}"
  2. Top 3 learnings relevant to new topic (FTS5 match against learnings table)
  3. HOT files relevant to new topic (FTS5 match against observation file paths)
  4. Last checkpoint's relevant decisions (if any match new topic)
- NOT a full assembly -- lightweight context pivot (~200-400 tokens average)

### Token Gauge Injection (ASMB-04)
- Injected at >= 70% utilization (configurable via `config.injection.gauge_threshold`)
- Format: `# Token Gauge\nUtilization: {pct}% ({input} / {window})`
- ~50 tokens, always fits
- Only fires on regular prompt turns when no topic-shift and no post-compaction

### Three-Tier Degradation (QUAL-02)
- Tier 1 (normal): Full assembly with DB + FTS5 + checkpoint + learnings
- Tier 2 (DB unavailable): Checkpoint-only assembly via `loadFromFile()` (reads YAML files directly)
- Tier 3 (everything fails): Identity-only assembly (reads USER.md flat file)
- Each tier catches errors and falls through to the next
- Never crashes -- always returns at least an empty InjectPayload

### Session-Start FTS5 Query
- At `session_init`, there is no user prompt for keyword extraction
- Architecture Section 7.2: "Keywords extracted from user's prompt (or checkpoint topic for session-start)"
- Priority 7 FTS5 uses the checkpoint's thread topic as the search query during session-start

### Assembler Returns InjectPayload Only
- The assembler returns `InjectPayload` (content, tokenEstimate, sources)
- The adapter (Phase 8/9) decides where to route it (CC: `additionalContext` for session_init, `systemMessage` for before_prompt; OpenClaw: `enqueueSystemEvent`)
- Clean separation: assembler has no knowledge of adapter protocol

### Section Formatters Are Stateless
- Each formatter takes pre-fetched data and returns formatted markdown string (or null if empty)
- No DB access in formatters -- the assembler handles all data fetching
- Formatters are pure functions for testability

### File Locations
- `src/assembly/token-estimator.ts`: estimateTokens() -- Math.ceil(text.length / 4)
- `src/assembly/sections.ts`: formatIdentitySection(), formatProjectSection(), formatCheckpointSection(), formatLearningsSection(), formatHotFilesSection(), formatGsdSection(), formatFts5Section(), formatRecentSection(), formatGaugeSection(), formatTopicPivotSection()
- `src/assembly/assembler.ts`: assembleFullContext(), assembleRegularPrompt(), assembleTopicPivot() -- orchestrator with three-tier degradation

### Claude's Discretion
- Exact markdown formatting within each section (headers, bullet styles, etc.)
- Helper function decomposition within assembler.ts
- How reference mode compacts observations (one-line summary format)
- FTS5 keyword extraction from user prompt (simple word splitting or reuse of text-utils)
- Error logging within non-throwing functions
- Test fixture construction details
- Internal organization within each file

</decisions>

<specifics>
## Specific Ideas

- `estimateTokens(text: string): number` -- `Math.ceil(text.length / 4)`, non-throwing (returns 0 on error)
- `formatIdentitySection()` reads `USER.md` from `getIdentityDir()` path, returns null if file missing
- `formatProjectSection()` reads `PROJECT_PRIMER.md` from project root and `ACTIVE.md` from `getHandoffsDir()`, returns null if both missing
- `assembleFullContext()` accepts params: `{ db, project, projectDir, prompt?, config, checkpoint?, searchQuery? }` and returns `InjectPayload`
- `assembleRegularPrompt()` accepts params: `{ isPostCompaction, prompt, gauge?, topicShift?, db, project, projectDir, config, checkpoint? }` and returns `InjectPayload`
- Three-tier degradation wraps fullAssembly in try/catch: on DB error, try checkpoint-only; on that error, try identity-only; on that error, return empty
- Post-redaction reclaim: track which sections were skipped due to budget, after redaction check if freed tokens allow adding skipped sections
- Topic pivot learnings: use `searchObservations(db, newTopic, project, { limit: 3 })` to find relevant observations for the new topic

</specifics>

<deferred>
## Deferred Ideas

- **Adapter integration** -- Phase 8 (CC) and Phase 9 (OpenClaw) wire the assembler into their event handlers
- **Telemetry emission** -- Assembly should emit telemetry events (injection size, tier used, sections included); wired in Phase 8/9
- **Background work** -- Decision capture, thread update, checkpoint threshold check happen in adapters, not assembly
- **tiktoken-based estimation** -- Token estimator uses char/4 approximation; could upgrade to tiktoken for accuracy later
- **Dynamic budget adjustment** -- Budget could vary based on context window size (larger windows = larger budgets)
- **Caching** -- Identity and project sections rarely change; could cache across turns within a session

</deferred>

---

*Phase: 05-assembly-pipeline*
*Context gathered: 2026-03-12*
