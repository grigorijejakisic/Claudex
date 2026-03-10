# Roadmap: Claudex v3

## Overview

Claudex v3 is a unified context management system delivering persistent LLM memory across sessions and compaction events, targeting both Claude Code (hooks) and OpenClaw (bridge plugin) from a single codebase. The roadmap progresses from foundational infrastructure (repo setup, storage) through core intelligence and assembly pipelines, into adapter-specific deployment, and concludes with integration testing and live deployment. Phases are organized into waves enabling parallel execution where dependencies allow.

## Phases

**Phase Numbering:**
- Integer phases (0-11): Planned implementation work aligned with ARCHITECTURE.md Section 14
- Decimal phases (e.g., 3.1): Urgent insertions if needed (marked with INSERTED)

**Wave Structure (parallel execution):**
- Wave 1: Phase 0 + Phase 1 (sequential foundation)
- Wave 2: Phase 2 + Phase 3 + Phase 6 + Phase 7 (4 parallel streams after storage)
- Wave 3: Phase 4 + Phase 5 (2 parallel streams after Wave 2)
- Wave 4: Phase 8 + Phase 9 (2 parallel streams after core complete)
- Sequential: Phase 10 then Phase 11

- [ ] **Phase 0: Repository Setup** - Project scaffolding, shared utilities, type system, build tooling
- [ ] **Phase 1: Storage Layer** - SQLite database, full schema, CRUD modules, FTS5, telemetry
- [ ] **Phase 2: Extraction Pipeline** - Per-tool observation extractors, redaction, quality gates
- [ ] **Phase 3: Intelligence Core** - Decision capture (regex stage), dedup, thread tracking, learnings
- [ ] **Phase 4: Intelligence v1.2** - Embeddings, enrichment, topic-shift detection, embedding classification
- [ ] **Phase 5: Assembly Pipeline** - Boundary-only injection, priority-budgeted sections, token estimation
- [ ] **Phase 6: Checkpoint System** - ULID IDs, DB-first state machine, 3-hop recovery, atomic writes
- [ ] **Phase 7: Supporting Subsystems** - Token gauge, decay engine, GSD state reader
- [ ] **Phase 8: CC Hook Adapter** - 6 hook entry points, stdin/stdout protocol, claudex setup CLI
- [ ] **Phase 9: OpenClaw Bridge Adapter** - globalThis registration, plugin activate(), bridge callbacks
- [ ] **Phase 10: Integration Testing** - End-to-end flows, performance SLAs, observability validation
- [ ] **Phase 11: Deployment** - Fresh install verification, optional v2 migration, monitoring

## Phase Details

### Phase 0: Repository Setup
**Goal**: A buildable, testable TypeScript project with the shared type system and utilities that all subsequent phases depend on
**Depends on**: Nothing (first phase)
**Requirements**: QUAL-01, QUAL-05
**Success Criteria** (what must be TRUE):
  1. `bun test` runs and passes on an empty test suite (build toolchain works)
  2. Shared types (RuntimeEvent, RuntimeCapabilities, InjectPayload) compile and are importable by any module
  3. Utility modules (paths, scope-detector, fs-helpers, text-utils) exist with defensive non-throwing error handling
  4. Project builds on both Windows and Linux without platform-specific workarounds (2-3 process.platform checks only)
**Plans**: TBD

Plans:
- [ ] 00-01: TBD
- [ ] 00-02: TBD

### Phase 1: Storage Layer
**Goal**: A fully operational SQLite database that any subsystem can store and query data against, with complete v3 schema and structured observability
**Depends on**: Phase 0
**Requirements**: STOR-01, STOR-02, STOR-03, STOR-04, STOR-05, STOR-06, STOR-07, STOR-08, OBSV-01, OBSV-02, OBSV-04, QUAL-04
**Success Criteria** (what must be TRUE):
  1. Running `claudex setup` on a clean machine creates a SQLite database with all v3 tables, indexes, and FTS5 virtual table
  2. Multi-step writes are atomic (interrupted mid-transaction produces zero partial state)
  3. FTS5 search returns relevant observations ranked by BM25 with temporal re-ranking
  4. Telemetry events can be emitted from any module and queried via standard SQL
  5. All queries filter by project scope (no cross-project data leakage)
**Plans**: TBD

Plans:
- [ ] 01-01: TBD
- [ ] 01-02: TBD
- [ ] 01-03: TBD

### Phase 2: Extraction Pipeline
**Goal**: Tool usage observations are automatically captured, scored, redacted, and stored with quality filtering
**Depends on**: Phase 1
**Requirements**: EXTR-01, EXTR-02, EXTR-03, EXTR-04, EXTR-05
**Success Criteria** (what must be TRUE):
  1. Each of the 10 tool types produces structured observations with correct category and importance score
  2. Secrets, absolute paths, and PII are redacted before storage (three-layer redaction)
  3. Low-signal observations (empty results, trivial reads) are filtered out by quality gates
  4. Stored observations include files_modified as valid JSON arrays
**Plans**: TBD

Plans:
- [ ] 02-01: TBD
- [ ] 02-02: TBD

### Phase 3: Intelligence Core
**Goal**: The system captures decisions, tracks conversation threads, deduplicates content, and promotes cross-session learnings -- all without requiring embeddings
**Depends on**: Phase 1
**Requirements**: INTL-01, INTL-03, INTL-04, INTL-05, INTL-06, INTL-07, INTL-09
**Success Criteria** (what must be TRUE):
  1. Regex-based decision capture identifies confirmed decisions across Claude, MiniMax, GLM, and DeepSeek model outputs
  2. Filler actions (reading, checking, navigation) are rejected as non-decisions
  3. Thread tracker maintains rolling topic, summary, and 8-exchange key_exchanges window
  4. Duplicate observations and decisions are detected and merged via 3-tier dedup (normalized exact, Jaccard, substring)
  5. Learnings accumulate promotion counts across sessions with max 50 per project
**Plans**: TBD

Plans:
- [ ] 03-01: TBD
- [ ] 03-02: TBD

### Phase 4: Intelligence v1.2
**Goal**: Embedding-powered intelligence enhances decision classification, topic-shift detection, and checkpoint enrichment when Ollama is available, with full graceful fallback
**Depends on**: Phase 3
**Requirements**: INTL-02, INTL-08, INTL-10, INTL-11, EMBD-01, EMBD-02, EMBD-03, EMBD-04
**Success Criteria** (what must be TRUE):
  1. With Ollama running, decision capture Stage 2 filters false positives via embedding classification (0.15 confidence threshold)
  2. Topic-shift detection fires when embedding similarity drops below 0.35 with avgRecent below 0.40
  3. LLM enrichment refines heuristic checkpoint data without dropping any heuristic entries (safety-net merge)
  4. When Ollama is unavailable, all embedding/enrichment features degrade gracefully (system still works, uses regex-only and Jaccard fallback)
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD

### Phase 5: Assembly Pipeline
**Goal**: Context is injected at session boundaries and topic shifts only, with priority-budgeted sections and near-zero overhead on regular turns
**Depends on**: Phase 4, Phase 6, Phase 7
**Requirements**: ASMB-01, ASMB-02, ASMB-03, ASMB-04, ASMB-05, ASMB-06, QUAL-02
**Success Criteria** (what must be TRUE):
  1. Full context assembly fires at session-start and post-compaction only (boundary-only injection)
  2. Topic-shift produces a micro-injection of max 800 tokens (pivot block)
  3. Assembly sections follow priority order: identity, checkpoint, learnings, decisions, pressure, GSD, FTS5, recent
  4. Most turns produce zero injection (gauge-only or empty), verified by telemetry
  5. Three-tier degradation works: full assembly, checkpoint-only, identity-only (never crashes)
**Plans**: TBD

Plans:
- [ ] 05-01: TBD
- [ ] 05-02: TBD

### Phase 6: Checkpoint System
**Goal**: Session state is reliably persisted and recoverable across crashes, compaction events, and session restarts
**Depends on**: Phase 1
**Requirements**: CHKP-01, CHKP-02, CHKP-03, CHKP-04, CHKP-05, CHKP-06, CHKP-07, CHKP-08, QUAL-03
**Success Criteria** (what must be TRUE):
  1. Checkpoint IDs are ULIDs (monotonic, collision-free under concurrent writers)
  2. DB-first write flow completes: INSERT pending, build YAML, UPDATE committed, enrich, write file, UPDATE mirrored
  3. Recovery chain restores state: DB first, then latest.yaml, then directory scan, then hop chain (3-hop)
  4. Checkpoint writes are debounced (60-second minimum between non-compaction writes)
  5. File writes are atomic (tmp + rename with Windows EPERM fallback)
**Plans**: TBD

Plans:
- [ ] 06-01: TBD
- [ ] 06-02: TBD

### Phase 7: Supporting Subsystems
**Goal**: Token utilization is tracked, stale data decays, and GSD planning state is surfaced in context
**Depends on**: Phase 1
**Requirements**: SUPP-01, SUPP-02, SUPP-03, SUPP-04, SUPP-05, SUPP-06
**Success Criteria** (what must be TRUE):
  1. Token gauge reports utilization from transcript JSONL (CC) or SDK (OpenClaw) with auto-detected context window size
  2. Token gauge injection appears at >= 70% utilization
  3. Decay engine calculates EI scores (importance * recency * access * co-occurrence) and soft-deletes entries over threshold
  4. GSD state reader surfaces .planning/ phase and plan status with +0.10 priority boost
**Plans**: TBD

Plans:
- [ ] 07-01: TBD
- [ ] 07-02: TBD

### Phase 8: CC Hook Adapter
**Goal**: Claudex v3 runs as Claude Code lifecycle hooks with a working setup CLI for fresh installs
**Depends on**: Phase 2, Phase 3, Phase 5, Phase 6, Phase 7
**Requirements**: ADPT-01, ADPT-02, ADPT-03, ADPT-07, ADPT-08
**Success Criteria** (what must be TRUE):
  1. All 6 CC hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop, PreCompact, SessionEnd) fire correctly and map to RuntimeEvent
  2. Each hook reads stdin JSON, processes via core pipeline, writes stdout JSON, and exits (ephemeral process lifecycle)
  3. `claudex setup` creates DB, patches ~/.claude/settings.json with hook paths, and offers optional v2 migration
  4. Adapter auto-detection correctly identifies CC environment
**Plans**: TBD

Plans:
- [ ] 08-01: TBD
- [ ] 08-02: TBD

### Phase 9: OpenClaw Bridge Adapter
**Goal**: Claudex v3 runs as an OpenClaw plugin via globalThis bridge registration
**Depends on**: Phase 2, Phase 3, Phase 5, Phase 6, Phase 7
**Requirements**: ADPT-04, ADPT-05, ADPT-06
**Success Criteria** (what must be TRUE):
  1. Bridge adapter registers via globalThis Symbol and receives callbacks from OpenClaw gateway
  2. Plugin activate() function installs correctly as a standard OpenClaw plugin
  3. OpenClaw capabilities are declared correctly (all fields from Section 3.1)
**Plans**: TBD

Plans:
- [ ] 09-01: TBD

### Phase 10: Integration Testing
**Goal**: The complete system works end-to-end on both adapters, meets performance SLAs, and produces queryable observability data
**Depends on**: Phase 8, Phase 9
**Requirements**: OBSV-03, PERF-01, PERF-02, PERF-03, PERF-04, QUAL-06
**Success Criteria** (what must be TRUE):
  1. Full CC hook flow (session-start through session-end) completes without errors and produces correct context injection
  2. Full OpenClaw bridge flow (init through compact) completes without errors
  3. Per-turn overhead stays under 600ms common case; injection turns under 1000ms
  4. Telemetry is queryable via SQL and answers "what did Claudex do on this turn?"
  5. Full vitest test suite passes covering all modules
**Plans**: TBD

Plans:
- [ ] 10-01: TBD
- [ ] 10-02: TBD

### Phase 11: Deployment
**Goal**: Claudex v3 is running in production on both adapters, verified on fresh installs, with predecessor systems archived
**Depends on**: Phase 10
**Requirements**: (no unmapped requirements -- deployment validates all prior phases)
**Success Criteria** (what must be TRUE):
  1. Fresh `claudex setup` on a clean Windows machine produces a fully operational CC hook system
  2. Fresh OpenClaw plugin install produces a fully operational bridge adapter
  3. Optional v2 migration completes successfully for existing Claudex users (data preserved, backup created)
  4. Both adapters verified independently for one week of real usage
**Plans**: TBD

Plans:
- [ ] 11-01: TBD

## Progress

**Execution Order:**
Wave 1: Phase 0 then Phase 1 (sequential)
Wave 2: Phase 2, Phase 3, Phase 6, Phase 7 (parallel after Phase 1)
Wave 3: Phase 4, Phase 5 (after Wave 2 dependencies met)
Wave 4: Phase 8, Phase 9 (parallel after core complete)
Then: Phase 10 then Phase 11 (sequential)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 0. Repository Setup | 0/2 | Not started | - |
| 1. Storage Layer | 0/3 | Not started | - |
| 2. Extraction Pipeline | 0/2 | Not started | - |
| 3. Intelligence Core | 0/2 | Not started | - |
| 4. Intelligence v1.2 | 0/2 | Not started | - |
| 5. Assembly Pipeline | 0/2 | Not started | - |
| 6. Checkpoint System | 0/2 | Not started | - |
| 7. Supporting Subsystems | 0/2 | Not started | - |
| 8. CC Hook Adapter | 0/2 | Not started | - |
| 9. OpenClaw Bridge Adapter | 0/1 | Not started | - |
| 10. Integration Testing | 0/2 | Not started | - |
| 11. Deployment | 0/1 | Not started | - |
