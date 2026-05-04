---
plan_id: 04-08
phase: 4
wave: 6
depends_on:
  - 04-07
files_modified:
  - src/angel/memory-md-writer.ts
  - src/tests/angel/memory-md-writer.test.ts
  - src/angel/heartbeat.ts
autonomous: true
requirements:
  - CUR-01
---

# Plan 04-08: Memory-MD Writer Project-ID Resolution Fix

## Goal

`computeMemoryMdPath` in `src/angel/memory-md-writer.ts` has been silently
computing the wrong path for every project for at least 17 days. The function
receives a Claudex **project ID** (e.g., `claudex-v3`, `soak-test-p4b-1df6c0f2`)
but applies a path-separator heuristic that only activates for filesystem paths.
Because project IDs contain no separators, the ID is used verbatim as the CC
slug, producing `~/.claude/projects/claudex-v3/memory/MEMORY.md` instead of
`~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/MEMORY.md`.

`heartbeat.ts:482` whitelists `no_project_dir` as a non-error, so the failure is
silent. `memory_curation_done` fires anyway. CLAUDEXv3's MEMORY.md is dated Apr 9
— 17 days stale — confirming the writer has not successfully written for any
project since before the V17 migration.

The fix chains `resolveProjectPath` (already imported) → `pathToCcSlug` to
recover the correct CC slug from any Claudex project ID. The fallback for
path-shaped inputs and unresolvable IDs is preserved.

A secondary defect: `no_project_dir` returns are silently whitelisted in the
heartbeat, making future silent skips invisible. This plan adds a dedicated
telemetry counter.

## Tasks

<task id="04-08-01">
  <subject>Write the plan doc</subject>
  <autonomous>true</autonomous>
  <description>
Write this plan document at
`.planning/phases/04-p3-memory-md-curation-auto-dream-guard/04-08-memory-md-writer-resolution-fix-PLAN.md`.
Commit: `docs(04-08): plan for memory-md-writer project ID resolution fix`.
  </description>
</task>

<task id="04-08-02">
  <subject>Apply the computeMemoryMdPath fix + add unit tests</subject>
  <autonomous>true</autonomous>
  <description>
Edit `src/angel/memory-md-writer.ts`:

1. Update the JSDoc above `computeMemoryMdPath` to describe the new resolution
   chain: project-ID → `resolveProjectPath` → `pathToCcSlug`. Mention the
   fallback for path-shaped inputs and unresolvable IDs.

2. Replace the function body with:

```ts
export function computeMemoryMdPath(project: string): string {
  // First try to resolve as a Claudex project ID → filesystem path → CC slug
  const projectPath = resolveProjectPath(project);
  if (projectPath) {
    return path.join(os.homedir(), '.claude', 'projects', pathToCcSlug(projectPath), 'memory', 'MEMORY.md');
  }
  // Fallback: input might already be a path (e.g., test fixtures, edge cases)
  const slug = /[\\/:]/.test(project) ? pathToCcSlug(project) : project;
  return path.join(os.homedir(), '.claude', 'projects', slug, 'memory', 'MEMORY.md');
}
```

Then add unit tests to `src/tests/angel/memory-md-writer.test.ts` covering:
- Project ID registered in projects.json → resolves to CC slug (not raw ID)
- Path-shaped input falls through to slug conversion
- Unresolvable ID returns the raw-ID path (old behavior)

Run `bun run test`. Commit: `fix(04-08-02): computeMemoryMdPath chains resolveProjectPath → pathToCcSlug`.
  </description>
</task>

<task id="04-08-03">
  <subject>Add memory_curation_no_project_dir telemetry counter in heartbeat</subject>
  <autonomous>true</autonomous>
  <description>
Edit `src/angel/heartbeat.ts`:

1. In `TickResult` interface, add `memory_curation_no_project_dir?: number`
   after `memory_curation_errors?: number`.

2. In Phase 5b curator block (~line 480), replace the current:

```ts
if (mr.written) {
  result.memory_md_written = (result.memory_md_written ?? 0) + 1;
} else if (mr.reason !== 'idempotent_noop' && mr.reason !== 'no_project_dir') {
  result.memory_curation_errors = (result.memory_curation_errors ?? 0) + 1;
}
```

with:

```ts
if (mr.written) {
  result.memory_md_written = (result.memory_md_written ?? 0) + 1;
} else if (mr.reason === 'no_project_dir') {
  result.memory_curation_no_project_dir = (result.memory_curation_no_project_dir ?? 0) + 1;
} else if (mr.reason !== 'idempotent_noop') {
  result.memory_curation_errors = (result.memory_curation_errors ?? 0) + 1;
}
```

Add a test for the counter to `src/tests/angel/heartbeat.test.ts`. Run `bun run test`.
Commit: `feat(04-08-03): memory_curation_no_project_dir telemetry counter`.
  </description>
</task>

<task id="04-08-04">
  <subject>Build + restart Angel + re-soak</subject>
  <autonomous>true</autonomous>
  <description>
1. `bun run build` — must compile cleanly.
2. Find the current Angel PID via `~/.claudex/angel.pid` and kill it.
3. Start Angel manually: `node dist/angel/index.cjs &`.
4. Confirm Angel is running by querying the latest angel event from the DB.
5. Enqueue a fresh `memory_curation_pending` row for the soak session
   (session `ff9cace2-025a-4282-80ad-245a2d1823df`, project `soak-test-p4b-1df6c0f2`).
6. Wait up to 60s for Angel to process, then verify
   `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-soak-test-p4b/memory/MEMORY.md`
   exists (or equivalent resolved slug).
7. Run `node .planning/phases/04-p3-memory-md-curation-auto-dream-guard/verify-soak.cjs
   --report --session=ff9cace2-025a-4282-80ad-245a2d1823df`.
   Expect `--- PASS (8/8 checks) ---`.
Commit: `test(04-08-04): live-fire re-soak after writer fix — verify-soak PASS 8/8`.
  </description>
</task>

<task id="04-08-05">
  <subject>Backfill check for stale MEMORY.md across active projects</subject>
  <autonomous>true</autonomous>
  <description>
Using the compiled `dist/shared/scope-detector.cjs` and `dist/shared/cc-slug.cjs`,
scan all projects with `session_events` activity in the last 7 days. For each,
resolve the CC slug and check the MEMORY.md mtime and size.

Document findings in the SUMMARY. If projects have no MEMORY.md or are
genuinely stale (no write in 7+ days with recent activity), enqueue a fresh
`memory_curation_pending` row to trigger Angel to re-curate them.
  </description>
</task>

<task id="04-08-06">
  <subject>Write SUMMARY</subject>
  <autonomous>true</autonomous>
  <description>
Write `.planning/phases/04-p3-memory-md-curation-auto-dream-guard/04-08-memory-md-writer-resolution-fix-SUMMARY.md`
covering bug description, root cause, fix, test additions, live-fire result,
backfill action, and a methodology learning section on static-vs-runtime gaps.

Commit: `docs(04-08): SUMMARY for memory-md-writer resolution fix`.
  </description>
</task>

## Success Criteria

- `computeMemoryMdPath('claudex-v3')` returns the correct CC-slug path (verified
  in test with mocked `projects.json`)
- `bun run test` passes with new test count (no regressions)
- `bun run build` compiles cleanly
- `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/MEMORY.md`
  is written or updated after Angel re-processes a pending event
- verify-soak passes 8/8 for the soak session
- `memory_curation_no_project_dir` counter visible in heartbeat telemetry
- All commits atomic per task

## Risks

1. **`resolveProjectPath` scan fails silently for unregistered projects**: The
   function scans `~/Desktop/Projects/` as a fallback, but derived-ID matching
   depends on exact hash parity. Tests must mock `projects.json` injection
   rather than relying on scan fallback.

2. **Existing tests break**: The test harness in `memory-md-writer.test.ts` uses
   `toSlug(PROJECT)` directly to set up the memory dir. With the fix, if
   `resolveProjectPath('test-proj')` were to return something, the path would
   change. We avoid this by NOT registering `test-proj` in the fixture
   `projects.json`, so the unresolvable fallback fires and behavior is unchanged.

3. **Angel not responding to re-enqueue**: If Angel PID has drifted, use Option B
   (direct call to `curateMemoryMd`) instead of waiting for the Angel tick.

4. **`no_project_dir` after fix if soak project slug differs**: The soak project
   `soak-test-p4b-1df6c0f2` may not be in `projects.json` if it was registered
   under a different key. Verify with a direct `resolveProjectPath` call before
   committing to the live-fire test.
