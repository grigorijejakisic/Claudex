# Unified Code Review Report

**Scope:** Uncommitted changes (Evolved Flow implementation) — `git diff HEAD`
**Date:** 2026-03-20
**Grade:** F
**Perspectives:** Quality [OK], Acceptance [OK], Security [OK], General [OK], Reuse [OK], Efficiency [OK], Code-Health [FAILED: empty output on 2 attempts]

## Grading Rubric

| Grade | Criteria |
|-------|----------|
| A | No critical, <=2 recommended |
| B | No critical, 3-5 recommended |
| C | No critical, 6+ recommended OR 1 critical |
| D | 2-3 critical |
| F | 4+ critical |

**Tier counts:** 5 critical, 13 recommended, 8 observations

---

## Critical

### [QUALITY][ACCEPTANCE][SECURITY][GENERAL] Migration version bump is unconditional
**File:** src/core/migrations.ts:758
**Issue:** `runMigrations()` always sets `user_version = 8` even though individual migration steps are broadly non-throwing and can partially fail. This can permanently mark a partially-migrated DB as current, suppressing future repair attempts and leaving missing structures (FTS tables, triggers, columns) that degrade retrieval correctness and observability.
**Recommendation:** Make each migration return success/failure. Advance `user_version` incrementally per successful step. Only bump to target after post-checks verify required schema elements exist.

### [SECURITY][ACCEPTANCE][QUALITY][GENERAL] Cross-project session fallback in claudex_events
**File:** src/mcp/recall-server.ts:193-197
**Issue:** `claudex_events` falls back to the latest active session across all projects when no project-local session exists. The project-scoped query also does not filter by `status='active'`, so it can return completed sessions. This breaks project isolation: a caller in Project A can receive events from Project B (which may contain secrets, internal decisions, or sensitive prompts).
**Recommendation:** Filter project-scoped query by `status='active'` first. Remove cross-project fallback by default; if needed, require an explicit `cross_project=true` flag. Enforce `session.project === requestedProject` before returning events.

### [SECURITY] User prompt fragments stored without redaction
**File:** src/adapters/shared/lifecycle.ts:810
**Issue:** Verbatim user prompt fragments (first ~150 chars) are persisted as `user_framing` events, promoted into `recall_text` on journal entries, and returned by `claudex_search` output without redaction. If a user pastes credentials in a prompt, the sensitive text is stored and later exposed via search.
**Recommendation:** Apply secret/PII redaction before persisting prompt-derived fields and before returning recall hits. Prefer storing normalized topic labels over verbatim prompt text. Add denylist patterns for common secret formats (API keys, tokens, connection strings).

### [EFFICIENCY][GENERAL] Stop hook runs 3 full session_events reads per turn
**File:** src/adapters/cc-hooks/stop.ts:171-172
**Issue:** `Stop` (runs every assistant turn) now invokes `captureRecallFlowEntry` and `detectIdleSession`, both of which call `getSessionEvents` (full session load). Combined with existing summary synthesis, this yields 3 full `session_events` reads per turn. This scales with total session length and produces O(n^2)-ish behavior over long sessions.
**Recommendation:** Load events once in `Stop` and pass them to summary/recall/idle logic, or add specialized SQL for idle detection and recall inputs to avoid full-table materialization each time.

### [REUSE] FTS DDL duplicated in schema bootstrap and migration
**File:** src/core/migrations.ts:773, src/core/migrations.ts:234
**Issue:** `session_journal_fts` table and trigger SQL is duplicated in the fresh-schema DDL and again in the V7-to-V8 migration SQL. Changes to one will not propagate to the other, creating drift risk for a critical search feature.
**Recommendation:** Move journal FTS DDL into one SQL constant/helper and reuse it in both schema bootstrap and migration path.

---

## Recommended

### [QUALITY][ACCEPTANCE][GENERAL][EFFICIENCY][REUSE] Orphan recovery scope and timestamp issues
**File:** src/adapters/cc-hooks/session-start.ts:37-48
**Issue:** Orphan recovery closes all active sessions older than 1 hour globally (no project/adapter scope), which can terminate legitimate long-running concurrent sessions. It also stamps `ended_at_epoch` to the cutoff time rather than the actual close time, skewing timelines. Per-orphan reads/writes run without an explicit transaction.
**Recommendation:** Use last activity time (events/telemetry heartbeat) instead of creation time. Scope by adapter/project. Set `ended_at_epoch` to current time. Wrap processing in a single transaction. Skip summary synthesis when `session_summary` already exists.

### [ACCEPTANCE] Compaction can skip flow journal entry
**File:** src/adapters/shared/lifecycle.ts:865
**Issue:** `runCompactionSequence()` now calls only `captureRecallFlowEntry()`, which exits early when recall metadata is unavailable (`buildRecallMetadata()` returns null). Compaction can then produce no flow entry at all.
**Recommendation:** Keep enriched recall capture, but fall back to plain `captureFlowEntry()` when recall metadata is absent.

### [EFFICIENCY] captureRecallFlowEntry writes on every Stop call
**File:** src/adapters/shared/lifecycle.ts:783
**Issue:** A new `session_journal` flow row (plus FTS trigger write) is inserted on every assistant turn via `Stop`. This causes steady write amplification and journal growth on the hot path.
**Recommendation:** Gate writes to compaction/session-end/topic-shift only, or dedupe by content hash or time window before inserting.

### [EFFICIENCY] captureUserFraming runs count query on every prompt
**File:** src/adapters/shared/lifecycle.ts:803
**Issue:** `captureUserFraming` executes `SELECT COUNT(*)` on every `UserPromptSubmit`, even after the 3-framing cap is reached. This is 1 extra DB read per user prompt for the rest of the session.
**Recommendation:** Replace count with existence check (`LIMIT 1 OFFSET 2`) or persist a "framing cap reached" flag per session.

### [EFFICIENCY] Missing composite index on session_events
**File:** src/core/session-events.ts:89
**Issue:** `getSessionEvents` orders by `timestamp_epoch`, but schema indexes are `session_id` and `(project, timestamp_epoch)` only. Repeated `WHERE session_id ... ORDER BY timestamp_epoch` calls (now amplified by new Stop-path reads) incur extra sorting work.
**Recommendation:** Add composite index `(session_id, timestamp_epoch)` and optionally `(session_id, event_type, timestamp_epoch)` for framing queries.

### [REUSE][QUALITY][GENERAL] Migration steps V5-V6 and V6-V7 contain duplicated rebuild logic
**File:** src/core/migrations.ts:1056-1250
**Issue:** `migrateV5toV6` and `migrateV6toV7` both contain near-identical sessions and observations rebuild logic (probe, BEGIN/COMMIT, DROP/RENAME, index/trigger recreation), creating high drift risk (~220 lines removable).
**Recommendation:** Extract shared rebuild helpers (`rebuildSessionsWithNotNull`, `rebuildObservationsWithNotNull`) and call them from both migration steps with version-specific pre-steps only.

### [REUSE] searchJournalFTS reimplements query tokenization
**File:** src/core/journal.ts:120
**Issue:** `searchJournalFTS` re-implements query tokenization and punctuation stripping that already exists in shared search utilities.
**Recommendation:** Reuse `tokenizeQuery(query, maxTerms)` from `src/shared/search-utils.ts` so FTS query behavior stays consistent across artifacts, experience scoring, and journal search.

### [REUSE] Read-only tool sets duplicated across extractors
**File:** src/extraction/scoring.ts:29, src/extraction/type-classifier.ts:34
**Issue:** `READ_ONLY_TOOLS` in scoring and `ROUTINE_TOOLS` in type-classifier duplicate the same members.
**Recommendation:** Export a canonical `READ_ONLY_FILE_TOOLS` from `src/shared/tool-catalog.ts` and import it in both classifiers.

### [REUSE] Flow section metadata parse duplication
**File:** src/assembly/sections.ts:652
**Issue:** `formatFlowSection` re-parses `e.metadata` JSON inline, duplicating parse logic already added in `core/journal.ts`.
**Recommendation:** Use `parseJournalMetadata()` before rendering hints to centralize JSON parsing and error handling.

### [REUSE] CLAUDE.md rule extraction duplication
**File:** src/assembly/sections.ts:556
**Issue:** New CLAUDE.md rule extraction in `formatRulesReminderSection` duplicates existing CLAUDE.md reading/section extraction patterns from worker context assembly.
**Recommendation:** Extract shared CLAUDE.md parsing helpers into a shared utility and reuse in both worker-context and rules-reminder formatting.

### [QUALITY] BehavioralCounters last_loop_signal_epoch not deserialized
**File:** src/intelligence/experience-flags.ts:227
**Issue:** `BehavioralCounters` now includes `last_loop_signal_epoch`, but `getBehavioralCounters` does not deserialize it. `applyToolCallPattern` writes/reads this field, so cooldown state is not reliably persisted across turns.
**Recommendation:** Add `last_loop_signal_epoch` to the deserialization path in `getBehavioralCounters`.

### [GENERAL] Migration header docs are stale
**File:** src/core/migrations.ts:704
**Issue:** Migration header docs still describe old version semantics (`version 2 current`, `user_version = 3`), which no longer match v8 logic.
**Recommendation:** Update migration docs and version map to current reality.

### [GENERAL] New core behaviors lack direct tests
**File:** src/adapters/shared/lifecycle.ts (multiple functions)
**Issue:** New core behaviors (user framing capture, idle-session detection, orphan recovery, rules extraction, command summarization) appear untested directly.
**Recommendation:** Add focused unit/integration tests for these paths, especially timestamp-edge cases and cross-project/orphan scenarios.

---

## Observations

### [ACCEPTANCE][GENERAL] Idle detection uses second-resolution timestamps
**File:** src/adapters/shared/lifecycle.ts:842
**Issue:** Work-between filter uses strict `>` and `<` on `timestamp_epoch`. Events in the same second as compaction are excluded, potentially producing false "idle" warnings.
**Recommendation:** Use millisecond precision or event-id ordering with boundary-safe comparisons.

### [QUALITY][GENERAL] Mixed module style (require vs import)
**File:** src/assembly/sections.ts:558
**Issue:** `require('os')` inside an otherwise ESM-import module breaks local style consistency.
**Recommendation:** Use top-level ESM import (`import * as os from 'os'`).

### [GENERAL] V7-V8 migration comment mentions unimplemented column
**File:** src/core/migrations.ts:768
**Issue:** Comment claims addition of `concept_mention` to `session_events`, but the migration code does not implement that.
**Recommendation:** Align comment with code, or add the missing migration if intended.

### [GENERAL] node_modules test results in diff
**File:** node_modules/.vite/vitest/results.json
**Issue:** Generated test-result artifact is in the diff. High-churn, should not be source-controlled.
**Recommendation:** Add to `.gitignore`.

### [EFFICIENCY] CLAUDE.md rule extraction not cached
**File:** src/assembly/sections.ts:563
**Issue:** `formatRulesReminderSection` synchronously re-reads and re-parses global/project `CLAUDE.md` on each post-compaction assembly.
**Recommendation:** Cache extracted rules by file path + mtime in module scope.

### [EFFICIENCY] claudex_search runs dual pipeline unconditionally
**File:** src/mcp/recall-server.ts:73
**Issue:** `claudex_search` always runs both artifact search and journal FTS, then truncates merged results. Up to 2 full search pipelines per request.
**Recommendation:** Staged retrieval (query second source only for remaining slots) or unified merge strategy with a single effective limit.

### [SECURITY] Prompt injection persistence via CLAUDE.md rules
**File:** src/assembly/sections.ts:556
**Issue:** Post-compaction rule reinjection pulls broad bullet content from CLAUDE.md sections without trust gating. In an untrusted repo, a crafted project CLAUDE.md could plant persistent behavioral text.
**Recommendation:** Restrict extraction to an allowlisted section/schema, or require explicit trust for project-level reinjection.

### [REUSE] Bash command path scrubbing overlaps with existing redaction
**File:** src/core/session-events.ts:331
**Issue:** `summarizeBashCommand` has custom absolute-path scrubbing regex that overlaps with existing `sanitizePath()` logic.
**Recommendation:** Reuse `sanitizePath()` from `src/extraction/redaction.ts` to avoid diverging path normalization rules.
