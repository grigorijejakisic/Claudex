# Full Multi-Model Code Review Report

**Scope:** Full codebase (src/, 77 source files)
**Date:** 2026-03-14
**Models:** Codex CLI (28/77 perspectives completed) + Gemini CLI (5/5 perspectives)

---

## Coverage

| Chunk | Files | Codex Quality | Codex Acceptance | Codex Other | Gemini |
|-------|-------|:---:|:---:|:---:|:---:|
| assembly | assembler.ts, sections.ts, token-estimator.ts | Done | Rate-limited | -- | Covered |
| bridge | bridge-adapter.ts, plugin-entry.ts, bridge-types.ts, lifecycle.ts | Done | Done | Rate-limited (5 perspectives) | Covered |
| checkpoint | inject.ts, loader.ts, writer.ts, types.ts | Done | Done | general (rate-limited) | Covered |
| cli | dashboard.ts, migrate.ts, setup.ts | Done | Rate-limited | -- | Covered |
| core-data | storage.ts, observations.ts, decisions.ts, thread.ts, pressure.ts | Done | Done | Rate-limited (5 perspectives) | Covered |
| core-new | artifacts.ts, checkpoint-tracking.ts, migrations.ts, learnings.ts, sessions.ts | Done | Rate-limited | -- | Covered |
| extraction | extractor.ts, scoring.ts, redaction.ts, quality-gate.ts, type-classifier.ts, bash.ts | Done | Done | Rate-limited (5 perspectives) | Covered |
| hooks | infrastructure.ts, post-tool-use.ts, user-prompt-submit.ts, stop.ts, session-start.ts, session-end.ts, pre-compact.ts | Done | Done | Rate-limited (5 perspectives) | Covered |
| intelligence | decision-capture.ts, enrichment.ts, topic-shift.ts, thread-tracker.ts, semantic-dedup.ts, learnings-promoter.ts | Done | Rate-limited | -- | Covered |
| shared | config.ts, fs-helpers.ts, scope-detector.ts, fetch-utils.ts, constants.ts, types.ts, tool-catalog.ts, paths.ts, db-stats.ts, text-utils.ts | Done | Done | security (Done) | Covered |
| support | decay-engine.ts, telemetry.ts, token-gauge.ts, embedding-provider.ts, templates.ts, gsd/state-reader.ts | Done | Rate-limited | -- | Covered |

**Summary:** 11 quality perspectives (all completed), 6 acceptance perspectives (completed), 5+ other perspectives hit Codex rate limits. Gemini provided full architectural coverage across all 5 dimensions.

---

## Codex Quality Scores (averaged across 11 chunks)

| Dimension | Assembly | Bridge | Checkpoint | CLI | Core-Data | Core-New | Extraction | Hooks | Intelligence | Shared | Support | **Average** |
|-----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| naming_quality | 82 | 84 | 82 | 84 | 86 | 84 | 89 | 84 | 87 | 86 | 82 | **84.5** |
| error_consistency | 69 | 62 | 66 | 61 | 68 | 61 | 66 | 71 | 71 | 71 | 66 | **66.5** |
| abstraction_fitness | 71 | 69 | 75 | 72 | 79 | 72 | 84 | 87 | 79 | 69 | 70 | **75.2** |
| logic_clarity | 67 | 73 | 70 | 76 | 74 | 67 | 71 | 78 | 73 | 73 | 68 | **71.8** |
| ai_generated_debt | 62 | 56 | 54 | 57 | 64 | 59 | 64 | 64 | 66 | 48 | 61 | **59.5** |
| type_safety | 64 | 58 | 61 | 68 | 71 | 63 | 72 | 65 | 76 | 62 | 74 | **66.7** |
| contract_coherence | 58 | 53 | 72 | 63 | 67 | 58 | 68 | 74 | 69 | 67 | 67 | **65.1** |

**Composite average: 70.0 / 100**

---

## Gemini Architecture Scores

| Dimension | Score | Assessment |
|-----------|:-----:|------------|
| Architectural Coherence | 86/100 | Strong layer separation; assembly has hidden side effects (TTL/materialization writes during read) |
| Pattern Consistency | 88/100 | Excellent error handling consistency; minor drift in decay/intelligence layers |
| Structural Efficiency | 88/100 | Lean and purposeful; legacy fallback is transitional dead weight |
| Contract Alignment | 88/100 | Strong interfaces; CC hooks ephemeral model breaks stateful contracts |
| Dependency Health | 85/100 | Good layering; core layer has layer-inversion imports from extraction |

**Gemini composite: 87/100 (Grade B+)**

---

## Cross-Model Findings (both models found independently)

These findings were identified by both Codex and Gemini independently, giving them the highest confidence:

### 1. [CODEX][GEMINI] Bridge Adapter Mutable Shared State -- Cross-Session Contamination
- **Files:** `src/adapters/openclaw-bridge/bridge-adapter.ts:202`
- **Severity:** Critical
- **Issue:** Bridge state is a single mutable global (`bctx.sessionId`, `bctx.cwd`, `bctx.project`) overwritten on each `onInit`. All callbacks read from the shared global instead of per-event `ctx.sessionKey/cwd`, creating cross-session contamination risk.
- **Both sources:** Codex bridge-acceptance FINDING-ACC-001 + bridge-quality quality-001; Gemini FINDING-CTR-003

### 2. [CODEX][GEMINI] Plugin Entry Premature Bridge Teardown
- **Files:** `src/adapters/openclaw-bridge/plugin-entry.ts:72`
- **Severity:** Critical
- **Issue:** `session_end` always unregisters the bridge and closes DB in `finally`, disabling the plugin after the first session end, even on early return with empty sessionId.
- **Both sources:** Codex bridge-acceptance FINDING-ACC-002; Gemini contract analysis

### 3. [CODEX][GEMINI] Checkpoint Loader Tautological Path Validation
- **Files:** `src/checkpoint/loader.ts:102-119`
- **Severity:** Critical
- **Issue:** `isWithinDir(resolvedMirror, mirrorParent)` is tautological because `mirrorParent` is `dirname(resolvedMirror)`. The only real gate is checking if parent contains 'checkpoints' segment.
- **Both sources:** Codex checkpoint-acceptance FINDING-ACC-002 + checkpoint-quality quality-001; Gemini FINDING-ARCH-003 context

### 4. [CODEX][GEMINI] Assembly Side Effects During Read
- **Files:** `src/assembly/assembler.ts:285`
- **Severity:** Critical
- **Issue:** `assembleRegularPrompt` and `assembleFullContext` call `tickArtifactTTL(db)` and `materializeArtifacts(db)` -- DB writes during what should be pure read-render operations.
- **Both sources:** Codex assembly-quality (abstraction fitness commentary); Gemini FINDING-ARCH-003

### 5. [CODEX][GEMINI] Layer Inversion -- Core Imports from Extraction
- **Files:** `src/core/decisions.ts:10`, `src/core/thread.ts:11`
- **Severity:** Recommended
- **Issue:** Core DB layer imports `redactContent` from extraction, breaking dependency direction and causing double-redaction.
- **Both sources:** Codex core-data quality commentary; Gemini FINDING-DEP-001

### 6. [CODEX][GEMINI] isPathSafe Symlink Escape on Nonexistent Targets
- **Files:** `src/shared/fs-helpers.ts:139-140`
- **Severity:** Critical
- **Issue:** `isPathSafe` falls back to unresolved path when `realpath` fails (new file), so a symlinked in-home directory pointing outside home is incorrectly accepted.
- **Both sources:** Codex shared-acceptance FINDING-ACC-001 + shared-quality quality-001; Gemini FINDING-ARCH-001 context

### 7. [CODEX][GEMINI] Artifact TTL Ticking Per Tool Call Instead of Per Turn
- **Files:** `src/adapters/shared/lifecycle.ts:163`
- **Severity:** Recommended
- **Issue:** Artifact TTL is decremented on every tool call, but the API contract says TTL ticking is turn-boundary behavior. Over-decrements in tool-heavy turns.
- **Both sources:** Codex bridge-acceptance FINDING-ACC-003; Gemini FINDING-ARCH-003

---

## Critical Findings

| # | ID | File:Line | Issue | Source |
|---|-----|-----------|-------|--------|
| 1 | CROSS-001 | bridge-adapter.ts:202 | Mutable shared global state causes cross-session contamination | [CODEX][GEMINI] |
| 2 | CROSS-002 | plugin-entry.ts:72 | Bridge teardown in `finally` disables plugin after first session end | [CODEX][GEMINI] |
| 3 | CROSS-003 | loader.ts:102 | Tautological path validation in checkpoint recovery | [CODEX][GEMINI] |
| 4 | CROSS-004 | assembler.ts:285 | Non-idempotent assembly -- DB writes during read-render | [CODEX][GEMINI] |
| 5 | CROSS-006 | fs-helpers.ts:139 | isPathSafe symlink escape on nonexistent targets | [CODEX][GEMINI] |
| 6 | CDX-CP-001 | loader.ts:65 | Gzip bomb: decompressed size checked after full decompression | [CODEX] |
| 7 | CDX-ASM-001 | sections.ts:570 | Unsanitized rationale interpolation enables prompt-shaping injection | [CODEX] |
| 8 | CDX-EXT-001 | extractor.ts:130 | Dedup compares pre-canonicalized content, bypassing storage normalization | [CODEX] |
| 9 | CDX-RED-001 | redaction.ts:68 | Base64 heuristic lets slash-heavy secrets bypass redaction | [CODEX] |
| 10 | GEM-PAT-006 | extractor.ts:74 | Missing per-string path-length validation (path-bomb risk) | [GEMINI] |
| 11 | GEM-DWT-006 | assembler.ts:254-325 | Legacy fallback dead weight (~70 lines, rarely activated) | [GEMINI] |
| 12 | CDX-MIG-001 | migrations.ts:511 | v2-to-v3 copy assumes v2 column names that may not exist | [CODEX] |
| 13 | CDX-DEC-001 | decay-engine.ts:90 | Co-occurrence LIKE matching without wildcard escaping | [CODEX] |
| 14 | CDX-DEC-002 | decay-engine.ts:143 | N+1 per-candidate DB queries during pruning | [CODEX] |

**Total critical: 14** (6 cross-model, 6 Codex-only, 2 Gemini-only)

---

## Recommended Findings

| # | ID | File:Line | Issue | Source |
|---|-----|-----------|-------|--------|
| 1 | CROSS-005 | decisions.ts:10, thread.ts:11 | Layer inversion: core imports from extraction | [CODEX][GEMINI] |
| 2 | CROSS-007 | lifecycle.ts:163 | Artifact TTL decremented per tool call, not per turn | [CODEX][GEMINI] |
| 3 | CDX-CP-002 | loader.ts:309 | Sync re-mirror does not update latest.yaml | [CODEX] |
| 4 | CDX-CP-003 | loader.ts:98 | Schema/version validation too loose (non-v3 accepted) | [CODEX] |
| 5 | CDX-ASM-002 | assembler.ts:240 | Fallback tiers bypass budget_tokens enforcement | [CODEX] |
| 6 | CDX-ASM-003 | assembler.ts:367 | Keyword extraction collapses to empty, matches all learnings | [CODEX] |
| 7 | CDX-ASM-004 | assembler.ts:361 | Core pivot path uses `any[]`, losing type safety | [CODEX] |
| 8 | CDX-ASM-005 | assembler.ts:235 | Top-level catch silently downgrades tiers without telemetry | [CODEX] |
| 9 | CDX-BRG-001 | plugin-entry.ts:23 | activate() swallows init failures without cleanup/telemetry | [CODEX] |
| 10 | CDX-BRG-002 | lifecycle.ts:237 | toolOutput type mismatch between bridge types and lifecycle | [CODEX] |
| 11 | CDX-BRG-003 | lifecycle.ts:417 | buildFlowEntry mixes session/project scoped data | [CODEX] |
| 12 | CDX-CP-004 | writer.ts:279 | key_exchanges cast without validating gist field | [CODEX] |
| 13 | CDX-CP-005 | loader.ts:326 | Remirroring uses inconsistent write methods | [CODEX] |
| 14 | CDX-CP-006 | writer.ts:404 | Bare catch blocks swallow write failures | [CODEX] |
| 15 | CDX-CLI-001 | dashboard.ts:380 | Operational failures returned as strings, exit 0 | [CODEX] |
| 16 | CDX-CLI-002 | dashboard.ts:120 | Query exceptions swallowed into empty results | [CODEX] |
| 17 | CDX-CLI-003 | dashboard.ts:51 | Arg parsing lets last positional win silently | [CODEX] |
| 18 | CDX-CLI-004 | setup.ts:88 | Hook ownership detected via substring heuristic | [CODEX] |
| 19 | CDX-CLI-005 | migrate.ts:283 | Already-upgraded DB reported as migration failure | [CODEX] |
| 20 | CDX-CLI-006 | setup.ts:68 | Broad type assertions on untrusted JSON | [CODEX] |
| 21 | CDX-COR-001 | thread.ts:41 | upsertThreadState uses INSERT OR REPLACE, silently clears fields | [CODEX] |
| 22 | CDX-COR-002 | thread.ts:113 | setCooldownState silently no-ops when row missing | [CODEX] |
| 23 | CDX-COR-003 | observations.ts:142 | FTS5 MATCH without query sanitization | [CODEX] |
| 24 | CDX-COR-004 | pressure.ts:34 | 4-positional parameter binding is fragile | [CODEX] |
| 25 | CDX-COR-005 | checkpoint-tracking.ts:42 | Unguarded JSON.parse on malformed data | [CODEX] |
| 26 | CDX-COR-006 | checkpoint-tracking.ts:66 | clear/mark asymmetry for tracking rows | [CODEX] |
| 27 | CDX-COR-007 | artifacts.ts:27 | ArtifactRow.artifact_type typed as string, not union | [CODEX] |
| 28 | CDX-COR-008 | artifacts.ts:153 | materializeArtifacts not scoped by project/session | [CODEX] |
| 29 | CDX-EXT-002 | scoring.ts:51 | Case-sensitive regex misses common variants | [CODEX] |
| 30 | CDX-EXT-003 | scoring.ts:54 | Test-failure regex also partially case-sensitive | [CODEX] |
| 31 | CDX-EXT-004 | redaction.ts:203 | Path normalization missing for Windows case/separator | [CODEX] |
| 32 | CDX-EXT-005 | quality-gate.ts:107 | Quality gate fails open, dispatcher fails closed (inconsistent) | [CODEX] |
| 33 | CDX-EXT-006 | extractor.ts:103 | exitCode cast to number without runtime check | [CODEX] |
| 34 | CDX-HK-001 | session-start.ts:15 | SessionStart creates session without adapter identity | [CODEX] |
| 35 | CDX-HK-002 | session-start.ts:42, user-prompt-submit.ts:99 | Injection telemetry emitted without adapter arg | [CODEX] |
| 36 | CDX-HK-003 | user-prompt-submit.ts:51 | jaccardShiftThreshold config not passed to detector | [CODEX] |
| 37 | CDX-HK-004 | session-start.ts:32, user-prompt-submit.ts:76 | Assembly called without sessionId | [CODEX] |
| 38 | CDX-HK-005 | post-tool-use.ts:17 | tool_input cast without runtime shape check | [CODEX] |
| 39 | CDX-HK-006 | user-prompt-submit.ts:22 | user_prompt force-cast to string | [CODEX] |
| 40 | CDX-HK-007 | infrastructure.ts:67 | Parsed stdin fields lack typeof enforcement | [CODEX] |
| 41 | CDX-HK-008 | infrastructure.ts:181 | Invalid input returns {} without telemetry | [CODEX] |
| 42 | CDX-INT-001 | learnings-promoter.ts:45 | Promotion inserts new rows when agent_id differs | [CODEX] |
| 43 | CDX-INT-002 | decision-capture.ts:234 | Top-level catch returns [] silently on all failures | [CODEX] |
| 44 | CDX-INT-003 | enrichment.ts:160 | Strict JSON parse rejects fenced/prose LLM output | [CODEX] |
| 45 | CDX-INT-004 | learnings-promoter.ts:61 | Partial object assertion bypasses required fields | [CODEX] |
| 46 | CDX-SH-001 | scope-detector.ts:29 | detectProjectScope does not validate projectId type | [CODEX] |
| 47 | CDX-SH-002 | fetch-utils.ts:60 | Response fully buffered before size check | [CODEX] |
| 48 | CDX-SH-003 | config.ts:85 | Multiple `as unknown as` casts bypass static safety | [CODEX] |
| 49 | CDX-SH-004 | scope-detector.ts:86 | normalizePath overly complex | [CODEX] |
| 50 | CDX-SH-005 | db-stats.ts:26 | Errors silently swallowed at multiple levels | [CODEX] |
| 51 | CDX-SUP-001 | telemetry.ts:43 | pruneTelemetry not wrapped in try/catch | [CODEX] |
| 52 | CDX-SUP-002 | embedding-provider.ts:62 | LAN option exposed but unreachable via constructor | [CODEX] |
| 53 | CDX-SUP-003 | telemetry.ts:94 | Unix path redaction misses /Users/ (macOS) | [CODEX] |
| 54 | GEM-ARCH-001 | gauge/token-gauge.ts:25 | isPathSafe in gauge module (leaky abstraction) | [GEMINI] |
| 55 | GEM-ARCH-002 | migrate.ts, dashboard.ts | Inconsistent database initialization in CLI | [GEMINI] |
| 56 | GEM-ARCH-004 | infrastructure.ts:133 | sanitizeErrorForTelemetry in wrong module | [GEMINI] |
| 57 | GEM-ARCH-006 | post-tool-use.ts:35 | Milestone detection only in CC hooks | [GEMINI] |
| 58 | GEM-CTR-002 | user-prompt-submit.ts:31 | Topic shift cooldown not loaded in CC hooks | [GEMINI] |
| 59 | GEM-PAT-001 | decay-engine.ts:94 | cachedPrepare not used for hot-path queries | [GEMINI] |
| 60 | GEM-PAT-002 | observations.ts:56 | Observation redaction inconsistency | [GEMINI] |
| 61 | GEM-DEP-002 | thread.ts:133, topic-shift.ts:11 | Circular type dependency (core <-> intelligence) | [GEMINI] |
| 62 | GEM-DEP-003 | loader.ts:12 | Loader imports from writer (read/write coupling) | [GEMINI] |

**Total recommended: 62**

---

## Observations

**Total observation-level findings: 23**

Top 5:

1. **CDX-CP-007** -- Thread section gated on `topic` only; summary/exchanges skipped when topic is null (`inject.ts:43`) [CODEX]
2. **CDX-COR-009** -- `markObservationsConsumed` prefetches IDs into Set but never uses Set contents (`observations.ts:200`) [CODEX]
3. **CDX-EXT-007** -- `sanitizePath` project-root matching is exact `startsWith` without path normalization (`redaction.ts:203`) [CODEX]
4. **GEM-DWT-001** -- Unused RuntimeEvent types in `types.ts:105` [GEMINI]
5. **GEM-DWT-002** -- token-estimator.ts is a passthrough re-export [GEMINI]

Additional observations from Gemini: redundant path normalization logic (ARCH-005), tight coupling thread<->topic-shift (ARCH-007), positional vs object parameter drift (PAT-003), fake async in writeCompressedFile (PAT-004), inconsistent DB type import sources (PAT-005), dead hookToEventKind variable (DWT-003), redundant try-catch in getDefaultConfig (DWT-005), extractTopic coupled to heavy ThreadTracker module (DEP-004), unused createArtifact/getObservationsByProject imports (DEP-005).

---

## Grade

### Grading Rubric Application

| Factor | Value | Assessment |
|--------|-------|------------|
| Critical findings | 14 | Significant -- includes security (isPathSafe, gzip bomb, prompt injection), correctness (session contamination, tautological validation), and data integrity issues |
| Recommended findings | 62 | High count, but many are contract tightening, type safety, and error consistency improvements rather than bugs |
| Cross-model agreement | 7 findings | High confidence -- both models independently found the same issues |
| Codex quality composite | 70/100 | Below-average on ai_generated_debt (59.5), contract_coherence (65.1), and error_consistency (66.5) |
| Gemini architecture composite | 87/100 | Strong architectural foundation despite specific issues |

### Scoring

- **Architecture & Design:** B+ (87/100, per Gemini)
- **Code Quality:** C+ (70/100, per Codex)
- **Security posture:** Needs attention (3 security-relevant criticals: isPathSafe symlink escape, gzip bomb guard, prompt injection via rationale interpolation)
- **Error handling:** Weakest dimension codebase-wide (66.5/100 average)

### Overall Grade: **B- (74/100)**

The codebase has a strong architectural foundation with clear module boundaries and good abstraction patterns. However, it is held back by: (1) 14 critical findings including security vulnerabilities and correctness bugs that need immediate attention; (2) pervasive AI-generated boilerplate debt (lowest dimension at 59.5/100) suggesting insufficient human refinement; (3) weak error consistency (66.5/100) with many silent catch blocks that hide operational failures; and (4) contract coherence gaps (65.1/100) where API behavior diverges from documented/implied promises.

**Priority fixes (in order):**
1. Bridge adapter mutable global state (session contamination risk)
2. isPathSafe symlink escape (security)
3. Gzip bomb decompression guard (security)
4. Sections.ts rationale injection (prompt safety)
5. Plugin entry premature teardown (reliability)
