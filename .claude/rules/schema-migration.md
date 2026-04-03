---
paths:
  - "src/core/schema.ts"
  - "src/core/migrations/**"
---

# Schema & Migration Rules

## Current Schema: V12

### Key Tables (V12 additions)

| Table | Purpose |
|-------|---------|
| `session_signals` | Stigmergic coordination (wip, failure, danger, claim, discovery) |
| `angel_opinions` | CARA reasoning (opinions with confidence dynamics) |
| `solution_outcomes` | Outcome tracking (success/failure/partial per pattern) |
| `entity_aliases` | Entity name canonicalization |

### Key Column Additions (V12)
- `sessions.name` — Human-friendly session naming (project-sN-pid)
- `sessions.transferred_to` — Session transfer tracking
- `session_messages.sender_type` — Angel vs session vs system messages
- `session_messages.request_id` — Request/response linking

## Migration Conventions
- Always add new tables/columns — never drop existing ones
- Use `IF NOT EXISTS` for all CREATE TABLE/INDEX statements
- Use `ALTER TABLE ... ADD COLUMN` with try/catch (SQLite lacks `IF NOT EXISTS` for columns)
- Test migrations with a fresh DB (no existing data) and an existing DB (with data)
- Schema version lives in `PRAGMA user_version`
