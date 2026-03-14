# V2 Termination Report
Date: 2026-03-13

## Status Summary

V2 is substantially ready for decommission but not fully terminated. The critical v2 hooks in
`~/.claude/settings.json` have already been replaced with v3 equivalents (6 v3 hooks present,
no v2 references). However, the legacy `~/.claudex/hooks/*.cmd` dispatch files still point to
`Claudex v2\Claudex\dist\*.mjs` paths — these are dead on next hook fire since `claudex migrate`
has not yet been run for the database. The v2 project directory exists and is intact. The v3
codebase contains zero problematic v2 path references; all "v2" occurrences in `src/` are
intentional migration support code (schema detection, data import, upgrade-in-place).

---

## Automated (Migration Handles)

Running `claudex migrate` will handle:
1. Detect `~/.claudex/db/claudex.db` (schema version 7, confirmed v2 — below threshold 300)
2. Create backup at `~/.claudex/db/claudex.db.v2-backup`
3. Initialize a fresh v3 schema (SCHEMA_VERSION 300) in a temp file
4. Run `migrateFromV2()` — copies `observations`, `sessions`, `pressure_scores` into v3 tables,
   converts comma-separated `files_modified` values to JSON arrays, archives unknown tables
5. Verify integrity: count parity + valid JSON + schema_versions contains 300
6. Atomic swap: rename temp DB to `claudex.db` (removing old file first on Windows)
7. Retains `.v2-backup` file for safety

The `claudex setup` command would also offer interactive migration if run again, but `claudex migrate`
is the dedicated non-interactive path.

---

## Already Done

- **settings.json hooks**: All 6 v3 hooks are registered pointing to
  `CLAUDEXv3\dist\adapters\cc-hooks\*.cjs`. No v2 hook entries remain in settings.json.
- **v3 hook events covered**: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PostToolUse`,
  `PreCompact`, `Stop` — full parity with v2 event surface.
- **v3 codebase**: Zero references to the v2 project directory in `src/`. All v2 mentions are
  migration support logic (correct, intentional).

---

## User Manual Actions Required

### 1. Run database migration
```
cd C:\Users\Grigorije\Desktop\Projects\CLAUDEXv3
node dist/cli/migrate.cjs
```
(Or `bun run migrate` if the package.json script is wired up.)

This is the only mandatory step before shutting down v2.

### 2. Update projects.json status
Edit `C:\Users\Grigorije\.claudex\projects.json` manually:
- Change `claudex-v2` entry `"status"` from `"active"` to `"archived"`
- Optionally change `claudex` entry (already `"archived"`) — no change needed

Exact edit:
```json
"claudex-v2": {
  ...
  "status": "archived"
}
```

### 3. Update the legacy .cmd hook stubs (optional, low priority)
The files `~/.claudex/hooks/*.cmd` still point to V2 paths:
- `session-start.cmd` → `Claudex v2\Claudex\dist\session-start.mjs`
- `session-end.cmd` → `Claudex v2\Claudex\dist\session-end.mjs`
- `post-tool-use.cmd` → `Claudex v2\Claudex\dist\post-tool-use.mjs`
- `pre-compact.cmd` → `Claudex v2\Claudex\dist\pre-compact.mjs`
- `pre-flush.cmd` → `Claudex v2\Claudex\dist\pre-flush.mjs`
- `user-prompt-submit.cmd` → `Claudex v2\Claudex\dist\user-prompt-submit.mjs`

These `.cmd` files are no longer invoked by Claude Code (which uses the settings.json hooks
pointing to v3 `.cjs` files directly). They are dead code. They can be left as-is, deleted, or
updated — they do not affect v3 operation.

The `.ps1` files (`sessionstart.ps1`, `sessionend.ps1`, `precompact.ps1`) are v2-era PowerShell
scripts that implement their own logic directly (no path references to v2 dist files). They are
also no longer invoked by Claude Code.

### 4. Delete or archive the V2 project directory (optional, after migration verified)
After migration is confirmed successful:
```
# Verify backup exists first
ls "C:\Users\Grigorije\.claudex\db\claudex.db.v2-backup"

# Then optionally archive or delete:
# Move-Item "C:\Users\Grigorije\Desktop\Projects\Claudex v2" "C:\Users\Grigorije\Desktop\Projects\Claudex v2 (archived)"
```
Do NOT delete until migration is verified.

---

## Verification Steps

After running `claudex migrate`:

1. **Check schema version is 300**:
   ```
   node -e "const D=require('better-sqlite3'); const db=new D('C:/Users/Grigorije/.claudex/db/claudex.db',{readonly:true}); console.log(db.prepare('SELECT MAX(version) as v FROM schema_versions').get()); db.close()"
   ```
   Expected: `{ v: 300 }`

2. **Confirm backup exists**:
   ```
   ls "C:\Users\Grigorije\.claudex\db\claudex.db.v2-backup"
   ```

3. **Confirm row counts are non-zero** (if v2 had data):
   ```
   node -e "const D=require('better-sqlite3'); const db=new D('C:/Users/Grigorije/.claudex/db/claudex.db',{readonly:true}); console.log('obs:', db.prepare('SELECT COUNT(*) as c FROM observations').get().c, 'sess:', db.prepare('SELECT COUNT(*) as c FROM sessions').get().c); db.close()"
   ```

4. **Verify v3 hooks fire correctly** by starting a new Claude Code session and checking
   `~/.claudex/hooks/logs/` for fresh log entries from the v3 hooks.

5. **Confirm projects.json** has `claudex-v2` status as `"archived"`.

---

## Codebase V2 References Audit

Searched `src/` for: `claudex-v2`, `Claudex v2`, `v2` (case-insensitive), `.mjs` imports.

**Files with v2 references (all intentional):**

| File | Nature | Problematic? |
|------|--------|-------------|
| `src/core/migrations.ts` | `migrateFromV2()`, `detectV2Database()`, `upgradeV2SchemaInPlace()` — core migration functions | No — this IS the migration code |
| `src/cli/migrate.ts` | Invokes `detectV2Database()`, `migrateFromV2()`, runs the migration flow | No — this IS the migration CLI |
| `src/cli/setup.ts` | Uses `detectV2Database()`, `migrateFromV2()` during interactive setup | No — migration offer in setup |
| `src/tests/core/migrations.test.ts` | Tests for `migrateFromV2()` and `detectV2Database()` | No — test coverage |
| `src/tests/cli/setup.test.ts` | Tests for `detectV2Database()` import in setup | No — test coverage |
| `src/tests/extraction/redaction.test.ts` | `https://api.example.com/v2/users?q=...` — URL in a test fixture | No — unrelated "v2" in a URL |

**Zero references** to `C:\Users\Grigorije\Desktop\Projects\Claudex v2\` path in any source file.
**Zero `.mjs` imports** in `src/`.

Conclusion: The v3 codebase is clean. All v2 references are migration support code that should
remain in place for users running migration.

---

## Projects.json State

File: `C:\Users\Grigorije\.claudex\projects.json`

Current state:
```json
{
  "schema": "claudex/project-registry",
  "version": 1,
  "projects": {
    "claudex":       { "path": "...\\Claudex",    "status": "archived" },
    "claudex-v2":    { "path": "...\\Claudex v2", "status": "active"   },  ← NEEDS CHANGE
    "openclaw-main": { "path": "...\\openclaw-main", "status": "active" },
    "claudex-v3":    { "path": "...\\CLAUDEXv3",  "status": "active"   }
  }
}
```

Required change: `claudex-v2.status` must be changed from `"active"` to `"archived"`.
Do NOT modify any other entries. Do NOT delete the `claudex-v2` entry (keep for audit trail).

---

## Settings.json State

File: `C:\Users\Grigorije\.claude\settings.json`

**V2 hooks: NONE present.** Clean.

**V3 hooks present (6/6):**

| Event | Command |
|-------|---------|
| `SessionStart` | `CLAUDEXv3\dist\adapters\cc-hooks\session-start.cjs` |
| `SessionEnd` | `CLAUDEXv3\dist\adapters\cc-hooks\session-end.cjs` |
| `UserPromptSubmit` | `CLAUDEXv3\dist\adapters\cc-hooks\user-prompt-submit.cjs` |
| `PostToolUse` | `CLAUDEXv3\dist\adapters\cc-hooks\post-tool-use.cjs` |
| `PreCompact` | `CLAUDEXv3\dist\adapters\cc-hooks\pre-compact.cjs` |
| `Stop` | `CLAUDEXv3\dist\adapters\cc-hooks\stop.cjs` |

There is also a `SessionStart` entry for `gsd-check-update.js` (a separate non-Claudex hook) —
this is unrelated and should remain.

Settings.json is fully migrated. No action needed here.

---

## Risk Assessment

### Risks

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|-----------|
| `claudex migrate` fails mid-swap | Low | High | Original `claudex.db` is deleted only after temp DB is verified; backup at `.v2-backup` is created before any writes |
| `claudex.db` is locked by a running session | Medium | Medium | Close all Claude Code sessions before running migrate; check for `*.db-wal` files |
| WAL/SHM files from temp DB left behind | Low | Low | `runMigration()` explicitly cleans up `-wal` and `-shm` side files after swap |
| `files_modified` CSV → JSON conversion loses data | Low | Low | `migrateFromV2()` splits on `,` and filters empty strings — safe for typical v2 paths |
| projects.json edited incorrectly | Low | Low | Only the `"status"` field of `claudex-v2` needs changing; all other entries untouched |
| V2 `.cmd` hooks re-activated by accident | Very Low | Low | These are dead code — nothing in settings.json invokes them; Claude Code uses `.cjs` hooks directly |

### Rollback Procedure

If migration fails or produces unexpected results:

1. **Stop all Claude Code sessions**
2. **Restore from backup**:
   ```
   copy "C:\Users\Grigorije\.claudex\db\claudex.db.v2-backup" "C:\Users\Grigorije\.claudex\db\claudex.db"
   ```
3. **Verify restoration**:
   ```
   node -e "const D=require('better-sqlite3'); const db=new D('C:/Users/Grigorije/.claudex/db/claudex.db',{readonly:true}); console.log(db.pragma('table_info(sessions)')); db.close()"
   ```
4. **Report the failure output from `claudex migrate`** before attempting again.

The backup is retained at `~/.claudex/db/claudex.db.v2-backup` until manually deleted. Do not delete it until v3 has been running successfully for at least 1 week.

---

## Summary of Required Actions

| Priority | Action | Who |
|----------|--------|-----|
| **Required** | Run `claudex migrate` to upgrade `~/.claudex/db/claudex.db` from schema v7 to v300 | User |
| **Required** | Set `claudex-v2.status = "archived"` in `~/.claudex/projects.json` | User |
| Optional | Update/delete `~/.claudex/hooks/*.cmd` stubs (dead code, not invoked) | User |
| Optional | Archive/delete `Claudex v2` project directory after migration verified | User |
