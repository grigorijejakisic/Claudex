---
plan_id: 04-04
phase: 4
wave: 2
depends_on:
  - 04-01
  - 04-02
files_modified:
  - src/angel/heartbeat.ts
  - src/adapters/cc-hooks/stop.ts
  - src/tests/angel/heartbeat.test.ts
  - src/tests/adapters/cc-hooks/hooks.test.ts
autonomous: true
requirements:
  - CUR-01
  - CUR-03
  - STOR-06
---

# Plan 04-04: Drive Chunker and Curator from Session-Completed Signal

## Objective

Wire the chunker (Plan 04-02) and the MEMORY.md curator (Plan 04-01) into Angel's heartbeat so they run exactly once per completed session and once per affected project. Introduce a `memory_curation_pending` event that acts as the queue between "session completed" (user `/endsession` via stop hook OR Angel auto-close) and "Angel curates at the next tick." No injection-path changes; no changes to the existing memory-monitor prune pass (it still runs for non-managed projects).

## Must-haves (goal-backward)

- `src/adapters/cc-hooks/stop.ts` emits a `session_events` row `event_type='memory_curation_pending'` whenever the stop hook detects session completion — implementation detail: on every stop turn, not every session is ending, so the trigger is actually the session's LIFECYCLE end. In CC's model, `/endsession` does not emit a dedicated hook; the stop hook fires after every turn, and the session-end hook fires when the terminal actually closes. Planner decision: emit the `memory_curation_pending` event from **`session-end.ts`** as the primary site (matches "at /endsession" semantics once CC's SessionEnd fires), AND additionally from Angel's Phase 1b auto-close path (at `heartbeat.ts:~170` where sessions get marked completed). Two emit sites; one heartbeat consumer.
  - NOTE: users running `/endsession` skill do not directly close the terminal; the skill ends with a git commit. The actual session close happens later when the user exits CC. Phase 4's "at /endsession" language in ROADMAP is interpreted as "when session is marked completed" — the earliest unambiguous lifecycle boundary. This matches CUR-01/03 intent: sectioned MEMORY.md ready for the NEXT session's start.
- New heartbeat phase — call it "Phase 5b: Session-completion artifact curation" — runs AFTER Phase 2 (pattern extraction) and AFTER Phase 5 (memory_monitor) and BEFORE Phase 6b (embedding backfill). For each pending row:
  1. Run `chunkSessionTranscript(db, session_id, project)` — non-throwing, accumulates errors.
  2. Run `curateMemoryMd(db, project)` — non-throwing, returns CurationResult.
  3. Mark the pending row consumed by inserting `session_events` row `event_type='memory_curation_done'` with the originating session_id + result JSON; OR simpler: delete the `memory_curation_pending` row after processing (planner picks; recommended: mark done with a separate event for audit trail, since session_events is append-only in normal usage).
- Dedup: within a single tick, if multiple pending rows share the same `project`, curator runs ONCE per project (chunker runs per-session). Avoid re-curating the same project repeatedly on batch sessions.
- Failure isolation: chunker exception does NOT prevent curator; curator exception does NOT prevent the next pending row from being processed.
- `TickResult` gains three optional counters: `chunks_created?: number`, `memory_md_written?: number`, `memory_curation_errors?: number`.
- Integration test: two completed sessions in two projects → chunker fires twice, curator fires twice (once per project), each produces a valid MEMORY.md on disk.
- `bun run test` full suite passes.
- No changes to `src/assembly/*`, `src/adapters/cc-hooks/user-prompt-submit.ts`, or any injection path.

## Tasks

<task id="04-04-01">
  <subject>Emit memory_curation_pending from session-end hook</subject>
  <description>
Edit `src/adapters/cc-hooks/session-end.ts`. After the existing `runSessionEndCleanup` block (line 25-35) and before `clearSessionSignals` (line 39):

```ts
// Enqueue MEMORY.md curation — Angel picks this up on next tick.
try {
  recordEvent(ctx.db, input.session_id, ctx.project,
    'memory_curation_pending', 'angel', 'enqueue',
    JSON.stringify({ project: ctx.project, session_id: input.session_id }));
} catch { /* telemetry-style, non-fatal */ }
```

Import `recordEvent` from `'../../core/session-events.js'` (already used in session-start.ts, verify path). Keep the emit non-throwing — this hook must not fail a session close because of a telemetry write.

Do NOT call the curator or chunker synchronously here. Hooks deadlock on heavy work; Angel consumes the queue asynchronously.
  </description>
</task>

<task id="04-04-02">
  <subject>Emit memory_curation_pending from Angel auto-close path</subject>
  <description>
Edit `src/angel/heartbeat.ts` — Phase 1b auto-close section (lines ~148-201). Inside the `for (const session of escalated)` loop, after the `UPDATE sessions SET status='completed'` at ~171 and after the existing `INSERT INTO session_events ... 'angel_auto_close'` at ~174-178, insert:

```ts
// Queue MEMORY.md curation for this newly-closed session
cachedPrepare(ctx.db,
  `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
   VALUES (?, ?, 'memory_curation_pending', 'angel', 'enqueue', ?)`
).run(session.session_id, session.project,
  JSON.stringify({ project: session.project, session_id: session.session_id }));
```

Keep the enqueue inside the existing per-session try/catch so one session's failure does not cascade.
  </description>
</task>

<task id="04-04-03">
  <subject>Add Phase 5b consumer loop to heartbeat</subject>
  <description>
Edit `src/angel/heartbeat.ts`. Insert a new section after existing Phase 5 (memory_monitor, ~line 373-381) and before Phase 6 (artifact linking):

```ts
// Phase 5b: Session-completion artifact curation (P3).
// Consumes `memory_curation_pending` events: runs transcript chunker per
// session, then MEMORY.md curator per unique project. Idempotent — chunker
// short-circuits if chunks already exist; curator no-ops when inputs and
// sentinel match.
try {
  const pending = cachedPrepare(ctx.db,
    `SELECT se.id, se.session_id, se.project, se.timestamp_epoch
     FROM session_events se
     WHERE se.event_type = 'memory_curation_pending'
       AND NOT EXISTS (
         SELECT 1 FROM session_events done
         WHERE done.event_type = 'memory_curation_done'
           AND done.session_id = se.session_id
       )
     ORDER BY se.timestamp_epoch ASC
     LIMIT 20`
  ).all() as Array<{ id: number; session_id: string; project: string; timestamp_epoch: number }>;

  const curatedProjects = new Set<string>();

  for (const p of pending) {
    // Chunker: per-session
    try {
      const { chunkSessionTranscript } = await import('./transcript-chunker.js');
      const cr = await chunkSessionTranscript(ctx.db, p.session_id, p.project);
      result.chunks_created = (result.chunks_created ?? 0) + cr.inserted;
      if (cr.errors > 0) {
        result.memory_curation_errors = (result.memory_curation_errors ?? 0) + cr.errors;
      }
    } catch {
      result.memory_curation_errors = (result.memory_curation_errors ?? 0) + 1;
    }

    // Curator: per project (deduped within this tick)
    if (!curatedProjects.has(p.project)) {
      try {
        const { curateMemoryMd } = await import('./memory-md-writer.js');
        const mr = curateMemoryMd(ctx.db, p.project);
        if (mr.written) {
          result.memory_md_written = (result.memory_md_written ?? 0) + 1;
        } else if (mr.reason !== 'idempotent_noop' && mr.reason !== 'no_project_dir') {
          result.memory_curation_errors = (result.memory_curation_errors ?? 0) + 1;
        }
        curatedProjects.add(p.project);
      } catch {
        result.memory_curation_errors = (result.memory_curation_errors ?? 0) + 1;
      }
    }

    // Mark done so we don't re-process on the next tick
    try {
      cachedPrepare(ctx.db,
        `INSERT INTO session_events (session_id, project, event_type, entity, action, detail)
         VALUES (?, ?, 'memory_curation_done', 'angel', 'processed', ?)`
      ).run(p.session_id, p.project,
        JSON.stringify({ pending_event_id: p.id, tick_epoch: Math.floor(Date.now()/1000) }));
    } catch { /* non-fatal; worst case duplicate processing next tick, both runs are idempotent */ }
  }
} catch {
  // Non-critical — queue processing failure doesn't break the heartbeat
}
```

Add the three new optional fields to the `TickResult` interface near the other Phase counters. Use dynamic imports so unit tests can mock them via `vi.mock`.

Important ordering notes:
- Phase 5b must run BEFORE Phase 6b (embedding backfill) because the chunker inserts artifacts without embeddings; Phase 6b needs to see them in the same tick (or the next) to backfill embeds. Same tick is fine — backfill already iterates `artifact_embeddings`-less rows.
- Phase 5b must run AFTER Phase 2 (pattern extraction) so that any pattern-extracted artifacts already landed; otherwise Recent Threads could miss a just-chunked session. (This is belt-and-suspenders: pattern extractor does not write transcript_chunk rows; chunker does.)
- Phase 5b must run AFTER Phase 5 (existing memory_monitor prune pass) so Angel's curator never has its write stomped by the monitor's rewrite. Phase 5 only touches files WITHOUT Angel sentinel today (the pruner assumes CC-managed files); with Plan 04-01 shipped, Phase 5b will produce files WITH sentinel → Plan 04-04 does NOT need to modify Phase 5 logic. Document this invariant in a code comment.
  </description>
</task>

<task id="04-04-04">
  <subject>Guard memory_monitor from touching Angel-managed files</subject>
  <description>
Edit `src/angel/memory-monitor.ts`. Add a pre-check in `monitorMemoryFiles` — before the existing `parseMemoryMd` + prune logic runs for a given project — that reads the file's first line and aborts the prune pass for that one project if it matches the Angel sentinel regex:

```ts
// Angel-managed files are owned by memory-md-writer; never prune them here.
try {
  const firstLine = content.split('\n', 1)[0];
  if (/^<!-- CLAUDEX-MANAGED: .* hash=[0-9a-f]+ -->$/.test(firstLine)) {
    continue; // skip this project; Angel writer owns it
  }
} catch { /* fall through to existing prune path */ }
```

Place this check immediately after the `content = fs.readFileSync(memoryMdPath, 'utf-8')` block in the main loop (around line 257 in the existing file). Continue statement skips to next project in the outer `for (const slug of dirs)` loop.

Unit test extension in `src/tests/angel/` (add to existing memory-monitor test file if one exists, otherwise create `src/tests/angel/memory-monitor.test.ts`):
- Write a MEMORY.md WITHOUT sentinel + >5 unpinned entries + a valid ingest target → existing prune path runs, entries migrated.
- Write a MEMORY.md WITH sentinel + 10 unpinned entries → monitor skips the project; file unchanged; zero entries migrated.
  </description>
</task>

<task id="04-04-05">
  <subject>Integration test: stop→heartbeat→written file</subject>
  <description>
Create or extend `src/tests/angel/heartbeat.test.ts` with an end-to-end case:

Setup:
- Temp HOME pointing at tempdir.
- Fresh DB + `applyV17DDL` + base schema.
- Seed two sessions (`s-a` for project `p1`, `s-b` for project `p2`), each with 4 conversation_turns rows.
- Seed both projects' `~/.claude/projects/<slug>/memory/` directories (mkdir -p equivalent).
- Seed two entity_summary artifacts per project (in legacy `artifacts` table).
- Mock `callLocalLLM` to return `{segments:[{start:1,end:4,topic_label:'test'}]}` for any call.

Action:
- Emit two `memory_curation_pending` events (one per session) via direct DB insert.
- Invoke `heartbeatTick(ctx)` once.

Assertions:
- `result.chunks_created === 2` (one per session).
- `result.memory_md_written === 2` (once per project — curator dedup within tick).
- `~/.claude/projects/<p1-slug>/memory/MEMORY.md` exists, has valid sentinel, contains `## Entities`.
- Same for `p2-slug`.
- Two `session_events` rows with `event_type='memory_curation_done'` exist.
- Invoking `heartbeatTick(ctx)` a SECOND time with no new pending rows → `result.chunks_created === 0`, `result.memory_md_written === 0`.
- Invoke a THIRD time after touching one entity_summary row in p1 (updated_at changes) AND emitting a new pending event for p1 → `result.memory_md_written === 1`, p1's MEMORY.md bytes differ from previous; p2's bytes unchanged.

Failure isolation test:
- Mock `chunkSessionTranscript` to throw for session `s-a`; leave `s-b` passing.
- Emit pending events for both sessions.
- Tick once → `result.memory_curation_errors >= 1`, `s-b` still gets chunked, both projects still get curated (curator independent of chunker failure).
  </description>
</task>

<task id="04-04-06">
  <subject>Update session-end hook unit test for new enqueue</subject>
  <description>
Extend `src/tests/adapters/cc-hooks/hooks.test.ts` (or the existing session-end test file) with one case:

- Invoke session-end hook for a session.
- Assert `session_events` has exactly one row with `event_type='memory_curation_pending'`, `session_id=<the session>`, `action='enqueue'`, `detail` JSON containing both `project` and `session_id`.

This is a lightweight test — wiring only, no heartbeat.
  </description>
</task>

## Verification

- `bun run build` succeeds.
- `bun run test src/tests/angel/heartbeat.test.ts` — new integration cases pass.
- `bun run test src/tests/angel/memory-monitor.test.ts` — sentinel-skip case passes.
- `bun run test src/tests/adapters/cc-hooks/hooks.test.ts` — session-end enqueue case passes.
- `bun run test` — full 2020+ suite green.
- Manual smoke: end a real CC session on this project; wait one Angel tick; verify `~/.claude/projects/<claudexv3-slug>/memory/MEMORY.md` has a `<!-- CLAUDEX-MANAGED: ...` first line and `## Entities`, `## Active Projects`, `## Recent Threads`, `## Handoff`, `## How to Query` sections.
- Diff restricted to files listed in frontmatter plus `src/angel/memory-monitor.ts` (guard clause).
