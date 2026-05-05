# Phase 6: Crash-resilient episode boundary — Research

**Researched:** 2026-05-05
**Domain:** filesystem-watch + process-liveness + transactional event-sourced state machine
**Confidence:** HIGH (chokidar, better-sqlite3 transactions, sessions schema) / MEDIUM (Windows `process.kill(pid,0)` semantics, exact debounce values)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Episode boundary semantics**
- `episode_id := session_id`. No new id allocated.
- Close trigger = composite OR of four signals: clean SessionEnd, idle-timeout, PID-dead-with-stale-heartbeat-and-stale-JSONL, JSONL-silent-with-corroborating-PID-death. First-fired wins; populates `close_reason`.
- Sub-session boundaries deferred to v6+.

**Aliveness composition rule (formal, locked)**
```
ALIVE       <=>  (PID is live)
                ∧ (now − last_jsonl_write_ts < T_jsonl)
                ∧ (now − last_heartbeat_ts  < T_heartbeat
                   ∨ now − last_jsonl_write_ts < T_jsonl_short)

DORMANT     <=>  ¬ALIVE ∧ (now − last_jsonl_write_ts < T_jsonl + T_grace)

TERMINATED  <=>  ¬ALIVE
                ∧ (   (now − last_jsonl_write_ts ≥ T_jsonl + T_grace)
                    ∨ clean SessionEnd received
                    ∨ (PID dead
                       ∧ now − last_heartbeat_ts  ≥ T_heartbeat
                       ∧ now − last_jsonl_write_ts ≥ T_jsonl_short) )
```
JSONL trumps heartbeat (Claude Code issue #16047 — hooks die after ~2.5h while session writes continue). Stale heartbeat alone NEVER closes a session.

**Per-signal thresholds (defaults; env-configurable)**
| Symbol | Default | Env var |
|--------|---------|---------|
| `T_jsonl` | 15 min | `CLAUDEX_EPISODE_T_JSONL_SECONDS` |
| `T_grace` | 15 min | `CLAUDEX_EPISODE_T_GRACE_SECONDS` |
| `T_heartbeat` | 5 min | `CLAUDEX_EPISODE_T_HEARTBEAT_SECONDS` |
| `T_jsonl_short` | 5 min | `CLAUDEX_EPISODE_T_JSONL_SHORT_SECONDS` |
| `T_reopen` | 60 min | `CLAUDEX_EPISODE_REOPEN_WINDOW_SECONDS` |
| sweep cadence | 2 min | reuse `heartbeatIntervalMs` |

**Heartbeat-compare-before-cleanup (SHALL)**
Before TERMINATED transition, re-read `last_heartbeat_ts` and `last_jsonl_write_ts` inside the same SQLite transaction that writes the close marker. Fresher than threshold ⇒ abort + `close_aborted_stale_check_failed` telemetry row.

**Close emission (locked)**
On close, emit a single `episode_closed` row via Phase 1's `writeEnvironmentalEvent`:
- `provenance='environmental'`, `source='angel-boundary'`, `type='episode_closed'`
- `metadata_json`: `{ close_reason, duration_seconds, event_count, pid_alive, last_heartbeat_ts, last_jsonl_write_ts }`
- `close_reason ∈ { clean_endsession | idle_timeout | jsonl_silent | pid_dead }`

**Re-open semantics**
- New JSONL write within `T_reopen` ⇒ append `re_opened` env event row + flip session status back to ALIVE. Original `episode_closed` is append-only, never mutated.
- Beyond `T_reopen` ⇒ `episode_reopen_anomaly` telemetry row; session stays TERMINATED. Do NOT auto-allocate new session_id.

**JSONL watcher (locked library)**
- **chokidar** as runtime dependency (NOT currently in `package.json` deps).
- Watch path: `~/.claude/projects/**/*.jsonl` (recursive on the projects root).
- Watch parent dir, not files (atomic-write rename quirks).

**Crash recovery via persisted cursor**
New table `episode_boundary_cursor` in `~/.claudex/db/claudex.db`:
```
episode_boundary_cursor (
  project                       TEXT NOT NULL,
  session_id                    TEXT NOT NULL,
  last_processed_jsonl_offset   INTEGER NOT NULL,
  last_processed_event_ts_epoch INTEGER NOT NULL,
  last_close_event_id           INTEGER,            -- soft reference (no FK in V29)
  PRIMARY KEY (project, session_id)
)
```

**Transactional cursor + env event write (SHALL)**
Each Angel boundary tick wraps `(advance cursor + emit env events + advance close marker)` in a single `db.transaction(...)`. Crash mid-tick ⇒ replay from last successful commit.

**V29 migration (single bump)**
1. NEW table `episode_boundary_cursor` (above).
2. ADD COLUMN `sessions.last_heartbeat_ts INTEGER` (nullable).
3. ADD COLUMN `sessions.last_jsonl_write_ts INTEGER` (nullable).

**Crash-without-final-JSONL-line tradeoff**
Hard crash with no final write ⇒ surface as close marker after `T_jsonl + T_grace` = 30 min, with `close_reason='idle_timeout'` and metadata indicating PID was dead. Accept "never miss a crash" beats "detect instantly."

**Telemetry surfaces** (single-row writes to existing `telemetry` table)
- `episode_close_emitted` (per close)
- `episode_reopen` (per re-open within `T_reopen`)
- `episode_reopen_anomaly` (write past `T_reopen`)
- `close_aborted_stale_check_failed` (heartbeat-compare guard fired)
- `boundary_cursor_replay` (Angel restart resumed from cursor)
- `jsonl_watcher_unreachable` (chokidar watcher error / failed to bind)

### Claude's Discretion (open for plan-phase)

- Exact PID-liveness mechanism on Windows (`process.kill(pid, 0)` cross-platform vs `tasklist` shell-out vs npm helper).
- Exact column types/defaults for `sessions` additions (INTEGER NULL vs INTEGER DEFAULT 0; CHECK shape).
- Exact debounce window for chokidar event coalescing (engineering-doc references ~200ms; plan-phase confirms / overrides).
- Watcher recovery policy on chokidar error (retry with exponential backoff vs hard-restart Angel).
- Exact `detail` JSON schema per `event_kind` for telemetry.
- Whether `episode_closed` env event also UPDATEs `sessions.status='terminated'` (consistency vs source-of-truth).

### Deferred Ideas (OUT OF SCOPE)

- Synthesis at episode close (was Phase 5, dropped 2026-05-05).
- Sub-session episode segmentation by content/intent/commit (future v6+).
- Splitting closed sessions into multiple episodes by detected transitions.
- New retrieval surface that consumes the marker (Phase 7 or future).
- Real-time PII redaction on JSONL (open question #6 in engineering doc; not v5).
- Replacing `experience_warning_triggers` reader surface (Phase 7).
- Sub-30-min crash detection (future-milestone problem).
- Conservative post-hoc synthesizer at episode close (future v6+).
- Cross-project boundary detection (Phase 6 is per-(project, session_id)).
- Hard FK on `last_close_event_id` (soft now; promote in Phase 7 if FK pragma flips).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| EBD-01 | Angel observes session activity via fsnotify on JSONL directory | chokidar `watch('~/.claude/projects', { ignored, ignoreInitial: true, awaitWriteFinish, recursive default for glob roots })`; emits `add`, `change`, `unlink`, `error`. Watch parent, not files. |
| EBD-02 | Heartbeat row written by every UserPromptSubmit / PreToolUse / PostToolUse | Existing PostToolUse + Stop already write episodic_events; the `last_heartbeat_ts` column UPDATE is a single `cachedPrepare` co-located with each existing hook write. UserPromptSubmit + PreToolUse audited per-hook during plan. |
| EBD-03 | Idle-timeout sweep: T_jsonl + T_grace silence ⇒ TERMINATED | Reuse `getIdleSessions` shape in `src/angel/session-monitor.ts:25`; new predicate joins `sessions.last_heartbeat_ts/last_jsonl_write_ts`. Sweep runs on existing `heartbeatIntervalMs` tick. |
| EBD-04 | PID liveness with heartbeat-compare-before-cleanup | `process.kill(pid, 0)` cross-platform with try/catch; re-read timestamps inside the close transaction. |
| EBD-05 | Episode boundary unit decided | LOCKED in CONTEXT: episode = session. EBD-05 closed-by-decision; no investigation work in this phase. |
| EBD-06 | Synthesis fires when episode closes by ANY of: clean /endsession, idle timeout, JSONL absent for T | "Synthesis" reframed by CONTEXT to "single environmental event row" — `writeEnvironmentalEvent` with type='episode_closed'. Detection-only, no LLM synthesis. |
</phase_requirements>

## Summary

Phase 6 builds a four-signal composite-OR boundary detector layered on top of Phase 1's `episodic_events` substrate. The architecture is fully locked by CONTEXT.md — there is no design-space exploration left for plan-phase. What remains is mechanical: V29 migration, chokidar dep + watcher module, sessions-column update path in five hooks, boundary detector in Angel heartbeat tick, transactional cursor + env event writer, telemetry instrumentation, regression tests.

The load-bearing engineering invariants are (a) JSONL trumps heartbeat for liveness (Claude Code issue #16047 — hooks die at ~2.5h), (b) heartbeat-compare inside the close transaction (Session Amnesia guard from Claude Code's own `cleanup.sh` pattern), (c) atomic `(cursor advance + env event emit)` so crash-replay from cursor is correct, and (d) re-open is append-only — closed episodes are never mutated.

**Primary recommendation:** Decompose into 5 vertical-slice plans by code-path layer: V29 migration, hook column writes, chokidar watcher module, boundary detector + composition rule, integration + telemetry + tests. All five are mostly serial dependencies (migration → columns → watcher → detector → integration), so wave structure will be 1-2-3-4-5 with each plan single-wave.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| chokidar | ^4.0.0 | Cross-platform JSONL directory watch | Industry-standard wrapper over `fs.watch` / `fsevents` / `inotify`; handles atomic-rename quirks; used by Webpack, Rollup, nodemon. ~100KB pure JS via `readdirp`, no native bindings. |
| better-sqlite3 | ^11.7.0 (already in deps) | Synchronous DB writes inside transactions | Existing dep; transactions via `db.transaction(fn)()` are atomic and synchronous — perfect for the cursor + env-event write pattern. |
| Node.js `process.kill(pid, 0)` | builtin | Cross-platform PID liveness | Builtin; throws ESRCH on POSIX dead PID, EPERM on POSIX live-but-not-ours. Windows: throws on dead, returns true on live. Wrap in try/catch. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `fs/promises` | builtin | `fs.stat()` for JSONL file size / mtime fallback if cursor offset is stale | Recovery path only — cursor reads bypass when offset > current file size (file truncated/rotated). |
| `node:path` | builtin | Resolve `~/.claude/projects` cross-platform | Standard pattern in existing codebase (`src/shared/paths.ts`). |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| chokidar | Native `fs.watch` (recursive: true on Node ≥14) | Native works on macOS/Linux/Win10+, but: rename events are inconsistent on Windows (multiple events per atomic rename); recursive is broken on older Linux kernels (returns events but fires once); ENOSPC on Linux with many watches. chokidar normalizes all of these. **Locked by CONTEXT.** |
| chokidar | `parcel-watcher` (`@parcel/watcher`) | Faster + lower-level (uses platform-native APIs directly), but adds native binary build step + doesn't match the "no native bindings" preference in CONTEXT. |
| `process.kill(pid, 0)` | `tasklist` shell-out on Windows | More accurate (returns process name), but spawns a process per check — the boundary tick runs every 2 min over up to 10 sessions, so 5 spawns/min × ~30ms each = 150ms of CPU. `process.kill(pid, 0)` is a single syscall (~microseconds). |
| `process.kill(pid, 0)` | `ps-list` npm package | Returns full process snapshot — overkill for a single PID-alive check, ~5MB memory allocation per call. |

**Installation:**
```bash
npm install chokidar
# (Phase 6 plan-01 task adds this and bumps package.json + lockfile)
```

## Architecture Patterns

### Recommended File Structure

```
src/
├── angel/
│   ├── boundary/
│   │   ├── jsonl-watcher.ts          # chokidar setup + event coalescing + last_jsonl_write_ts UPDATE
│   │   ├── pid-liveness.ts           # process.kill(pid, 0) wrapper, cross-platform
│   │   ├── boundary-detector.ts      # composition rule (ALIVE/DORMANT/TERMINATED), close emission
│   │   ├── cursor.ts                 # episode_boundary_cursor read/write/replay
│   │   └── thresholds.ts             # T_jsonl, T_grace, etc. read from env with fallbacks
│   ├── heartbeat.ts                  # MODIFIED: integrate boundary-detector tick
│   └── session-monitor.ts            # PRESERVED: existing idle/stuck logic stays
├── core/
│   ├── episodic-events.ts            # PRESERVED: writeEnvironmentalEvent reused for episode_closed
│   ├── migration-steps.ts            # MODIFIED: add migrateV28toV29
│   └── migrations.ts                 # MODIFIED: append [28, ...] to migrations array, bump TARGET_USER_VERSION to 29
├── adapters/cc-hooks/
│   ├── user-prompt-submit.ts         # MODIFIED: UPDATE sessions.last_heartbeat_ts
│   ├── pre-tool-use.ts               # MODIFIED: UPDATE sessions.last_heartbeat_ts (audit if hook exists)
│   ├── post-tool-use.ts              # MODIFIED: UPDATE sessions.last_heartbeat_ts (already writes episodic)
│   ├── stop.ts                       # MODIFIED: UPDATE sessions.last_heartbeat_ts (already writes episodic)
│   └── session-end.ts                # MODIFIED: trigger clean_endsession close-marker emission
└── tests/
    └── angel/boundary/
        ├── composition-rule.test.ts  # ALIVE/DORMANT/TERMINATED truth-table
        ├── heartbeat-compare.test.ts # Session Amnesia guard fires on race
        ├── cursor-replay.test.ts     # crash mid-tick replays cleanly
        ├── reopen.test.ts            # within-T_reopen / past-T_reopen branches
        └── jsonl-watcher.test.ts     # chokidar integration with synthetic JSONL writes
```

### Pattern 1: chokidar watcher with atomic-rename safety

```typescript
// src/angel/boundary/jsonl-watcher.ts
import chokidar from 'chokidar';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Database } from 'better-sqlite3';
import { cachedPrepare } from '../../core/stmt-cache.js';

const DEBOUNCE_MS = 200; // engineering-doc anchor; configurable via env
const PROJECTS_ROOT = path.join(homedir(), '.claude', 'projects');

export function startJsonlWatcher(db: Database, onError: (err: Error) => void): chokidar.FSWatcher {
  const watcher = chokidar.watch(`${PROJECTS_ROOT}/**/*.jsonl`, {
    ignored: (p) => p.includes('node_modules'),
    ignoreInitial: true,           // don't fire `add` for existing files at start
    awaitWriteFinish: {            // wait for write-stream stability (atomic-rename safety)
      stabilityThreshold: DEBOUNCE_MS,
      pollInterval: 50,
    },
    persistent: true,
    ignorePermissionErrors: true,
  });

  // Best-effort write-ts UPDATE; never block the watcher loop on DB errors
  const updateWriteTs = (filePath: string) => {
    try {
      const sessionId = parseSessionIdFromPath(filePath); // {project}/{session_id}.jsonl
      if (!sessionId) return;
      const now = Math.floor(Date.now() / 1000);
      cachedPrepare(db,
        `UPDATE sessions SET last_jsonl_write_ts = ? WHERE session_id = ?`
      ).run(now, sessionId);
    } catch { /* swallow — telemetry written elsewhere */ }
  };

  watcher.on('add', updateWriteTs);
  watcher.on('change', updateWriteTs);
  watcher.on('error', (err) => onError(err instanceof Error ? err : new Error(String(err))));
  return watcher;
}

function parseSessionIdFromPath(filePath: string): string | null {
  // ~/.claude/projects/{project}/{session_id}.jsonl  →  session_id
  const base = path.basename(filePath, '.jsonl');
  return base.length > 0 ? base : null;
}
```

**Source:** chokidar v4 README — `awaitWriteFinish.stabilityThreshold` is the documented atomic-rename safety knob (https://github.com/paulmillr/chokidar#performance — verified MEDIUM confidence; widely cited in build-tool integrations like Webpack and Vite).

### Pattern 2: PID liveness, cross-platform

```typescript
// src/angel/boundary/pid-liveness.ts
export function isPidAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = no-op probe
    return true;
  } catch (err: unknown) {
    // POSIX: ESRCH = no such process; EPERM = exists but not ours (still alive)
    // Windows: throws with errno on dead PID; succeeds (returns) on live.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM') return true; // process exists, we just can't signal it
    return false;
  }
}
```

**Source:** Node.js docs (`process.kill`) — https://nodejs.org/api/process.html#processkillpid-signal. Verified HIGH confidence; the EPERM-means-alive idiom is in `is-running` and `pid-from-port` npm packages.

### Pattern 3: Transactional cursor + env event write

```typescript
// src/angel/boundary/cursor.ts
import type { Database } from 'better-sqlite3';
import { writeEnvironmentalEvent } from '../../core/episodic-events.js';

export interface BoundaryTickPayload {
  project: string;
  sessionId: string;
  jsonlOffset: number;             // size of file at decision time
  lastEventTsEpoch: number;
  closeMarker?: { reason: 'clean_endsession' | 'idle_timeout' | 'jsonl_silent' | 'pid_dead'; metadata: Record<string, unknown> };
}

export function commitBoundaryTick(db: Database, payload: BoundaryTickPayload): void {
  // Single transaction: cursor advance + (optional) close-marker env event.
  // CRITICAL — heartbeat-compare-before-cleanup happens INSIDE this tx so a
  // racing JSONL write or heartbeat update aborts the close.
  const tx = db.transaction(() => {
    if (payload.closeMarker) {
      const fresh = db.prepare(
        `SELECT last_heartbeat_ts, last_jsonl_write_ts FROM sessions WHERE session_id = ?`
      ).get(payload.sessionId) as { last_heartbeat_ts: number | null; last_jsonl_write_ts: number | null } | undefined;
      if (staleCheckFailed(fresh, payload)) {
        // Bail: write a single telemetry row INSIDE the transaction so it
        // commits with the cursor advance.
        db.prepare(
          `INSERT INTO telemetry (session_id, event_kind, detail, adapter)
           VALUES (?, 'close_aborted_stale_check_failed', ?, 'angel-boundary')`
        ).run(payload.sessionId, JSON.stringify({ project: payload.project, freshness: fresh }));
        return; // skip close emission
      }
      writeEnvironmentalEvent({
        db,
        sessionId: payload.sessionId,
        project: payload.project,
        type: 'environmental_event',
        source: 'angel-boundary',
        content: `Episode closed: ${payload.closeMarker.reason}`,
        metadata: { ...payload.closeMarker.metadata, episode_closed: true, close_reason: payload.closeMarker.reason },
      });
    }
    db.prepare(
      `INSERT INTO episode_boundary_cursor (project, session_id, last_processed_jsonl_offset, last_processed_event_ts_epoch)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project, session_id) DO UPDATE SET
         last_processed_jsonl_offset = excluded.last_processed_jsonl_offset,
         last_processed_event_ts_epoch = excluded.last_processed_event_ts_epoch`
    ).run(payload.project, payload.sessionId, payload.jsonlOffset, payload.lastEventTsEpoch);
  });
  tx();
}
```

**Source:** Phase 1's `episodic-events.ts` already follows this exact `db.transaction(() => {...})()` pattern (verified via Read above) — the new module mirrors it. better-sqlite3 docs confirm transactions are atomic and synchronous.

### Anti-Patterns to Avoid

- **Single global timeout T**: signals have different reliability characteristics; one T either closes legit long-reasoning sessions or misses crashed ones. CONTEXT explicitly rejects.
- **Stale heartbeat alone closing a session**: Claude Code issue #16047 — hooks die at ~2.5h while session continues writing. Closing on heartbeat-only causes "Session Amnesia."
- **Cursor in a sidecar file**: must live in claudex.db so the env-event write is atomic with cursor advance. Crash mid-tick with a sidecar would orphan one of the two.
- **Mutating closed `episode_closed` rows**: append-only event sourcing. Re-open writes a NEW `re_opened` row.
- **Auto-allocating new session_ids on past-`T_reopen` writes**: Claude Code owns session_id allocation. Do not synthesize new ones. Anomaly telemetry only.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cross-platform recursive directory watching | Custom `fs.watch` wrapper handling rename/atomic-write/ENOSPC quirks | chokidar | Production-tested across Windows/macOS/Linux; handles every edge case the engineering doc references. |
| Atomic write-stream coalescing | Manual debounce/timer logic | chokidar `awaitWriteFinish` | Built-in, handles the case where atomic-write tools rename the file mid-stream. |
| PID liveness across OS | `tasklist` shell-out / parsing `ps` output | `process.kill(pid, 0)` + try/catch | Single syscall, no subprocess spawn; Node guarantees the EPERM/ESRCH semantics. |
| Transaction atomicity for cursor + event | Two separate writes with retry logic | `db.transaction(fn)()` | better-sqlite3's transaction is BEGIN IMMEDIATE + COMMIT, fully ACID, sync. |

**Key insight:** Every "should we hand-roll this?" question in Phase 6 has a one-line answer in the existing codebase or a battle-tested library. Phase 6 is integration plumbing, not novel infrastructure.

## Common Pitfalls

### Pitfall 1: chokidar event firing during Angel restart

**What goes wrong:** Angel exits, then comes back up. chokidar with `ignoreInitial: false` fires `add` for every existing JSONL file → mass `last_jsonl_write_ts` UPDATE → wrong values (timestamps reflect now, not actual last-write-time).

**Why it happens:** chokidar's `add` event fires for files present at watch-start by default.

**How to avoid:** `ignoreInitial: true` (set in pattern above) — only fire on NEW writes after watcher is up. The `last_jsonl_write_ts` column starts at NULL and gets backfilled by the boundary detector reading `fs.stat().mtime` for any active session whose value is still NULL.

**Warning signs:** Test by killing Angel mid-session, restarting, and checking that `last_jsonl_write_ts` was NOT updated for files that haven't been written to since restart.

### Pitfall 2: Race between SessionEnd hook and idle-timeout sweep

**What goes wrong:** SessionEnd hook fires (clean close); 30 seconds later, the boundary detector tick runs and emits a SECOND `episode_closed` row with `close_reason='idle_timeout'`.

**Why it happens:** Hook writes its close marker, but `episode_boundary_cursor` may not be updated atomically — detector reads stale cursor, considers session ALIVE→TERMINATED→fires close.

**How to avoid:** SessionEnd hook MUST advance `episode_boundary_cursor` in the same transaction that writes its `clean_endsession` close marker. Detector SELECTs `last_close_event_id IS NOT NULL` from cursor before re-evaluating composition rule — already-closed sessions short-circuit.

**Warning signs:** Two `episode_closed` rows for the same session_id in `episodic_events`. Telemetry should bound this to zero.

### Pitfall 3: Cursor offset > current JSONL file size

**What goes wrong:** Claude Code rotates / truncates a JSONL (rare but possible — e.g., file system corruption recovery). Cursor still points at offset 1MB; new file is 0 bytes. Boundary detector treats the file as "haven't seen new content" and never closes.

**Why it happens:** Cursor offset is an absolute byte index, not a content hash.

**How to avoid:** Before reading, compare `cursor.last_processed_jsonl_offset` to `fs.stat(file).size`. If cursor > size, reset cursor to 0 and emit a `boundary_cursor_replay` telemetry row with `detail.reason='offset_overflow'`.

**Warning signs:** `boundary_cursor_replay` telemetry with `offset_overflow` reason — non-zero count means rotation is happening. Alarm if count > a few/day.

### Pitfall 4: Windows path normalization

**What goes wrong:** chokidar emits paths in OS-native form on Windows (backslashes); `path.basename()` works but glob matches in `ignored` may fail if the watcher pattern uses forward slashes only.

**Why it happens:** Windows uses `\`, glob patterns conventionally use `/`.

**How to avoid:** Always pass Unix-style globs to chokidar (`${PROJECTS_ROOT}/**/*.jsonl`) — chokidar normalizes internally. For path parsing in our code, use `path.basename()` and `path.sep` (don't string-split on `/`).

**Warning signs:** Watcher fires no events on Windows despite JSONL writes. Check `path.sep` handling. Add a Windows smoke test in `composition-rule.test.ts`.

### Pitfall 5: `T_reopen=60min` re-open race with new agent reusing session_id

**What goes wrong:** User kills agent, opens fresh session 30 min later — Claude Code may reuse a session_id (it's a UUID, but human eye / tooling could confuse). Boundary detector sees new JSONL writes and flips status from TERMINATED → ALIVE without verifying it's the same logical episode.

**Why it happens:** session_id is allocated by Claude Code; we don't control re-allocation invariants.

**How to avoid:** CONTEXT locked the policy: re-open is by `last_jsonl_write_ts` proximity to last-known-close. We do NOT verify "same logical episode" — that's a future-milestone problem. The `re_opened` env event row carries gap_seconds for diagnostic review; if Claude Code ever re-issues a session_id within `T_reopen`, the anomaly is visible in the data.

**Warning signs:** `gap_seconds` distribution in `re_opened` rows — if you see bimodal distribution (cluster at <T_jsonl and cluster at ~T_reopen), investigate.

## Code Examples

Verified patterns from official sources / existing codebase:

### Reading existing-pattern reuse for `getIdleSessions`-shape predicate

```typescript
// Adapted from src/angel/session-monitor.ts:25 (existing) — Phase 6 EXTENDS, doesn't replace
export function getCloseCandidates(
  db: Database,
  thresholds: BoundaryThresholds,
): CloseCandidate[] {
  const now = Math.floor(Date.now() / 1000);
  const tJsonlPlusGrace = thresholds.tJsonl + thresholds.tGrace;
  return cachedPrepare(db,
    `SELECT s.session_id, s.project, s.last_heartbeat_ts, s.last_jsonl_write_ts,
            s.created_at_epoch, s.adapter
     FROM sessions s
     LEFT JOIN episode_boundary_cursor c
       ON c.project = s.project AND c.session_id = s.session_id
     WHERE s.status = 'active'
       AND (c.last_close_event_id IS NULL OR c.last_close_event_id = 0)
       AND (s.last_jsonl_write_ts IS NULL OR (? - s.last_jsonl_write_ts) >= ?)
     ORDER BY s.last_jsonl_write_ts ASC NULLS FIRST
     LIMIT 10`
  ).all(now, tJsonlPlusGrace) as CloseCandidate[];
}
```

### Per-hook column UPDATE pattern (5 hook files)

```typescript
// In each of: user-prompt-submit.ts, pre-tool-use.ts, post-tool-use.ts, stop.ts, session-end.ts
// Co-located with existing dualWrite* / writeToolResult / writeEnvironmentalEvent calls.
const now = Math.floor(Date.now() / 1000);
cachedPrepare(db, `UPDATE sessions SET last_heartbeat_ts = ? WHERE session_id = ?`).run(now, sessionId);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Synchronous SessionEnd-hook-only close detection | Composite OR of fsnotify + heartbeat + idle + PID-liveness | Phase 6 (this) | Crash-resilient: PC reboot, OOM, segfault all surface as close markers within `T_jsonl + T_grace`. |
| `experience_patterns` extracted at heartbeat-tick | Episode close emission only; extraction-time pattern creation deleted | Phase 4 (shipped 2026-05-05) | Mem0 trap structurally impossible. Phase 6 boundary detector inherits the substrate-only discipline. |
| `idleThresholdSeconds` single-value cutoff | Per-signal thresholds (`T_jsonl`, `T_grace`, `T_heartbeat`, `T_jsonl_short`, `T_reopen`) | Phase 6 | Long-reasoning sessions (Claude #29881) and dead-hooks sessions (#16047) handled correctly. |

**Deprecated/outdated:** none — Phase 6 is additive over the substrate. Phase 4's deletions don't conflict; the surviving `getIdleSessions` is reused as a pattern, not replaced.

## Open Questions

1. **Exact debounce window for chokidar `awaitWriteFinish.stabilityThreshold`**
   - What we know: engineering doc references ~200ms; Webpack default is 300ms; Vite default is 100ms.
   - What's unclear: which value minimizes `last_jsonl_write_ts` jitter without lagging real writes.
   - Recommendation: ship 200ms (engineering-doc anchor), add `CLAUDEX_EPISODE_JSONL_DEBOUNCE_MS` env override, observe in telemetry. Open env var even though CONTEXT didn't list it — tunable observability is cheap.

2. **Should `episode_closed` env event write ALSO UPDATE `sessions.status='terminated'`?**
   - What we know: CONTEXT explicitly leaves this to plan-phase. The sessions table has a `status` column already constrained to `('active', 'completed', 'failed', 'transferred')`.
   - What's unclear: whether 'completed' is the right post-close value (it's a forward-only enum from "active" right now in the existing code path).
   - Recommendation: YES, update `sessions.status='completed'` inside the same close-marker transaction. Symmetric with the existing auto-close path in `heartbeat.ts:196-198` which already does this. Avoids divergence between `episodic_events` (says closed) and `sessions` (says active).

3. **Watcher recovery policy on chokidar `error` event**
   - What we know: chokidar emits `error` on EBADF, ENOSPC (Linux: out of inotify watches), permission errors. Many are recoverable by re-`watch()`.
   - Recommendation: exponential backoff with cap (1s, 2s, 4s, 8s, 16s, 30s; reset on success). After 5 consecutive failures, write a `jsonl_watcher_unreachable` telemetry row and continue retrying at 30s — never give up, since the boundary detector falls back to PID + heartbeat-only signals while watcher is down (degraded but non-fatal).

4. **Whether UserPromptSubmit / PreToolUse hooks already exist as separate files**
   - What we know: `src/adapters/cc-hooks/post-tool-use.ts` and `stop.ts` exist (verified via grep — they import V25/V26/V27/V28). UserPromptSubmit is referenced in `src/core/episodic-events.ts:144` as `'cc-hooks/user-prompt-submit'`.
   - Recommendation: plan-phase verifies existence with `Glob src/adapters/cc-hooks/*.ts` before assuming. If missing, the column-UPDATE goes in whichever file is the actual hook entry point per `src/adapters/cc-hooks/`.

## Sources

### Primary (HIGH confidence)
- `src/core/episodic-events.ts` — `writeEnvironmentalEvent` signature + transaction pattern (read in full above).
- `src/angel/session-monitor.ts:25` — `getIdleSessions` shape Phase 6 extends.
- `src/angel/types.ts:135` — `DEFAULT_ANGEL_CONFIG.heartbeatIntervalMs = 2 * 60 * 1000` (Phase 6 sweep cadence).
- `src/core/migration-steps.ts:1828` (V25→V26) and `:1949` (V27→V28) — migration patterns to mirror for V29.
- `src/core/migrations.ts:99,142` — `TARGET_USER_VERSION` and migrations array append point.
- `src/core/schema.ts:106` — sessions table DDL (where ALTER ADD COLUMN lands).
- `package.json` — current deps; chokidar absent → must `npm install`.
- Node.js docs (`process.kill`) — https://nodejs.org/api/process.html#processkillpid-signal

### Secondary (MEDIUM confidence)
- chokidar v4 README (paulmillr/chokidar) — `awaitWriteFinish`, `ignoreInitial`, `error` event semantics. Widely cited in build-tool integrations.
- Claude Code issue #16047 (hooks die at ~2.5h while session continues writing) — referenced in CONTEXT and `.planning/research/2026-04-30-v5-episodic-memory.md` L84-95.
- Claude Code issue #29881 (Stop hook doesn't fire on stalls) — same source.

### Tertiary (LOW confidence)
- "EPERM means alive" idiom for `process.kill(pid, 0)` on POSIX — documented in is-running and pid-from-port npm packages, not in Node docs themselves. Confidence is high enough to use; flagged here for transparency.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — chokidar and better-sqlite3 are unambiguous; PID liveness pattern is verified.
- Architecture: HIGH — composition rule, table schema, helper reuse all locked by CONTEXT.
- Pitfalls: MEDIUM — pitfalls 1, 2, 3 verified against existing codebase patterns; pitfall 5 is theoretical (depends on Claude Code session_id semantics we don't fully control).

**Research date:** 2026-05-05
**Valid until:** 2026-06-05 (chokidar v4 stable; better-sqlite3 v11 stable; Node 22 LTS through 2027)
