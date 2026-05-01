---
phase: 14
plan: 02
subsystem: configurable-paths
tags: [INST-05, INST-06, projects-dir, callsite-refactor, mcp-instructions]
requires: [14-01]
provides: [projects-dir-callsite-refactor]
affects:
  - src/shared/scope-detector.ts
  - src/shared/content-router.ts
  - src/mcp/recall-server.ts
  - src/assembly/sections.ts
  - src/core/session-events.ts
  - src/angel/memory-md-writer.ts
  - src/angel/curated-context-extractor.ts
  - src/tests/angel/memory-md-writer.test.ts
  - src/tests/core/memory-md-verify.test.ts
tech-stack:
  added: []
  patterns: [single-source-of-truth, runtime-resolution, generic-phrasing, regex-alternation]
key-files:
  created: []
  modified:
    - src/shared/scope-detector.ts
    - src/shared/content-router.ts
    - src/mcp/recall-server.ts
    - src/assembly/sections.ts
    - src/core/session-events.ts
    - src/angel/memory-md-writer.ts
    - src/angel/curated-context-extractor.ts
    - src/tests/angel/memory-md-writer.test.ts
    - src/tests/core/memory-md-verify.test.ts
key-decisions:
  - "MCP instructions use option A (buildClaudexInstructions function called at construction); recall-server is a fresh process per CC connect, so resolving once at construction is sufficient — no runtime re-resolution complexity"
  - "Assembly sections use option B (generic phrasing) — section text is a system-reminder hint, not load-bearing path the agent operates on; generic wording is cleaner than embedded interpolation"
  - "session-events regex extended via alternation to match BOTH legacy and new layouts, preserving simplification of paths logged from existing v4 installs"
  - "Test fixtures retargeted to ~/Projects/ form — the paths were already arbitrary fixture strings; getProjectsDir is never invoked in those test paths because resolveProjectPath finds them via registry"
requirements-completed:
  - INST-05
  - INST-06
duration: 14 min
completed: 2026-05-01
---

# Phase 14 Plan 02: Apply projects-dir refactor across callsites Summary

Applied every fix from 14-01-CALLSITE-AUDIT.md across 9 files (7 src/ + 2 tests). MCP server instructions text now interpolates `getProjectsDir()` at registration so the agent sees the user's configured CLAUDEX_PROJECTS_DIR (INST-06).

**Tasks:** 5
**Files modified:** 9
**Files created:** 1 (this SUMMARY)
**Commits:** 5 (one per task + close)

## Tasks completed

| Task | Commit | What |
|------|--------|------|
| 14-02-01 | 355a320 | scope-detector.ts:133 + content-router.ts:100 → getProjectsDir() |
| 14-02-02 | 138775c | recall-server.ts → buildClaudexInstructions() with runtime getProjectsDir() (INST-06) |
| 14-02-03 | 4248429 | sections.ts (generic phrasing) + session-events.ts (regex alternation legacy/new) + memory-md-writer.ts JSDoc + curated-context-extractor.ts example |
| 14-02-04 | 05b8c66 | Test fixtures retargeted (memory-md-writer.test.ts + memory-md-verify.test.ts) |
| 14-02-05 | (this commit) | SUMMARY + close |

## Replacements applied

- **2 code-fix** (scope-detector.ts:133, content-router.ts:100) — `path.join(os.homedir(), 'Desktop', 'Projects')` → `getProjectsDir()`
- **3 string-text-fix** (recall-server.ts MCP instructions, sections.ts system-reminder, session-events.ts regex)
- **5 comment-update** (scope-detector x2, content-router, memory-md-writer, curated-context-extractor)
- **3 test-fixture** (2 in memory-md-writer.test.ts + 1 in memory-md-verify.test.ts)
- **4 keep-with-reason** (llama-server-supervisor.ts:26,46,48,139 — separate llama-cpp concern)

## Final grep audit

```
grep -rn "Desktop/Projects" src/ --include="*.ts"
```

Output (all kept-with-reason or doc-as-history):

```
src/angel/llama-server-supervisor.ts:26: * ~/Desktop/Projects/holo3/run-gemma.sh — they can be overridden via
src/angel/llama-server-supervisor.ts:46:  /** Default: $LLAMA_SERVER_EXE or ~/Desktop/Projects/llama-cpp/llama-server.exe. */
src/angel/llama-server-supervisor.ts:48:  /** Default: $LLAMA_MODEL_PATH or ~/Desktop/Projects/llama-cpp/models/...gguf. */
src/angel/llama-server-supervisor.ts:139:    path.join(os.homedir(), 'Desktop', 'Projects', 'llama-cpp', 'llama-server.exe')
src/core/session-events.ts:333:    // Handles legacy (~/Desktop/Projects/<name>/) and new
src/mcp/recall-server.ts:118: * value rather than a hardcoded `~/Desktop/Projects/`. Called once when the
```

- llama-server-supervisor (4 hits): kept-with-reason — separate concern (LLAMA_SERVER_EXE / LLAMA_MODEL_PATH env vars)
- session-events (1 hit): comment documents the regex's dual-layout support
- recall-server (1 hit): JSDoc explains what was avoided

## Verifications passed

- `bun run build` green
- `bun run test`: 3128 passing (3123 baseline + 5 new from 14-01); 20 baseline llama failures unchanged
- `bun run vesna`: **17/17 PASS** (entity-recall 3/3, constraint-recall 3/3, handoff-pickup 3/3, cross-project 3/3, lesson-application 3/3, self-instrumented 2/2 — AGGREGATE: 100% GATED PASS)
- DB schema unchanged
- Hook semantics unchanged
- ~/.claudex/projects.json registry data NOT migrated (per CONTEXT.md decision)

## Deviations from Plan

None — plan executed exactly as written. INST-06 implemented via option A (function-wrapped instructions) rather than option B (lazy const evaluation) because the function form keeps the test seam clean and avoids static-initialization races.

## Next

Ready for 14-03 (bootstrap steps wired into bun run setup).
