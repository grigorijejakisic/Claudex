---
phase: 13
plan: 02
subsystem: cross-platform-code-audit
tags: [audit, hooks, subprocess, plat-02, plat-04, read-only]
requires: []
provides:
  - .planning/phases/13-cross-platform-code-audit/13-02-AUDIT-HOOKS-SUBPROCESS.md
affects:
  - .planning/phases/13-cross-platform-code-audit/13-03-PLAN.md
  - .planning/phases/13-cross-platform-code-audit/13-04-PLAN.md
tech-stack:
  added: []
  patterns: [grep + per-callsite inspection]
key-files:
  created:
    - .planning/phases/13-cross-platform-code-audit/13-02-AUDIT-HOOKS-SUBPROCESS.md
  modified: []
key-decisions:
  - "PLAT-02 (hooks) is already clean: 0 PowerShell-only constructs in src/adapters/cc-hooks/"
  - "PLAT-04 has 0 taskkill callsites in src/ — 13-03 migration step (13-03-04) is a documented no-op"
  - "PLAT-04 has 1 production fix-needed: heartbeat.ts:202 execSync git-shell-string → execFileSync git array-args"
  - "build.ts and package.json scripts are already cross-platform (no rmdir /s, del /q, cmd /c, etc.)"
  - "llama-server-supervisor's Windows-default serverExePath is kept-with-reason (Phase 16 territory; env override available; baseline failures pre-existing)"
requirements-completed:
  - PLAT-02 (audit complete; no fixes needed in 13-04)
  - PLAT-04 (audit step; 13-04 acts on heartbeat.ts:202 only)
duration: 10 min
completed: 2026-04-30
---

# Phase 13 Plan 02: PLAT-02 + PLAT-04 Hook + Subprocess Audit Summary

Audit of `src/adapters/cc-hooks/` (PLAT-02 hook portability) and all `src/` subprocess callsites (PLAT-04 subprocess portability). Read-only output: `13-02-AUDIT-HOOKS-SUBPROCESS.md`.

## Substantive one-liner

PLAT-02 is fully clean (0 hits — hooks are pure Node.cjs, no PowerShell, no `.ps1`/`.bat`/`.cmd`); PLAT-04 surfaces a **single** production fix-needed entry in `src/angel/heartbeat.ts:202` (a shell-chained `execSync` git auto-commit with embedded double-quotes that needs refactoring to three sequential `execFileSync` calls). All other subprocess callsites — angel-launcher, reranker-supervisor, llama-server-supervisor, build.ts smoke tests — are already cross-platform (direct binary call + array args, no shell).

## Stats

- Duration: 10 min
- Start: 2026-04-30T20:55:00Z (parallel with 13-01)
- End: 2026-04-30T21:05:00Z
- Tasks: 4 (PLAT-02 grep, PLAT-04 taskkill/cmd-c grep, subprocess callsite inspection, write findings file)
- Files created: 1 (`13-02-AUDIT-HOOKS-SUBPROCESS.md`)
- Files modified: 0 (read-only)

## What was found

### PLAT-02 — `src/adapters/cc-hooks/`

| Check | Hits |
|-------|------|
| PowerShell cmdlets (`Get-Process`, `Stop-Process`, etc.) | 0 |
| `.ps1` / `.bat` / `.cmd` invocations | 0 |
| `cmd /c` chains | 0 |
| `chmod` / octal-mode literals | 0 |
| `.sh` / `.ps1` / `.bat` / `.cmd` files in tree | 0 |

Hook tree is pure `.cjs`/`.ts` invoked by Node. No PLAT-02 fixes required.

### PLAT-04 — all `src/`

| Check | Hits | Disposition |
|-------|------|-------------|
| `taskkill` literal | 0 | nothing to migrate to 13-03 abstraction |
| `cmd /c` literal | 0 | clean |
| `rmdir /s` / `del /q` / `tasklist` | 0 (1 prose mention of `wmic` in a comment) | clean |
| Production subprocess callsites | 6 | 5 already-portable, 1 fix-needed |
| `Bun.spawn` / `Bun.$` | 0 | not used |
| `build.ts` shell idioms | 0 | uses `spawn('node', [...])` only |
| `package.json` scripts | 0 | all `bun run X` / `node dist/X.cjs` / `vitest run` |

#### Production subprocess callsites

| file:line | Disposition |
|-----------|-------------|
| `src/adapters/cc-hooks/angel-launcher.ts:94` — `spawn(process.execPath, [angelDist], {...})` | already-portable |
| `src/angel/reranker-supervisor.ts:338` — `spawnFn('python', [scriptPath], {...})` | already-portable (PATH-resolved) |
| `src/angel/llama-server-supervisor.ts:611` — `spawnFn(serverExePath, args, {...})` | keep-with-reason (Windows-default `.exe`; env override; Phase 16 territory) |
| `src/angel/heartbeat.ts:202` — `execSync('git add -A && ... \|\| git commit -m "..."')` | **fix-needed** for 13-04 |
| `build.ts:236` — `spawn('node', [hookPath], {...})` | already-portable |

## Implications for 13-03 and 13-04

- **13-03**: scaffolding work (create `src/shared/process-control.ts` + `process-control.test.ts`) is still required per PLAT-03 acceptance, but the migration step (13-03-04) is a documented no-op since there are no taskkill callsites in current source.
- **13-04**: a single fix-cluster — refactor `src/angel/heartbeat.ts:202` to three sequential `execFileSync('git', [...], opts)` calls (no shell, array args). PLAT-01 and PLAT-02 fix steps are no-ops.

## Deviations from Plan

None — plan executed exactly as written. The audit anticipated some "no findings" outcomes per the CONTEXT.md `<execution_context>` ("PLAT-02 likely empty or near-empty; document the verification regardless"). The `taskkill = 0` outcome is a stronger version of the same: the abstraction has nothing to migrate yet, but PLAT-03 still introduces it for forward-looking parity.

## Verification

- `13-02-AUDIT-HOOKS-SUBPROCESS.md` exists in phase directory ✓
- PLAT-02 + PLAT-04 sections both present (PLAT-02 explicitly empty per CONTEXT.md keep-rule for "no findings → document the verification") ✓
- `build.ts` and `package.json` audited explicitly ✓
- Single fix-needed row has concrete proposed replacement ✓
- No source files modified (read-only audit) ✓

## Commit

`f053b9b phase(13-02): PLAT-02,PLAT-04 — hook + subprocess portability audit findings`

## Ready for

Wave 2: 13-03 (process-control abstraction + tests, no callsites to migrate) and 13-04 (single heartbeat.ts:202 fix-cluster).
