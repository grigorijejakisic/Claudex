---
schema: claudex/handoff
version: 1
id: v3-artifact-architecture
session_id: session-8-2026-03-14
scope: project:claudex-v3
status: active
created_at: 2026-03-14T10:00:00Z
updated_at: 2026-03-14T11:00:00Z
---

# Handoff: Artifact-Based Context Assembly

**Priority: HIGH** (7 critical security/correctness findings from Codex review need fixing)

## Current State

Session 8 delivered a complete architecture overhaul: budget-cascade assembly replaced with reference + materialization model. **1210 tests passing**, 69 test files, build clean. Commit `cdb0594` on master.

### Architecture (NEW — Session 8)

Three-layer assembly pipeline replacing the old P1-P8 budget cascade:

| Layer | Purpose | Budget | Always? |
|-------|---------|--------|---------|
| **Structural** | Identity, project, checkpoint, session flow | ~500-800 tok | Yes |
| **Reference** | Packed artifact summaries (metadata only) | ~200-400 tok | When ≥10 artifacts |
| **Materialization** | FTS5-selected full content with provenance | ~2000-3000 tok | Query-driven |
| **Legacy fallback** | Old cascade (learnings, hot files, GSD, FTS5, recent) | ~2000 tok | When <10 artifacts |

Key design decisions:
- **Flow entries are always visible** — narrative spine with "why" for retrieval hints
- **TTL-based lifecycle** — fresh(3) → packed(0) → materialized(2) → packed. Lossless.
- **Compaction = packing, not loss** — data never deleted, just visibility-managed
- **Provenance + freshness** on all materialized content (source, age, session attribution)
- **Temporal awareness** in gauge (session duration, UTC time, compaction timing)
- Informed by IAM project artifact patterns (Teneral Agent Platform)

### New Modules (Session 8)

| Module | Purpose |
|--------|---------|
| `src/core/journal.ts` | Session journal CRUD (flow/milestone/summary entries) |
| `src/core/artifacts.ts` | Artifact CRUD + TTL lifecycle (8 functions) |
| `src/core/session-query.ts` | DB-first session context queries |
| `src/cli/migrate.ts` | `claudex migrate` CLI (v2→v3 automated migration) |

### Hook Integrations (Session 8)

| Hook | New Behavior |
|------|-------------|
| `lifecycle.ts` | `captureFlowEntry()` at compaction, `captureSessionSummary()` at session end |
| `post-tool-use.ts` | `detectMilestone()` + `captureMilestone()` for test/build/commit events |
| `assembler.ts` | Three-layer model + TTL tick every turn + provenance trust directives |
| `sections.ts` | `formatFlowSection`, `formatReferenceLayer`, `formatMaterializationLayer` + temporal gauge |

---

## 1. REMAINING WORK (Priority Order)

### 1.0 Codex Review Critical Findings (HIGH — 7 items)

From partial unified review (40/77 perspectives completed before Codex usage limit):

| # | Issue | File | Category |
|---|-------|------|----------|
| 1 | `wrapFileContent` doesn't escape sentinels — `wrapFileContentBoundary` exists but unused by project/session wrappers | sections.ts:34 | Security: prompt injection |
| 2 | WAL-unsafe backup — `copyFileSync` misses WAL data | migrate.ts:314 | Correctness: data loss |
| 3 | `verified_facts` table not in DDL — writer reads/writes but schema doesn't create it | writer.ts:440 | Contract: silently broken |
| 4 | Symlink bypass on non-Windows — `realpathSync` only on Windows | token-gauge.ts:32 | Security: path traversal |
| 5 | Co-occurrence double-counting — same observation counted multiple times | decay-engine.ts:89 | Correctness: inflated scores |
| 6 | Artifact content not redacted at write time — decision artifacts bypass redaction | decision-capture.ts:210 | Security: data exposure |
| 7 | Migrate CLI runs on v3 DBs and silently drops tables | migrate.ts:496 | Correctness: data loss |

**Also fixed this session:** duplicate path import, getProjectId arity, duplicate artifact creation.

### 1.1 Post-Compaction Mode Split (DONE)

Implemented in Wave 4 W4. Skips identity + primer on post-compaction (~780 token savings).

### 1.2 Token Telemetry Wiring (DONE)

Injection token estimates aren't logged to the telemetry table. Wire `tokenEstimate` and `sources` from `assembleFullContext`/`assembleRegularPrompt` return values into `emitTelemetry()`.

**Files:** `src/adapters/cc-hooks/user-prompt-submit.ts`, `src/adapters/cc-hooks/session-start.ts`

### 1.3 Re-Grade Recommended Findings (26 items) (LOW)

The re-grade review found 26 recommended improvements. None are critical. Top concerns:
- REC-08: `updateTopic()` dead code
- REC-10: `migrateV1toV2` fails on partial legacy DBs
- REC-14: Decision fingerprint from unredacted text
- REC-15: Co-occurrence timeout guard removed
- REC-22: Root path corruption in scope detector
Full list in `UNIFIED_REVIEW_REPORT.md`.

### 1.4 V2 Termination (LOW)

The `claudex migrate` CLI exists but hasn't been run. Steps:
1. Run `node dist/cli/migrate.cjs` against `~/.claudex/db/claudex.db`
2. Verify integrity
3. Delete/archive v2 project directory
4. Clean `~/.claudex/projects.json`

### 1.5 Artifact Population (DEFERRED)

The artifact system is built but no code currently CREATES artifacts from observations/learnings/decisions. The system works via legacy fallback (when artifacts < 10). Need to add artifact creation in:
- `post-tool-use.ts` — create artifacts from captured observations
- `lifecycle.ts` — create artifacts from promoted learnings
- `decision-capture.ts` — create artifacts from captured decisions

This is the bridge from "legacy data in existing tables" to "managed artifacts with TTL."

---

## 2. COMPLETED (Session 8)

- [x] Session journal table + CRUD (`journal.ts`, 20 tests)
- [x] Artifact model + TTL lifecycle (`artifacts.ts`, 33 tests)
- [x] Three-layer assembly pipeline (`assembler.ts` rewrite)
- [x] Reference + materialization section renderers with provenance
- [x] Flow capture at compaction, milestone detection at tool-use, summary at session-end
- [x] DB-first session protocol (`session-query.ts`, 17 tests)
- [x] `claudex migrate` CLI with --source/--dry-run/--force (22 tests)
- [x] 7 critical regression fixes with TDD (28 tests)
- [x] Temporal awareness in gauge (session duration, UTC time, compaction timing)
- [x] 83 unified review fixes from sessions 5-6
- [x] Embedding provider flaky test fixed

## 3. KEY FILES

| File | Purpose |
|------|---------|
| `src/assembly/assembler.ts` | Three-layer assembly orchestrator |
| `src/assembly/sections.ts` | 12+ section formatters including reference/materialization layers |
| `src/core/artifacts.ts` | Artifact CRUD + TTL lifecycle |
| `src/core/journal.ts` | Session journal CRUD |
| `src/core/session-query.ts` | DB-first session context queries |
| `src/cli/migrate.ts` | V2→V3 migration CLI |
| `src/adapters/shared/lifecycle.ts` | Flow capture + session summary |
| `src/adapters/cc-hooks/post-tool-use.ts` | Milestone detection + artifact capture |

## 4. ARCHITECTURE REFERENCE

Study `C:\Users\Grigorije\Desktop\Projects\Definitive IAM AI Tool` for artifact patterns:
- `base/agent_processor.py` — ToolProcessor with 3-tier categorization
- `utility_tools/artifacts_toolkit.py` — unpack_artifact state tool
- `base/utils.py` — format_packed_artifacts / format_unpacked_artifacts
- `docs - Documentation/architecture/DESIGN_PHILOSOPHY.md` — "Make the right thing easy"
