---
plan_id: 04-01
phase: 4
wave: 1
depends_on: []
files_modified:
  - src/angel/memory-md-writer.ts
  - src/tests/angel/memory-md-writer.test.ts
autonomous: true
requirements:
  - CUR-01
  - CUR-02
  - CUR-04
---

# Plan 04-01: Angel MEMORY.md Writer — Sectioned, Sentinel-Guarded, Idempotent

## Objective

Produce `src/angel/memory-md-writer.ts` — a pure function that, given a Claudex DB handle and a project slug, renders a sectioned MEMORY.md for `~/.claude/projects/<slug>/memory/MEMORY.md` with the sentinel-hashed top portion and a preserved `## User Notes` tail. Writer is idempotent (byte-identical output on unchanged inputs), refuses to write when the sentinel is missing from a previously-curated file, and respects the 25KB / 200-line hard ceiling. No heartbeat wiring here — that lands in Plan 04-04.

## Must-haves (goal-backward)

- New module `src/angel/memory-md-writer.ts` exports `curateMemoryMd(db, project): {path, written, reason}`.
- Output file shape: top sentinel → preamble (universal user memories, ≤5 lines, no header) → `## Entities` (≤15) → `## Active Projects` (≤5) → `## Recent Threads` (≤5) → `## Handoff` (≤10 lines + `See:` pointer) → `## How to Query` (static) → `<!-- USER EDITABLE -->` marker → everything below preserved byte-for-byte.
- Entities read from legacy `artifacts WHERE artifact_type='entity_summary' AND project=?`, ordered `importance DESC, timestamp_epoch DESC, id ASC` (RESEARCH §2 reconciliation: importance lives on legacy `artifacts` table, not V17 unified).
- Active Projects read from V17 `artifact` table via a 7-day activity window; Recent Threads pre-filter to the most recent 10 sessions (by latest-chunk timestamp), then dedup by `topic_label`, then top-5 by latest chunk `created_at` — per CONTEXT §Recent Threads source.
- Preamble reads sibling files in `~/.claude/projects/<slug>/memory/*.md` with `type: user` frontmatter, rendered as one line each (name from frontmatter, or filename).
- Handoff distilled from `context/handoffs/ACTIVE.md` (Commander's Intent + What's Left To Do), capped 10 lines; missing file renders `No active handoff.`.
- Sentinel: `<!-- CLAUDEX-MANAGED: do not edit above user section. hash=<sha256-hex> -->` on line 1; sha256 covers normalized Angel-owned bytes below the sentinel and above the `<!-- USER EDITABLE -->` marker.
- Normalization contract: LF line endings, trailing whitespace stripped per line, runs of ≥2 blank lines collapsed to 1, exactly one `\n` before `<!-- USER EDITABLE -->`.
- Atomic write: write to `MEMORY.md.tmp`, `fs.renameSync` to final path. If final file existed, rename-overwrite. On Windows rename failure, retry once after 50ms before giving up.
- Refuse rule: if file has `<!-- USER EDITABLE -->` marker but no valid `<!-- CLAUDEX-MANAGED: ... hash=<hex> -->` sentinel, writer returns `{written:false, reason:'sentinel_missing'}` and inserts `session_events` row (`event_type='memory_curation_refused'`, `entity=<path>`, `detail='sentinel_missing'`). Fail loud at the boundary.
- Idempotency: two back-to-back calls against unchanged inputs produce byte-identical file. Cheaper path: if computed sha256 matches sentinel-on-disk and user tail hasn't changed, return `{written:false, reason:'idempotent_noop'}` without touching the file.
- Size cap: if Angel-owned content > 25KB or > 200 lines, trim in this order until it fits: Recent Threads tail → Active Projects tail → Entities tail → Handoff tail. Preamble + How to Query never trim.
- Unit tests assert: render shape; byte-identical re-run; user-block preserved under upstream change; sentinel-missing refusal emits the event; cold-start (zero transcript_chunk rows) renders valid file; oversize inputs trim to ≤25KB.
- `bun run build` succeeds; `bun run test src/tests/angel/memory-md-writer.test.ts` passes; full `bun run test` still passes.
- No edits to `src/assembly/*`, `src/adapters/cc-hooks/*`, or `src/angel/heartbeat.ts` in this plan.

## Tasks

<task id="04-01-01">
  <subject>Create module scaffold + types + top-level curateMemoryMd</subject>
  <description>
Create `src/angel/memory-md-writer.ts`. Exports:

```ts
export interface CurationResult {
  path: string;
  written: boolean;
  reason:
    | 'wrote'
    | 'idempotent_noop'
    | 'sentinel_missing'
    | 'sentinel_invalid'
    | 'write_io_error'
    | 'no_project_dir';
  bytes?: number;
  lines?: number;
  hash?: string;
}

export function curateMemoryMd(db: Database, project: string): CurationResult { ... }
```

Compute `memoryMdPath = path.join(os.homedir(), '.claude', 'projects', <slug>, 'memory', 'MEMORY.md')` where `<slug>` is the CC slug for the project (use the existing `pathToSlug` pattern in `src/angel/memory-monitor.ts:58` — lift it into a shared helper `src/shared/cc-slug.ts` and re-export from both modules to avoid duplication). If the enclosing `memory/` dir doesn't exist, return `{written:false, reason:'no_project_dir'}`.

Orchestrate: gather inputs → render body → compute sha256 → check existing file + sentinel → write (or no-op).

Top-level must be wrapped in a try/catch that returns `{written:false, reason:'write_io_error'}` on any unexpected throw. Non-throwing is the invariant for Angel-heartbeat callees.
  </description>
</task>

<task id="04-01-02">
  <subject>Preamble renderer — scan sibling user memory files</subject>
  <description>
In `memory-md-writer.ts` add `function renderPreamble(slug: string): string`.

1. Read directory `~/.claude/projects/<slug>/memory/` (skip if not present).
2. List `*.md` files that are NOT `MEMORY.md`.
3. For each, read first 1KB (files are small); parse YAML frontmatter between `---` fences. Filter to `type: user`.
4. Extract `description:` field from frontmatter; if absent, fall back to filename stem.
5. Sort files by filename ASC (deterministic).
6. Render one line per file: `- <description>` (max 5 lines total; truncate silently if more).
7. Join with `\n`. Append a trailing blank line to separate from `## Entities`.
8. If zero files matched → return empty string (no preamble, `## Entities` starts at top).

Reuse scanning style from `src/angel/user-profile-sync.ts::scanAllProjectsForUserMemories` but scoped to a single slug — copy the frontmatter-parse approach without adding a dependency on the full sync module (keep writer lean and synchronous; user-profile-sync is async + rate-limited).

Unit test: temp dir with `user_a.md` (type: user, description: "alpha"), `user_b.md` (type: user, description: "beta"), `feedback.md` (type: feedback) → output has exactly `- alpha\n- beta\n\n` with `feedback.md` excluded.
  </description>
</task>

<task id="04-01-03">
  <subject>Entities / Projects / Threads SQL + formatters</subject>
  <description>
Implement three private helpers in `memory-md-writer.ts`:

```ts
function renderEntities(db: Database, project: string): string
function renderActiveProjects(db: Database): string
function renderRecentThreads(db: Database, project: string): string
```

**renderEntities**:
```sql
SELECT artifact_ref, summary, importance, timestamp_epoch, id
FROM artifacts
WHERE artifact_type = 'entity_summary' AND project = ? AND state IN ('active','packed','fresh','materialized')
ORDER BY importance DESC, timestamp_epoch DESC, id ASC
LIMIT 15
```
Format each row as `- <artifact_ref> — <summary_first_80_chars>`. Section header `## Entities\n`. If zero rows → `## Entities\n\n` (empty section, header still rendered for shape stability).

**renderActiveProjects**:
```sql
SELECT project_id, COUNT(*) AS activity_cnt, MAX(updated_at_epoch) AS last_touched
FROM artifact
WHERE updated_at_epoch >= ? AND project_id IS NOT NULL AND project_id != ''
GROUP BY project_id
ORDER BY activity_cnt DESC, last_touched DESC, project_id ASC
LIMIT 5
```
where `?` = `Math.floor(Date.now()/1000) - 7*86400`. Format `- <project_id> — <activity_cnt> edits in last 7d`. Section header `## Active Projects\n`.

**renderRecentThreads** — per CONTEXT: "window = most recent 10 sessions; rank by most-recent-chunk created_at DESC within window; dedup by topic_label; take top 5." Two-CTE query:
```sql
WITH recent_sessions AS (
  SELECT DISTINCT session_id
  FROM artifact
  WHERE kind = 'transcript_chunk' AND project_id = ? AND session_id IS NOT NULL
  ORDER BY MAX(created_at_epoch) OVER (PARTITION BY session_id) DESC
  LIMIT 10
),
ranked_chunks AS (
  SELECT json_extract(a.data, '$.topic_label') AS topic_label,
         MAX(a.created_at_epoch) AS latest,
         -- ties broken deterministically by session_id
         MAX(a.session_id) AS session_id
  FROM artifact a
  WHERE a.kind = 'transcript_chunk'
    AND a.project_id = ?
    AND a.session_id IN (SELECT session_id FROM recent_sessions)
  GROUP BY json_extract(a.data, '$.topic_label')
)
SELECT topic_label, latest, session_id
FROM ranked_chunks
ORDER BY latest DESC, session_id ASC, topic_label ASC
LIMIT 5
```
SQLite supports `DISTINCT` + window functions; if the CTE's combination of `DISTINCT` and `ORDER BY MAX(...) OVER (...)` trips an older SQLite build, fall back to a two-step: run `SELECT session_id FROM artifact WHERE kind='transcript_chunk' AND project_id=? GROUP BY session_id ORDER BY MAX(created_at_epoch) DESC LIMIT 10` then a second query filtering on the returned IDs. Planner picks whichever the active SQLite version (3.44+ in this repo) supports cleanly.

Format `- <topic_label> — session <session_id_short>`. Cold start (no `transcript_chunk` rows yet) → `## Recent Threads\n\n`. Never fail on missing rows.

Use `cachedPrepare(db, sql)` for every statement so the writer is cheap under repeated calls (heartbeat runs every 30s).

Unit tests: seed 3 entities with varying importance/timestamp, assert output order; seed multi-project activity, assert top-5 ordering; seed chunks for 7 topics → top 5 selected; seed chunks across 12 sessions (11 old, 1 new) all with distinct topic labels → only the 10 newest sessions contribute to Recent Threads candidate pool, and within that pool the 5 with latest `created_at` win.
  </description>
</task>

<task id="04-01-04">
  <subject>Handoff section + static How-to-Query block</subject>
  <description>
Add `function renderHandoff(project: string): string`:

1. Resolve project path via `resolveProjectPath(project)` from `src/shared/scope-detector.js`.
2. `handoffPath = path.join(projectPath, 'context', 'handoffs', 'ACTIVE.md')`.
3. If file does not exist → return `## Handoff\n\nNo active handoff.\n`.
4. Read file; extract content between the first `## Commander's Intent` header and the next `## ` header; also extract `## What's Left To Do` block to the next `## ` header.
5. Concatenate distilled lines, cap at 10 lines total (drop trailing lines, don't truncate mid-line).
6. Append `\nSee: context/handoffs/ACTIVE.md\n`.
7. Render under `## Handoff\n` with single blank line separator.

Add `const HOW_TO_QUERY_STATIC = ...`: exactly these lines (subject to planner taste but keep literal and byte-stable):

```
## How to Query

- claudex_search("topic") — decisions, learnings, prior sessions
- claudex_events — latest session history
- claudex_recall(id|path) — fetch a specific artifact

See ~/.claude/CLAUDE.md for Claudex tool reference.
```

Both renderers must return strings that end with exactly one `\n`. This keeps concatenation boundaries stable for normalization.

Unit tests:
- ACTIVE.md absent → returns the `No active handoff.` variant.
- ACTIVE.md with 3-line Intent + 4-item todo list → renders ≤10 distilled lines + `See:` pointer.
- ACTIVE.md with 20-item todo list → truncates at 10 lines total (including Intent), never mid-line.
  </description>
</task>

<task id="04-01-05">
  <subject>Normalization + sha256 sentinel computation</subject>
  <description>
Add helpers in `memory-md-writer.ts`:

```ts
function normalize(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '\n'); // exactly one trailing newline
}

function sentinelLine(normalizedBody: string): string {
  const hash = createHash('sha256').update(normalizedBody, 'utf8').digest('hex');
  return `<!-- CLAUDEX-MANAGED: do not edit above user section. hash=${hash} -->`;
}

function parseSentinelHash(firstLine: string): string | null {
  const m = firstLine.match(/^<!-- CLAUDEX-MANAGED: .*? hash=([0-9a-f]{64}) -->$/);
  return m ? m[1] : null;
}
```

Import `createHash` from `node:crypto`. Body digested = bytes between sentinel-line-end (exclusive) and `<!-- USER EDITABLE -->` marker-line-start (exclusive), after `normalize()`.

Unit test: two runs with identical inputs → identical hash; single byte change in preamble → different hash; whitespace-only change in source before normalization → same hash (normalization absorbs it).
  </description>
</task>

<task id="04-01-06">
  <subject>Assemble + write pipeline with refuse + idempotency + size cap</subject>
  <description>
Complete `curateMemoryMd`:

```ts
export function curateMemoryMd(db: Database, project: string): CurationResult {
  try {
    const memoryMdPath = computeMemoryMdPath(project);
    if (!fs.existsSync(path.dirname(memoryMdPath))) {
      return { path: memoryMdPath, written: false, reason: 'no_project_dir' };
    }

    const preamble   = renderPreamble(toSlug(project));
    const entities   = renderEntities(db, project);
    const projects   = renderActiveProjects(db);
    const threads    = renderRecentThreads(db, project);
    const handoff    = renderHandoff(project);
    const howTo      = HOW_TO_QUERY_STATIC;

    let body = [preamble, entities, projects, threads, handoff, howTo]
      .filter(Boolean).join('\n');
    body = normalize(body);

    // Size cap
    body = enforceSizeCap(body, { maxBytes: 25_000, maxLines: 200 });

    const sentinel = sentinelLine(body);

    // Build full file content
    const existing = fs.existsSync(memoryMdPath)
      ? fs.readFileSync(memoryMdPath, 'utf8')
      : '';

    // Extract user tail (content at/below <!-- USER EDITABLE --> marker)
    let userTail = '';
    const markerIdx = existing.indexOf('<!-- USER EDITABLE -->');
    if (markerIdx >= 0) {
      userTail = existing.slice(markerIdx); // includes the marker itself
      // Refuse if existing file had marker but lacked valid sentinel
      const firstLine = existing.split('\n', 1)[0];
      if (!parseSentinelHash(firstLine)) {
        recordRefusal(db, project, memoryMdPath, 'sentinel_missing');
        return { path: memoryMdPath, written: false, reason: 'sentinel_missing' };
      }
    } else {
      userTail = '<!-- USER EDITABLE -->\n\n## User Notes\n\n';
    }

    const fullNew = `${sentinel}\n${body}\n${userTail}`;

    // Idempotency fast-path
    if (existing === fullNew) {
      return { path: memoryMdPath, written: false, reason: 'idempotent_noop',
               bytes: Buffer.byteLength(existing, 'utf8'), hash: parseSentinelHash(existing.split('\n',1)[0]) ?? undefined };
    }

    // Atomic write
    const tmp = memoryMdPath + '.tmp';
    fs.writeFileSync(tmp, fullNew, 'utf8');
    try {
      fs.renameSync(tmp, memoryMdPath);
    } catch {
      // Windows: lock retry once
      try { fs.renameSync(tmp, memoryMdPath); } catch {
        try { fs.unlinkSync(tmp); } catch {}
        return { path: memoryMdPath, written: false, reason: 'write_io_error' };
      }
    }

    return {
      path: memoryMdPath, written: true, reason: 'wrote',
      bytes: Buffer.byteLength(fullNew, 'utf8'),
      lines: fullNew.split('\n').length,
      hash: parseSentinelHash(sentinel),
    };
  } catch {
    return { path: '', written: false, reason: 'write_io_error' };
  }
}
```

`enforceSizeCap(body, { maxBytes, maxLines })`: while either budget exceeded, trim trailing `- ...` lines from Recent Threads first, then Active Projects, then Entities tail, then trailing lines of Handoff. Preamble and How-to-Query never trim. If still exceeds after all trimming — very unlikely — truncate Entities to 3 entries. (Planner pragma: never break file shape.)

`recordRefusal(db, project, path, reason)`: inserts `session_events` row via existing `recordEvent` helper from `src/core/session-events.js`. Use `session_id='angel-memory-writer'` (sessionless), `event_type='memory_curation_refused'`, `entity=path`, `action='refuse'`, `detail=reason`.

Unit tests required for this task:
1. Happy path: seed entities + projects + chunks → writer creates file with valid sentinel; second run with unchanged inputs → `idempotent_noop` with byte-identical file on disk.
2. User-tail preserved: pre-write file with sentinel + custom `## User Notes\n\nmy note\n`; call writer (inputs changed); assert new sentinel, new body, and `my note` preserved literally.
3. Refusal: write file with `<!-- USER EDITABLE -->` marker but stripped sentinel line; call writer; assert `reason='sentinel_missing'`, file NOT modified (mtime unchanged), `session_events` row present with `event_type='memory_curation_refused'`.
4. Cold start: no existing MEMORY.md → writer creates fresh one with marker at end and empty user tail.
5. Oversize: seed 30 entities + 20 projects + 20 threads → `enforceSizeCap` trims so file ≤25KB and ≤200 lines; header shape preserved (all 5 sections present).
6. Byte-identity against LF normalization: inject a handoff ACTIVE.md with CRLF line endings → written MEMORY.md still has only LF.
  </description>
</task>

<task id="04-01-07">
  <subject>Test fixtures + full unit suite</subject>
  <description>
Create `src/tests/angel/memory-md-writer.test.ts` with:
- `beforeEach` helper that sets HOME to a tempdir (`os.tmpdir() + uuid`) so `~/.claude/projects/...` resolves to the test tree. Use `vi.spyOn(os, 'homedir')` or set `process.env.HOME` / `USERPROFILE` depending on platform.
- Helper `seedEntities(db, project, count, importanceStart)`.
- Helper `seedChunks(db, project, topics[])`.
- Helper `seedActiveProjects(db, projects: {name, edits, touchedEpoch}[])`.

Cover all unit-test assertions from tasks 04-01-02 through 04-01-06 plus these additional cases:
- Entities tied on importance + timestamp fall back to `id ASC` — assert deterministic ordering across two runs.
- Two calls between which a user adds a line under `## User Notes` → second call still `idempotent_noop` for Angel-owned portion (hash unchanged because user tail NOT hashed); file bytes not rewritten because existing === fullNew would be false due to user change; writer rewrites BUT user tail is preserved. Assert: sha in sentinel unchanged; `## User Notes` content now contains the user's line.
  
  (Clarification to assert: idempotency per CUR-04 is about the Angel-owned portion producing byte-identical output given identical inputs — user-tail mutation is expected to cause a rewrite that still preserves the tail. The sentinel hash confirms the Angel portion didn't change.)
- Chunker integration surface: when `transcript_chunk` rows exist with mixed `topic_label` values, `renderRecentThreads` dedupes by label.
- Handoff file ends without trailing newline → renderer still produces correctly-separated section.

All tests must run in <1s each — writer is sync and small.
  </description>
</task>

## Verification

- `bun run build` succeeds.
- `bun run test src/tests/angel/memory-md-writer.test.ts` — all pass.
- `bun run test` — full 2020-test suite plus new tests pass.
- Diff touches ONLY `src/angel/memory-md-writer.ts`, `src/tests/angel/memory-md-writer.test.ts`, `src/shared/cc-slug.ts` (new helper), and trivial import-line updates in `src/angel/memory-monitor.ts` (to consume the shared helper). No assembler, no hook, no heartbeat edits.
- Manual smoke test: from a REPL, call `curateMemoryMd(db, 'claudexv3')`; inspect `~/.claude/projects/<slug>/memory/MEMORY.md`; file has all 5 sections; run again; file bytes identical; `session_events` table shows no `memory_curation_refused` rows.
