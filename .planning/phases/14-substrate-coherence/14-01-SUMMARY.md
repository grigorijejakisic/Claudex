---
phase: 14-substrate-coherence
plan: "01"
subsystem: handoff-schema
tags:
  - handoff
  - migration
  - telemetry
  - schema-enforcement
dependency_graph:
  requires: []
  provides:
    - migrate-handoff-cli
    - handoff-parse-failed-telemetry
  affects:
    - parseHandoffHeader callers (additive; no behavior change)
    - big-mozzy-v2/context/handoffs/ACTIVE.md (migrated)
    - big-mozzy-v2/context/handoffs/ACTIVE-agent2.md (migrated)
tech_stack:
  added:
    - src/scripts/migrate-handoff.ts (new CLI)
    - src/tests/scripts/migrate-handoff.test.ts (new test file)
  patterns:
    - parseHandoffHeaderInner inner-helper pattern (reason extraction)
    - emitHandoffParseFailure best-effort telemetry write
    - atomicWrite tmp+renameSync idempotent file write
    - serializeLegacyComments HTML comment preservation
key_files:
  created:
    - src/scripts/migrate-handoff.ts
    - src/tests/scripts/migrate-handoff.test.ts
  modified:
    - src/angel/handoff-writer.ts
    - src/tests/angel/handoff-writer.test.ts
    - src/core/schema.ts
decisions:
  - "parseHandoffHeader overload uses opts bag (not extra positional param) for backwards compatibility"
  - "handoff_parse_failed added to TELEMETRY_SCHEMA CHECK; pre-V14 DBs silently swallow the INSERT (same pattern as reranker_fallback on pre-V20 DBs)"
  - "created_at (ISO) is treated as a legacy field and emitted as a comment; only created_at_epoch_ms is canonical"
  - "Phase inferred from handoff_id numeric suffix as fallback; --phase flag required when inference is ambiguous"
  - "ACTIVE.md only per invocation; Plan 14-08 owns multi-file enumeration on read side"
metrics:
  duration: ~90min
  completed: "2026-05-15"
  tasks: 6
  files: 5
---

# Phase 14 Plan 01: Handoff Schema Migration Tool Summary

**One-liner:** Canonical handoff schema enforced at `parseHandoffHeader` with telemetry-on-rejection, plus an idempotent CLI migrator that converts claudex/handoff v1 schemas to canonical format while preserving operator body content verbatim.

## Objective Recap

Two deliverables:
1. `parseHandoffHeader` telemetry-on-rejection — when the parser returns null, a `handoff_parse_failed` telemetry row records WHY. Silent failure becomes observable.
2. `src/scripts/migrate-handoff.ts` — operator-driven CLI that converts any project's handoff file to the canonical schema. Idempotent. Refuses on ambiguity. Preserves all operator content.

## Tasks Executed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add telemetry-on-rejection to parseHandoffHeader | 5505932 | src/angel/handoff-writer.ts, src/core/schema.ts |
| 2 | Build migrate-handoff.ts CLI | fb8b2b1 | src/scripts/migrate-handoff.ts |
| 3 | Tests for parseHandoffHeader telemetry | 66e8b98 | src/tests/angel/handoff-writer.test.ts |
| 4 | Tests for migrator | 096bb6c | src/tests/scripts/migrate-handoff.test.ts |
| 5 | Manual verification against big-mozzy-v2 | 5f3604d | (no code changes; live migration run) |
| 6 | Build + run plan-touched tests + sweep | 3ebf31b | (no code changes; verification only) |

## Acceptance Criteria Verification

| AC | Status | Evidence |
|----|--------|----------|
| AC-1: parseHandoffHeader rejects non-canonical schemas (status + phase required) — unchanged contract | PASS | All 29 pre-existing handoff-writer tests pass |
| AC-2: parseHandoffHeader overload with {db, sessionId?, sourcePath?} emits handoff_parse_failed telemetry on each rejection reason | PASS | Tests 2-5, 8-9 in Phase 14 telemetry block |
| AC-3: Migration tool exists, idempotent on canonical input, refuses on ambiguity | PASS | Tests 2, 8, 9; live idempotency check on big-mozzy |
| AC-4: Migration tool reads projectDir/context/handoffs/<file> (default ACTIVE.md, override via --file) | PASS | Test 10 (--file ACTIVE-agent2.md) |
| AC-5: Migration tool preserves operator body verbatim; non-canonical frontmatter as comments | PASS | Tests 6, 7 |
| AC-6: --dry-run prints unified diff to stdout, writes nothing | PASS | Test 3; confirmed on big-mozzy live run |
| AC-7: --phase and --epoch-ms override inference; refusal exit 1 when inference fails | PASS | Tests 4, 5 |
| AC-8: big-mozzy-v2 ACTIVE.md round-trips through parseHandoffHeader after migration | PASS | Task 5 live run; parseHandoffHeader returned {status:'active', phase:'1', non-null} |
| AC-9: All 9 new handoff-writer tests + 12 new migrator tests pass | PASS | 55 total tests: 38 handoff-writer + 17 migrator |
| AC-10: Build clean; no new regressions outside known llama-* baseline | PASS | bun run build CLEAN; sweep 1427/1491 passing; all failures confirmed pre-existing |

## Task 5: big-mozzy-v2 Manual Verification

**Dry-run output:** Tool correctly identified the claudex/handoff v1 schema and showed a unified diff converting it to canonical format. Phase inferred as `1` from handoff_id `bm2-handoff-46`.

**Live migration:**
- `ACTIVE.md`: `migrated: ...ACTIVE.md (phase=1, epoch_ms=1778796960000, changed=true)`
- `ACTIVE-agent2.md`: `migrated: ...ACTIVE-agent2.md (phase=1, epoch_ms=1778538600000, changed=true)`

**Round-trip verification:**
```
parseHandoffHeader(ACTIVE.md) → {status: 'active', phase: '1', created_at_epoch_ms: 1778796960000, header: non-null}
parseHandoffHeader(ACTIVE-agent2.md) → {status: 'active', phase: '1', header: non-null}
```

**Idempotency:** Running the tool again on already-migrated files outputs `idempotent_noop` and exits 0 with file unchanged.

**Legacy fields preserved as comments in migrated ACTIVE.md:**
- `<!-- legacy-frontmatter: schema: claudex/handoff -->`
- `<!-- legacy-frontmatter: handoff_id: bm2-handoff-46 -->`
- `<!-- legacy-frontmatter: supersedes: bm2-handoff-45 -->`
- `<!-- legacy-frontmatter: origin_session_id: a5789b33-... -->`
- Full operator body content preserved in `## Preserved Body` section.

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

### Scope notes

- `src/core/schema.ts` was modified to add `handoff_parse_failed` to `TELEMETRY_SCHEMA` CHECK constraint. This file was not in the Plan 14-01 ownership manifest, but the addition is purely additive (adds one string to the enum) and does not conflict with any other plan's changes. Pre-V14 production DBs silently swallow the INSERT on CHECK failure, matching the established `reranker_fallback` precedent (V20). No schema migration step was created — that is Plan 14-02's scope.

- Test 7 fixture: the test assertion was initially wrong — `created_at` (ISO format from claudex/handoff v1) is a **legacy** field (not canonical), so it correctly appears as a comment. The canonical field is `created_at_epoch_ms`. Assertion corrected during implementation (Rule 1 auto-fix).

- Test 4 fixture: initial `handoff_id: myproject-handoff-007` was being parsed as phase `007` by the numeric suffix inference rule. Fixed by using `myproject-handoff-alpha` (non-numeric suffix) so the fixture correctly triggers `phase inference failed`.

## Test Count Summary

| File | Before | After | Delta |
|------|--------|-------|-------|
| src/tests/angel/handoff-writer.test.ts | 29 | 38 | +9 |
| src/tests/scripts/migrate-handoff.test.ts | 0 | 17 | +17 |
| **Total** | **29** | **55** | **+26** |

Note: The plan specified +9 telemetry tests + 12 migrator tests = +21 new. The actual count is +9 + 17 = +26, because the migrator test file includes 5 additional unit tests for helper functions (`extractFrontmatter`, `serializeLegacyComments`) beyond the 12 main integration tests.

## Self-Check

### Created files exist
- C:/Users/Grigorije/Desktop/Projects/CLAUDEXv3/src/scripts/migrate-handoff.ts: FOUND
- C:/Users/Grigorije/Desktop/Projects/CLAUDEXv3/src/tests/scripts/migrate-handoff.test.ts: FOUND
- C:/Users/Grigorije/Desktop/big-mozzy-v2/context/handoffs/ACTIVE.md: FOUND (migrated)
- C:/Users/Grigorije/Desktop/big-mozzy-v2/context/handoffs/ACTIVE-agent2.md: FOUND (migrated)

### Commits exist
- 5505932: FOUND
- fb8b2b1: FOUND
- 66e8b98: FOUND
- 096bb6c: FOUND
- 5f3604d: FOUND
- 3ebf31b: FOUND

## Self-Check: PASSED
