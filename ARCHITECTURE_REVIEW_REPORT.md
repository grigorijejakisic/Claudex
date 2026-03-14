# Architecture Review Report

**Scope:** Full codebase (src/, 77 files, 12K lines)
**Date:** 2026-03-14 14:50 UTC
**Tool:** Gemini CLI (Google Gemini Advanced)
**Grade:** B+ (87/100)

## Dimension Scores

| Dimension | Score | Assessment |
|-----------|-------|------------|
| Architectural Coherence | 86/100 | Strong layer separation, but assembly has side effects (TTL/materialization writes during read) |
| Pattern Consistency | 88/100 | Excellent error handling consistency, minor drift in decay/intelligence layers |
| Structural Efficiency | 88/100 | Lean and purposeful, legacy fallback is transitional dead weight |
| Contract Alignment | 88/100 | Strong interfaces, but CC hooks ephemeral model breaks stateful contracts |
| Dependency Health | 85/100 | Good layering, but core layer has layer-inversion imports from extraction |

---

## Critical

### [ARCH] FINDING-ARCH-003 — Non-Idempotent Assembly (Hidden Side Effects)
**File:** src/assembly/assembler.ts:285
**Issue:** `assembleRegularPrompt` and `assembleFullContext` call `tickArtifactTTL(db)` and `materializeArtifacts(db)` — DB writes during what should be a pure read-render operation.
**Recommendation:** Move TTL ticking and materialization to turn-lifecycle events in lifecycle.ts.

### [CONTRACT] FINDING-CTR-003 — Duplicate User Exchanges from Ephemeral CC Hooks
**File:** src/intelligence/thread-tracker.ts:167, src/adapters/shared/lifecycle.ts:145
**Issue:** PostToolUse records user prompt (process A), then Stop records it AGAIN (process B) because in-memory `hasUserThisTurn` flag doesn't persist across processes.
**Recommendation:** Check last `key_exchanges` entry from DB before appending to prevent duplicates.

### [PATTERN] FINDING-PAT-006 — Missing Path-Length Validation in Extraction
**File:** src/extraction/extractor.ts:74
**Issue:** `validFiles` filter checks count but not individual string length — potential "path-bomb" observations.
**Recommendation:** Add per-string length validation.

### [DEPENDENCY] FINDING-DEP-001 — Layer Inversion (Core imports from Extraction)
**File:** src/core/decisions.ts:10, src/core/thread.ts:11
**Issue:** Core DB layer imports `redactContent` from extraction, breaking dependency direction. Also causes double-redaction.
**Recommendation:** Remove redaction from core layer, require callers to sanitize before persistence.

### [DEAD WEIGHT] FINDING-DWT-006 — Legacy Fallback Dead Weight
**File:** src/assembly/assembler.ts:254-325
**Issue:** Legacy budget-cascade (4 deprecated formatters + ~70 lines) only activates with <5 artifacts — threshold crossed almost immediately for active projects.
**Recommendation:** Decommission legacy path, rely exclusively on artifact-based assembly.

---

## Recommended

### [ARCH] FINDING-ARCH-001 — isPathSafe in Gauge Module (Leaky Abstraction)
**File:** src/gauge/token-gauge.ts:25
**Recommendation:** Move to src/shared/path-utils.ts or fs-helpers.ts.

### [ARCH] FINDING-ARCH-002 — Inconsistent Database Initialization in CLI
**File:** src/cli/migrate.ts, src/cli/dashboard.ts
**Recommendation:** Use openDatabase() consistently for production PRAGMAs.

### [ARCH] FINDING-ARCH-004 — sanitizeErrorForTelemetry in CC-hooks Infrastructure
**File:** src/adapters/cc-hooks/infrastructure.ts:133
**Recommendation:** Move to src/observability/telemetry.ts or src/shared/.

### [ARCH] FINDING-ARCH-006 — Milestone Detection Only in CC Hooks
**File:** src/adapters/cc-hooks/post-tool-use.ts:35
**Recommendation:** Move to lifecycle.ts so OpenClaw bridge also captures milestones.

### [CONTRACT] FINDING-CTR-002 — Topic Shift Cooldown Not Loaded in CC Hooks
**File:** src/adapters/cc-hooks/user-prompt-submit.ts:31
**Recommendation:** Load CooldownState from DB before creating TopicShiftDetector.

### [PATTERN] FINDING-PAT-001 — cachedPrepare Drift in Decay Layer
**File:** src/decay/decay-engine.ts:94
**Recommendation:** Use cachedPrepare instead of db.prepare for hot-path queries.

### [PATTERN] FINDING-PAT-002 — Observation Redaction Inconsistency
**File:** src/core/observations.ts:56
**Recommendation:** Add redactContent inside insertObservation to match decisions/thread pattern.

### [DEPENDENCY] FINDING-DEP-002 — Circular Type Dependency (core ↔ intelligence)
**File:** src/core/thread.ts:133, src/intelligence/topic-shift.ts:11
**Recommendation:** Move CooldownState to shared/types.ts to break cycle.

### [DEPENDENCY] FINDING-DEP-003 — Loader imports from Writer (read/write coupling)
**File:** src/checkpoint/loader.ts:12
**Recommendation:** Move writeCompressedFile to shared/fs-helpers.ts.

### [DEAD WEIGHT] FINDING-DWT-001 — Unused RuntimeEvent Types
**File:** src/shared/types.ts:105
**Recommendation:** Remove unused event union and payload interfaces.

### [DEAD WEIGHT] FINDING-DWT-002 — token-estimator.ts Passthrough Re-export
**File:** src/assembly/token-estimator.ts:7
**Recommendation:** Delete file, import directly from shared/text-utils.ts.

### [DEAD WEIGHT] FINDING-DWT-004 — Duplicated TOOL_KEY_FIELDS
**File:** src/intelligence/thread-tracker.ts:25
**Recommendation:** Import from TOOL_CATALOG in shared/tool-catalog.ts.

---

## Observations

### [ARCH] FINDING-ARCH-005 — Redundant Path Normalization Logic
### [ARCH] FINDING-ARCH-007 — Tight Coupling (thread.ts ↔ topic-shift.ts)
### [PATTERN] FINDING-PAT-003 — Positional vs Object Parameter Drift in lifecycle.ts
### [PATTERN] FINDING-PAT-004 — Fake Async in writeCompressedFile
### [PATTERN] FINDING-PAT-005 — Inconsistent Database Type Import Sources
### [DEAD WEIGHT] FINDING-DWT-003 — Dead hookToEventKind Variable
### [DEAD WEIGHT] FINDING-DWT-005 — Redundant try-catch in getDefaultConfig
### [DEPENDENCY] FINDING-DEP-004 — extractTopic Coupled to Heavy ThreadTracker Module
### [DEPENDENCY] FINDING-DEP-005 — Unused createArtifact/getObservationsByProject Imports
