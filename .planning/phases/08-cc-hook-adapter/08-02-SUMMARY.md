---
phase: 08-cc-hook-adapter
plan: 02
status: complete
started: 2026-03-12
completed: 2026-03-12
duration: 3min
tasks_completed: 1
files_created:
  - src/cli/setup.ts
  - src/tests/cli/setup.test.ts
tests_added: 15
tests_passing: 15
---

## What was built

Setup CLI (`claudex setup`) — the fresh install entry point for Claudex v3.

### setup.ts Exports
- `getHookPaths(installDir)` — resolves absolute paths to all 6 hook dist files
- `getSettingsJsonPath()` — returns `~/.claude/settings.json` path
- `patchSettingsJson(settingsPath, hookPaths)` — merges hook entries, preserves existing hooks, updates Claudex entries in-place
- `detectV2Database(dbPath)` — checks for schema_versions with version < 300, returns stats
- `main()` — full setup flow: directories, DB init, config, settings.json patch, v2 migration offer

### Setup Flow
1. Create `~/.claudex/` directory structure (db/, identity/)
2. Check for existing v2 database (before schema init)
3. If v2: offer migration with backup (interactive only)
4. Initialize v3 schema (CREATE IF NOT EXISTS — idempotent)
5. Write default config.json (only if not exists)
6. Patch `~/.claude/settings.json` with hook paths (merge, not overwrite)
7. Print summary

### Key Decisions
- Settings.json hook format: `{ matcher: '', hooks: [{ type: 'command', command: 'node /abs/path' }] }`
- Claudex hooks identified by 'claudex' or 'CLAUDEXv3' in command path for in-place updates
- v2 detection happens before initializeSchema (otherwise version is already 300)
- `isDirectRun` guard prevents auto-execution during test imports
- Non-interactive mode (no TTY) auto-declines v2 migration
