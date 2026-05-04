# Phase 15: `claudex doctor` Diagnostics — Context

**Gathered:** 2026-05-02 (synthesized inline by team-lead orchestrator from PROJECT.md + REQUIREMENTS.md + Phase 14 outputs)
**Status:** Ready for planning
**Generative axiom:** When an install or session breaks, ONE command tells the operator exactly what's wrong and how to fix it. Doctor is the diagnostic surface that bridges Phase 14's bootstrap (which builds health) and Phase 16's onboarding (which depends on health being verifiable).

---

<domain>
## Phase Boundary

This phase delivers eight things and ONLY these eight:

1. **DIAG-01:** `bun run doctor` command exists and is documented in README (the documentation update lives here, not in Phase 16)
2. **DIAG-02:** Doctor checks Bun version (>=1.3) — pass/fail with version found
3. **DIAG-03:** Doctor checks Ollama running + `snowflake-arctic-embed2` model pulled
4. **DIAG-04:** Doctor checks BGE reranker reachable on port 7439 (HTTP probe to `/health`)
5. **DIAG-05:** Doctor checks `~/.claudex/db/claudex.db` exists and `PRAGMA user_version` matches build's expected schema version
6. **DIAG-06:** Doctor checks Claude Code hooks registered (reads CC settings, finds Claudex hook entries)
7. **DIAG-07:** Doctor checks Angel process alive (PID file exists + process running + heartbeat freshness from telemetry)
8. **DIAG-08:** Doctor returns exit 0 if all pass, exit 1 with actionable error per failed check

**Out of scope:**
- Auto-fix logic — doctor diagnoses, it doesn't repair (out of scope intentionally; "tell the user what's wrong" is the contract)
- New features beyond diagnostics
- Onboarding fixtures → Phase 16 territory
- Public push → Phase 17

**Hard gates:**
- `bun run build` (esbuild ~70ms) green throughout
- `bun run test` passes 3147 baseline + new tests for doctor checks + 20 baseline llama-server-supervisor failures unchanged from v4.0.0; anything beyond is regression
- `bun run vesna` 17/17 PASS at phase close (SC#1 holds)
- DB schema unchanged (no migrations)
- Hook semantics unchanged

</domain>

<decisions>
## Implementation Decisions

### Doctor architecture
- **Entry point:** `bun run doctor` → new `src/cli/doctor.ts` → `dist/cli/doctor.cjs`
- **Module structure:** `src/cli/doctor.ts` is a thin orchestrator that calls into `src/diagnostics/` for individual checks. Each check is its own module:
  - `src/diagnostics/check-bun.ts` (DIAG-02)
  - `src/diagnostics/check-ollama.ts` (DIAG-03)
  - `src/diagnostics/check-reranker.ts` (DIAG-04)
  - `src/diagnostics/check-db.ts` (DIAG-05)
  - `src/diagnostics/check-hooks.ts` (DIAG-06)
  - `src/diagnostics/check-angel.ts` (DIAG-07)
  - `src/diagnostics/types.ts` (shared `CheckResult` interface, `CheckStatus = 'pass' | 'fail' | 'warn'`)
  - `src/diagnostics/runner.ts` (executes all checks in parallel where independent, aggregates results)

### Check result contract
```ts
interface CheckResult {
  name: string;          // 'Bun version', 'Ollama', 'Reranker', etc.
  status: 'pass' | 'fail' | 'warn';
  detail: string;        // 'Bun 1.3.5' (pass) or 'Bun not found in PATH' (fail)
  remediation?: string;  // 'Install Bun: https://bun.sh' (only on fail/warn)
  durationMs: number;    // observability
}
```
- **`warn` status:** for things that aren't strictly broken but degrade behavior (e.g., reranker down → bi-encoder fallback works but SC#1 may degrade). Warn ≠ fail; doctor still exits 0 if all checks pass-or-warn (no fails).
- **`fail` status:** anything that prevents Claudex from working at all (no Bun, no DB, hooks not registered, etc.).

### Output format
- **Default:** human-readable table to stdout
  ```
  Claudex Doctor — checking install health
  ─────────────────────────────────────────
  ✓ Bun version            1.3.5         (4ms)
  ✓ Ollama                 running       (62ms)
  ✓ snowflake-arctic-embed2 pulled       (12ms)
  ✓ Reranker               port 7439     (118ms)
  ✓ DB schema              user_version=24 (8ms)
  ✓ CC hooks               6 registered  (3ms)
  ✓ Angel                  PID 73568, fresh heartbeat (5ms)
  ─────────────────────────────────────────
  All checks passed. Claudex is healthy.
  ```
- **`--json` flag:** machine-readable for CI/scripting
  ```json
  { "status": "pass", "checks": [ { "name": "Bun version", ... }, ... ] }
  ```
- **Exit codes:**
  - 0 — all checks pass (or pass + warn)
  - 1 — one or more fails
  - 2 — internal error (doctor itself crashed)

### Per-check decisions

**DIAG-02 (Bun):**
- Detection: `process.versions.bun` (Bun-native; works since doctor runs under Bun)
- Fail floor: `>=1.3`
- Detail format: `Bun 1.X.Y`
- Remediation on fail: `Install Bun >=1.3: https://bun.sh`
- Cross-platform: trivial (process.versions is portable)

**DIAG-03 (Ollama):**
- Detection (binary): same as Phase 14 INST-02 — reuse existing helper if present (`src/cli/setup.ts` has `detectOllama()`)
- Detection (running): `fetch('http://localhost:11434/api/tags')` with 2s timeout — connection refused = not running
- Detection (model): parse `/api/tags` response for `snowflake-arctic-embed2` entry
- Fail cases:
  - Binary not in PATH → "Ollama not installed. Install: <platform-specific link>"
  - Daemon not running → "Ollama installed but not running. Start: 'ollama serve' (or restart desktop app)"
  - Model not pulled → "snowflake-arctic-embed2 not pulled. Run: 'ollama pull snowflake-arctic-embed2'"

**DIAG-04 (Reranker):**
- Detection: `fetch('http://localhost:7439/health')` with 2s timeout
- Fail (HTTP non-200 or connection refused): warn (not fail) — bi-encoder fallback handles this; doctor surfaces the degraded state but doesn't block
- Detail: `port 7439` (pass) / `unreachable` (warn) / `HTTP 5xx` (warn)
- Remediation on warn: `Reranker on port 7439 unavailable. Bi-encoder fallback active. Run 'bun run setup' or restart Angel.`

**DIAG-05 (DB):**
- Detection: `fs.existsSync(path.join(os.homedir(), '.claudex', 'db', 'claudex.db'))`
- Schema check: open with `bun:sqlite` readonly; query `PRAGMA user_version`; compare against build's expected version (read from `src/core/migrations.ts` or a constant)
- Fail cases:
  - DB missing → "DB not initialized. Run 'bun run setup'."
  - Schema older than expected → "DB schema vN < build vM. Run 'bun run setup' to migrate."
  - Schema newer than expected → "DB schema vN > build vM. Update Claudex via git pull + bun run build."

**DIAG-06 (CC hooks):**
- Detection: read `~/.claude/settings.json`; parse `hooks` array; check for entries pointing to `dist/adapters/cc-hooks/*.cjs`
- Expected hooks (from current setup): session-start, session-end, user-prompt-submit, pre-tool-use, post-tool-use, stop, compact, others — count from existing setup script
- Detail: `N registered (expected M)` where N = found count, M = expected count
- Fail: `M - N > 0` registered hooks missing
- Remediation: "Hooks not registered. Run 'bun run setup'."

**DIAG-07 (Angel):**
- PID file: `~/.claudex/angel.pid` exists?
- Process alive: cross-platform check via `process.kill(pid, 0)` (sends signal 0 — verifies process exists without affecting it). Wrap in try/catch — if throws, process is dead.
- Heartbeat freshness: query `telemetry` table for most recent Angel heartbeat row; check timestamp is within 60s
- Fail cases:
  - No PID file → "Angel not running. Start via session-start hook (open Claude Code) or 'node dist/angel/index.cjs'."
  - PID stale (process dead): "Angel PID file stale (process gone). Delete '~/.claudex/angel.pid' and restart."
  - Heartbeat stale (>60s): warn (Angel might be busy in heavy consolidation phase)

**DIAG-08 (exit codes):**
- Aggregator: any `fail` → exit 1; all pass-or-warn → exit 0
- Internal error (doctor crashed) → exit 2 with stderr trace

### Documentation update (DIAG-01)
- README: add a small "Diagnostics" section after Quick Start (or below it; Quick Start is Phase 16 territory but the Diagnostics section can go in now and reference future Quick Start)
- CONTRIBUTING.md: add line in "Troubleshooting" or "Useful Commands" pointing to `bun run doctor`
- This is the ONLY documentation update for Phase 15 — Quick Start + Troubleshooting full rewrite is Phase 16

### `package.json`
- Add `"doctor": "node dist/cli/doctor.cjs"` to `scripts` (mirrors existing `setup` pattern)
- `build.ts` should pick up `src/cli/doctor.ts` automatically if it follows the existing entry-point convention; verify

</decisions>

<integration_points>
## Integration Points

- **Phase 14's `src/cli/setup.ts`:** doctor checks should re-use detection helpers from setup where applicable (Ollama detection, reranker probe, etc.). Avoid duplication; extract shared helpers to `src/diagnostics/` and import from both places if needed.
- **Phase 14's `src/shared/projects-dir.ts`:** doctor doesn't need to validate this directly (it's an env var; nothing to check), but doctor's report should include the configured value as informational metadata.
- **Existing AngelSupervisor / heartbeat telemetry:** doctor reads from existing telemetry table; no new schema needed.
- **Existing migrations (`src/core/migrations.ts`):** export the expected `user_version` constant for doctor to check against. If not exported, add a small change to expose it.
- **Existing setup hook registration logic:** know the canonical list of expected hooks; doctor compares actual against expected.
- **`build.ts`:** ensure new `src/cli/doctor.ts` and `src/diagnostics/*.ts` are picked up (likely via glob; verify).

</integration_points>

<acceptance>
## Acceptance Criteria

The phase is closed when:

1. `bun run doctor` runs on this Windows machine, exits 0 with all checks passing (since v4 IS installed and healthy here)
2. `bun run doctor --json` produces well-formed JSON with all check results
3. `src/cli/doctor.ts` exists; `src/diagnostics/` directory contains 7 modules (1 per check + types + runner)
4. Each check has unit tests covering pass + fail cases (mocked subprocess + filesystem); ≥14 new tests total
5. Doctor exits 1 when any check fails (test by mocking missing prereq)
6. README has Diagnostics section mentioning `bun run doctor`
7. `package.json` has `"doctor": "node dist/cli/doctor.cjs"` script
8. `bun run build` green; `bun run test` 3147+14 = 3161+ + 20 baseline llama unchanged; `bun run vesna` 17/17 PASS
9. Atomic per-task commits using `phase(15):` convention; SUMMARY.md per plan; phase-close commit at end with STATE/ROADMAP/REQUIREMENTS marking Phase 15 [x] and DIAG-01..08 [x] in traceability

</acceptance>

<plan_authorization>
## Pre-authorized Plan Decisions

The plan-phase agent has authority to:

- Use the locked decisions in `<decisions>` without re-asking the operator
- Decide whether to split into per-check plans (8 plans) or grouped (4-5 plans by theme: bun+db, ollama+reranker, hooks+angel, cli+docs+close)
- Choose the exact directory structure under `src/diagnostics/` (decisions section is a guide, not gospel — refactor if cleaner)
- Re-use detection helpers from `src/cli/setup.ts` (Phase 14) — extract shared helpers if duplication appears
- Decide between fetch (built-in undici via Node 22+/Bun) vs http module for HTTP probes — fetch is simpler

The plan-phase agent does NOT have authority to:

- Add auto-fix logic (out of scope)
- Add new diagnostic checks beyond DIAG-01..08 (scope lock)
- Modify DB schema (no migrations)
- Touch `services/reranker.py`
- Move Quick Start or Troubleshooting README work into this phase (Phase 16 territory)

</plan_authorization>

<open_questions>
## Open Questions

None at phase-context creation time. The doctor surface is well-understood; per-check logic is straightforward; the only judgment is structure (one big file vs split modules) and split is preferred for testability.

If genuinely needs operator input mid-flow (e.g., "expected hook list isn't documented anywhere in code, doctor needs a source of truth that doesn't exist") → SendMessage team-lead. The bar is "this changes the deliverable shape," not "I want to confirm an obvious choice."

</open_questions>
