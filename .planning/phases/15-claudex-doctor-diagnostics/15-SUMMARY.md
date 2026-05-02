# Phase 15 — `claudex doctor` Diagnostics — CLOSED

**Shipped:** 2026-05-02
**Generative axiom satisfied:** When an install or session breaks, ONE command tells the operator exactly what's wrong and how to fix it.

---

## What shipped

`bun run doctor` runs six diagnostic checks in parallel and reports overall health with actionable remediation per failed check:

| # | Check | Status semantics |
|---|-------|------------------|
| 1 | **Bun version** (DIAG-02) | fail if missing or `<1.3` |
| 2 | **DB schema** (DIAG-05) | fail if missing or `user_version != TARGET_USER_VERSION` |
| 3 | **Ollama** (DIAG-03) | fail if binary missing / daemon down / `snowflake-arctic-embed2` not pulled |
| 4 | **Reranker** (DIAG-04) | **warn** (not fail) if `:7439/health` unreachable / non-2xx — bi-encoder fallback covers it |
| 5 | **CC hooks** (DIAG-06) | fail if any expected hook missing from `~/.claude/settings.json` |
| 6 | **Angel** (DIAG-07) | fail if no PID file / dead PID; **warn** if alive but heartbeat (mtime) stale ≥60s |

Default output is a human-readable table with `✓`/`⚠`/`✗` symbols. `--json` produces `{ status, checks, startedAt, durationMs }`. Exit codes: `0` healthy (warns OK), `1` any fail, `2` doctor itself crashed.

## Requirements closed

- [x] DIAG-01 — `bun run doctor` exists and is documented in README §Diagnostics
- [x] DIAG-02 — Bun version (>=1.3) check
- [x] DIAG-03 — Ollama daemon + `snowflake-arctic-embed2` model
- [x] DIAG-04 — Reranker on `:7439` (warn-on-fail)
- [x] DIAG-05 — DB schema vs `TARGET_USER_VERSION`
- [x] DIAG-06 — CC hooks vs `EXPECTED_HOOK_NAMES`
- [x] DIAG-07 — Angel PID liveness + heartbeat freshness via PID-file mtime
- [x] DIAG-08 — exit-code contract (0/1/2)

## Files added

- `src/diagnostics/types.ts` — `CheckResult`, `CheckFn`, `RegisteredCheck`, `DoctorReport`
- `src/diagnostics/runner.ts` — `runChecks()` parallel aggregator with per-check try/catch
- `src/diagnostics/check-bun.ts` — DIAG-02
- `src/diagnostics/check-db.ts` — DIAG-05
- `src/diagnostics/check-ollama.ts` — DIAG-03
- `src/diagnostics/check-reranker.ts` — DIAG-04
- `src/diagnostics/check-hooks.ts` — DIAG-06
- `src/diagnostics/check-angel.ts` — DIAG-07
- `src/diagnostics/format.ts` — `formatHuman` + `formatJson` (pure)
- `src/cli/doctor.ts` — orchestrator + `runDoctor({json,checks})` testable entry
- `src/cli/hook-registry.ts` — canonical `HOOK_FILES` / `EXPECTED_HOOK_NAMES` / `getSettingsJsonPath` / `getHookPaths`
- `src/angel/pid-file.ts` — shared `getPidFilePath()` (avoids index↔heartbeat circular import)
- `src/tests/diagnostics/{runner,check-bun,check-db,check-ollama,check-reranker,check-hooks,check-angel,format}.test.ts` — 8 test files
- `src/tests/cli/doctor.test.ts` — orchestrator integration tests

## Files modified

- `src/core/migrations.ts` — exports `TARGET_USER_VERSION = 24`; `runMigrations` now consumes the export (pure refactor)
- `src/cli/setup.ts` — `HOOK_FILES`/`getHookPaths`/`getSettingsJsonPath`/`EXPECTED_HOOK_NAMES` re-exported from `hook-registry.ts`; inline duplicates removed
- `src/angel/index.ts` — `getPidFilePath` re-exported from `pid-file.ts` for back-compat
- `src/angel/heartbeat.ts` — at end of every `heartbeatTick`, `fs.utimesSync(pidPath, now, now)` (best-effort, try/catch). DIAG-07 freshness signal — no schema migration.
- `build.ts` — `src/cli/doctor.ts` added as required entry point
- `package.json` — `"doctor": "node dist/cli/doctor.cjs"` script
- `README.md` — Diagnostics section after Installation
- `.planning/STATE.md` / `ROADMAP.md` / `REQUIREMENTS.md` — Phase 15 marked `[x]`, DIAG-01..08 marked Done

## Test delta

- Diagnostic + doctor unit tests: **41 new** (4 runner + 5 bun + 4 db + 5 ollama + 4 reranker + 5 hooks + 5 angel + 4 format + 5 doctor)
- Total `bun run test`: 3188 passing + 20 baseline llama-server-supervisor failures (unchanged from v4.0.0)
- `bun run vesna`: **17/17 GATED PASS** (entity-recall 3/3 · constraint-recall 3/3 · handoff-pickup 3/3 · cross-project 3/3 · lesson-application 3/3 · self-instrumented 2/2)

## Live verification on this Windows machine

```
$ bun run doctor
Claudex Doctor — checking install health
──────────────────────────────────────────────────
✓ Bun version        Bun 1.3.6                    (231ms)
✓ DB schema          user_version=24              (204ms)
✓ Ollama             daemon up, snowflake-arctic-embed2 pulled (208ms)
✓ Reranker           port 7439 healthy            (7ms)
✓ CC hooks           25 of 25 registered          (1ms)
⚠ Angel              PID 73568 alive but last heartbeat 210s ago (>=60s) (0ms)
  → Angel may be stuck in a long consolidation cycle. If this persists, restart via Claude Code session-end + session-start.
──────────────────────────────────────────────────
All checks passed (1 warning). Claudex is healthy.
```

Exit code: `0`. The Angel-warn is expected and self-clearing: the running Angel was started before this phase's `heartbeatTick` mtime-touch landed; on the next session-start it picks up the new build and the warn goes away.

## Notable decisions made during execution

1. **Heartbeat freshness signal: PID-file mtime, not telemetry row.** `telemetry.event_kind` CHECK constraint excludes `'heartbeat'`; adding it would require a migration (hard-gated). `fs.utimesSync(pidPath)` at end of each `heartbeatTick` is a single FS call, no DB lock contention with consolidator paths, zero schema change. Doctor reads via `fs.statSync(pidPath).mtimeMs`.

2. **Bun detection: dual path (runtime + spawn).** When invoked via `bun run doctor`, `process.versions.bun` is populated. When invoked via raw `node dist/cli/doctor.cjs` (which is what the package.json script does), it isn't — so we fall back to `spawnSync('bun', ['--version'])`. Either path now works and the bundled doctor.cjs detects Bun on this Windows box.

3. **`hook-registry.ts` extracted from `setup.ts`.** When `setup.ts` was the source of `EXPECTED_HOOK_NAMES`, esbuild bundled setup's top-level `if (isDirectRun) main()` into `doctor.cjs`. Because esbuild's CJS wrapper makes `require.main === module` true for any bundled entry, the setup bootstrap fired alongside the doctor — printing "Claudex v3 Setup" before doctor's table. Solution: split the canonical hook list + path resolvers into a side-effect-free module (`hook-registry.ts`); setup.ts re-exports for back-compat. Doctor and `check-hooks` now import from `hook-registry.ts` directly.

4. **`pid-file.ts` shared module** — `index.ts` imports from `heartbeat.ts` and now `heartbeat.ts` needs `getPidFilePath`. Defining it in either creates a circular import. The tiny `pid-file.ts` module breaks the cycle and serves as a single source of truth that `check-angel.ts` also imports.

5. **Reranker = warn, not fail.** Locked in CONTEXT.md and respected — bi-encoder fallback (`hybrid-retrieval.ts`) keeps retrieval working. Doctor surfaces the degraded state but doesn't block exit 0. Production retrieval health (RETR-08) is enforced separately via Angel's `RerankerSupervisor` and the `reranker_fallback` telemetry counter, not by doctor.

## Out of scope (deferred per CONTEXT.md plan_authorization)

- Auto-fix logic — doctor diagnoses, doesn't repair. Remediation messages tell the operator what to do.
- Quick Start + Troubleshooting full rewrite — Phase 16
- Public push to `grigorijejakisic/Claudex` — Phase 17
- Telemetry schema additions for `event_kind='heartbeat'` — would require a migration, hard-gated
- New diagnostic checks beyond DIAG-01..08 — phase scope-lock
