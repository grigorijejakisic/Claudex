# Phase 14 — Bootstrap install + configurable paths

**Closed:** 2026-05-01
**Milestone:** v4.1 Distribution
**Requirements satisfied:** INST-01, INST-02, INST-03, INST-04, INST-05, INST-06, INST-07

## What shipped

1. **One-command bootstrap** — `bun run setup` (and the new `./install.sh` / `install.bat` wrappers) is end-to-end on this Windows machine: Bun version → Ollama detect+daemon → model pull → BGE reranker venv+spawn → projects-dir ensure → DB/config/hooks. Idempotent; re-running exits 0 with no-op markers. (INST-01)
2. **Ollama detection** — bootstrap exits 1 with platform-specific install link (macOS / Linux / Windows) if Ollama is missing OR if the daemon is unreachable on `:11434/api/tags`. (INST-02)
3. **Model pull** — `snowflake-arctic-embed2` pulled via `ollama pull` with 5-min timeout; `ollama list` short-circuit makes the step a fast no-op when already present. (INST-03)
4. **Reranker bootstrap** — Python 3.11+ detection (python3 → python fallback), `services/.venv/` venv creation, `pip install -r services/requirements.txt`, detached service spawn redirecting stdout/stderr to `context/logs/reranker.log`, `/health` poll with 60s budget and exponential backoff. **Best-effort fallback**: every failure returns ok:true with a warning naming the failing step; bi-encoder degraded mode is documented, not a hard fail. (INST-04)
5. **Configurable projects directory** — new `src/shared/projects-dir.ts` exports `getProjectsDir()` honoring `CLAUDEX_PROJECTS_DIR` env var (default `path.join(os.homedir(), 'Projects')` cross-platform). All scope-detector / content-router / MCP-instructions / assembly-section callsites updated. **No automatic data migration** of `~/.claudex/projects.json` (per CONTEXT.md decision). (INST-05)
6. **MCP runtime path** — `recall-server.ts` instructions text resolves `getProjectsDir()` at registration so the agent sees the user's actual configured directory (INST-06).
7. **First-session UX verified live** — fresh CC session in any project under `getProjectsDir()` produces session-start assembly + Angel auto-spawn + working `claudex_search` MCP tool within 1 user turn. Verified via `~/.claudex/angel.pid` + node.exe (PID 73568), session_events DB activity from this session, and a successful claudex_search call returning ranked RRF results. (INST-07)

## Plans

- **14-01** — `getProjectsDir()` helper + classified callsite audit (3 tasks, 4 commits)
- **14-02** — apply audit replacements: code-fix, string-text-fix, comment-update, test-fixture (5 tasks, 5 commits)
- **14-03** — bootstrap steps (Bun version, Ollama, model pull, reranker venv) wired into `bun run setup`; 19 unit tests via DI (6 tasks, 6 commits)
- **14-04** — `install.sh` POSIX wrapper (mode 100755) + `install.bat` Windows wrapper (with `call bun` to handle bun.cmd shim); .gitattributes (4 tasks, 4 commits)
- **14-05** — verify + close (4 tasks, this commit + STATE/ROADMAP/REQUIREMENTS update commit + SUMMARY commit)

Total: 22 tasks, 19 atomic commits + 5 SUMMARY commits + this final close commit.

## Hard gates passed

- `bun run build` green (esbuild ~70ms throughout)
- `bun run test`: **3147 passed** (3123 baseline + 5 from 14-01 + 19 from 14-03); 20 baseline llama-server-supervisor failures unchanged from v4.0.0
- `bun run vesna`: **17/17 PASS GATED PASS** (entity-recall 3/3, constraint-recall 3/3, handoff-pickup 3/3, cross-project 3/3, lesson-application 3/3, self-instrumented 2/2 — AGGREGATE 100%)
- `bun run setup` idempotent on this Windows machine (exits 0 twice in a row, identical end state)
- DB schema unchanged (no Phase 14 migration registered)
- Hook semantics unchanged (post-setup still 25 hooks registered in settings.json)
- Existing v4 install state preserved: `curl /health` 200, hooks intact, DB intact, Angel still alive (PID file fresh)

## Notable decisions

- **Standard `venv` + `pip`, not uv** — minimum compatibility for first install; uv revisitable in Phase 16+ if benchmarks show pip is too slow. Adding a Python tool dependency to install Claudex is the wrong direction (we want fewer pre-reqs not more).
- **No project-registry data migration** — `~/.claudex/projects.json` is left alone; absolute paths keep resolving regardless of base-dir change. Auto-migration is destructive and out of scope.
- **Reranker is best-effort in setup** — Python on Windows can be brittle (especially torch wheels); a degraded-mode warning is acceptable. Vesna SC#1 still requires the reranker; this is documented as a known limitation for the bootstrap path, not the steady-state path.
- **Delegate to RerankerSupervisor** — setup spawns the reranker as a one-shot externally-managed process; Angel's existing supervisor detects (`existing reranker detected on health port`) and reuses it on first heartbeat (no duplicated lifecycle logic).
- **MCP instructions resolve at registration, not module load** — `buildClaudexInstructions()` function called once at server construction. The MCP server is a fresh process per CC connect, so resolving once is sufficient — no runtime re-resolution complexity.
- **shell:true on Windows shim PATH resolution** — bun, ollama, python all ship as `.cmd` / `.bat` shims on Windows; node's `execFileSync` cannot resolve them without `shell: true`. POSIX is unaffected. Discovered live during 14-03 smoke; codified as a session-events comment for future readers.
- **`call bun ...` in install.bat** — without `call`, control transfers to bun.cmd and never returns; install.bat halts after the first invocation. Verified live; documented in install.bat REM comment.

## Out of scope (deferred)

- Doctor diagnostics → **Phase 15** (next phase)
- Fresh-VM verification on Mac/Linux → **Phase 16 HITL** (PLAT-06/07/08, VER-01..05)
- README Quick Start polish (DOC-03) and Troubleshooting (DOC-04) → **Phase 16** (depend on INST + DIAG)
- Public push to `grigorijejakisic/claudex` → **Phase 17**

## Files of interest

- `src/shared/projects-dir.ts` — single source of truth for the projects directory (40 lines, 5 unit tests)
- `src/cli/setup.ts` — orchestrator (enhanced, not rewritten — 270 → 320 lines)
- `src/cli/bootstrap-steps/` — modular, testable bootstrap step library (5 modules + 1 types file)
- `src/tests/cli/bootstrap-steps.test.ts` — 19 DI-mocked tests (no real bun/ollama/python/reranker spawned)
- `services/requirements.txt` — pinned reranker dependencies
- `install.sh` — POSIX first-touch wrapper (mode 100755, LF)
- `install.bat` — Windows first-touch wrapper (CRLF, `call bun` for shim handling)
- `.gitattributes` — line-ending policy (PLAT-05 baseline + explicit install-wrapper rules)
- `.planning/phases/14-.../14-01-CALLSITE-AUDIT.md` — classified audit consumed by 14-02

## v4.1 milestone progress

After Phase 14: **19/44 requirements complete** (LIC-01..03, DOC-01/02/05/06, PLAT-01..05, INST-01..07). 3 of 6 phases shipped; 25 reqs remaining across Phases 15, 16, 17 (DIAG, PLAT-06..08, VER, DOC-03/04, REL).
