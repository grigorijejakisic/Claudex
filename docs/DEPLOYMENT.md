# Claudex v3 Deployment Guide

Claudex v3 runs as Claude Code lifecycle hooks (CC adapter) or an OpenClaw bridge plugin (OpenClaw adapter). This guide covers fresh install, optional v2 migration, monitoring, and predecessor archiving.

## Prerequisites

**Common:**
- Node.js 20+ (runtime for hooks and setup CLI)
- bun 1.3+ (build toolchain)
- Git (to clone the repository)

**CC Hook Adapter:**
- Claude Code installed with hooks support
- `~/.claude/settings.json` writable

**OpenClaw Bridge Adapter:**
- OpenClaw gateway with plugin support
- Plugin directory accessible

**Optional:**
- Ollama with `nomic-embed-text` model for embedding-enhanced topic-shift detection and LLM enrichment. The system works without it via Jaccard similarity fallback and heuristic-only enrichment.

## CC Hook Adapter -- Fresh Install

### Steps

1. Clone the repository:
   ```
   git clone <repo-url> CLAUDEXv3
   cd CLAUDEXv3
   ```

2. Install dependencies:
   ```
   bun install
   ```

3. Build:
   ```
   bun run build
   ```
   This produces 8 CJS bundles in `dist/`:
   - `dist/adapters/cc-hooks/session-start.js`
   - `dist/adapters/cc-hooks/user-prompt-submit.js`
   - `dist/adapters/cc-hooks/post-tool-use.js`
   - `dist/adapters/cc-hooks/stop.js`
   - `dist/adapters/cc-hooks/pre-compact.js`
   - `dist/adapters/cc-hooks/session-end.js`
   - `dist/cli/setup.js`
   - `dist/adapters/openclaw-bridge/plugin-entry.js`

   `better-sqlite3` is marked external (native binding resolved at runtime from `node_modules/`).

4. Run setup:
   ```
   node dist/cli/setup.js
   ```

### What setup does

The setup CLI (`src/cli/setup.ts`) performs these operations:

1. Creates `~/.claudex/` directory structure (`db/`, `identity/`)
2. Initializes SQLite database at `~/.claudex/db/claudex.db` with full v3 schema (11 tables, FTS5, indexes, triggers)
3. Writes default `~/.claudex/config.json` (preserved if already exists)
4. Patches `~/.claude/settings.json` with 6 hook entries (preserves existing non-Claudex hooks)

### Expected output

```
Claudex v3 Setup
================

[OK] Directory structure created: C:\Users\<user>\.claudex
[OK] Database initialized: C:\Users\<user>\.claudex\db\claudex.db
[OK] Config written: C:\Users\<user>\.claudex\config.json
[OK] Hook paths registered in: C:\Users\<user>\.claude\settings.json

Setup complete! Claudex v3 is ready.
  - Database: C:\Users\<user>\.claudex\db\claudex.db
  - Config: C:\Users\<user>\.claudex\config.json
  - Hooks: 6 registered in C:\Users\<user>\.claude\settings.json
```

### Verification

- `~/.claudex/db/claudex.db` exists and is non-empty
- `~/.claude/settings.json` contains 6 Claudex hook entries: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `PreCompact`, `SessionEnd`
- Each hook entry has the format:
  ```json
  {
    "matcher": "",
    "hooks": [{ "type": "command", "command": "node /path/to/CLAUDEXv3/dist/adapters/cc-hooks/session-start.js" }]
  }
  ```
- Start a new Claude Code session. Claudex should initialize silently (no errors in terminal). After one session with tool use, verify `~/.claudex/db/claudex.db` has rows in the `observations` table.

## OpenClaw Bridge Adapter -- Plugin Install

### Build target

`dist/adapters/openclaw-bridge/plugin-entry.js` (CJS bundle)

### Steps

1. Build the project: `bun run build` (if not already done)
2. Copy or reference `dist/adapters/openclaw-bridge/plugin-entry.js` in OpenClaw's plugin configuration
3. Ensure `better-sqlite3` native binding is accessible from the OpenClaw runtime (`node_modules/better-sqlite3` must be resolvable)
4. The plugin exports an `activate(api)` function that:
   - Opens the Claudex database
   - Creates bridge callbacks (onInit, onContext, onToolResult, onTurnEnd, onCompact)
   - Registers on `globalThis[Symbol.for('claudex.v3.bridge')]`
   - Registers a `session_end` cleanup hook

### Verification

- OpenClaw gateway loads without errors
- Plugin registers on `globalThis` and receives callbacks
- Context injection appears at session start (onInit returns an `InjectPayload` with assembled context)
- After tool use, observations accumulate in the database

**Note:** OpenClaw is a separate project. Detailed plugin installation depends on the OpenClaw version and configuration format.

## Optional v2 Migration

For existing Claudex v2 users who want to preserve observation history.

### Prerequisites

- Existing v2 database at `~/.claudex/db/claudex.db` (or `~/.claudex/claudex.db`)
- v2 schema version < 300

### Process

1. Run `node dist/cli/setup.js` -- setup detects v2 database automatically
2. Setup displays v2 statistics (observation count, session count, pressure scores)
3. Prompt: `Migrate v2 data? [y/N]`
4. If accepted:
   - Backup created at `~/.claudex/db/claudex.db.v2-backup`
   - Migration runs atomically in a transaction

### Migration actions

Per Architecture Section 4.3.2:
- New v3 tables created (learnings, decisions, thread_state, checkpoint_tracking, checkpoint_meta, telemetry)
- Observations, sessions, and pressure_scores copied from v2
- Unused v2 tables archived (renamed with `_archived_` prefix)
- WARM pressure tier converted to COLD (v3 uses HOT/COLD only)
- `files_modified` converted from comma-separated text to JSON arrays
- Schema version set to 300

### Rollback

If v3 has issues after migration:

1. **Quick rollback**: Swap hook paths in `~/.claude/settings.json` back to v2 hook locations. v2 ignores `_archived_` tables and new v3 tables.
2. **Full rollback**: Restore from backup: copy `~/.claudex/db/claudex.db.v2-backup` to `~/.claudex/db/claudex.db`

### Non-interactive mode

If stdin is not a TTY (e.g., CI), the migration prompt is auto-declined. Setup proceeds with fresh v3 schema alongside existing data.

## Monitoring Checklist

After deployment, monitor for 1 week using these telemetry queries against `~/.claudex/db/claudex.db`.

### Error events (should be zero or near-zero)

```sql
SELECT event_kind, detail, timestamp_epoch
FROM telemetry
WHERE event_kind = 'error'
ORDER BY timestamp_epoch DESC
LIMIT 20;
```

### Observation capture rate (should show steady accumulation)

```sql
SELECT DATE(timestamp_epoch, 'unixepoch') AS day, COUNT(*) AS obs_count
FROM observations
WHERE deleted_at_epoch IS NULL
GROUP BY DATE(timestamp_epoch, 'unixepoch')
ORDER BY day DESC
LIMIT 7;
```

### Checkpoint write success (should show regular writes)

```sql
SELECT status, COUNT(*) AS count
FROM checkpoint_meta
GROUP BY status;
-- Expected: mostly 'mirrored', few or zero 'pending'
```

### Assembly latency distribution

```sql
SELECT event_kind,
  ROUND(AVG(latency_ms), 1) AS avg_ms,
  MAX(latency_ms) AS max_ms,
  COUNT(*) AS count
FROM telemetry
WHERE event_kind IN ('injection', 'hook_invocation')
GROUP BY event_kind;
-- Expected: hook_invocation avg < 100ms for regular turns, < 500ms for injection turns
```

### Session lifecycle completeness

```sql
SELECT status, COUNT(*) AS count
FROM sessions
GROUP BY status;
-- Expected: mostly 'completed', few 'active' (current session only)
```

### Learnings promotion (should accumulate over sessions)

```sql
SELECT content, promotion_count, first_seen_epoch
FROM learnings
ORDER BY promotion_count DESC
LIMIT 10;
```

### Hot files tracking

```sql
SELECT file_path, raw_pressure AS score, temperature
FROM pressure_scores
WHERE temperature = 'HOT'
ORDER BY raw_pressure DESC
LIMIT 10;
```

### Success indicators

- Zero crash-level errors in telemetry
- Observations accumulating daily
- Checkpoints writing and reaching 'mirrored' status
- Assembly latencies within SLA: regular turn < 100ms, full assembly < 500ms, aggregate per turn < 600ms
- Sessions completing normally (status = 'completed')
- Learnings promoting across sessions (promotion_count > 1)

## Archive Plan

After the 1-week monitoring period with no critical issues:

### 1. Claudex v2 (GitHub: Corleanus/claudex)

- Mark repository as archived on GitHub
- Add note in README: "Superseded by Claudex v3"
- Remove v2 hook paths from `~/.claude/settings.json` (setup already replaced them)

### 2. openclaw-context plugin

- Mark as superseded in OpenClaw's plugin registry
- Add note: "Replaced by Claudex v3 bridge adapter"

### 3. Archived v2 tables (if migration was run)

After 30 days of stable v3 operation, optionally drop archived tables:
```sql
DROP TABLE IF EXISTS _archived_reasoning_chains;
DROP TABLE IF EXISTS _archived_reasoning_fts;
DROP TABLE IF EXISTS _archived_consensus_decisions;
DROP TABLE IF EXISTS _archived_consensus_fts;
DROP TABLE IF EXISTS _archived_audit_log;
DROP TABLE IF EXISTS _archived_checkpoint_state;
DROP TABLE IF EXISTS _archived_schema_versions;
```

## Troubleshooting

### better-sqlite3 binding mismatch

**Symptom:** `Error: The module was compiled against a different Node.js version`

**Fix:** Rebuild the native binding for your Node version:
```
npm rebuild better-sqlite3
```
Or reinstall dependencies:
```
bun install
```

### settings.json format errors

**Symptom:** Claude Code reports hook configuration error

**Fix:** Verify `~/.claude/settings.json` has valid JSON. Run `node dist/cli/setup.js` again (idempotent -- it updates existing Claudex hooks in-place).

Expected hook structure:
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "node /path/to/CLAUDEXv3/dist/adapters/cc-hooks/session-start.js" }]
      }
    ]
  }
}
```

### Database lock errors

**Symptom:** `SQLITE_BUSY` or `database is locked`

**Cause:** Multiple processes accessing DB simultaneously without WAL mode

**Fix:** Verify DB was opened with WAL mode. Check with:
```sql
PRAGMA journal_mode;
-- Should return 'wal'
```
WAL mode is set automatically during `openDatabase()`. If the database was created without it, delete and re-run setup.

### Ollama not running (non-critical)

**Symptom:** Telemetry shows `embedding_unavailable` events; topic-shift detection and enrichment use fallback paths

**Impact:** System works correctly without Ollama. Topic-shift detection falls back to Jaccard similarity. Enrichment uses heuristic-only path (no LLM refinement).

**Fix (optional):**
```
ollama pull nomic-embed-text
ollama serve
```

### Setup fails with permission error

**Symptom:** `[ERROR] Setup failed: EACCES` or `EPERM`

**Fix:** Ensure write permissions to:
- `~/.claudex/` (database and config)
- `~/.claude/` (settings.json for hook registration)

### Hook not firing

**Symptom:** No observations being captured, context not injecting

**Debug steps:**
1. Check `~/.claude/settings.json` hook paths point to existing files in `dist/`
2. Test a hook directly: `echo '{}' | node dist/adapters/cc-hooks/session-start.js` -- should exit without error
3. Check `~/.claudex/db/claudex.db` exists (setup has been run)
4. Query telemetry for hook invocations:
   ```sql
   SELECT event_kind, detail, timestamp_epoch
   FROM telemetry
   WHERE event_kind = 'hook_invocation'
   ORDER BY timestamp_epoch DESC
   LIMIT 10;
   ```

### Config not taking effect

**Symptom:** Changed `~/.claudex/config.json` but behavior unchanged

**Fix:** Config is loaded on each hook invocation (CC hooks are ephemeral processes). Changes take effect on the next hook call. Verify config is valid JSON with `node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claudex/config.json','utf-8')))"`.
