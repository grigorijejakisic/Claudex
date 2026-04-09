---
paths:
  - "src/core/schema.ts"
  - "src/core/migrations/**"
---

# Schema & Migration Rules

## Current Schema: V15

33 tables total, migrations in `src/core/migration-steps.ts`.

### Recent Additions

**V15 (session 47)** — sqlite-vec foundation
- 5 vec0 virtual tables: `vec_artifacts`, `vec_patterns`, `vec_threads`, `vec_journal`, `vec_conversations`
- Each stores 1024-dim float embeddings (snowflake-arctic-embed2 native)
- Created via `migrateV14toV15()` which loads the sqlite-vec extension first
- Backed the Qdrant removal in Phase 5

**V14** — Incremental pattern extraction
- `sessions.extraction_cursor` (INTEGER, nullable) — last-processed turn per session
- `experience_patterns.needs_reembed` (INTEGER, default 0) — deferred re-embedding flag

**V13** — Critical Reminders tier
- `critical_rules` table for behavioral rule re-injection

**V12** — Session communication
- `session_signals` — stigmergic coordination (wip/failure/danger/claim/discovery)
- `angel_opinions` — CARA reasoning with confidence dynamics
- `solution_outcomes` — outcome tracking per pattern
- `entity_aliases` — entity name canonicalization
- `sessions.name`, `sessions.transferred_to`, `session_messages.sender_type`, `session_messages.request_id`

## Migration Conventions
- Always add new tables/columns — never drop existing ones (except in explicit cleanup migrations)
- Use `IF NOT EXISTS` for all CREATE TABLE/INDEX/VIRTUAL TABLE statements
- Use `ALTER TABLE ... ADD COLUMN` with try/catch (SQLite lacks `IF NOT EXISTS` for columns)
- Test migrations with a fresh DB (no existing data) and an existing DB (with data)
- Schema version lives in `PRAGMA user_version`; also tracked in `schema_versions` table for cross-version detection
- V14→V15 is a good example of a migration that requires loading a SQLite extension before running its DDL — see `migrateV14toV15()` for the pattern
