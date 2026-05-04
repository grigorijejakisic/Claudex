---
plan_id: 04-08
status: complete
completed: 2026-04-26
commits:
  - 79bdb83 docs(04-08): plan for memory-md-writer project ID resolution fix
  - cbd1d60 fix(04-08-02): computeMemoryMdPath chains resolveProjectPath → pathToCcSlug
  - 4a55729 feat(04-08-03): memory_curation_no_project_dir telemetry counter
  - e79ad5e test(04-08-04): live-fire re-soak after writer fix — verify-soak PASS 8/8
---

# 04-08 Summary: Memory-MD Writer Project-ID Resolution Fix

## Bug Description

`computeMemoryMdPath` in `src/angel/memory-md-writer.ts` had been silently
computing the wrong path for every project for at least 17 days (since before
the V17 migration on Apr 20).

The function receives Claudex **project IDs** like `claudex-v3` or
`soak-test-p4b-1df6c0f2`. These contain no path separators, so the heuristic
fell through to the `else` branch and used the project ID verbatim as the CC
slug:

```
~/.claude/projects/claudex-v3/memory/MEMORY.md       ← computed (WRONG)
~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/MEMORY.md  ← correct
```

## Root Cause

```ts
// BROKEN (old code):
export function computeMemoryMdPath(project: string): string {
  const slug = /[\\/:]/.test(project) ? pathToCcSlug(project) : project;
  return path.join(os.homedir(), '.claude', 'projects', slug, 'memory', 'MEMORY.md');
}
```

The heuristic `/[\\/:]/.test(project)` only activates when the input contains
path separators or drive colons. Claudex project IDs never contain those, so the
ID was used directly as a CC slug. The CC slug is derived from the **filesystem
path** using `pathToCcSlug`, not from the project ID.

Two secondary masking factors:
1. `heartbeat.ts:482` whitelisted `no_project_dir` as a non-error alongside
   `idempotent_noop`, so the failure produced no alert. `memory_curation_done`
   still fired after every `no_project_dir` return, making telemetry look healthy.
2. The test suite used `toSlug(PROJECT)` = `'test-proj'` (raw ID) to set up
   the fixture memory dir. Since `'test-proj'` is not registered in
   `projects.json`, `resolveProjectPath` returns null and the fallback applies —
   keeping the existing tests green while hiding the production bug.

**Evidence this was global:** CLAUDEXv3's `MEMORY.md` was dated Apr 9 — 17 days
stale. The writer hadn't successfully written for any project since before V17.

## Fix

`computeMemoryMdPath` now chains `resolveProjectPath` → `pathToCcSlug`:

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

`resolveProjectPath` (already imported, already used by `renderHandoff`) reads
`~/.claudex/projects.json` first, then scans `~/Desktop/Projects/` for derived
matches. The fallback preserves behavior for path-shaped inputs (older callers)
and unregistered projects.

Commit: `cbd1d60 fix(04-08-02): computeMemoryMdPath chains resolveProjectPath → pathToCcSlug`

## Secondary Fix: Telemetry Counter

`TickResult.memory_curation_no_project_dir` was added to `heartbeat.ts` so
future silent skips are visible in telemetry. Previously, `no_project_dir`
was whitelisted alongside `idempotent_noop` (both silently ignored). Now:

```ts
if (mr.written) {
  result.memory_md_written = (result.memory_md_written ?? 0) + 1;
} else if (mr.reason === 'no_project_dir') {
  result.memory_curation_no_project_dir = (result.memory_curation_no_project_dir ?? 0) + 1;
} else if (mr.reason !== 'idempotent_noop') {
  result.memory_curation_errors = (result.memory_curation_errors ?? 0) + 1;
}
```

Commit: `4a55729 feat(04-08-03): memory_curation_no_project_dir telemetry counter`

## Test Additions

**`src/tests/angel/memory-md-writer.test.ts`** (3 new tests, +100 lines):
- `registered project ID resolves to CC slug, not raw project ID` — registers
  `claudex-v3` in a temp `projects.json`, asserts the result doesn't use the
  project ID as slug directly.
- `path-shaped input falls through to slug conversion` — no `projects.json`,
  path input with separators still converts via `pathToCcSlug`.
- `unresolvable project ID falls back to raw-ID slug (old behavior preserved)` —
  unknown ID with no registry entry uses ID verbatim (backward compat).

Also updated the existing `CRLF normalization` test to create the memory dir
at the resolved CC slug path instead of the raw project-ID path (now that
`computeMemoryMdPath` resolves registered projects).

**`src/tests/angel/heartbeat.test.ts`** (1 new test, +32 lines):
- `04-08-03: no_project_dir increments memory_curation_no_project_dir, not errors` —
  verifies the counter is incremented correctly and `memory_curation_errors`
  stays zero.

**Test counts:** 2573 passing (baseline) → 2577 passing. 20 pre-existing
failures unchanged (llama-server-supervisor + llama-client).

## Live-Fire Result

```
verify-soak.cjs --report --session=ff9cace2-025a-4282-80ad-245a2d1823df

✓ step 1 — MEMORY.md exists at ...C--Users-Grigorije-Desktop-Projects-soak-test-p4b\memory\MEMORY.md
✓ step 2 — first line matches sentinel (hash=e4ba5ee7c124…)
✓ step 3 — 5 required sections in order
✓ step 4 — <!-- USER EDITABLE --> marker present
✓ step 5 — wc -c ≤ 25000 AND wc -l ≤ 200 (773 bytes / 30 lines)
✓ step 6 — no memory_md_invalid events
✓ step 7 — entity_summary rows in corpus (informational, count=0)
✓ step 8 — second-tick idempotency (skipped — not requested)

--- PASS (8/8 checks) ---
```

File: `benchmarks/results/p3-postmigration/soak-report.md`

## Backfill Actions

Backfill check (`backfill_check.cjs`) scanned 16 projects with activity in
the last 7 days. Findings:

| Project | Status | Action |
|---------|--------|--------|
| `claudex-v3` | OK but 16.2d stale | Enqueued fresh curation |
| `big-mozzy-v2` | Memory dir exists, no MEMORY.md | Created dir + enqueued |
| `searxng-master-349af8d7` | CC dir exists, no memory subdir | Created dir + enqueued |
| `soak-test-p4b-1df6c0f2` | OK (0.0d old) | Already fixed by task 04-08-04 |
| `context-097edcef` | No CC dir at all | Skipped (CC never opened project) |
| `claude-code-main-67063aae` | No CC dir at all | Skipped (CC never opened project) |
| `desktop-01dcc792` | UNRESOLVABLE (not in projects.json) | Skipped |
| `big-mozzy-v2-copy2-09ad89a9` | UNRESOLVABLE | Skipped |

Three projects with CC dirs and recent activity were enqueued for backfill.
Projects without CC project dirs are skipped — the writer would return
`no_project_dir` anyway, as CC has never opened those projects.

## Static-vs-Runtime Methodology Learning

This is the **third consecutive inline-bugfix** that exposed a production bug
the 2577-test suite missed:

- **04-06**: Angel crash-loop resilience — tests mocked away the error paths
- **04-07**: V17 migration idempotency — tests only exercised first-open, not
  reopen of a migrated DB
- **04-08**: Writer project-ID resolution — tests used `toSlug(PROJECT)` to
  construct fixture paths, which accidentally matched the broken fallback behavior

**Pattern:** Test fixtures that set up the environment to match what the code
*would* compute (rather than what the code *should* compute) allow bugs to
hide. In 04-08, `ensureMemoryDir('test-proj')` created the dir at the path the
buggy code looked for — making the test pass while the production path didn't
exist.

**The fix:** For tests that depend on path resolution, verify the test fixture
matches what production would actually find, not what the current implementation
happens to look for. In 04-08, this meant updating `CRLF normalization` to use
`pathToCcSlug(projDir)` for the fixture path. Adding new tests that explicitly
assert the **wrong** path is NOT used (negative assertions) catches this class
of bug earlier.

**Recommended follow-up:** Add a CI smoke test that calls
`computeMemoryMdPath(REAL_PROJECT_ID)` against the actual `projects.json` and
verifies the computed path matches an existing CC project dir. This would have
caught 04-08 immediately.

## Build Evidence

`bun run build`: 82ms, 45 output files, all 24 smoke test hooks pass.
`bun run test`: 2577/2597 passing, 20 pre-existing failures.
