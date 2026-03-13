# Phase 7: Supporting Subsystems - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Three independent subsystems that support the assembly pipeline (Phase 5) and adapters (Phases 8-9): token utilization gauge, memory decay engine, and GSD planning state reader. These run at different lifecycle points -- gauge at before_prompt, decay at session_end, GSD state at checkpoint writes and assembly -- but share no internal dependencies.

Target modules:
- New: `src/gauge/token-gauge.ts` (transcript JSONL or SDK-derived token usage)
- New: `src/gauge/window-detector.ts` (auto-detect 200k vs 1M context window)
- New: `src/decay/decay-engine.ts` (EI formula + observation pruning + retention policy)
- New: `src/decay/pressure-decay.ts` (stratified half-life pressure score decay)
- New: `src/gsd/state-reader.ts` (.planning/ filesystem reader)
- New: `src/gsd/types.ts` (GSD state types)
- Existing: `src/core/pressure.ts` (Phase 1 -- `decayPressure()` will be replaced by stratified version)
- Existing: `src/core/observations.ts` (Phase 1 -- queried by decay engine for EI computation)
- Existing: `src/shared/types.ts` (TokenUsage interface already defined)
- Existing: `src/shared/config.ts` (ClaudexConfig with `gsd`, `observations`, `injection.gauge_threshold`)

</domain>

<decisions>
## Implementation Decisions

### Token Gauge: Parameter-Based Transcript Path
- Gauge module accepts transcript JSONL path as a parameter, does NOT discover it
- CC adapter (Phase 8) knows the session context and will pass the path
- Keeps the gauge adapter-agnostic: receives either `TokenUsage` (OpenClaw SDK path) or transcript path (CC JSONL path)
- Architecture Section 7.4: CC reads transcript JSONL tail for `message.usage.input_tokens`

### Token Gauge: Efficient Tail Reading
- Transcript JSONL files grow to megabytes during long sessions
- Read only the tail of the file (last ~8KB) to find the most recent assistant message with usage data
- Parse JSONL lines from the tail, find last line with `message.usage.input_tokens`
- Non-throwing: return null on any read/parse error

### Window Size Auto-Detection (Architecture Section 7.4)
- Default: 200,000 tokens
- 1M detection: if model is `claude-opus-4` or `claude-sonnet-4` AND observed tokens > 195,000
- Model name passed as optional parameter (from adapter or transcript metadata)
- Returns `contextWindowTokens` field of TokenUsage

### Pressure Decay: Replace Existing Function
- The existing `decayPressure()` in `src/core/pressure.ts` is a Phase 1 placeholder (simple multiplicative rate)
- Architecture Section 9.3 specifies stratified half-life decay, which replaces it
- New implementation in `src/decay/pressure-decay.ts` with the architecture's SQL
- Existing tests for `decayPressure()` will be updated to match new behavior
- The old function in pressure.ts will be replaced by an import/re-export from pressure-decay.ts, or the caller will import from the new location

### Decay Engine: EI Formula (Architecture Section 9.1)
- `EI = baseWeight x accessFactor x decayFactor x connectivityBonus`
- baseWeight: importance tier mapped (1->0.2, 2->0.4, 3->0.6, 4->0.8, 5->1.0)
- accessFactor: `1 + log2(1 + accessCount)` (diminishing returns)
- decayFactor: `2^(-age / effectiveHL)` where `effectiveHL = halfLife x (1 + 0.15 x accessCount)`
- Half-lives by importance: 1->7d, 2->14d, 3->60d, 4->90d, 5->365d
- connectivityBonus: `1.0 + 0.1 x min(coOccurrences, 5)` with 100ms query timeout guard

### Decay Engine: Pruning Rules (Architecture Section 9.2)
- Runs at sessionEnd
- Threshold: 1000 non-deleted observations (configurable via `observations.prune_threshold`)
- Prune count: soft-delete lowest 50 by EI (configurable via `observations.prune_count`)
- Immune observations: importance >= 5, OR (accessCount >= 3 AND lastAccessedAt within 180 days)
- Soft-delete: set `deleted_at_epoch` (not hard delete)

### Decay Engine: Retention Policy (Architecture Section 9.4)
- Hard delete soft-deleted observations older than `retention_days` (default 90)
- Hard delete non-deleted observations older than `retention_days` if importance < 5
- Configurable via `observations.retention_days`

### Pressure Score Decay: Stratified Half-Life (Architecture Section 9.3)
- HOT files: 7-day half-life
- COLD files: 3-day half-life
- Temperature re-classification after decay: HOT if pressure >= 0.851, else COLD
- Scores below 0.01 deleted (cleanup)
- Runs at sessionEnd alongside observation decay

### Co-Occurrence Timeout Guard
- The connectivity bonus query joins observations via `files_modified` JSON values
- This can be slow on large datasets
- Architecture specifies 100ms timeout guard
- Implementation: use SQLite's `sqlite3_progress_handler` or simply cap the query with a LIMIT and time check
- Fallback: connectivity bonus = 1.0 (no bonus) if query times out

### GSD State Reader: Read-Only Filesystem Access (Architecture Section 10)
- Reads `.planning/STATE.md` -> parse current phase number, plan number, status
- Reads `.planning/ROADMAP.md` -> parse all phases with goals, success criteria
- Reads `.planning/phases/{phase-dir}/*.md` -> plan files, count `- [x]` vs `- [ ]` checkboxes
- Returns structured GSD state for checkpoint `gsd:` field
- If `.planning/` doesn't exist: returns null (non-throwing)

### GSD Phase Boost (Architecture Section 10)
- When GSD is active, files mentioned in current phase's plan get +0.10 pressure boost
- Applied via `updatePressureScore()` from `src/core/pressure.ts`
- Boost is additive (not multiplicative) to existing pressure
- Caller (assembly pipeline or adapter) triggers boost application, GSD reader just provides the data

### File Locations
- `src/gauge/token-gauge.ts`: getTokenGauge() -- capability-aware, returns TokenUsage | null
- `src/gauge/window-detector.ts`: detectWindowSize() -- auto-detect 200k vs 1M
- `src/decay/decay-engine.ts`: computeEI(), pruneObservations(), applyRetentionPolicy()
- `src/decay/pressure-decay.ts`: decayPressureStratified() -- replaces Phase 1 placeholder
- `src/gsd/state-reader.ts`: readGsdState() -- filesystem reader
- `src/gsd/types.ts`: GsdState interface matching checkpoint gsd: field

### Claude's Discretion
- Exact JSONL tail-read buffer size (8KB suggested, but reasonable alternatives fine)
- JSONL line parsing implementation details
- EI computation helper function decomposition
- GSD markdown regex patterns for STATE.md/ROADMAP.md parsing
- Error logging/reporting within non-throwing functions
- Test fixture construction details
- Internal organization within each file

</decisions>

<specifics>
## Specific Ideas

- `getTokenGauge()` signature: `(params: { capabilities: RuntimeCapabilities; transcriptPath?: string; nativeUsage?: TokenUsage; model?: string }) => TokenUsage | null`
- When `hasNativeContextUsage` is true and `nativeUsage` is provided, return it directly (OpenClaw path)
- When `hasTranscriptAccess` is true and `transcriptPath` is provided, parse transcript JSONL tail
- `detectWindowSize()` signature: `(params: { model?: string; observedTokens?: number }) => number`
- Returns 200_000 by default, 1_000_000 if model matches and observed tokens > 195_000
- `computeEI()` is a pure function: takes observation fields, returns EI score (no DB access)
- `pruneObservations()` reads from DB, computes EI for all non-immune, soft-deletes lowest N
- `decayPressureStratified()` uses the SQL from Architecture Section 9.3 directly
- `GsdState` interface: `{ phase: number; plan: number; status: string; goal: string; success_criteria: string[]; completion: string }`
- GSD reader parses STATE.md with simple regex: `/Phase:\s*(\d+)/`, `/Plan:\s*(\d+)/`, `/Status:\s*(.+)/`

</specifics>

<deferred>
## Deferred Ideas

- **Assembly pipeline integration** -- Phase 5 consumes gauge output for injection decisions and GSD state for assembly sections
- **Hook adapter wiring** -- Phase 8 (CC) passes transcript path to gauge; Phase 9 (OpenClaw) passes native usage
- **Checkpoint writer integration** -- Already accepts `gsd` as optional param; Phase 7 GSD reader provides the data
- **Telemetry emission** -- Decay engine and gauge should emit telemetry events; wired in Phase 8/9 integration
- **Phase boost application** -- GSD reader provides file lists; caller (adapter/assembly) applies boost via updatePressureScore

</deferred>

---

*Phase: 07-supporting-subsystems*
*Context gathered: 2026-03-12*
