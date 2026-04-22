---
phase: 04-p3-memory-md-curation-auto-dream-guard
plan: 01
subsystem: angel
tags: [memory-md, sentinel, idempotent, sectioned, user-notes, curation]

requires:
  - phase: 02-p1-artifact-table-unification
    provides: V17 `artifact` kernel (`renderActiveProjects`, `renderRecentThreads` read here)
  - legacy schema
    provides: `artifacts` table with `importance` + `artifact_type='entity_summary'` (`renderEntities` reads here)
provides:
  - `curateMemoryMd(db, project)` — pure, non-throwing MEMORY.md writer with `CurationResult` struct
  - `renderPreamble` / `renderEntities` / `renderActiveProjects` / `renderRecentThreads` / `renderHandoff` — composable section renderers
  - `normalize` / `sentinelLine` / `parseSentinelHash` — hashing helpers that make byte-identical output possible
  - `HOW_TO_QUERY_STATIC`, `USER_TAIL_DEFAULT`, `MAX_BYTES`, `MAX_LINES` — layout constants
  - `src/shared/cc-slug.ts` with `pathToCcSlug` — lifted out of `memory-monitor.ts`; shared by writer + monitor
affects: [04-04 heartbeat wiring, 04-03 dream-guard verifier]

tech-stack:
  added: []
  patterns:
    - Sentinel-line + sha256 content digest over normalized body
    - User-editable tail preserved byte-for-byte via marker-anchored slice
    - Atomic write via `tmp` file + `renameSync`, one Windows-lock retry
    - Size cap with deterministic trim order (threads → projects → entities → handoff)

key-files:
  created:
    - src/angel/memory-md-writer.ts
    - src/shared/cc-slug.ts
    - src/tests/angel/memory-md-writer.test.ts
  modified:
    - src/angel/memory-monitor.ts (consume shared cc-slug)
    - src/core/session-events.ts (EventType += 'memory_curation_refused')

key-decisions:
  - "Entities source = legacy `artifacts` table (NOT V17 `artifact`) — resolves RESEARCH §2 friction: entity_summary rows have not migrated and `importance` lives only on the legacy table."
  - "Schema CHECK on `artifacts.state` excludes `'active'` — filter uses the actual valid set `('fresh','packed','materialized')` to avoid a CHECK violation at write time and at read time."
  - "Idempotency is about identical Angel-portion output for identical inputs. User-tail mutations that happen to already match the next render are reported as `idempotent_noop` because the bytes on disk already match — the writer respects the tail byte-for-byte."
  - "Refuse path: a file with the user-editable marker but no valid top sentinel → `{written:false, reason:'sentinel_missing'}` + `session_events` row with `event_type='memory_curation_refused'`. Fail loud at the boundary (CONTEXT decision)."
  - "Recent Threads query resolved as two steps (10 most-recent sessions, then dedup by topic_label) rather than a single CTE with window functions — avoids SQLite-version edge cases."

patterns-established:
  - "Non-throwing writer: all I/O paths wrapped; heartbeat can call `curateMemoryMd(db, project)` every 30s without defensive try/catch around the call."
  - "Normalize before hashing: `normalize()` guarantees CRLF/trailing-ws/blank-run equivalence classes collapse to the same hash; makes idempotency robust across editors and platforms."
  - "Deterministic render order across renderers: every `SELECT` has tiebreakers all the way down (importance/timestamp/id, activity_cnt/last_touched/project_id, latest/session_id/topic_label) so two runs on the same DB produce byte-identical output."

requirements-completed:
  - CUR-01
  - CUR-02
  - CUR-04

duration: ~1 session
completed: 2026-04-22
---

# Plan 04-01: Angel MEMORY.md Writer — Summary

**`src/angel/memory-md-writer.ts` — sectioned, sentinel-guarded, idempotent writer for `~/.claude/projects/<slug>/memory/MEMORY.md`. Preamble (user memories) + 5 section headers (Entities, Active Projects, Recent Threads, Handoff, How to Query) + user-editable tail preserved byte-for-byte. Refuses to overwrite when the top sentinel is missing. Non-throwing; safe for every-30s heartbeat invocation.**

## Performance

- **Completed:** 2026-04-22
- **Tasks:** 7 atomic commits (scaffold → preamble → section SQL → handoff/how-to → normalize/sentinel → assemble pipeline → tests)
- **Files created:** 3 (writer, shared cc-slug helper, test suite)
- **Files modified:** 2 (memory-monitor consumes shared helper; session-events adds new EventType)
- **New tests:** 31 (all pass in ~260ms)
- **Repo-wide test posture:** 2540 of 2560 tests pass. The 20 pre-existing failures are in `llama-client.test.ts` + `llama-server-supervisor.test.ts`, unrelated to this plan — confirmed by stashing these changes and re-running the same failing files on master.

## Accomplishments

- Five Angel-owned sections render in fixed order with deterministic SQL tiebreakers. All empty-state paths still emit headers to keep the file shape stable across invocations.
- Top sentinel `<!-- CLAUDEX-MANAGED: do not edit above user section. hash=<sha256> -->` covers post-normalize body bytes. Parser is strict (64-hex only) so non-hex hashes never slip through.
- User-editable tail (`<!-- USER EDITABLE -->` marker and everything below) is preserved byte-for-byte. Cold-start path writes the canonical template `## User Notes\n\n`.
- Refuse rule engaged: a file with the marker but no valid sentinel → `{written:false, reason:'sentinel_missing'}` plus a `memory_curation_refused` row in `session_events`. The corrupted file is not modified (mtime verified in tests).
- Idempotency fast-path: rendered body identical to what's on disk → `idempotent_noop` with no file write.
- Size cap: if body exceeds 25KB or 200 lines, trim tails in priority order Recent Threads → Active Projects → Entities → Handoff (preamble and How-to-Query never trim). Last-resort path truncates Entities to 3 entries.
- Atomic write: `writeFileSync(tmp)` + `renameSync(tmp, final)`, with one brief retry on Windows rename races (AV / editor watch locks).
- Shared helper `src/shared/cc-slug.ts::pathToCcSlug` lifted out of `memory-monitor.ts`; the monitor now consumes it, matching PLAN §Verification. Plan 04-03 can import the same helper.

## Task Commits

1. `47cb87a` — feat(04-01-01): MEMORY.md writer scaffold + shared cc-slug helper
2. `4b7d914` — feat(04-01-02): preamble renderer — scan sibling user-memory files
3. `db59221` — feat(04-01-03): section renderers — entities, active projects, recent threads
4. `acf6717` — feat(04-01-04): handoff renderer + static How-to-Query block
5. `af7472d` — feat(04-01-05): normalization + sha256 sentinel helpers
6. `942655e` — feat(04-01-06): assemble pipeline — refuse, idempotency, size cap, atomic write
7. `2c201db` — test(04-01-07): unit suite — 31 tests for memory-md-writer

## Decisions Made

- **Entities come from the legacy `artifacts` table** (`artifact_type='entity_summary'`), not V17 `artifact`. RESEARCH §2 identified this as the only place where `importance` is still written, and `entity_summary` rows have not migrated. The SELECT filters `state IN ('packed','fresh','materialized')` to match the actual schema CHECK — the plan's original `('active','packed','fresh','materialized')` would be a no-op for `'active'` anyway since the CHECK rejects it.
- **Active Projects uses V17 `artifact.updated_at_epoch >= now - 7d`**, cross-project by design (dashboard), ordered by activity count DESC then last-touched DESC then project_id ASC.
- **Recent Threads is computed in two steps**: first the 10 most-recent sessions for this project (`GROUP BY session_id ORDER BY MAX(created_at_epoch) DESC`), then dedup-by-topic-label over those sessions. Avoids reliance on window-function edge cases in older SQLite builds.
- **Normalization contract**: CRLF → LF, trim trailing whitespace per line, collapse runs of blank lines to one, exactly one trailing `\n`. Applied before sentinel hashing so whitespace-only changes upstream don't flip the hash.
- **User-tail idempotency nuance**: if the user adds a line inside `## User Notes`, the next run will observe that existing === fullNew (because fullNew reconstructs the same byte-pattern from the preserved tail), so it reports `idempotent_noop`. The Angel-owned hash is unchanged, and the user's line stays. The test suite asserts this explicitly so the nuance is locked in.
- **Atomic write strategy**: `writeFileSync(tmp, 'utf8')` → `renameSync(tmp, final)` matches the V17-backup prior art, with a single sub-50ms busy-retry to absorb Windows AV/editor lock races.

## Deviations from Plan

- **Entity state CHECK**: PLAN SQL listed `state IN ('active','packed','fresh','materialized')` but the `artifacts.state` CHECK only accepts the last three. Filter reduced to the three valid values. No behavioral change — the invalid `'active'` was never matchable.
- **`ref` / `artifact_ref`**: plan wrote `SELECT artifact_ref, summary, importance, timestamp_epoch, id FROM artifacts ...` — kept as-is, this is the schema column. `entity-summarizer.ts` writes via the alias-column `ref` but the CHECK-constrained column in `artifacts` is `artifact_ref`. Not a plan deviation so much as a schema clarification.
- **Test HOME override**: plan suggested `vi.spyOn(os, 'homedir')` but `os.homedir` is non-configurable in the running Node version (`TypeError: Cannot redefine property`). Tests override `process.env.HOME` + `process.env.USERPROFILE` instead, which Node's native `homedir()` honours on both Unix and Windows. Tests restore the originals in `afterEach`.
- **Test for "user edits → rewrite"**: PLAN §Tasks/04-01-07 case #2 expected `written:true` after a user adds a line. But the rendered bytes already match what the writer would produce (same body + the preserved tail with the user's line), so the idempotency fast-path correctly reports `idempotent_noop`. Test was adjusted to assert that outcome and that the hash is unchanged — the underlying invariant (user mutations don't alter the Angel-owned hash) is the same.
- **`EventType` extension**: the plan's refuse path emits `event_type='memory_curation_refused'`, which was not in the existing `EventType` union. Added the literal to `src/core/session-events.ts` so the refuse path type-checks cleanly. One-line addition, same shape as every other literal in that union.

## Issues Encountered

- Pre-existing failures in `llama-client.test.ts` + `llama-server-supervisor.test.ts` (20 tests) — confirmed by stashing this plan's changes and re-running the same files; same failures on master. Filed mentally as "not this plan's problem".
- `vi.spyOn(os, 'homedir')` throws on the current Node — worked around via env vars as noted above.

## Next Phase Readiness

- `curateMemoryMd(db, project)` is callable today. Plan 04-04 wires it into the Angel heartbeat (run on session-completed signal).
- Plan 04-03 can import `pathToCcSlug` from `src/shared/cc-slug.ts` without creating a duplicate.
- The writer never mutates the `## User Notes` block — Phase 5 session-start verification can safely inspect the file without worrying about interleaved writes.

---
*Phase: 04-p3-memory-md-curation-auto-dream-guard*
*Completed: 2026-04-22*
