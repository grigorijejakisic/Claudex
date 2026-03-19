# Claudex Upgrades Spec — 6 Enhancements (Reviewed)

## Overview

Six upgrades to transform Claudex from keyword-reactive memory to task-aware, self-improving context intelligence. Combined, they close the gap between "memory system" and "brain."

Research: `context/reasoning/recall-v2-street-knowledge.md`
Gemini review: 2026-03-19 — 3 disagreements (explained), 10 fixes applied.

**Key architectural constraint**: CC hooks run as fresh Node.js processes per invocation. Cross-hook state MUST be DB-persisted. Claudex already handles this via `thread_state` table (`upsertThreadState` / `getThreadState`) — experience flags, cooldown state, and behavioral counters all survive across hooks through this mechanism.

---

## Upgrade 1+4 (Combined): Trigger Engine — Task-Aware Assembly + Predictive Patterns

### Problem
Assembly uses FTS5 against user prompts. Prompts like "/starthere" give FTS5 nothing. Experience patterns fire on prompt keywords, not on what the user is actually doing (editing a file, running a command).

### Solution
A unified trigger engine that matches tool input (file paths, commands) against stored triggers, surfacing relevant knowledge and warnings proactively.

### Schema
```sql
-- Trigger table: maps file globs and command patterns to knowledge domains
CREATE TABLE context_triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  glob_pattern TEXT,               -- e.g. 'src/core/migrations*'
  command_pattern TEXT,            -- e.g. 'bun test'
  knowledge_domain TEXT NOT NULL,  -- e.g. 'schema-migration'
  priority INTEGER NOT NULL DEFAULT 5,
  project TEXT NOT NULL DEFAULT '__global__'
);

-- Experience patterns: new columns for predictive matching
ALTER TABLE experience_patterns ADD COLUMN trigger_glob TEXT;
ALTER TABLE experience_patterns ADD COLUMN trigger_command TEXT;
```

### Behavior
PostToolUse (after observation extraction):
1. Load all trigger entries for project (small table — cache in-memory at hook start)
2. Match `tool_input.file_path` against `glob_pattern` entries (app-level, not SQL GLOB)
3. Match Bash `command` against `command_pattern` entries (substring, app-level)
4. Match file path against `experience_patterns.trigger_glob` (hard cap: 50 active patterns max)
5. All matched artifact IDs + pattern IDs persisted to `thread_state` via existing `setExperienceFlags`
6. UserPromptSubmit: read pending trigger matches from thread_state, query matched domains via FTS5 (Upgrade 3), inject alongside regular FTS5 results

### Trigger Population
- Auto: files edited 3+ times across sessions → auto-create trigger entry
- Auto: experience patterns get `trigger_glob` extracted from the file paths in the originating observation
- Manual: `claudex trigger add 'src/daemon/**' daemon-architecture`

### Budget
Trigger context shares the existing injection budget — no new budget. PostToolUse matching: <10ms (small table, app-level matching).

---

## Upgrade 2: MCP Server for On-Demand Recall

### Problem
Workers get context injected once at spawn. Mid-task search requires a tool they don't have.

### Solution
MCP server exposing Claudex DB as 4 tools. Workers and agents can query on demand.

### Tools
| Tool | Purpose | Params |
|------|---------|--------|
| `claudex_search` | Hybrid FTS5 search across all artifacts | `query`, `project?`, `limit?` |
| `claudex_recall` | Retrieve specific artifact by ID or ref | `id` or `artifact_ref` |
| `claudex_store` | Save a decision or learning | `content`, `type`, `project` |
| `claudex_events` | Query session events | `project`, `since_epoch?`, `entity?` |

### Implementation
- Node.js MCP server process
- Opens DB **read-write** (WAL mode supports concurrent writer + readers)
- `busy_timeout = 3000` for write contention
- `project` defaults to CWD-derived scope when not specified (same as `getProjectId`)
- Registered in `~/.claude/settings.json` as MCP server
- Workers automatically get MCP tools when spawned

---

## Upgrade 3: Unified FTS5 for All Artifact Content

### Problem
File artifacts searched via LIKE (full table scan). Observations via FTS5. Two paths, one slow.

### Solution
`artifacts_fts` virtual table indexing all artifact summary + content.

### Schema
```sql
CREATE VIRTUAL TABLE artifacts_fts USING fts5(
  summary,
  content,
  content=artifacts,
  content_rowid=id,
  tokenize='porter unicode61'
);

-- Sync triggers
CREATE TRIGGER artifacts_fts_insert AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, summary, content)
  VALUES (new.id, new.summary, COALESCE(new.content, ''));
END;
CREATE TRIGGER artifacts_fts_update AFTER UPDATE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, summary, content)
  VALUES ('delete', old.id, old.summary, COALESCE(old.content, ''));
  INSERT INTO artifacts_fts(rowid, summary, content)
  VALUES (new.id, new.summary, COALESCE(new.content, ''));
END;
CREATE TRIGGER artifacts_fts_delete AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, summary, content)
  VALUES ('delete', old.id, old.summary, COALESCE(old.content, ''));
END;
```

### Search (replaces Stage 2 LIKE)
```sql
SELECT a.*, bm25(artifacts_fts, 2.0, 1.0) as rank
FROM artifacts a
JOIN artifacts_fts fts ON fts.rowid = a.id
WHERE artifacts_fts MATCH ?
ORDER BY
  CASE a.artifact_type
    WHEN 'decision' THEN 0
    WHEN 'learning' THEN 1
    WHEN 'memory_file' THEN 2
    WHEN 'observation' THEN 3
    ELSE 4
  END,
  rank
LIMIT ?
```

**Note**: `bm25()` returns negative values (more negative = better match). `ORDER BY rank` ascending is correct. `observations_fts` retained — it indexes observations including those below the importance gate that never become artifacts. Different data, not double indexing.

### Migration
- Add FTS5 table + triggers in next schema migration
- Backfill: `INSERT INTO artifacts_fts SELECT id, summary, COALESCE(content, '') FROM artifacts`

---

## Upgrade 5: Retrieval Feedback Loop

### Problem
Injected context has no feedback signal. Search quality can't improve.

### Solution
Implicit feedback scoring from Stop hook data. No explicit user rating needed.

### Schema
```sql
ALTER TABLE artifacts ADD COLUMN retrieval_score REAL NOT NULL DEFAULT 1.0;
```

### Signals (detected at Stop hook)
| Signal | Detection | Score Delta |
|--------|-----------|-------------|
| **Referenced** | Assistant output (first 500 tokens) contains keywords from injected artifact | +0.1 |
| **Correction after injection** | User correction on topic matching injected context | -0.2 |
| **Session success** | Session ends without corrections after injection | +0.05 for all injected |

**No "Ignored" penalty.** Preventative patterns ("never use bun test") succeed precisely when they DON'T appear in the output. Penalizing zero overlap would destroy the most valuable patterns.

### Score Update
```
retrieval_score = retrieval_score * 0.95 + signal * 0.05
```
Clamped to [0.1, 3.0]. Artifacts with `retrieval_score < 0.3` deprioritized in search.

### Budget
Stop hook comparison: Jaccard similarity on first 500 tokens of assistant output vs injected artifact summaries. <50ms.

---

## Upgrade 6: Cross-Session Thread Reconstruction

### Problem
Thread state dies with the session. Handoffs are manually written. The DB has all the data but doesn't synthesize it.

### Solution
Structured events table + pre-computed session summary at session end.

### Schema
```sql
CREATE TABLE session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  event_type TEXT NOT NULL,  -- no CHECK constraint (TypeScript types only)
  entity TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_session_events_session ON session_events(session_id);
CREATE INDEX idx_session_events_project ON session_events(project, timestamp_epoch);
```

**Event types** (enforced in TypeScript, not SQL): `file_edit`, `file_create`, `file_delete`, `test_run`, `build`, `decision`, `error`, `topic_shift`.

### Event Capture (PostToolUse)
- Edit/Write → `file_edit`/`file_create` with file path
- Bash with test keywords → `test_run` with pass/fail
- Bash with build keywords → `build` with success/error
- Decision capture → `decision` event

Lightweight extraction alongside existing observation logic. <5ms additional.

### Summary Generation (Stop hook / endsession)
At session end, synthesize events into a one-paragraph summary:
```
"Session 18: edited migrations.ts (3x), file-ingester.ts (new), ran tests (2x, all pass),
decided async file I/O, topic shifted from daemon cleanup to Recall to spec writing."
```
Store in `sessions` table as `session_summary` column. Pre-computed, not generated at session-start.

### Reconstruction (SessionStart)
Read pre-computed summary — sub-millisecond SELECT:
```sql
SELECT session_summary FROM sessions
WHERE project = ? AND status != 'completed'
ORDER BY created_at_epoch DESC LIMIT 1
```
Inject as "Last Session" section in assembly.

---

## Implementation Order (Gemini-revised)

| Phase | Upgrade | Complexity | Why this order |
|-------|---------|-----------|----------------|
| 1 | **3. Unified FTS5** | Small | Foundation — all search improvements depend on this |
| 2 | **2. MCP Server** | Medium | Debugging lens into DB for testing subsequent upgrades |
| 3 | **1+4. Trigger Engine** | Medium | Unified trigger engine (file globs + command patterns + predictive patterns) |
| 4 | **6. Session Events** | Medium | Most new code, benefits from FTS5 + MCP for testing |
| 5 | **5. Feedback Loop** | Medium | Last — needs preventative penalty design validated first |

Total estimated: 4-6 sessions across all upgrades.
