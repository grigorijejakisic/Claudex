# Phase 13 — Cross-Platform Code Audit — SUMMARY

**Status:** Closed
**Date closed:** 2026-04-30
**Commits:** d1a0218 → phase-close (8 atomic commits)

## What shipped

- **PLAT-01** — Path-handling audit (`13-01-AUDIT-PATHS.md`). 39 raw hits in `src/` (16 `\\` literals + 23 `path.normalize`/`path.win32`/`path.posix` callsites), all 39 classify keep-with-reason. **0 fix-needed entries.** No path-construction-by-concatenation exists anywhere in `src/`. Categories: JSON-string parsers (5), SQL `ESCAPE '\\'` clauses (5), cross-platform separator checks (2), test fixtures documenting Windows behavior (2), POSIX bash single-quote-escape idiom (1), defensive `path.normalize(path.join(...))` canonicalization (23). 13-04's PLAT-01 fix step was a documented no-op.
- **PLAT-02** — Hook portability audit (`13-02-AUDIT-HOOKS-SUBPROCESS.md` PLAT-02 section). **0 hits** in `src/adapters/cc-hooks/`: no PowerShell cmdlets (`Get-Process`, `Stop-Process`, etc.), no `.ps1`/`.bat`/`.cmd` invocations or files, no `cmd /c` chains, no `chmod`/octal-mode literals. Hooks are pure `.cjs`/`.ts` invoked by Node — fully portable as-is. 13-04's PLAT-02 fix step was a documented no-op.
- **PLAT-03** — `src/shared/process-control.ts` introduced. Exports `terminateProcess(pid: number, options?: { force?: boolean }): Promise<void>` wrapping Windows `taskkill /PID <pid> [/F]` (via `execFile`) and Unix `process.kill(pid, SIGKILL|SIGTERM)`. Treats "process already dead" (taskkill `not found` / Unix `ESRCH`) as success. **8 unit tests** covering both code paths (4 Windows + 4 Unix), all pass. Migration step found 0 callsites in `src/` to migrate — abstraction is forward-looking parity per CONTEXT.md acceptance criteria 2 + 4.
- **PLAT-04** — Subprocess portability audit (`13-02-AUDIT-HOOKS-SUBPROCESS.md` PLAT-04 section) + fix execution. **1 fix-needed entry** applied: `src/angel/heartbeat.ts:202` Angel auto-close git commit refactored from shell-string `execSync('git add -A && git diff --cached --quiet || git commit -m "session(auto-close): ..."')` to three sequential no-shell `execFileSync('git', [...], opts)` calls. Removes embedded-double-quote fragility across `cmd.exe` vs `/bin/sh`. All other production subprocess callsites already-portable: `angel-launcher.ts:94` (`spawn(process.execPath, [angelDist])`), `reranker-supervisor.ts:338` (`spawn('python', [scriptPath])`), `build.ts:236` (`spawn('node', [hookPath])`). `build.ts` and `package.json` scripts already cross-platform (no `rmdir /s`/`del /q`/`cmd /c`). `llama-server-supervisor.ts:611` Windows-default `serverExePath` kept-with-reason (env-var `LLAMA_SERVER_EXE` override; Phase 16 territory; baseline 20 supervisor failures unchanged from v4.0.0). `cmd /c` count in `src/`: **0 hits**. `taskkill` count outside abstraction module: **0 hits**.
- **PLAT-05** — `.gitattributes` extended with per-extension rules. CACH-03 universal default `* text=auto eol=lf` preserved at top; explicit LF rules added for source extensions (`.ts .js .cjs .mjs .json .md .yml .yaml .toml .py .sh`); explicit CRLF rules added for Windows-only scripts (`.bat .cmd .ps1`, forward-looking — no such files exist in repo today); binary list preserved + `*.sqlite` added. `git add --renormalize .` produced one legitimate change: `src/intelligence/experience-patterns.ts` CRLF→LF (1470/1470 line-endings; pure line-ending change). All other tracked source files were already LF (CACH-03 had been enforcing this since v3.5).

## Gates passed

- `bun run build`: **PASS** (esbuild ~140ms; 24 hook smoke tests all pass)
- `bun run test`: **3123 passed**, **20 failed** — the 20 failures are the v4.0.0-baseline `llama-server-supervisor.test.ts` failures (`testHelpers.killCalls` undefined), unchanged from end-of-Phase-12. **No regression.**
- `bun run vesna`: **17/17 PASS** at 100% (entity-recall 3/3, constraint-recall 3/3, handoff-pickup 3/3, cross-project 3/3, lesson-application 3/3, self-instrumented 2/2 — AGGREGATE 100% GATED PASS)
- DB schema: **unchanged** (no migrations in Phase 13)
- Hook semantics: **unchanged** (each hook produces the same effect; only the heartbeat git auto-commit shifted from shell-string to array-args invocation, with identical behavior)

## Out of scope (deferred)

- **PLAT-06, PLAT-07, PLAT-08** — fresh-VM install verification on macOS, Linux, Windows. **Phase 16 HITL territory** (operator-runnable per CONTEXT.md acceptance criterion 10).
- **README install instructions** — Phase 16 polish.
- **Bootstrap install script** — Phase 14 territory.
- **`services/reranker.py`** — Python, separate concern per CONTEXT.md `<plan_authorization>`.
- **Refactoring beyond portability** — global rule 5 scope lock (e.g., heartbeat.ts has unrelated improvement opportunities not touched).

## Open follow-ups

1. **Renormalize commit scope leak** (commit `9c1dc9a`). The renormalize swept up 4 pre-existing dirty files alongside the legitimate `experience-patterns.ts` change: 06-02 ablation run JSONs, `context/checkpoints/latest.yaml`, `node_modules/.vite/vitest/results.json`. Documented transparently in `13-05-SUMMARY.md`. Per global rule 5 (scope lock) Phase 13 should not have committed other phases' leftover work; reported to team-lead and resolved via Option A (transparent documentation rather than `git reset --hard` history rewrite). If team-lead later prefers a clean history, a follow-up commit can revert those four files to their pre-Phase-13 state.

## Files added

- `src/shared/process-control.ts` (48 lines)
- `src/shared/process-control.test.ts` (112 lines, 8 tests)

## Files modified

- `.gitattributes` (extended from 14 lines to 30 lines; CACH-03 baseline preserved)
- `src/angel/heartbeat.ts` (lines 196-220: shell-string `execSync` → 3-step `execFileSync`)
- `src/intelligence/experience-patterns.ts` (CRLF → LF renormalization, no semantic change)
- `.planning/STATE.md` (Phase 14 next; v4.1 progress 1/6 → 2/6 phases)
- `.planning/ROADMAP.md` (Phase 13 marked `[x]`; Plans section filled; progress table 0/0 → 5/5)
- `.planning/REQUIREMENTS.md` (PLAT-01..05 marked `[x]` with traceability; table rows Pending → Done)

Plus 4 pre-existing dirty files captured in the renormalize commit (see "Open follow-ups"): `06-02-all-disabled.json`, `06-02-sweep-summary.json`, `latest.yaml`, vite results cache.

## Audit artifacts (kept for traceability)

- `.planning/phases/13-cross-platform-code-audit/13-CONTEXT.md` (gathered 2026-04-30)
- `.planning/phases/13-cross-platform-code-audit/13-01-AUDIT-PATHS.md` (path audit findings)
- `.planning/phases/13-cross-platform-code-audit/13-02-AUDIT-HOOKS-SUBPROCESS.md` (hook + subprocess audit findings)
- `.planning/phases/13-cross-platform-code-audit/13-04-FINAL-AUDIT-REPORT.md` (closure + grep verification)
- `.planning/phases/13-cross-platform-code-audit/13-01-SUMMARY.md` … `13-05-SUMMARY.md` (per-plan summaries)

## Commits

```
9c1dc9a phase(13-05): PLAT-05 — renormalize line endings per .gitattributes
7d068d7 phase(13-05): PLAT-05 — extend .gitattributes with per-extension rules
77aea3e phase(13-04): final audit report — PLAT-01,02,04 closed
8aa5530 phase(13-04): PLAT-04 — heartbeat git auto-commit uses execFileSync (no shell)
7c1b8d3 phase(13-03): PLAT-03 — unit tests for terminateProcess
a374633 phase(13-03): PLAT-03 — add src/shared/process-control.ts
f053b9b phase(13-02): PLAT-02,PLAT-04 — hook + subprocess portability audit findings
d1a0218 phase(13-01): PLAT-01 — path-handling audit findings
```

Plus the phase-close commit (this commit) covering STATE/ROADMAP/REQUIREMENTS + 13-SUMMARY.md + 13-05-SUMMARY.md.

## Next phase

**Phase 14 — Bootstrap install + configurable paths.** INST-01..07. One-command `bun run setup` + Ollama prerequisite detection + `snowflake-arctic-embed2` model pull + BGE reranker boot + `CLAUDEX_PROJECTS_DIR` env var replacing hardcoded `~/Desktop/Projects/` + first-session UX verification.

Run `/gsd:discuss-phase 14` to begin.
