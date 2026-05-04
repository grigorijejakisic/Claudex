# Phase 14: Bootstrap Install + Configurable Paths — Context

**Gathered:** 2026-04-30 (synthesized inline by team-lead orchestrator from PROJECT.md + REQUIREMENTS.md + v4.1 milestone kickoff conversation + Phase 13 portability audit)
**Status:** Ready for planning
**Generative axiom:** A stranger runs ONE command from a clean clone and ends up with a working session in their first user turn. No insider knowledge required. No hidden steps. No "now go install Ollama and pull the model and start Python on port 7439."

---

<domain>
## Phase Boundary

This phase delivers seven things and ONLY these seven:

1. **INST-01:** One-command bootstrap (`bun run setup`) sets up everything from clean clone, exit 0 success, idempotent (safe to re-run)
2. **INST-02:** Bootstrap detects Ollama; if missing, prints platform-specific install instruction and exits 1 (does NOT auto-install — Ollama is a sudo-class operation; we surface the link instead)
3. **INST-03:** Bootstrap pulls `snowflake-arctic-embed2` model via `ollama pull` (idempotent — Ollama itself skips if already pulled)
4. **INST-04:** Bootstrap sets up Python venv for the BGE reranker, pip-installs requirements, starts the service on port 7439, verifies HTTP 200 on `/health`
5. **INST-05:** Hardcoded `~/Desktop/Projects/` replaced with configurable `CLAUDEX_PROJECTS_DIR` env var (default: `~/Projects/` cross-platform via `os.homedir()`)
6. **INST-06:** MCP server registration (`src/mcp/recall-server.ts` instructions) uses the configurable projects directory; existing project registry at `~/.claudex/projects.json` migrates if needed
7. **INST-07:** First-session UX: after `bun run setup`, opening Claude Code in any project directory under `CLAUDEX_PROJECTS_DIR` produces working assembly within 1 user turn (hooks fire, Angel spawns, MCP serves)

**Out of scope:**
- Doctor diagnostics → Phase 15's territory (different command: `bun run doctor` vs `bun run setup`)
- Fresh-VM verification on Mac/Linux → Phase 16 HITL
- README Quick Start that walks through this → Phase 16 polish
- Public push / tag / release → Phase 17
- New features beyond install
- Bundling Ollama or Python into a single binary (out of scope for v4.1)

**Hard gates:**
- `bun run build` (esbuild ~70ms) green throughout
- `bun run test` (vitest) passes 3123 tests + 20 baseline llama-server-supervisor failures unchanged from v4.0.0; anything beyond is regression
- `bun run vesna` 17/17 PASS at phase close (SC#1 holds)
- DB schema unchanged (no migrations needed for env-var refactoring)
- Hook semantics unchanged
- Idempotency: `bun run setup` runnable any number of times without breaking state
- No regression in current install: I'm running v4 right now via the old setup; the new setup must produce a state at least as healthy

</domain>

<decisions>
## Implementation Decisions

### Bootstrap script architecture (INST-01)
- **Primary entry:** `bun run setup` → existing `src/cli/setup.ts` → `dist/cli/setup.cjs`. **Enhance, don't rewrite.** Existing script registers hooks; we extend it with bootstrap steps.
- **Bootstrap step ordering** (each step idempotent + skippable if already-done):
  1. Verify Bun version (>=1.3) — fail with clear message if missing
  2. Verify or detect Ollama — print install link + exit 1 if missing (INST-02)
  3. Pull `snowflake-arctic-embed2` (INST-03)
  4. Bootstrap reranker venv + start service (INST-04)
  5. Determine `CLAUDEX_PROJECTS_DIR` (INST-05) — env var or default
  6. Initialize DB if missing (`~/.claudex/db/claudex.db` schema bootstrap)
  7. Register CC hooks (existing `setup:hooks` logic)
  8. Sanity check: read MCP server settings, verify expected paths
  9. Print "ready" summary with next-step instruction
- **`install.sh` POSIX wrapper** at repo root for Mac/Linux first-touch UX:
  ```sh
  #!/usr/bin/env bash
  set -e
  command -v bun >/dev/null || { echo "Bun not found. Install: https://bun.sh"; exit 1; }
  bun install --frozen-lockfile
  bun run build
  bun run setup
  ```
  Make executable (`chmod +x` via `git update-index --chmod=+x`)
- **`install.bat` Windows wrapper** at repo root (parity):
  ```bat
  @echo off
  where bun >nul 2>&1 || (echo Bun not found. Install: https://bun.sh && exit /b 1)
  bun install --frozen-lockfile && bun run build && bun run setup
  ```

### Ollama detection (INST-02)
- **Method:** spawn `ollama --version` with timeout; exit code 0 = present
- **Missing handler:**
  - macOS: `Install Ollama: https://ollama.com/download/mac (or 'brew install ollama')`
  - Linux: `Install Ollama: curl -fsSL https://ollama.com/install.sh | sh`
  - Windows: `Install Ollama: https://ollama.com/download/windows`
- **Detection of Ollama running** (vs just installed): `curl -s http://localhost:11434/api/tags` — if connection refused, print `Ollama installed but not running. Start: 'ollama serve' (or restart if launched via app)` and exit 1

### Model pull (INST-03)
- **Method:** `ollama pull snowflake-arctic-embed2` — Ollama itself is idempotent (skips if model layers already present)
- **Verification:** `ollama list | grep snowflake-arctic-embed2` post-pull
- **Timeout:** allow 5 min for first pull (model is ~1GB); print progress if Ollama emits stream

### Reranker bootstrap (INST-04)
- **Python tooling decision: use standard `venv` + `pip`.** Rationale: maximum compatibility, ships with Python 3.11+ natively, no extra dependency. (We considered uv — faster + better — but adding a Python tool dependency to install Claudex is the wrong direction; we want fewer pre-reqs not more. uv can be a Phase 16+ optimization if benchmarks show pip is too slow.)
- **Python version requirement:** Python 3.11+ (existing `services/reranker.py` likely already requires this; verify and pin)
- **Steps:**
  1. Detect Python 3.11+ — `python3 --version` (Mac/Linux) or `python --version` (Windows); fall back to alternate name; fail with install link if missing
  2. Create venv at `services/.venv/` (gitignored already? verify) if missing
  3. Activate venv + `pip install -r services/requirements.txt` (existing file?) — if no requirements.txt, create one with `transformers`, `torch`, `fastapi`, `uvicorn`, `pydantic`
  4. Start reranker as background process; wait for HTTP 200 on `/health` (timeout 60s — model load takes time)
  5. Persist PID to `~/.claudex/reranker.pid` for Angel's RerankerSupervisor to reuse
- **Cross-platform service start:**
  - Mac/Linux: `nohup` + redirect to log file + background
  - Windows: detached spawn via `child_process.spawn` with `detached: true` + `unref()`
  - Or: hand off to existing RerankerSupervisor (in `src/angel/reranker-supervisor.ts`) which already handles cross-platform — just trigger Angel start
- **Fallback when reranker can't boot:** print warning, document degraded-mode (bi-encoder fallback ships in v4 already), don't fail setup hard. The reranker is required for Vesna SC#1 ≥80% but the install can complete without it; document this as known limitation.

### `CLAUDEX_PROJECTS_DIR` env var (INST-05)
- **Default:** `path.join(os.homedir(), 'Projects')` — cross-platform via Node's `path` module + `os.homedir()`
- **Resolution function:** new helper `src/shared/projects-dir.ts` exporting `getProjectsDir(): string`
  - If `process.env.CLAUDEX_PROJECTS_DIR` set, return it (resolved)
  - Else return default `~/Projects`
  - Ensure directory exists (mkdir -p semantics) at first call; idempotent
- **Migration of existing `~/Desktop/Projects/` users:** If env var unset AND `~/Projects` doesn't exist AND `~/Desktop/Projects/` exists, print warning suggesting they set `CLAUDEX_PROJECTS_DIR=~/Desktop/Projects` to keep using old layout, OR move/symlink. Don't auto-migrate (destructive).
- **Audit + replace 10 callsites** (from grep):
  - `src/angel/curated-context-extractor.ts:119` — comment, leave as is (documents user-content shape)
  - `src/angel/llama-server-supervisor.ts:26,46,48` — defaults for env-overridable paths; leave (separate concern)
  - `src/angel/memory-md-writer.ts:94` — comment in JSDoc; update to mention `CLAUDEX_PROJECTS_DIR`
  - `src/assembly/sections.ts:71` — system-reminder text shown to agent; UPDATE to use env var lookup at runtime
  - `src/core/session-events.ts:332` — path simplification regex; update to handle both old default + new env var value
  - `src/mcp/recall-server.ts:127` — MCP instructions text; UPDATE to use env var
  - `src/shared/content-router.ts:9` — JSDoc comment; UPDATE
  - `src/shared/scope-detector.ts:108` — JSDoc + actual implementation if hardcoded; UPDATE
- **Test coverage:** unit tests for `getProjectsDir()` covering: env var set, env var unset (default), platform-specific home dir resolution

### MCP server registration (INST-06)
- **Existing state:** MCP registration done by `bun run setup` already; reads/writes `~/.claude/settings.json`
- **Change:** registration includes the `CLAUDEX_PROJECTS_DIR` value (or default) so the MCP server's instructions text is correct
- **Project registry migration:** `~/.claudex/projects.json` — if exists with old `~/Desktop/Projects/` paths, leave alone (the env var lookup will find them under the new env if set; otherwise users keep working with the old paths until they explicitly migrate). No automatic data migration.

### First-session UX (INST-07)
- **Acceptance:** after `bun run setup` exits 0, opening Claude Code in any project directory inside `CLAUDEX_PROJECTS_DIR` produces:
  - SessionStart hook fires (visible: assembly pipeline injects context within 1 user turn)
  - Angel spawns (visible: PID file written to `~/.claudex/angel.pid`)
  - MCP server reachable (visible: `claudex_search` tool callable)
- **Verification approach for this phase:**
  - Static: tests of bootstrap script paths
  - Dynamic on this Windows machine: re-run `bun run setup` after the changes; verify hooks still fire, Angel still alive, reranker still on 7439 (we know v4 IS installed today; setup must be at-least-as-good)
  - Cross-platform dynamic: Phase 16 HITL VM tests

</decisions>

<integration_points>
## Integration Points

- **Existing `src/cli/setup.ts`:** the entry point we enhance. Read it first to understand current setup logic before extending.
- **Existing RerankerSupervisor (`src/angel/reranker-supervisor.ts`):** already handles cross-platform reranker start within Angel's runtime. Phase 14's INST-04 should DELEGATE to this supervisor when possible rather than duplicating logic.
- **Existing AngelSupervisor (`src/angel/angel-supervisor.ts`?):** Angel auto-spawns from session-start hook today; setup doesn't need to start Angel directly.
- **Existing project registry (`~/.claudex/projects.json`):** maintained by content-router and scope-detector; touchable but not migrate-able automatically.
- **Existing MCP server instructions (`src/mcp/recall-server.ts:127`):** literal text shown to the agent at session start; referenced by assembly pipeline.
- **`services/reranker.py`:** existing Python service. Read it to understand its dependencies + startup contract.
- **`services/requirements.txt`** (if exists): the dependency manifest for the reranker venv.
- **Hook registration logic:** wherever `bun run setup:hooks` does its work — extend, don't rewrite.
- **Phase 13's `src/shared/process-control.ts`:** use this for any process-killing logic in INST-04 (reranker start should reuse `terminateProcess` if it needs to recover from a stale PID).

</integration_points>

<acceptance>
## Acceptance Criteria

The phase is closed when:

1. `bun run setup` runs end-to-end on this Windows machine, exits 0, and produces a state at least as healthy as the current install (Angel alive, reranker on 7439, MCP serving, hooks registered)
2. `bun run setup` is idempotent: running it again immediately after produces same state, exits 0
3. `install.sh` exists at repo root with `chmod +x` (POSIX wrapper); `install.bat` exists at repo root (Windows wrapper)
4. Ollama missing → setup exits 1 with platform-specific install link (test via `mv`-ing ollama temporarily, or unit test of detection function)
5. `snowflake-arctic-embed2` model pulled and verifiable via `ollama list`
6. BGE reranker venv at `services/.venv/` exists; reranker process responds to HTTP `/health` with 200
7. `src/shared/projects-dir.ts` exports `getProjectsDir()` with unit tests covering env-set/env-unset/cross-platform defaults
8. All identified `~/Desktop/Projects/` callsites updated to use `getProjectsDir()` or env-var lookup; grep `~/Desktop/Projects/` returns only acceptable references (docs/comments documenting old default, not active path construction)
9. MCP server's instructions text uses the env var lookup
10. `bun run build` green, `bun run test` 3123+ baseline + new tests for projects-dir helper, `bun run vesna` 17/17 PASS
11. Atomic per-task commits using `phase(14):` convention; SUMMARY.md per plan; phase-close commit at end with STATE/ROADMAP/REQUIREMENTS marking Phase 14 [x] and INST-01..07 [x] in traceability

</acceptance>

<plan_authorization>
## Pre-authorized Plan Decisions

The plan-phase agent has authority to:

- Use the locked decisions in `<decisions>` without re-asking the operator
- Decide whether to merge INST-02 + INST-03 into one plan (Ollama-related) or split (bisectability)
- Choose between dedicated reranker-bootstrap plan vs folding into setup.ts enhancement plan
- Defer reranker bootstrap to a "best-effort" mode (warn but don't fail setup) per CONTEXT.md fallback decision if Python tooling proves brittle on Windows during execution
- Decide on number of plans (estimated 4-6 plans for this phase given scope)
- Add a small `services/requirements.txt` if it doesn't exist; or read existing one if it does
- Skip the `install.sh`/`install.bat` wrappers if `bun run setup` alone proves sufficient AND the user can be expected to know what `bun` is (but default: ship the wrappers, they're cheap)

The plan-phase agent does NOT have authority to:

- Bundle Ollama or Python (out of scope per `<domain>`)
- Migrate project registry data automatically (per CONTEXT.md decision — destructive)
- Change DB schema (no migrations in this phase)
- Replace existing RerankerSupervisor with a new abstraction (delegate, don't replace)
- Add features beyond install (no doctor checks; that's Phase 15)

</plan_authorization>

<open_questions>
## Open Questions

None at phase-context creation time. All major design decisions are locked above. The plan-phase agent may surface implementation-detail questions during decomposition (e.g., "should the venv live in `services/.venv` or a hidden `.cache/` location?") — these can be answered from project conventions (existing `.gitignore` patterns + Python community norms favor `services/.venv` near the code).

If genuinely needs operator input mid-flow (e.g., "reranker won't boot at all on Windows in fresh-VM scenario, fundamentally different approach needed") → SendMessage team-lead. Bar is "this changes deliverable shape," not "I want to confirm an obvious choice."

</open_questions>
