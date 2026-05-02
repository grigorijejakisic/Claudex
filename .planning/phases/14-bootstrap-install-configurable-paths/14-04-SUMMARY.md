---
phase: 14
plan: 04
subsystem: install-wrappers
tags: [INST-01, install.sh, install.bat, gitattributes]
requires: []
provides: [install-wrappers]
affects:
  - install.sh
  - install.bat
  - .gitattributes
tech-stack:
  added: [install.sh, install.bat]
  patterns: [thin-wrapper, executable-bit-via-git-index, batch-call-prefix]
key-files:
  created:
    - install.sh
    - install.bat
  modified:
    - .gitattributes
key-decisions:
  - "install.bat uses 'call bun ...' instead of bare 'bun ...' — bun ships as bun.cmd on Windows; without 'call' control transfers to bun.cmd and never returns to install.bat. Verified via live smoke that bare invocations stop the script after the first bun command."
  - "install.sh executable bit set via 'git update-index --add --chmod=+x install.sh' — works on Windows NTFS where chmod is a no-op; resulting tree mode 100755 propagates to Mac/Linux clones"
  - "Explicit install.sh/install.bat rules in .gitattributes — redundant with the *.sh/*.bat rules from PLAT-05 but kept for clarity (first-time readers see the install-specific intent)"
requirements-completed:
  - INST-01
duration: 9 min
completed: 2026-05-01
---

# Phase 14 Plan 04: install wrappers (POSIX + Windows) Summary

Two cross-platform first-touch wrappers at repo root: `install.sh` (Mac/Linux, mode 100755, LF) and `install.bat` (Windows, CRLF). Both pre-flight Bun on PATH, then run `bun install --frozen-lockfile && bun run build && bun run setup` — delegating the real bootstrap to `bun run setup` from 14-03.

**Tasks:** 4
**Files created:** 2
**Files modified:** 1
**Commits:** 4

## Tasks completed

| Task | Commit | What |
|------|--------|------|
| 14-04-01 | c624fef | install.sh + git update-index --chmod=+x (mode 100755, LF endings) |
| 14-04-02 | 8d4237e | install.bat with 'call bun ...' fix and explicit errorlevel checks |
| 14-04-03 | c4def12 | .gitattributes explicit install.sh/install.bat rules (redundant-but-clear) |
| 14-04-04 | (this commit) | Live smoke + SUMMARY |

## Live smoke test on this Windows machine

`cmd.exe /C install.bat`:
- bun pre-flight: pass (Bun 1.3.6 found)
- bun install --frozen-lockfile: 0ms (no changes — already installed)
- bun run build: green (esbuild ~70ms)
- bun run setup: all 8 steps OK; Setup complete
- Total exit code: 0

Re-run `cmd.exe /C install.bat` immediately after: same output, exit 0 (idempotency confirmed).

`git ls-files --stage install.sh` reports mode `100755` (executable bit set).

## Verifications passed

- `bun run build` green
- `bun run test`: 3147 passing (no change from 14-03; this plan adds no test files); 20 baseline llama failures unchanged
- `bun run vesna`: **17/17 PASS** (all 6 categories at 100% — AGGREGATE: 100% GATED PASS)
- `git ls-files --stage install.sh`: 100755
- `od -c install.sh | head -3`: LF endings confirmed
- `od -c install.bat | head -3`: CRLF endings confirmed
- DB schema unchanged
- Hook semantics unchanged

## Notable gotcha discovered + handled

**Windows .bat-from-cmd .cmd-shim chaining.** First draft of install.bat used bare `bun install`, `bun run build`, `bun run setup`. The script halted after the first invocation because Windows `bun` is actually `bun.cmd`, and a batch file invoking another batch file without `call` transfers control without returning. Fix: `call bun install`, `call bun run build`, `call bun run setup`. Verified by running the wrapper twice in a row and seeing all 8 setup steps fire each time. This gotcha is not specific to Claudex — it's the canonical Windows .bat trap; documenting in the file's REM comment so future readers don't reintroduce the regression.

## Deviations from Plan

- **`call` prefix added to bun invocations** — PLAN.md showed bare `bun install` etc. The PLAN.md was technically wrong about Windows .bat semantics (this is the documented behavior of cmd.exe + .cmd shims). Tactical fix; intent unchanged.

## Next

Ready for 14-05 (verify + close).
