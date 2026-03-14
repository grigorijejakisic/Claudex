# Unified Code Review Report — RE-GRADE

**Scope:** Full codebase after 83 review fixes (uncommitted changes vs HEAD)
**Date:** 2026-03-14 02:15 UTC
**Grade:** F
**Perspectives:** Quality [OK], Acceptance [OK], Security [OK], General [PARTIAL — 2/6 chunks failed]

> **Re-grade context:** All 83 findings from the original F-grade review (12 original + 18 critical + 53 recommended) were fixed. This re-grade assesses the codebase in its current state. Findings below are NEW issues — mostly regressions introduced by fixes or residual gaps in incomplete fixes.

## Grading Rubric

| Grade | Criteria |
|-------|----------|
| A | No critical, <=2 recommended |
| B | No critical, 3-5 recommended |
| C | No critical, 6+ recommended OR 1 critical |
| D | 2-3 critical |
| F | 4+ critical |

**Grade justification:** 7 critical, 26 recommended, 19 observations. 5 of 7 criticals are regressions introduced by prior fixes; 2 are residual gaps.

---

## Critical

### [SECURITY] CRIT-01 — `wrapFileContent()` sentinel escape allows prompt injection
**File:** src/assembly/sections.ts:29-30
**Issue:** `wrapFileContent()` wraps file text in `<file-content>...</file-content>` markers without escaping. A poisoned file containing `</file-content>` breaks the data boundary and injects instructions that appear outside the wrapper during context assembly.
**Recommendation:** Encode payloads (JSON-string/base64) or escape sentinel sequences before embedding. Use per-block randomized delimiters.
**Origin:** C3 fix added data boundary wrappers but without escaping — residual prompt injection path.

### [SECURITY] CRIT-02 — UNC/device path bypass in cwd validation (Windows)
**File:** src/adapters/cc-hooks/infrastructure.ts:200
**Issue:** Fail-closed `cwd` validation checks `path.isAbsolute()` but still accepts UNC/device paths on Windows (e.g., `\\attacker\share`). Can trigger outbound SMB credential leaks and write session artifacts to remote storage.
**Recommendation:** Reject UNC/device prefixes, require local realpath, enforce `cwd` under allowlisted project root.
**Origin:** C5 fix changed fail-open to fail-closed but left UNC path gap — residual.

### [SECURITY] CRIT-03 — Hook command quoting is Windows-incompatible (shell injection)
**File:** src/cli/setup.ts:71
**Issue:** Hook command uses POSIX single-quote escaping (`'\''`), invalid in PowerShell/cmd.exe. Path characters like `&`/`|` are interpreted by Windows shells, creating command injection on the target platform.
**Recommendation:** Use platform-aware quoting or shell-neutral execution (executable + argv, no shell parsing).
**Origin:** C10 fix addressed POSIX shell injection but introduced Windows regression.

### [ACCEPTANCE] CRIT-04 — `migrateFromV2` fails on FTS shadow tables
**File:** src/core/migrations.ts:470
**Issue:** Narrowed catch block only allows `already exists` and `no such table` errors. SQLite returns `table may not be altered` for shadow tables and `there is already another table or index with this name` for rename conflicts — both abort the migration.
**Recommendation:** Proactively exclude non-renamable tables before `ALTER TABLE ... RENAME`, or broaden expected-error matching to include all known SQLite rename-conflict variants.
**Origin:** R11 narrowed broad catches — narrowed too aggressively, regression.

### [SECURITY] CRIT-05 — `fetchJsonWithTimeout` response size bypass via chunked transfer
**File:** src/shared/fetch-utils.ts:50
**Issue:** `maxResponseBytes` relies solely on `content-length` header. Server omitting or falsifying header (chunked transfer, compression) bypasses the check — `resp.json()` reads unbounded body, causing OOM.
**Recommendation:** Enforce byte limits via streaming body reader (`resp.body.getReader()`), count bytes incrementally, abort on limit.
**Origin:** R34 fix added header-based size checking only — residual bypass.

### [ACCEPTANCE] CRIT-06 — Grep quality gate rejects valid observations
**File:** src/extraction/quality-gate.ts:82
**Issue:** Gate now requires `output.content` for Grep observations, but grep payloads commonly use `matchCount` + `matches/files` with content synthesized later. Valid grep observations are silently dropped before extraction.
**Recommendation:** Gate on actual grep signal fields (`matches`, `files`, or non-empty `content`) instead of `content` alone.
**Origin:** R48 fix added context check — incomplete gate logic, regression.

### [ACCEPTANCE] CRIT-07 — Topic-shift detection suppressed in CC hooks
**File:** src/intelligence/topic-shift.ts:203
**Issue:** `computeAvgRecent()` returns `1.0` with empty history. Shift gate requires `avgRecent < 0.40`, which always fails. In CC hooks, the detector is stateless (recreated per invocation), so embedding-based topic-shift detection is effectively disabled on every call.
**Recommendation:** On empty history, bypass the `avgRecent` gate or persist embedding history across hook invocations.
**Origin:** R46 fix changed return from `0` to `1.0` — both values fail the gate, different failure mode.

---

## Recommended

### [ACCEPTANCE] REC-01 — Cooldown updated even when checkpoint creation fails
**File:** src/adapters/cc-hooks/user-prompt-submit.ts:41-52
**Issue:** `writeCheckpoint()` return value ignored; `updateCheckpointTracking()` called unconditionally. Failed checkpoint write still bumps cooldown.
**Recommendation:** Only update tracking when `result !== null`.

### [SECURITY] REC-02 — Enrichment validation permits non-string array elements
**File:** src/intelligence/enrichment.ts:159-175
**Issue:** Array sanitization truncates strings but doesn't filter non-string items. No array length cap.
**Recommendation:** Enforce strict type guards, cap array sizes, drop invalid entries.

### [ACCEPTANCE] REC-03 — Decision dedup limited to 100 allows old duplicates
**File:** src/intelligence/decision-capture.ts:188
**Issue:** Dedup checks only latest 100 decisions. Decisions beyond window can re-insert.
**Recommendation:** Add secondary dedup guard (fingerprint query beyond recent window).

### [SECURITY] REC-04 — Bridge adapter persists raw error strings in telemetry
**File:** src/adapters/openclaw-bridge/bridge-adapter.ts:241,314
**Issue:** CC hooks now sanitize errors but bridge callbacks still persist raw `String(e)`.
**Recommendation:** Centralize error sanitization in shared helper.

### [QUALITY] REC-05 — `updateCheckpointTracking` leaks unrelated state mutation
**File:** src/adapters/cc-hooks/user-prompt-submit.ts:52
**Issue:** Setting cooldown also overwrites `observation_count` to 0, coupling unrelated state.
**Recommendation:** Dedicated "set last checkpoint epoch" function.

### [GENERAL] REC-06 — Transcript path validation duplicated across modules
**File:** src/adapters/cc-hooks/infrastructure.ts:131 + src/gauge/token-gauge.ts:19
**Issue:** `isTranscriptPathSafe` re-implements path safety logic already in token gauge. Two passes per hook.
**Recommendation:** Centralize in one shared utility.

### [GENERAL] REC-07 — Fail-closed input validation has no test coverage
**File:** src/adapters/cc-hooks/infrastructure.ts:199
**Issue:** New fail-closed validation can silently drop hook work but tests don't exercise rejection.
**Recommendation:** Add wrapHook tests for invalid/missing fields.

### [GENERAL] REC-08 — `updateTopic()` has no caller (dead code)
**File:** src/intelligence/thread-tracker.ts:260
**Issue:** C17 added `updateTopic()` but no code path calls it. Topic shifts are detected but never persisted.
**Recommendation:** Wire `updateTopic(topicShift.newTopic)` into shift-handling paths.

### [GENERAL] REC-09 — Lifecycle comment contradicts ThreadTracker contract
**File:** src/adapters/shared/lifecycle.ts:137
**Issue:** New "single-event semantics" comment conflicts with `ThreadTracker` cross-event design.
**Recommendation:** Align comments and behavior.

### [ACCEPTANCE] REC-10 — `migrateV1toV2` fails on partial legacy DBs
**File:** src/core/migrations.ts:249-319
**Issue:** Enters V1-to-V2 path when `observations` exists but assumes `sessions`/`telemetry` also exist.
**Recommendation:** Add `hasTable()` checks per table before column migration.

### [QUALITY] REC-11 — Error matching uses brittle message substrings
**File:** src/core/migrations.ts:359,478,495
**Issue:** Selective catch/rethrow depends on `err.message.includes(...)` — fragile to driver wording.
**Recommendation:** Centralize robust SQLite error classification.

### [QUALITY] REC-12 — Adapter-column migration duplicated across paths
**File:** src/core/migrations.ts:528
**Issue:** Equivalent adapter-column logic in `migrateFromV2` and `migrateV1toV2`.
**Recommendation:** Consolidate into one shared step.

### [QUALITY] REC-13 — Dual version tracking (PRAGMA vs schema_versions)
**File:** src/core/migrations.ts:388-520
**Issue:** `PRAGMA user_version = 2` and `schema_versions` table coexist without mapping guarantees.
**Recommendation:** Document explicit mapping or consolidate.

### [SECURITY] REC-14 — Decision fingerprint generated from unredacted text
**File:** src/core/decisions.ts:44, src/intelligence/decision-capture.ts:207
**Issue:** Content is redacted before storage but fingerprint generated from unredacted text — sensitive tokens recoverable via fingerprint.
**Recommendation:** Generate fingerprint from redacted content.

### [ACCEPTANCE] REC-15 — Co-occurrence timeout guard removed
**File:** src/decay/decay-engine.ts:46-64
**Issue:** C16 rewrote query with `json_each` but removed per-call time budget. Unbounded execution during pruning.
**Recommendation:** Reintroduce hard execution bound.

### [SECURITY] REC-16 — `recoverFromDb()` path validation weaker than `loadCheckpoint()`
**File:** src/checkpoint/loader.ts:103-109
**Issue:** Recovery validates mirror paths via parent segment check while load uses stricter `isWithinDir()`. Inconsistent validation.
**Recommendation:** Unify mirror-path validation behind one policy.

### [ACCEPTANCE] REC-17 — Reclaim loop breaks after first candidate regardless of success
**File:** src/assembly/assembler.ts:283
**Issue:** Loop stops after first candidate meeting budget, even if re-validation fails. Later smaller candidates never considered.
**Recommendation:** Only `break` on successful reclaim.

### [ACCEPTANCE] REC-18 — `key_exchanges` filter throws on malformed data
**File:** src/checkpoint/writer.ts:302
**Issue:** `.filter((ex) => ex.role !== '__cooldown')` throws on null entry or non-string role, aborting checkpoint write.
**Recommendation:** Add runtime guards before role checks.

### [SECURITY] REC-19 — Token gauge symlink bypass on non-Windows
**File:** src/gauge/token-gauge.ts:31-39
**Issue:** `realpathSync.native` only used on Windows; Unix symlinks under home can point outside.
**Recommendation:** Resolve real paths on all platforms.

### [ACCEPTANCE] REC-20 — Swap fails on retry with stale `.pre-swap` file
**File:** src/cli/migrate.ts:201
**Issue:** Swap doesn't handle existing `.pre-swap` from interrupted prior run.
**Recommendation:** Detect and reconcile stale pre-swap path.

### [ACCEPTANCE] REC-21 — `sourceDb` not closed if WAL checkpoint throws
**File:** src/cli/migrate.ts:140
**Issue:** `sourceDb.close()` in same try block as pragma; no finally.
**Recommendation:** Wrap in try/finally.

### [QUALITY] REC-22 — Root path corruption in scope detector
**File:** src/shared/scope-detector.ts:96-98
**Issue:** Trailing-separator stripping can collapse `/` to `''` or `C:\` to `C:`, corrupting comparisons.
**Recommendation:** Special-case filesystem roots after stripping.

### [ACCEPTANCE] REC-23 — `posInt` validator accepts fractional values
**File:** src/shared/config.ts:164
**Issue:** Checks only finite and `> 0`; `0.5` passes. Downstream expects integer semantics.
**Recommendation:** Require `Number.isInteger(val)`.

### [QUALITY] REC-24 — `fs-helpers` changed from async to sync without updating callers
**File:** src/shared/fs-helpers.ts:33,82
**Issue:** `atomicWriteFile` and `writeJsonFile` changed to sync but callers still `await` them.
**Recommendation:** Make sync-ness explicit in naming or restore true async I/O.

### [ACCEPTANCE] REC-25 — Unbounded embedding batch before candidate cap
**File:** src/intelligence/decision-capture.ts:167-192
**Issue:** `MAX_CANDIDATES_PER_TURN` applied after `embedBatch` — full embedding work incurred before truncation.
**Recommendation:** Apply candidate cap before embedding/classification.

### [EFFICIENCY] REC-26 — `os.homedir()` + realpathSync recomputed per hook call
**File:** src/adapters/cc-hooks/infrastructure.ts:139
**Issue:** Synchronous filesystem work on every hook invocation.
**Recommendation:** Cache normalized home path at module init.

---

## Observations

1. **[ACCEPTANCE]** Path redaction misses `/Users/...` (macOS) — infrastructure.ts:180
2. **[GENERAL]** Rxx/Cx review tags in production code — infrastructure.ts:127
3. **[GENERAL]** Bridge nullable guard on non-null detector — bridge-adapter.ts:271
4. **[GENERAL]** Bridge constructs TopicShiftDetector directly vs factory — bridge-adapter.ts:127
5. **[GENERAL]** Manual truncation duplicates `truncateText()` — decision-capture.ts:77
6. **[GENERAL]** Enrichment length constants duplicate shared config — enrichment.ts:168
7. **[GENERAL]** Learnings cap hardcoded vs config — learnings-promoter.ts:10
8. **[EFFICIENCY]** Bridge topic-shift runs on every `onContext` in fallback — bridge-adapter.ts:267
9. **[EFFICIENCY]** Extra checkpoint-tracking write after checkpoint write — user-prompt-submit.ts:52
10. **[QUALITY]** Decay engine comment claims timeout guard that doesn't exist — decay-engine.ts:46
11. **[QUALITY]** `formatGaugeSection` signature change may break external callers — sections.ts:393
12. **[QUALITY]** Telemetry error-redaction duplicated in assembler — assembler.ts:225,253
13. **[QUALITY]** `sanitizeTopicText` doc/behavior mismatch — sections.ts:34
14. **[SECURITY]** Bash extractor stores full stderr unconditionally — bash.ts:29
15. **[SECURITY]** Checkpoint inject assumes `role` is string — inject.ts:53
16. **[QUALITY]** Extractor provenance encoded as string prefix — extractor.ts:141
17. **[GENERAL]** `fs-helpers` header mentions removed EPERM fallback — fs-helpers.ts:3
18. **[QUALITY]** `build.ts` hard-codes entrypoint lists — build.ts:5-26
19. **[GENERAL]** `isKnownTool` and `getToolDefinition` are separate lookup paths — tool-catalog.ts:113

---

## Analysis: Fix Regression Pattern

5 of 7 critical findings are **regressions introduced by prior fixes**:

| Critical | Origin Fix | What Went Wrong |
|----------|-----------|----------------|
| CRIT-01 | C3 (data boundary wrappers) | Wrappers added without escaping sentinels |
| CRIT-03 | C10 (shell injection escaping) | POSIX escaping invalid on Windows |
| CRIT-04 | R11 (narrow catch blocks) | Narrowed too aggressively for SQLite variants |
| CRIT-06 | R48 (grep gate context check) | Gate checks wrong field for grep payloads |
| CRIT-07 | R46 (computeAvgRecent return) | Changed 0→1.0, both values suppress detection |

2 are **residual gaps in incomplete fixes**:

| Critical | Origin Fix | What Was Missed |
|----------|-----------|----------------|
| CRIT-02 | C5 (fail-closed validation) | UNC/device paths not rejected |
| CRIT-05 | R34 (fetch body size limit) | Header-only check, no streaming enforcement |

**Pattern:** Fixes were applied mechanically without testing the fix itself against edge cases. The fix-verify cycle was: apply fix → build → run existing tests → pass. But existing tests didn't cover the fix's own edge cases.
