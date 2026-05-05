---
phase: 02-multi-modal-index-seeds-density-check
plan: 02
subsystem: substrate/fingerprinter
tags: [v5, phase2, idx-01, fingerprint, ingest]
requires: [phase-1-substrate, v26-schema]
provides: [error-fingerprint-module, tool-result-fingerprinting, features.error_fingerprint-flag]
affects:
  - src/core/error-fingerprint.ts
  - src/core/episodic-events.ts
  - src/shared/config.ts
  - src/shared/constants.ts
tech-stack:
  added: []
  patterns: [pure-fn-extractor, sidecar-feature-payload]
key-files:
  created:
    - src/core/error-fingerprint.ts
    - src/tests/core/error-fingerprint.test.ts
    - src/tests/adapters/episodic-events/tool-result-fingerprint.test.ts
  modified:
    - src/core/episodic-events.ts
    - src/shared/config.ts
    - src/shared/constants.ts
key-decisions:
  - "Fingerprint algorithm: token-shingle (whitespace tokens, width=5) + sha256-truncated-to-16-hex; deterministic by Set+sort."
  - "OUTER_EXCEPTION regex prefix relaxed to [\\w.]* (not [\\w.]+) so plain 'Error: ...' headers extract 'Error' as outer_exception. Prior pattern would have missed un-prefixed Error/Exception headers."
  - "writeToolResult emits 'error_fingerprint' key as OMITTED (not null) when content fails the stack-trace heuristic. Phase 4 extractor reads metadata_json defensively; null vs absent are now consistent."
  - "Feature flag pattern: optional param errorFingerprintEnabled on ToolResultWriteParams falls back to loadConfig().features.error_fingerprint when unset. Plan 02-05 flips DEFAULT_CONFIG entry on KILL/SCOPE_DOWN — no production caller changes."
  - "Sidecar table NOT written from writeToolResult — Plan 02-03 owns sidecar inserts. CONTEXT item 6 stance: ingest path is per-row metadata_json only; sidecar population is the explicit one-time backfill."
  - "Atomicity preserved: fingerprint compute is best-effort; throws are routed to telemetry with detail.kind='fingerprint_error' and the row is still written with error_fingerprint omitted."
requirements-completed: [IDX-01]
duration: "15 min"
completed: "2026-05-04"
---

# Phase 2 Plan 2: Pure Error Fingerprinter + Ingest-Time Wiring Summary

Pure fingerprint module + transparent attachment from `writeToolResult` to `episodic_events.metadata_json.error_fingerprint`, gated by the `features.error_fingerprint` flag (defaulted true for Phase 2 measurement, scaffolded for Plan 02-05's verdict-driven flip).

## Final algorithm choices

- **Token unit**: whitespace split (`/\s+/`), filter empty.
- **Shingle width**: 5 (`SHINGLE_WIDTH=5`).
- **Hash**: `crypto.createHash('sha256').update(ngram).digest('hex').slice(0, 16)` — first 16 hex chars (64 bits) is enough to keep collisions trivially small at our corpus scale (≤100 events × ~50 shingles each = 5000 entries; collision probability << 1 at 64-bit).
- **Determinism**: `Set` for dedup, lexical `sort()` for byte-stable order. No clocks, no PRNGs.
- **Outer exception**: `^([\w.]*(?:Error|Exception|Failed|Failure)):\s` multiline. The relaxed `*` (vs `+`) prefix admits both prefixed (`sqlite3.OperationalError`, `TypeError`) and unprefixed (`Error: ...`) headers. The plan's PLAN.md pattern would have missed plain `Error:` headers — caught during integration tests.
- **Frame extraction**: tries Node `^\s+at <func> (<file>:<line>:<col>)` → Python `^\s+File "<file>", line <line>(, in <func>)?` → generic `<file>:<line> ... <func>(`. Frames missing both file+line are skipped; func may be empty string.

## Flag-off scaffold contract

`ToolResultWriteParams.errorFingerprintEnabled?: boolean` — optional. When omitted, `writeToolResult` calls a non-throwing `resolveErrorFingerprintFlag()` helper that reads `loadConfig().features.error_fingerprint` (returns `true` on read failure, missing key, or non-boolean — Phase 2 default). When set explicitly (`true` or `false`), the param wins over the config — used by tests and by Plan 02-05's verdict-driven side-effect path.

The flag flip in Plan 02-05 is a single-line change in `src/shared/constants.ts`: `error_fingerprint: true` → `error_fingerprint: false`. Existing fingerprint rows in `metadata_json` and existing sidecar rows are untouched (CONTEXT item 7: "Backfilled rows retained — destructive cleanup is not the answer").

## Authentication Gates

None.

## Deviations from Plan

**[Rule 1 - Bug] OUTER_EXCEPTION prefix relaxed from `[\w.]+` to `[\w.]*`** — Found during: integration test "attaches error_fingerprint to metadata_json when toolResult looks like a stack trace" (initial run failed with `expected null to be 'Error'`) | Issue: the PLAN.md regex required at least one word character before `Error|Exception|Failed|Failure`, which excluded the canonical `Error: ...` and `Exception: ...` headers. Plan 02-04's pair-labeler also reads `outer_exception` for ground-truth labeling, so dropping these headers would silently shrink the labeled-pair corpus. | Fix: changed `+` to `*`. | Files modified: `src/core/error-fingerprint.ts` only. | Verification: pure fingerprinter test for "extract null outer when only frames present" still passes (no `Error:` header in that fixture), AND the integration test that expected `'Error'` now passes. | Commit hash: `b8d0ad3`.

**Total deviations:** 1 auto-fixed (Rule 1: bug). **Impact:** Strictly increases the recall of `outer_exception` extraction without changing any other semantic. Pure-fn determinism contract preserved.

## Verification

- `bun run build` clean.
- `bun run test src/tests/core/error-fingerprint.test.ts` → 21/21 PASS.
- `bun run test src/tests/adapters/episodic-events/tool-result-fingerprint.test.ts` → 6/6 PASS.
- `bun run test src/tests/adapters/episodic-events/` → 55/55 PASS (Phase 1 tests + 6 new + 49 original).
- Full `bun run test` → 3308 passing, 27 pre-existing baseline failures, no new regressions (test count rose 3316 → 3343 with the 27 new tests).
- Manual: `getDefaultConfig().features.error_fingerprint === true`.

## Issues Encountered

None directly tied to Plan 02-02.

## Next Phase Readiness

**Plan 02-02 complete.** The fingerprinter is callable from anywhere, ingest-time fingerprinting is transparent to `PostToolUse` callers, the V26 sidecar from Plan 02-01 stays untouched at write time, and the feature-flag scaffold awaits Plan 02-05's verdict-driven flip.

Wave 2 can now start: Plans 02-03 (backfill from accumulated tool_result rows + v4 artifact observations into the sidecar) and 02-04 (A/B/C measurement harness consuming the sidecar) can run in parallel.

Ready for Plan 02-03.
