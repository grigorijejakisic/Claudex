---
phase: 11-deployment
plan: 01
status: complete
started: 2026-03-12
completed: 2026-03-12
duration: 4min
tasks_completed: 2
files_modified:
  - src/cli/setup.ts
  - src/tests/cli/setup.test.ts
  - docs/DEPLOYMENT.md
---

## Summary

Build verification and deployment documentation for Claudex v3.

### Task 1: Build output verification

- `bun run build` succeeds: 8 CJS entry points in `dist/` (6 CC hooks + setup CLI + OpenClaw plugin)
- All entry points use CJS format with `better-sqlite3` marked external
- `vitest run` passes: 45 test files, 717 tests
- **Bug found and fixed**: `setup.ts` had incorrect hook path resolution due to esbuild preserving directory structure in output. `__dirname` in `dist/cli/setup.js` is `dist/cli/`, not `dist/`, causing hook paths to resolve to `dist/dist/session-start.js` (double `dist/`). Additionally, `HOOK_FILES` lacked the `adapters/cc-hooks/` subdirectory prefix.
  - Fixed `HOOK_FILES` to include `path.join('adapters', 'cc-hooks', ...)` prefix
  - Fixed `installDir` from `path.resolve(__dirname, '..')` to `path.resolve(__dirname, '..', '..')` (two levels up from `dist/cli/` to project root)
  - Updated test to verify hook paths include `dist/adapters/cc-hooks` directory
  - All 717 tests pass after fix

### Task 2: Deployment documentation

Created `docs/DEPLOYMENT.md` with 7 sections:
1. **Prerequisites** -- Node 20+, bun 1.3+, optional Ollama
2. **CC Fresh Install** -- Step-by-step with expected output and verification
3. **OpenClaw Plugin Install** -- Build target, activation, verification
4. **v2 Migration** -- Auto-detection, backup, rollback procedure
5. **Monitoring Checklist** -- 7 concrete SQL queries against v3 schema (error events, observation rate, checkpoint status, assembly latency, session lifecycle, learnings, hot files)
6. **Archive Plan** -- Claudex v2 repo, openclaw-context plugin, archived tables
7. **Troubleshooting** -- 6 common issues (native binding, settings.json, DB locks, Ollama, permissions, hook debugging, config)

### Decisions

- [11-01]: Hook paths must include `adapters/cc-hooks/` prefix matching esbuild's directory-preserving output structure
- [11-01]: `installDir` resolves two levels up from `dist/cli/setup.js` to reach project root
