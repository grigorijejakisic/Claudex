---
phase: 13
plan: 04
subsystem: cross-platform-code-audit
tags: [plat-01, plat-02, plat-04, fixes, heartbeat, refactor]
requires:
  - .planning/phases/13-cross-platform-code-audit/13-01-AUDIT-PATHS.md
  - .planning/phases/13-cross-platform-code-audit/13-02-AUDIT-HOOKS-SUBPROCESS.md
provides:
  - .planning/phases/13-cross-platform-code-audit/13-04-FINAL-AUDIT-REPORT.md
affects:
  - src/angel/heartbeat.ts
tech-stack:
  added: []
  patterns: [execFileSync with array args (no shell)]
key-files:
  created:
    - .planning/phases/13-cross-platform-code-audit/13-04-FINAL-AUDIT-REPORT.md
  modified:
    - src/angel/heartbeat.ts
key-decisions:
  - "Single PLAT-04 fix: heartbeat.ts:202 git auto-commit shell-string → 3 execFileSync calls"
  - "PLAT-01 fix step is documented no-op (audit found 0 fix-needed)"
  - "PLAT-02 fix step is documented no-op (audit found 0 fix-needed)"
  - "Final grep verification cross-checks all CONTEXT.md acceptance criteria 1-4 + 6-9"
requirements-completed:
  - PLAT-01 (no-op fix step; audit confirmed src/ already clean)
  - PLAT-02 (no-op fix step; hooks already pure Node.cjs)
  - PLAT-04 (single fix applied)
duration: 9 min
completed: 2026-04-30
---

# Phase 13 Plan 04: PLAT-01 + PLAT-02 + PLAT-04 Fix Execution Summary

Apply every fix-needed entry from 13-01 and 13-02 audits (excluding taskkill, which 13-03 owned). Single source change: `src/angel/heartbeat.ts:202` git auto-commit refactored from shell-string `execSync` to no-shell `execFileSync` with array args.

## Substantive one-liner

Refactored `heartbeat.ts:202` Angel auto-close git commit path from `execSync('git add -A && ... || git commit -m "session(auto-close): ..."')` (shell-chained, embedded-double-quoted, fragile across cmd.exe vs /bin/sh) to three sequential `execFileSync('git', [...], opts)` calls (no shell, array args, identical semantics on all platforms); PLAT-01 and PLAT-02 fix steps were no-ops because the audits found `src/` was already clean.

## Stats

- Duration: 9 min
- Start: 2026-04-30T21:30:00Z
- End: 2026-04-30T21:39:00Z
- Tasks: 5 (read both audits, apply PLAT-01 fixes [no-op], apply PLAT-02 fixes [no-op], apply PLAT-04 fixes [1 cluster], write final audit report)
- Files created: 1 (`13-04-FINAL-AUDIT-REPORT.md`)
- Files modified: 1 (`src/angel/heartbeat.ts`)
- Commits: 2 (8aa5530, 77aea3e)

## What changed

### `src/angel/heartbeat.ts:196-220` — Angel auto-close git commit path

**Before** (shell-chained, embedded-quoted):
```typescript
execSync('git add -A && git diff --cached --quiet || git commit -m "session(auto-close): Angel auto-closed idle session"', {
  cwd: projectPath,
  stdio: 'ignore',
  timeout: 10000,
});
```

**After** (no shell, array args):
```typescript
const { execFileSync } = require('child_process');
const gitOpts = { cwd: projectPath, stdio: 'ignore' as const, timeout: 10000 };
execFileSync('git', ['add', '-A'], gitOpts);
let hasStaged = false;
try {
  execFileSync('git', ['diff', '--cached', '--quiet'], gitOpts);
} catch {
  hasStaged = true;
}
if (hasStaged) {
  execFileSync(
    'git',
    ['commit', '-m', 'session(auto-close): Angel auto-closed idle session'],
    gitOpts,
  );
}
```

Why this matters: shell strings interpret `&&`/`||` and `"..."` quoting per the host shell's rules — cmd.exe preserves outer double-quotes when invoked with `cmd /c`; POSIX `/bin/sh` strips them as part of word-splitting. The pre-existing form happened to work on Windows because Node's `execSync` invokes `cmd.exe` by default on Windows; on Mac/Linux the embedded `"session(auto-close): ..."` arg would be split into multiple words and `git commit` would receive `-m session(auto-close):` with the rest as separate arguments. The new form passes the message as a single argv element regardless of platform.

Semantics preserved: stage all → check for staged changes via `git diff --cached --quiet` exit code (0 = no staged, 1 = staged) → commit only if there are staged changes → all failures swallowed by the outer `try/catch` per the existing non-fatal contract.

## Final grep verification

| Check | Command | Result |
|-------|---------|--------|
| Path-construction `\\` hits | `grep -rn "'\\\\'" src/` | 16 hits, exact match to 13-01 keep list (JSON parsers / SQL ESCAPE / cross-platform separator checks / POSIX bash quote idiom / Windows test fixtures) |
| `taskkill` outside abstraction | `grep -rn 'taskkill' src/` | 6 hits, all in `src/shared/process-control.ts` + `process-control.test.ts` (CONTEXT.md acceptance criterion 2 ✓) |
| `cmd /c` | `grep -rn 'cmd /c' src/` | 0 hits |
| Windows-only utilities | `grep -rn -E "rmdir /s\|del /q\|tasklist\|\bwmic\b" src/` | 1 hit at `run-precision.ts:272` (English prose comment, not invocation; documented in 13-02 audit) |

## Suite results

- `bun run build`: PASS (esbuild ~140ms; 24 hook smoke tests all pass)
- `bun run test`: **3123 passed**, **20 failed** (baseline llama-server-supervisor failures unchanged from v4.0.0). **No regression.**
- `bun run vesna`: **17/17 PASS** (100% — GATED PASS)
  - entity-recall 3/3, constraint-recall 3/3, handoff-pickup 3/3
  - cross-project 3/3, lesson-application 3/3, self-instrumented 2/2

## Deviations from Plan

**One deviation**, pre-authorized by CONTEXT.md `<plan_authorization>`:

1. **PLAT-01 fix step (13-04-02) and PLAT-02 fix step (13-04-03) were no-ops.** The 13-01 and 13-02 audits found 0 fix-needed entries in those categories. CONTEXT.md `<plan_authorization>` explicitly authorizes "skip files that grep finds but inspection proves are intentional" — this generalizes to "skip the fix step when the audit is already clean." The PLAN.md text for tasks 13-04-02 and 13-04-03 anticipates this case ("If 13-02-AUDIT-HOOKS-SUBPROCESS.md's PLAT-02 section explicitly recorded 'no findings', this task is a no-op... Note in 13-04-FINAL-AUDIT-REPORT.md that PLAT-02 was satisfied without code changes.").

**Total deviations:** 1 documented no-op-cluster (encompassing 2 plan tasks). **Impact:** Zero — PLAT-01/02/04 acceptance is fully met; the source tree is portable; final audit report records the closure of all three requirements.

## Authentication Gates

None encountered.

## Issues Encountered

None.

## Commits

- `8aa5530 phase(13-04): PLAT-04 — heartbeat git auto-commit uses execFileSync (no shell)`
- `77aea3e phase(13-04): final audit report — PLAT-01,02,04 closed`

## Ready for

13-05 (PLAT-05 `.gitattributes` extension + phase close: STATE/ROADMAP/REQUIREMENTS update + 13-SUMMARY.md).
