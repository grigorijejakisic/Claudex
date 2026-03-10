# Phase 1: Storage Layer - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Fully operational SQLite database with complete v3 schema (9 tables + FTS5 + telemetry), CRUD modules for every table, FTS5 search with BM25 + temporal re-ranking, structured telemetry emission, scope-aware querying, and v2 migration SQL functions. Architecture Section 4 defines all schema, PRAGMAs, and file structure — this phase implements it.

</domain>

<decisions>
## Implementation Decisions

### CRUD Module API Design
- Plain functions that take `db: Database` as first parameter — no singletons, no class-based repositories
- Module structure follows Architecture Section 12: `src/core/storage.ts` (init/open/close), then per-table modules (`observations.ts`, `decisions.ts`, `thread.ts`, `learnings.ts`, `pressure.ts`, `sessions.ts`, `checkpoint-tracking.ts`)
- Each module exports functions like `insertObservation(db, obs)`, `getObservationsByProject(db, project)`
- The adapter layer manages connection lifecycle and passes `db` down
- Consistent with ClaudexCore interface from Architecture Section 3.1 — core is instantiated with capabilities and holds db reference internally

### FTS5 Temporal Re-Ranking Formula
- Exponential decay: `finalScore = bm25Rank * Math.exp(-ageDays / 30)`
- 30-day half-life — recent observations get strong boost, older ones fade but don't disappear
- Consistent with EI formula pattern from the decay engine (Architecture Section 9)
- Simple: one multiplication, easily tunable later via config

### Connection Lifecycle
- `openDatabase(path: string): Database` and `closeDatabase(db: Database): void` in `src/core/storage.ts`
- The adapter owns the lifecycle — storage module has no opinion about it
- CC hooks: open at start, close at end of each hook invocation (ephemeral)
- OpenClaw: keeps connection open for process lifetime
- No lazy init, no singleton

### v2 Migration Scope
- Phase 1 implements: migration SQL functions (`migrateFromV2(db, v2DbPath)` — actual data copy logic from Architecture Section 4.3)
- Phase 1 implements: `detectV2Database(): string | null` to find existing v2 databases
- Phase 1 does NOT build the interactive CLI prompt — that's Phase 8 (setup CLI wraps migration with user prompt, backup, confirmation)

</decisions>

<specifics>
## Specific Ideas

- FTS5 temporal decay formula explicitly chosen to match the EI pattern from the decay engine — keeps scoring approach consistent across the system
- "db as first param" pattern ensures testability: tests pass an in-memory database, no mocking needed
- Migration function is pure SQL logic, CLI is separate concern — clean separation for Phase 8 to consume

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-storage-layer*
*Context gathered: 2026-03-10*
