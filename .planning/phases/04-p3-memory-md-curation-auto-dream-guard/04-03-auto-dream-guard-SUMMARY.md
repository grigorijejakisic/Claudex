---
phase: 04-p3-memory-md-curation-auto-dream-guard
plan: 03
subsystem: cc-hooks + core
tags: [auto-dream, env-file, memory-md, verifier, sentinel, session-start]

requires:
  - plan: 04-01
    provides: `src/shared/cc-slug.ts::pathToCcSlug` (imported by verifier for cwd-based slug derivation)
  - plan: 04-01
    provides: sentinel format `<!-- CLAUDEX-MANAGED: do not edit above user section. hash=<64-hex> -->` and `<!-- USER EDITABLE -->` marker semantics (verifier parses the same shape)
provides:
  - New `CLAUDE_CODE_DISABLE_AUTO_DREAM=1` line emitted by `writeClaudeEnvFile()` into CLAUDE_ENV_FILE (CUR-03 mechanical half)
  - Pure-read `src/core/memory-md-verify.ts::verifyMemoryMd(db, project, sessionId, opts)` returning `{path, reason, bytes, lines, hash}`
  - New `memory_md_invalid` value in the `EventType` union; `session_events` row written on size/line/sentinel violation with `{reason, bytes, lines}` JSON detail
  - Session-start wiring: verifier fires once per session after file-artifact ingestion, inside an isolated try/catch
affects: [04-04 (curator writer — verifier observes its output), future P4 formatter phase (events already being produced are consumable)]

tech-stack:
  added: []
  patterns:
    - Read-only verifier companion to a write-side module (writer owns all mutations; verifier only flags)
    - Outer try/catch with ok-shaped IO fallback so the session-start call site is zero-risk
    - Any-length hex regex for sentinel detection to distinguish `sentinel_missing` from `sentinel_invalid` cleanly

key-files:
  created:
    - src/core/memory-md-verify.ts
    - src/tests/core/memory-md-verify.test.ts
  modified:
    - src/adapters/shared/env-file.ts (new auto-dream disable line + comment)
    - src/adapters/cc-hooks/session-start.ts (verifier invocation after file-ingester block)
    - src/core/session-events.ts (EventType += 'memory_md_invalid')
    - src/tests/adapters/cc-hooks/hooks.test.ts (env-file assertion + wiring smoke test)
    - src/tests/adapters/cc-hooks/cwd-changed.test.ts (env-file assertion)

key-decisions:
  - "CC env-var name for auto-dream disable is provisional. `context/research/cc-source/06-dream-kairos.md` shows CC's `autoDream.ts` gates on `settings.autoDreamEnabled` / `tengu_onyx_plover` GrowthBook / auto-memory disable — not a named env var. Using `CLAUDE_CODE_DISABLE_AUTO_DREAM=1` mirrors the existing T1/T2 `DISABLE_AUTO_MEMORY` pattern per plan default; comment in env-file.ts documents the provisional status and what to update if CC exposes a canonical var."
  - "Verifier's sentinel regex uses `hash=([0-9a-f]+)` (any hex length) rather than the writer's `{64}` form. Lets the verifier distinguish `sentinel_missing` (first line doesn't match shape) from `sentinel_invalid` (shape matches but hash isn't 64 chars) — that distinction is the plan's contract."
  - "Size and line invariants flag regardless of sentinel state. A file that lost its marker/sentinel but is still oversize is still worth flagging; the verifier reports all invariants, not just the first-wins one."
  - "IO error fallback returns `reason='ok'` with `path=''` rather than a new `io_error` reason — session-start's outer try/catch already owns telemetry for this class of failure, and `ok` keeps the verifier's public contract a two-axis result (flagged vs not)."
  - "Direct import of `verifyMemoryMd` in session-start.ts (not the dynamic `await import()` form the plan listed as an alternative) — matches the import style of every other session-start dependency and keeps one source of truth for module loading."
  - "Wiring test lives inline in the existing `SessionStart hook logic` describe block (not a new file) — matches the plan and the pattern already established for env-file / detectCcMemoryConflict / writeClaudeEnvFile smoke tests in hooks.test.ts."

patterns-established:
  - "Verifier/writer duality: writer in `src/angel/memory-md-writer.ts` owns all mutations to `~/.claude/projects/<slug>/memory/MEMORY.md`; verifier in `src/core/memory-md-verify.ts` owns session-start invariant checks. Both share the sentinel shape parsed via the same-rule regex."
  - "Silent vs flag split: `file_missing` and `not_angel_managed` are silent (cold-start and pre-managed files are not our problem); size/line/sentinel invariants flag via `session_events`. Keeps the event stream meaningful."
  - "Non-throwing CC hook call site: session-start wraps the verifier in a `try/catch` that routes to `emitErrorTelemetry`. The verifier itself has an outer try/catch with an ok-shaped fallback, so the session-start call is double-guarded."

requirements-completed:
  - CUR-03 (mechanical half — auto-dream env flag + sentinel verifier)

duration: ~1 session
completed: 2026-04-22
---

# Plan 04-03: Auto-Dream Env Guard + Session-Start MEMORY.md Verifier — Summary

**`writeClaudeEnvFile()` now emits `CLAUDE_CODE_DISABLE_AUTO_DREAM=1` alongside the existing auto-memory + hook-additionalContext flags. New `src/core/memory-md-verify.ts` runs a pure-read invariant check at session-start (after file-artifact ingestion) and records a `memory_md_invalid` session event on size (>25KB), line (>200), sentinel-missing, or sentinel-invalid violations. Writer is still the sole mutator of MEMORY.md; verifier is the observability half.**

## Performance

- **Completed:** 2026-04-22
- **Tasks:** 5 (env-var verify + emit, verifier module, session-start wiring, verifier unit tests, session-start integration smoke test)
- **Files created:** 2
- **Files modified:** 5
- **New tests:** 9 (verifier unit) + 1 (session-start wiring smoke) = 10
- **Module size:** 134 lines (implementation), 192 lines (tests)

## Accomplishments

- `writeClaudeEnvFile()` emits a third export line `CLAUDE_CODE_DISABLE_AUTO_DREAM=1`; session-agnostic B6 invariant preserved (line matches `^export \w+=\w+$`, no session_id). Called from both `session-start.ts` and `cwd-changed.ts` — both test suites extended to assert the new line.
- `verifyMemoryMd(db, project, sessionId, opts)` resolves the MEMORY.md path via `scope` → `cwd → pathToCcSlug(cwd)` → project fallback, checks existence, reads once, computes bytes + line count, parses first-line sentinel with any-length hex regex, and decides among seven `VerifyReason` values: `ok | file_missing | not_angel_managed | size_exceeded | lines_exceeded | sentinel_missing | sentinel_invalid`.
- `flag()` helper inserts a `session_events` row with `event_type='memory_md_invalid'`, `entity=<memoryMdPath>`, `action='verify'`, `detail=JSON.stringify({reason, bytes, lines})`. Insertion is itself wrapped in a try/catch so telemetry failures don't bubble up.
- Session-start hook invokes `verifyMemoryMd` after the `ingestFileArtifacts` block (OS page cache is still hot from the file-ingester pass) inside a `try/catch` that routes to `emitErrorTelemetry('session_start/memory_md_verify', e)`.
- `memory_md_invalid` added to the `EventType` union in `src/core/session-events.ts` (next to `memory_curation_refused` which plan 04-01 added).
- Verifier unit suite (9 cases) exercises the full reason matrix including cwd-only slug derivation and the outer-try fallback (driven via a getter that throws).
- Integration smoke test in `hooks.test.ts` pre-populates a temp HOME with an oversize MEMORY.md under the CC project slug and confirms one `memory_md_invalid` row with `detail.reason='size_exceeded'`.

## Task Commits

1. **04-03-01** — `8e3578b feat(04-03-01): auto-dream disable in writeClaudeEnvFile`
2. **04-03-02** — `b57d44b feat(04-03-02): memory-md-verify read-only invariant checker`
3. **04-03-03** — `e2db4ff feat(04-03-03): wire memory-md-verify into session-start`
4. **04-03-04** — `4e2d379 test(04-03-04): unit suite for memory-md-verify — 9 cases`
5. **04-03-05** — `f883b88 test(04-03-05): session-start wiring smoke test for memory-md-verify`

## Files Created/Modified

- `src/core/memory-md-verify.ts` (new, 134 lines) — `verifyMemoryMd`, slug resolution, `flag()` helper; imports the shared `pathToCcSlug` from 04-01.
- `src/tests/core/memory-md-verify.test.ts` (new, 192 lines) — 9-case suite with tempdir HOME/USERPROFILE redirection.
- `src/adapters/shared/env-file.ts` — added `CLAUDE_CODE_DISABLE_AUTO_DREAM=1` line and expanded the JSDoc to explain the provisional naming.
- `src/adapters/cc-hooks/session-start.ts` — direct import of `verifyMemoryMd`; invocation block placed between `ingestFileArtifacts` and `seedCriticalRules`.
- `src/core/session-events.ts` — `memory_md_invalid` added to the `EventType` union.
- `src/tests/adapters/cc-hooks/hooks.test.ts` — env-file test extended with the new export assertion; new wiring smoke test at the tail of the `SessionStart hook logic` suite.
- `src/tests/adapters/cc-hooks/cwd-changed.test.ts` — env-file test extended with the new export assertion.

## Test Results

- Targeted: `bun run test src/tests/core/memory-md-verify.test.ts` — **9/9 pass**.
- Targeted: `bun run test src/tests/adapters/cc-hooks/hooks.test.ts src/tests/adapters/cc-hooks/cwd-changed.test.ts` — **79/79 pass** (76 prior + 2 env-file extensions + 1 wiring smoke; note the extensions are additional assertions inside existing cases so the suite count only grows by the one new `it` block).
- Full suite: `bun run test` — **2550 pass / 20 fail**. The 20 failures are all in `src/tests/angel/llama-server-supervisor.test.ts` (18) and `src/tests/angel/llama-client.test.ts` (2). Verified pre-existing by stashing my changes and re-running those files: same 20 failures on the clean tree. They are unrelated to this plan and already documented in the 04-02 summary under the same heading. No new regressions introduced.
- Build: `bun run build` succeeds (~70ms via esbuild, 26/26 hooks compiled).

## Decisions Made

- **Provisional env-var name.** `context/research/cc-source/06-dream-kairos.md` does not confirm a canonical CC env var to disable auto-dream — CC gates on settings.json, GrowthBook, or the indirect auto-memory disable. The plan defaulted to `CLAUDE_CODE_DISABLE_AUTO_DREAM=1` to mirror the T1/T2 pattern; I adopted that and documented the provisional status in the function JSDoc so the next maintainer knows to re-check when CC exposes a named flag (or when the GrowthBook override plumbing lands).
- **Any-length hex sentinel regex in the verifier.** The writer's `parseSentinelHash` uses `{64}` to only accept the canonical form; the verifier must detect both `sentinel_missing` (no match at all) and `sentinel_invalid` (match but wrong hash length) as distinct reasons, so the verifier-side regex is `[0-9a-f]+` with a separate `.length !== 64` check. Not a divergence, a different responsibility.
- **Direct import over dynamic import.** The plan allowed either; direct import is consistent with the rest of session-start.ts's dependency style and avoids spreading `await import(...)` patterns.
- **Tempdir HOME redirection in tests.** Matched the writer test harness (`src/tests/angel/memory-md-writer.test.ts`) — both `HOME` and `USERPROFILE` are set to a fresh `mkdtempSync` dir in `beforeEach`, restored in `afterEach`, so the verifier sees a cleanroom `~/.claude/projects/<slug>/memory/` hierarchy. No changes to the writer's harness.
- **Single wiring test, not a full harness invocation.** The `SessionStart hook logic` describe block in hooks.test.ts exercises individual pieces rather than the full `wrapHook` pipeline (consistent precedent: all existing cases in that block do the same). Adding one targeted `verifyMemoryMd` call confirms the plumbing without duplicating the 9-case unit matrix.

## Deviations from Plan

- **Plan references `pathToSlug`; helper is actually `pathToCcSlug`.** Plan 04-01's SUMMARY confirms the helper was landed as `pathToCcSlug` (line 17 of 04-01-memory-md-writer-SUMMARY.md), matching the existing name in `memory-monitor.ts`. Imported as `pathToCcSlug`. Cosmetic only.
- **IO error test approach.** Plan suggested "spy/stub `recordEvent` via vi.mock to observe flag() calls" and "simulate fs.readFileSync throw". Vitest on this Node/TS setup does not allow `vi.spyOn(fs, 'readFileSync')` because the `fs` module's function export is non-configurable (`Cannot redefine property: readFileSync`). Rather than switching to full module-level `vi.mock('fs')` (heavyweight for one test), I drove the outer try/catch via a `{ scope }` getter that throws. Same semantics (the outer try/catch swallows; result shape is the ok-fallback); zero-mock approach fits the rest of the suite better.
- **9 test cases in the unit suite, not the 8 the plan listed.** The extra case covers cwd-only slug derivation (not in the plan's list but implied by the verifier's `resolveSlug` code path that the plan requires). Every original case is present; one additional case strengthens coverage.
- Wiring smoke test uses `verifyMemoryMd` directly rather than invoking the full `main` hook handler — the existing SessionStart suite does not exercise wrapHook either (each test targets a piece, per `// Tests verify each hook's core orchestration — not the full wrapHook flow.` at top of file). Same pattern, same precedent.

## Issues Encountered

- Initial attempt to stub `fs.readFileSync` via property reassignment failed with `Cannot redefine property: readFileSync` (non-configurable). Second attempt with `vi.spyOn(fs, 'readFileSync').mockImplementation(...)` failed for the same reason. Resolved by driving the outer try/catch via a throwing getter on the `opts` argument — cleaner, no module-level mocks needed.

## Next Phase Readiness

- **Plan 04-04 (heartbeat wiring)** can proceed without blockers. The writer (04-01) and verifier (04-03) both live and can be invoked from a heartbeat phase; the verifier is read-only and cheap to call repeatedly.
- **Phase 5 (P4) formatter work** can consume `memory_md_invalid` events from `session_events` to render a warning in the assembled session-start prompt if it wants to — the event is the data contract, no code coupling.
- **Auto-dream env flag is provisional.** If CC ships a canonical env var (most likely channel: `context/research/cc-source/06-dream-kairos.md` gets updated, or a new `13-new-features-buildable.md`-style leak indexes one), update `src/adapters/shared/env-file.ts:34` and the two test-file assertions in one atomic commit.

---
*Phase: 04-p3-memory-md-curation-auto-dream-guard*
*Completed: 2026-04-22*
