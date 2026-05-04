---
phase: 14
plan: 03
subsystem: bootstrap
tags: [INST-01, INST-02, INST-03, INST-04, bun-version, ollama-detect, model-pull, reranker-bootstrap]
requires: []
provides: [bun-run-setup-bootstrap]
affects:
  - src/cli/setup.ts
  - src/cli/bootstrap-steps/types.ts
  - src/cli/bootstrap-steps/bun-version.ts
  - src/cli/bootstrap-steps/ollama-detect.ts
  - src/cli/bootstrap-steps/model-pull.ts
  - src/cli/bootstrap-steps/reranker-bootstrap.ts
  - src/tests/cli/bootstrap-steps.test.ts
  - services/requirements.txt
tech-stack:
  added: [services/requirements.txt]
  patterns: [step-orchestrator, dependency-injection, idempotent-short-circuit, best-effort-fallback, detached-spawn]
key-files:
  created:
    - src/cli/bootstrap-steps/types.ts
    - src/cli/bootstrap-steps/bun-version.ts
    - src/cli/bootstrap-steps/ollama-detect.ts
    - src/cli/bootstrap-steps/model-pull.ts
    - src/cli/bootstrap-steps/reranker-bootstrap.ts
    - src/tests/cli/bootstrap-steps.test.ts
    - services/requirements.txt
  modified:
    - src/cli/setup.ts
key-decisions:
  - "Module-per-step under src/cli/bootstrap-steps/ — keeps setup.ts a thin orchestrator and lets each step be unit-tested with DI"
  - "Reranker delegation via approach A (one-shot detached spawn that Angel's RerankerSupervisor reuses on first heartbeat). Avoids running an Angel process from setup."
  - "shell:true added to bun/ollama/python execFileSync calls — Windows shim binaries (bun.cmd, ollama.exe, python.exe) need shell PATH resolution; POSIX is unaffected"
  - "Reranker bootstrap is best-effort: Python missing, venv-create fail, pip-install fail, /health timeout all return ok:true + warning. Setup never hard-fails on reranker per CONTEXT.md INST-04 fallback decision."
  - "5-min timeout on ollama pull (typical first pull is ~1GB); 60s budget on /health poll (model load takes time); 10-min budget on pip install (torch wheel can be heavy)"
requirements-completed:
  - INST-01
  - INST-02
  - INST-03
  - INST-04
duration: 22 min
completed: 2026-05-01
---

# Phase 14 Plan 03: Bootstrap steps wired into bun run setup Summary

`bun run setup` is now a complete one-command bootstrap: Bun version → Ollama detect+daemon → embedding model pull → BGE reranker venv+spawn (best-effort) → projects-dir resolve → claudex home + DB + config → CC hooks. Idempotent: re-runs short-circuit on the already-pulled model and already-healthy reranker.

**Tasks:** 6
**Files created:** 7
**Files modified:** 1
**Commits:** 6

## Tasks completed

| Task | Commit | What |
|------|--------|------|
| 14-03-01 | fb8e600 | services/requirements.txt (torch, sentence-transformers, transformers, fastapi, uvicorn, pydantic) |
| 14-03-02 | 9eaf8e8 | bootstrap-steps/{types, bun-version, ollama-detect, model-pull}.ts |
| 14-03-03 | 0326e38 | bootstrap-steps/reranker-bootstrap.ts (venv + pip + spawn + health-poll, best-effort) |
| 14-03-04 | 7fe4ef0 | Wired into setup.ts as steps 1-8; shell:true added for Windows shim PATH resolution |
| 14-03-05 | 88f38d5 | 19 unit tests across the four steps via DI |
| 14-03-06 | (this commit) | E2E smoke + SUMMARY |

## Live smoke test on this Windows machine

First run:
```
[1/8] Checking Bun version...               [OK] Bun 1.3.6 (>= 1.3.0)
[2/8] Detecting Ollama...                   [OK] Ollama present and daemon reachable
[3/8] Pulling embedding model...            [OK] Model snowflake-arctic-embed2 already present
[4/8] Bootstrapping BGE reranker...         [OK] Reranker already healthy on :7439 (skipping bootstrap)
[5/8] Resolving projects directory...       [OK] Projects directory: C:\Users\Grigorije\Projects
[6/8] Creating Claudex home directory...    [OK] C:\Users\Grigorije\.claudex
[7/8] Initializing database...              [OK] C:\Users\Grigorije\.claudex\db\claudex.db
                                            [OK] Config preserved: C:\Users\Grigorije\.claudex\config.json
[8/8] Registering CC hooks...               [OK] Hooks registered in: C:\Users\Grigorije\.claude\settings.json

Setup complete! Claudex v3 is ready.
```

Second run (idempotency): identical output, exit 0.

## Verifications passed

- `bun run build` green
- `bun run test`: **3147 passing** (3128 post-14-02 + 19 new bootstrap-steps tests); 20 baseline llama failures unchanged from v4.0.0
- `bun run vesna`: **17/17 PASS** (entity-recall 3/3, constraint-recall 3/3, handoff-pickup 3/3, cross-project 3/3, lesson-application 3/3, self-instrumented 2/2 — AGGREGATE: 100% GATED PASS)
- DB schema unchanged
- Hook semantics unchanged (post-setup grep confirms 25 hooks still registered)
- Existing v4 install state preserved: `curl /health` returns 200, hooks intact, DB intact
- `ollama list` shows snowflake-arctic-embed2:latest (1.2 GB)

## Reranker delegation approach

**Approach A** (CONTEXT.md preferred): setup spawns reranker once as a detached, externally-managed process; Angel's existing RerankerSupervisor detects it on first heartbeat (`existing reranker detected on health port — supervising external instance`) and reuses it without respawn.

In the live smoke this short-circuited at step 4 (already-healthy short-circuit) because Angel was already supervising a reranker. Cold-install path is exercised by the unit tests.

## Deviations from Plan

- **`shell: true` added to spawn/exec calls.** PLAN.md did not explicitly call this out, but the first live run on this Windows machine surfaced that `bun`, `ollama`, and `python` all ship as PATH shims (.cmd, .ps1 wrappers) that node's `execFileSync` cannot resolve without `shell: true`. Cross-platform — POSIX is unaffected by the flag. Documented in commit 7fe4ef0.

## Next

Ready for 14-04 (install.sh + install.bat wrappers).
