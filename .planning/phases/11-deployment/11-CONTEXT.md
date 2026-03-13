# Phase 11: Deployment — Context

## Purpose

Verify the build output, create deployment checklists and scripts, define a monitoring protocol, and document the archive plan for predecessor systems. This is documentation and verification only — no new production code, no live deployment. Actual deployment to the user's machine happens manually after the pipeline completes.

## Dependencies (all complete)

- Phase 0: Repository Setup (shared types, paths, config, constants)
- Phase 1: Storage Layer (SQLite, CRUD modules, telemetry)
- Phase 2: Extraction Pipeline (per-tool extractors, redaction, quality gates)
- Phase 3: Intelligence Core (decision capture, thread tracker, dedup, learnings)
- Phase 4: Intelligence v1.2 (embeddings, topic-shift, enrichment)
- Phase 5: Assembly Pipeline (priority-budgeted assembly, sections, boundary-only)
- Phase 6: Checkpoint System (ULID writer, 3-hop loader, inject renderer)
- Phase 7: Supporting Subsystems (token gauge, decay engine, GSD reader)
- Phase 8: CC Hook Adapter (6 hooks, infrastructure, setup CLI)
- Phase 9: OpenClaw Bridge Adapter (bridge types, callbacks, plugin entry)
- Phase 10: Integration Testing (E2E flows, cross-cutting tests, performance SLAs)

## Requirements

No unmapped requirements — deployment validates all prior phases. Phase 11 is the operational capstone.

## Architecture References

- Section 4.3: Fresh install + v2 migration (lines 710-789)
- Section 14: Phase 11 — 6 deployment tasks (lines 2165-2171)
- Section 17: Success criteria (lines 2187-2207)

## Success Criteria (from ROADMAP.md)

1. Fresh `claudex setup` on a clean Windows machine produces a fully operational CC hook system
2. Fresh OpenClaw plugin install produces a fully operational bridge adapter
3. Optional v2 migration completes successfully for existing Claudex users (data preserved, backup created)
4. Both adapters verified independently for one week of real usage

## Scope Decisions (from discussion)

### 1. No live deployment during pipeline execution

`claudex setup` patches `~/.claude/settings.json` — that's a real-world operation. The plan verifies the build output and creates deployment instructions. Actual deployment happens manually after the pipeline completes.

### 2. OpenClaw: documentation-only

OpenClaw is a separate project. The bridge adapter is fully tested (E2E in Phase 10). Phase 11 documents the install steps but does not perform live OpenClaw plugin installation.

### 3. V2 migration: tested in integration

Migration logic (`migrateFromV2` in `src/core/migrations.ts`) is already covered by integration tests. A Claudex v2 project exists at `C:\Users\Grigorije\Desktop\Projects\Claudex v2` but real migration happens during actual deployment if the user opts in. No live migration in this phase.

### 4. Archive: document only

Note that Claudex v2 and openclaw-context are superseded by v3. Actual GitHub repo archiving happens after the 1-week monitoring period, not in this plan.

### 5. Monitoring: define checklist, mark "deployed, monitoring"

The plan creates a monitoring checklist (telemetry queries, checkpoint verification, error event counts). Phase 11 completes with "deployed, monitoring in progress." The 1-week real-time gate is outside the GSD pipeline.

## Current State

**Test suite**: 45 test files, 717 tests, all passing (11.39s)

**Build system**: `build.ts` uses esbuild to bundle 8 entry points to `dist/` as CJS for Node 20:
- 6 CC hook entry points (`dist/session-start.js`, etc.)
- `dist/setup.js` (setup CLI)
- `dist/plugin-entry.js` (OpenClaw plugin)
- `better-sqlite3` marked external (native binding)

**Setup CLI** (`src/cli/setup.ts`): Creates `~/.claudex/` directories, initializes DB schema, writes default config, patches `~/.claude/settings.json` with hook paths, detects v2 databases and offers migration with backup.

**Known considerations**:
- `setup.ts` uses `__dirname` to resolve hook paths relative to `dist/` — verify esbuild CJS output preserves correct `__dirname`
- `better-sqlite3` is external — runtime requires `node_modules/better-sqlite3` accessible from the execution directory
- OpenClaw packaging: Architecture open question #8 notes `dist/openclaw-plugin.cjs` as a separate build target. Current build produces `dist/plugin-entry.js` — may need renaming or build adjustment for OpenClaw's expected path.

## Plan Structure

### 11-01: Build Verification, Deployment Checklist, Monitoring Protocol

**Scope**: Single plan producing deployment documentation and verification artifacts. No new production code.

- Task 1: Build verification — run `bun run build`, inspect `dist/` output, verify all 8 entry points present and functional
- Task 2: Create deployment documentation — CC hook install steps, OpenClaw plugin install steps, v2 migration instructions, monitoring checklist with concrete telemetry queries, archive plan for predecessors

## Estimated Scope

- 0 new production source files
- 1 deployment documentation file
- Build output verification
- Single plan, 1-2 tasks

## Risks

- **Build output correctness**: `__dirname` behavior in esbuild CJS output. Mitigation: verify during build inspection.
- **Native binding resolution**: `better-sqlite3` external. Mitigation: document in deployment checklist that `node_modules` must be available at runtime.
- **Settings.json format drift**: CC may have evolved its hook format. Mitigation: document current expected format in checklist; setup CLI already handles both create-new and update-existing paths.
