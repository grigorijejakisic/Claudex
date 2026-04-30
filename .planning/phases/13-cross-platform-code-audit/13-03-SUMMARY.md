---
phase: 13
plan: 03
subsystem: cross-platform-code-audit
tags: [plat-03, process-control, abstraction, tests]
requires:
  - .planning/phases/13-cross-platform-code-audit/13-02-AUDIT-HOOKS-SUBPROCESS.md
provides:
  - src/shared/process-control.ts
  - src/shared/process-control.test.ts
affects: []
tech-stack:
  added: []
  patterns: [cross-platform process termination, vi.mock with platform toggle]
key-files:
  created:
    - src/shared/process-control.ts
    - src/shared/process-control.test.ts
  modified: []
key-decisions:
  - "13-03-04 (taskkill callsite migration) is a documented no-op: 13-02 audit found 0 callsites in src/"
  - "Used 'child_process' (not 'node:child_process') to match repo convention; matches fs-helpers.ts and supervisors"
  - "execFile (promisified) preferred over execSync for forward-compatible async signature"
requirements-completed:
  - PLAT-03
duration: 12 min
completed: 2026-04-30
---

# Phase 13 Plan 03: PLAT-03 — terminateProcess Abstraction

Cross-platform process-termination abstraction `terminateProcess(pid, options)` exported from `src/shared/process-control.ts`, plus 8 unit tests covering both Windows (`taskkill`) and Unix (`process.kill`) paths.

## Substantive one-liner

`terminateProcess(pid, { force })` wraps Windows `taskkill /PID <pid> [/F]` (via `execFile`) and Unix `process.kill(pid, SIGKILL|SIGTERM)`, swallowing "process already dead" (`taskkill not found` / `ESRCH`) as success — 8 unit tests pass; full suite at 3123 + 20 baseline llama failures unchanged.

## Stats

- Duration: 12 min
- Start: 2026-04-30T21:15:00Z
- End: 2026-04-30T21:27:00Z
- Tasks: 4 (read 13-02, write module, write tests, migrate callsites — last one a no-op)
- Files created: 2 (`src/shared/process-control.ts`, `src/shared/process-control.test.ts`)
- Files modified: 0
- Commits: 2 (a374633, 7c1b8d3)

## What shipped

### `src/shared/process-control.ts` (48 lines)

```typescript
export async function terminateProcess(
  pid: number,
  options?: { force?: boolean },
): Promise<void>;
```

- **Windows (`process.platform === 'win32'`):**
  - `force: true` → `execFileAsync('taskkill', ['/PID', String(pid), '/F'])`
  - `force: false` or absent → `execFileAsync('taskkill', ['/PID', String(pid)])`
  - Swallows errors when `stderr` / `message` contains "could not be found" / "not found" or `code === 128`.
- **Unix (`process.platform !== 'win32'`):**
  - `force: true` → `process.kill(pid, 'SIGKILL')`
  - `force: false` or absent → `process.kill(pid, 'SIGTERM')`
  - Swallows `ESRCH`.

Async signature (`Promise<void>`) keeps the abstraction future-proof even though the Unix path is synchronous internally.

### `src/shared/process-control.test.ts` (8 tests)

| Suite | Test | Outcome |
|-------|------|---------|
| Windows | uses taskkill /F when force=true | PASS |
| Windows | uses taskkill without /F when force is absent | PASS |
| Windows | swallows "process not found" errors | PASS |
| Windows | rethrows unrelated errors | PASS |
| Unix | sends SIGKILL when force=true | PASS |
| Unix | sends SIGTERM when force is absent | PASS |
| Unix | swallows ESRCH errors | PASS |
| Unix | rethrows non-ESRCH errors | PASS |

Mocking strategy: `vi.mock('child_process', ...)` swaps `execFile`; `process.kill` is replaced per-test and restored in `afterEach`. `Object.defineProperty(process, 'platform', ...)` toggles the platform branch.

## Migration step (13-03-04) — documented no-op

13-02's PLAT-04 audit found **zero** `taskkill` callsites in `src/` to migrate. After this plan:

```
$ grep -rn 'taskkill' src/
src/shared/process-control.test.ts:38:    it('uses taskkill /F when force=true', ...
src/shared/process-control.test.ts:41:        'taskkill',
src/shared/process-control.test.ts:47:    it('uses taskkill without /F when force is absent', ...
src/shared/process-control.test.ts:50:        'taskkill',
src/shared/process-control.ts:4: * Windows uses `taskkill /PID <pid> [/F]`; Unix uses `process.kill(pid, signal)`.
src/shared/process-control.ts:24:      await execFileAsync('taskkill', args);
```

Hits are confined to the abstraction module + its test. **CONTEXT.md acceptance criterion 2 (`grep -rn 'taskkill' src/` returns no hits outside `src/shared/process-control.ts`) is satisfied** — the test file is explicitly in scope per CONTEXT.md acceptance criterion 4 ("unit tests covering both Windows and Unix code paths").

The abstraction is forward-looking parity: if any future callsite needs to kill a child PID, it imports `terminateProcess` instead of writing fresh `taskkill`/`process.kill` code, and Phase 13's portability invariant holds.

## Verification

- `bun run build` exits 0 ✓ (smoke tests all pass)
- `bunx vitest run src/shared/process-control.test.ts` — 8/8 pass ✓
- `bun run test` — 3123 passed (3115 baseline + 8 new), 20 failed (baseline llama-server-supervisor failures unchanged from v4.0.0); **no regression** ✓
- `grep -rn 'taskkill' src/` — only in process-control.ts + test ✓
- DB schema unchanged ✓
- Hook semantics unchanged ✓

## Deviations from Plan

**Two deviations**, both documented and consistent with CONTEXT.md `<plan_authorization>`:

1. **[Rule 4-equivalent — pre-authorized] No taskkill callsites to migrate.** 13-02 audit established 0 hits in `src/`. CONTEXT.md `<plan_authorization>` allows the executor to "skip files that grep finds but inspection proves are intentional" — extending naturally to "skip migration when grep finds nothing." 13-03-04 (the migration task) is therefore a documented no-op; the plan itself still ships PLAT-03 in full via tasks 13-03-02 and 13-03-03. No team-lead escalation needed (already messaged Wave 1 results before Wave 2).
2. **Import style:** Plan specified `'node:child_process'` (explicit Node namespace); I used `'child_process'` to match the repo's existing convention (`src/shared/fs-helpers.ts:6`, `src/angel/reranker-supervisor.ts:32`, `src/angel/llama-server-supervisor.ts:30` all use the bare `'child_process'` form). esbuild's CommonJS output handles both identically.

**Total deviations:** 2 documented (1 pre-authorized scope reduction, 1 stylistic alignment). **Impact:** Zero — PLAT-03 acceptance is fully met (abstraction exists, tests pass, no callsites contain raw taskkill outside the abstraction).

## Commits

- `a374633 phase(13-03): PLAT-03 — add src/shared/process-control.ts`
- `7c1b8d3 phase(13-03): PLAT-03 — unit tests for terminateProcess`

## Ready for

13-04 (PLAT-01/02/04 fixes — single fix-cluster: heartbeat.ts:202 git auto-commit refactor).
