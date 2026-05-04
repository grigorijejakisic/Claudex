---
phase: 14
plan: 01
subsystem: configurable-paths
tags: [INST-05, projects-dir, helper, audit]
requires: []
provides: [getProjectsDir, callsite-audit]
affects: [src/shared/projects-dir.ts, src/tests/shared/projects-dir.test.ts, .planning/phases/14-bootstrap-install-configurable-paths/14-01-CALLSITE-AUDIT.md]
tech-stack:
  added: []
  patterns: [single-source-of-truth, env-var-override, idempotent-mkdir, never-throw]
key-files:
  created:
    - src/shared/projects-dir.ts
    - src/tests/shared/projects-dir.test.ts
    - .planning/phases/14-bootstrap-install-configurable-paths/14-01-CALLSITE-AUDIT.md
  modified: []
key-decisions:
  - "Mkdir failure is best-effort + non-throwing — getProjectsDir runs in hot paths (scope-detector, content-router) where throwing would mask intent"
  - "Empty-string env var treated as unset (defensive — avoids accidentally rooting at cwd)"
  - "llama-server-supervisor.ts callsites kept-with-reason — they govern LLAMA_SERVER_EXE / LLAMA_MODEL_PATH defaults (separate concern), not the projects scan"
requirements-completed:
  - INST-05
duration: 12 min
completed: 2026-05-01
---

# Phase 14 Plan 01: getProjectsDir helper + callsite audit Summary

Centralized projects-directory resolution behind a single helper (`src/shared/projects-dir.ts`) honoring `CLAUDEX_PROJECTS_DIR` with cross-platform `~/Projects` default; produced classified audit of every src/ callsite for 14-02 to consume.

**Started:** 2026-05-01T23:42:18Z
**Completed:** 2026-05-01T23:55:00Z (approximate)
**Duration:** 12 min
**Tasks:** 3
**Files created:** 3
**Files modified:** 0

## Tasks completed

| Task | Commit | Files |
|------|--------|-------|
| 14-01-01 — getProjectsDir() helper | 6d729d1 | src/shared/projects-dir.ts |
| 14-01-02 — projects-dir helper tests | d48cbd2 | src/tests/shared/projects-dir.test.ts |
| 14-01-03 — projects-dir callsite audit | 6646593 | .planning/phases/14-.../14-01-CALLSITE-AUDIT.md |

## Verifications passed

- `bun run build` green (~70ms)
- `bun run test` 3128 passing (3123 baseline + 5 new); 20 baseline llama failures unchanged from v4.0.0
- `getProjectsDir()` 5/5 unit tests pass: env-set absolute, env-set relative, env-unset (default ~/Projects), empty-string-as-unset, mkdir-failure-no-throw

## Audit summary

17 hits across 4 grep passes:
- 2 code-fix (scope-detector.ts, content-router.ts)
- 3 string-text-fix (recall-server.ts, sections.ts, session-events.ts)
- 5 comment-update (scope-detector x2, content-router, memory-md-writer, curated-context-extractor)
- 3 test-fixture (memory-md-writer.test.ts x2, memory-md-verify.test.ts)
- 4 keep-with-reason (llama-server-supervisor.ts — separate llama-cpp concern)

## Deviations from Plan

None — plan executed exactly as written. Mkdir-failure test case used a platform-specific bogus path strategy (Z:\... on Windows, /proc/... on POSIX) instead of `vi.spyOn(fs, 'mkdirSync')` because namespace-imported fs properties are read-only and cannot be redefined via spyOn. This was a tactical adjustment, not a design deviation.

## Next

Ready for 14-02 (apply audit replacements across the 13 actionable callsites).
