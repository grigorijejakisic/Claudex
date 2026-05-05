# Phase 6: Crash-resilient episode boundary — Context

**Gathered:** 2026-05-05
**Status:** Ready for planning
**Type:** engineering

<domain>
## Phase Boundary

Implement engineering-doc Recommendation #1: Angel-as-source-of-truth for session-end. Detect "this episode is closed" without depending on the `SessionEnd` hook firing, by composing four external signals — fsnotify-on-JSONL, session-emitted heartbeat row, idle-timeout sweep, PID-liveness with stale detection — under a heartbeat-compare-before-cleanup discipline. On close, emit a single `episode_closed` environmental event row via Phase 1's `writeEnvironmentalEvent`. Once this lands, agent lifetime is decoupled from memory persistence: PC crash, OOM, hung agent — the episode is on disk, the close marker fires when the episode goes quiet.

**Episode = session.** `episode_id := session_id` (no new id allocated). Sub-session boundaries (per-thread, per-detected-intent-shift, per-task) are explicitly **deferred to v6+** as a future projection over the substrate; introducing them in v5 would require new substrate (intent classifier, thread segmentation) — the same kind of out-of-scope expansion the post-reframe scope discipline forbids.

**Detection-only.** No synthesis fires on close. The `episode_closed` row is the entire deliverable. v5 is a substrate-only milestone post-reframe (`.planning/reframes/2026-05-05-multi-handle-kill.md`); re-introducing a "conservative post-hoc synthesizer" at episode close would smuggle Phase 5 (dropped) back in through the side door. Phase 7 reads markers when deciding what to migrate/retire. Future v6+ milestones MAY consume the marker for new retrieval/abstraction theses **with their own bound measurements**.

**Out of scope** (belongs in other phases):
- Any synthesis at episode close (was Phase 5, dropped 2026-05-05; future v6+ may add)
- Sub-session episode segmentation by content/intent/commit (future v6+ projection)
- Splitting closed sessions into multiple episodes by detected transitions (future v6+ projection)
- New retrieval surface that consumes the marker (Phase 7 or future milestone)
- Real-time PII redaction on JSONL (open question #6 in engineering doc; not v5)
- Replacing `experience_warning_triggers` reader surface (Phase 7)

**Reframe references:** `.planning/reframes/2026-05-05-multi-handle-kill.md`, ROADMAP.md Phase 6 entry (L81-83), engineering-doc Recommendation #1 in `.planning/research/2026-04-30-v5-episodic-memory.md` L97-103, L136, framing doc `.planning/research/2026-05-04-v5-bound-episodes-framing.md`.

</domain>

<decisions>
## Implementation Decisions

### Episode boundary semantics (locked)

- **Episode = session.** Reuse existing `session_id`; no new id column or table.
- **Close trigger = composite OR** of four signals: `clean SessionEnd received`, `idle-timeout exceeded`, `PID-dead-with-stale-heartbeat-and-stale-JSONL`, `JSONL-silent-with-corroborating-PID-death`. First-fired wins. Whichever fires populates `close_reason` for telemetry differentiation.
- **Sub-session boundaries deferred** to v6+ as substrate-projection (split closed sessions by commit / `/endsession` / detected idle-shift). Recorded under "Deferred Ideas." Not blocking; substrate emitted by Phase 6 supports the future projection without rework.

### Aliveness composition rule (locked, formal)

```
ALIVE       ⇔  (PID is live)
              ∧ (now − last_jsonl_write_ts < T_jsonl)
              ∧ (now − last_heartbeat_ts  < T_heartbeat
                 ∨ now − last_jsonl_write_ts < T_jsonl_short)

DORMANT     ⇔  ¬ALIVE ∧ (now − last_jsonl_write_ts < T_jsonl + T_grace)

TERMINATED  ⇔  ¬ALIVE
              ∧ (   (now − last_jsonl_write_ts ≥ T_jsonl + T_grace)
                  ∨ clean SessionEnd received
                  ∨ (PID dead
                     ∧ now − last_heartbeat_ts  ≥ T_heartbeat
                     ∧ now − last_jsonl_write_ts ≥ T_jsonl_short) )
```

The disjunction in the ALIVE clause encodes **JSONL trumps heartbeat** for liveness — motivated by Claude Code issue #16047 (hooks die after ~2.5 hours while session continues writing JSONL). Stale heartbeat alone NEVER closes a session.

The `close_reason` enum maps to the disjunction in TERMINATED:

| close_reason         | Triggering branch                                                                                      |
|----------------------|--------------------------------------------------------------------------------------------------------|
| `clean_endsession`   | SessionEnd hook fired cleanly — short-circuits all timing windows                                      |
| `idle_timeout`       | JSONL silent for `T_jsonl + T_grace`, no other signal corroborated                                     |
| `jsonl_silent`       | JSONL silent ≥ `T_jsonl_short` AND PID dead AND heartbeat stale (corroborated death)                   |
| `pid_dead`           | PID dead AND heartbeat stale AND JSONL stale (full AND-life broken; functionally similar to `jsonl_silent`, distinguished for telemetry — implementations may collapse if downstream doesn't differentiate) |

### Per-signal thresholds (locked defaults; all configurable via env)

| Symbol           | Meaning                                                              | Default | Env var                                  |
|------------------|----------------------------------------------------------------------|---------|------------------------------------------|
| `T_jsonl`        | dormant-T: idle JSONL silence before marking dormant                 | 15 min  | `CLAUDEX_EPISODE_T_JSONL_SECONDS`        |
| `T_grace`        | dormant → terminated grace window                                    | 15 min  | `CLAUDEX_EPISODE_T_GRACE_SECONDS`        |
| `T_heartbeat`    | heartbeat staleness (PID-dead corroborating signal only)             | 5 min   | `CLAUDEX_EPISODE_T_HEARTBEAT_SECONDS`    |
| `T_jsonl_short`  | short-window JSONL freshness for the AND-life clause                 | 5 min   | `CLAUDEX_EPISODE_T_JSONL_SHORT_SECONDS`  |
| `T_reopen`       | re-open window: closed session sees new JSONL → reopen vs anomaly    | 60 min  | `CLAUDEX_EPISODE_REOPEN_WINDOW_SECONDS`  |
| sweep cadence    | how often the boundary tick runs                                     | 2 min   | reuse existing `heartbeatIntervalMs`     |

Rationale:
- `T_jsonl = 15 min` matches existing `idleThresholdSeconds` in `src/angel/types.ts:137` — same value Angel already uses for "idle warning."
- `T_grace = 15 min` symmetric; total close at 30 min idle. Conservative — issue #29881 (Stop hook doesn't fire on stalls) means real sessions can have multi-minute gaps between writes during long Claude reasoning turns.
- `T_heartbeat = 5 min` tighter than `T_jsonl` because UserPromptSubmit/PreToolUse/PostToolUse hooks fire on EVERY tool action; 5 min without any hook is strong hooks-died signal. Used only as corroborating signal in the PID-dead branch — never alone.
- `T_jsonl_short = 5 min` corroborator for the heartbeat-OR-JSONL-fresh disjunction; prevents stale heartbeat from prolonging ALIVE state when JSONL is also quiet.
- `T_reopen = 60 min` wider than `T_jsonl + T_grace = 30 min` so a re-open is plausibly the same logical session resuming after a meal/lunch break. **Best-guess default — not user-tested.** Plan-phase ships telemetry capturing reopen-vs-anomaly classifications; if observability shows >X% misclassification in the first month of operation, the default tunes via env. Same observability-tunable pattern applies to `T_jsonl`, `T_grace`, `T_heartbeat`, `T_jsonl_short`.

**Reject single global T.** Signals have different reliability characteristics: JSONL writes are durable (filesystem); heartbeat hooks die at 2.5h (#16047); PID liveness is a cheap syscall but must never trigger close alone (Session Amnesia). Per-signal thresholds compose those characteristics correctly; one global T either closes legit long-reasoning sessions or misses crashed ones.

### Heartbeat-compare-before-cleanup (SHALL)

Before transitioning a session to TERMINATED, the boundary detector **MUST** re-read `last_heartbeat_ts` and `last_jsonl_write_ts` for the session inside the same SQLite transaction that writes the close marker. If either timestamp is fresher than its threshold at the moment of cleanup, the close is **aborted** and a `close_aborted_stale_check_failed` row is written to `telemetry`. This prevents the "Session Amnesia" failure mode where a slow Angel tick races against legitimate session activity.

Engineering-doc grounding (L102): "Compare lastHeartbeat before cleanup — exact pattern Claude Code team adopted in their cleanup.sh."

### What fires on episode close (locked, detection-only)

A single `episode_closed` row written via Phase 1's `writeEnvironmentalEvent` helper:

```
provenance      = 'environmental'
source          = 'angel-boundary'
type            = 'episode_closed'
session_id      = <closing session>
project         = <session.project>
metadata_json   = {
  close_reason: 'clean_endsession' | 'idle_timeout' | 'jsonl_silent' | 'pid_dead',
  duration_seconds: <created_at_epoch → close_ts>,
  event_count:      <count of episodic_events for this session>,
  pid_alive:        <bool at close-decision time>,
  last_heartbeat_ts: <epoch>,
  last_jsonl_write_ts: <epoch>
}
```

That is the entire substrate-side deliverable of "synthesis fires" in v5.

### Re-open semantics (locked)

When a TERMINATED session sees a new JSONL write within `T_reopen`:
- Append a `re_opened` env event row (provenance=environmental, source=angel-boundary, type=re_opened, metadata captures the gap duration).
- Toggle session status back to ALIVE.
- The previous `episode_closed` row remains in the log (append-only — never mutated; this is event-sourced, see engineering doc L106-115).
- Subsequent close re-fires when the composition rule fires again.

Beyond `T_reopen`:
- Anomaly telemetry row (`event_kind='episode_reopen_anomaly'`, includes session_id and gap_seconds).
- Session status stays TERMINATED.
- Do **NOT** auto-allocate a new `session_id` — Claude Code owns session_id allocation; we don't synthesize new ones. The new write is recorded via the normal Phase 1 dualWrite path against the existing (terminated) session_id; the anomaly row flags the inconsistency for diagnostic review.

### JSONL watcher (locked)

- **Library: chokidar** as runtime dependency. Currently NOT in `package.json` deps (verified during discuss). Add to `dependencies` (not devDependencies). Footprint cost: ~100KB pure JS via `readdirp`, no native bindings — modest. Cross-platform Windows reliability outweighs the footprint hit (project runs on Windows per CLAUDE.md; native `fs.watch` has known Windows quirks: no recursive on older Node, ENOSPC on Linux, inconsistent rename events).
- **Watch path:** `~/.claude/projects/**/*.jsonl` (recursive on the projects root; chokidar handles atomic-rename quirks).
- **Engineering-doc anchor (L98):** "Watch parent dir not files (atomic-write tools rename)." chokidar implements this correctly; CONTEXT does not pin a specific debounce value (plan-phase territory; engineering doc says ~200ms is reasonable; the current handoff suggests that ballpark).

### Crash recovery via persisted cursor (locked)

A new table `episode_boundary_cursor` tracks per-session JSONL processing state, persisted in `~/.claudex/db/claudex.db` (the same DB Phase 1 substrate writes to):

```
episode_boundary_cursor (
  project                       TEXT NOT NULL,
  session_id                    TEXT NOT NULL,
  last_processed_jsonl_offset   INTEGER NOT NULL,
  last_processed_event_ts_epoch INTEGER NOT NULL,
  last_close_event_id           INTEGER,           -- soft reference (no FK in V29)
  PRIMARY KEY (project, session_id)
)
```

DB choice rationale: (a) atomic with `episodic_events` writes via single `db.transaction(...)`; (b) Angel already holds a `Database` handle to claudex.db; (c) no new file or process to manage.

`last_close_event_id` is a **soft reference**, not a foreign key. v5 has not standardized `PRAGMA foreign_keys = ON` per connection (V25/V26/V27/V28 schemas don't depend on it; turning it on now would touch every reader). The column exists for traceability; readers `JOIN episodic_events ON id = last_close_event_id` defensively. Future Phase 7 retirement work may enable FKs project-wide, at which point this column is a candidate for promotion to a hard FK with `ON DELETE SET NULL`.

### Transactional cursor + env event write (SHALL)

At every boundary-relevant Angel tick, the work `(advance cursor offset + emit any env events triggered + advance close marker if applicable)` runs **inside a single SQLite transaction** via `db.transaction(...)`. If Angel crashes mid-tick, replay re-runs the whole transaction idempotently from the cursor at last successful commit. Without atomicity, a crash mid-tick would leave inconsistent boundary state (cursor advanced but close marker missing, or vice versa).

This is the load-bearing crash-recovery property — it's why the cursor lives in claudex.db and not a sidecar file.

### V29 migration scope (locked, single migration)

V29 lands all schema changes for Phase 6 in one bump:

1. **NEW table** `episode_boundary_cursor` (defined above).
2. **`sessions` table column adds:** `last_heartbeat_ts INTEGER` and `last_jsonl_write_ts INTEGER`. Both nullable (default NULL); populated by hooks (heartbeat) and the Angel watcher (jsonl_write_ts) once V29 lands. New columns are preferred over a sidecar `session_liveness` table — only 2 INTEGER columns and every aliveness check JOINs on `session_id` anyway.

Plan-phase confirms exact column types/defaults (e.g., whether to add a CHECK or DEFAULT 0); CONTEXT specifies the additions exist and the rationale.

### Crash-without-final-JSONL-line tradeoff (explicit)

A hard crash where the agent's process dies without writing a final JSONL line takes `T_jsonl + T_grace = 30 min` to surface as a close marker. **Accept this as Phase 6's design tradeoff: "never miss a crash" beats "detect instantly."** The close marker fires eventually with `close_reason='idle_timeout'` and metadata indicating PID was dead at decision time. Future readers (Phase 7, future v6+ milestones) should not expect sub-30-min crash detection from this substrate. If real-time crash detection ever matters (it doesn't for v5's substrate-only scope), it's a future-milestone problem; the substrate emitted by Phase 6 supports tighter detection upgrades later.

### Telemetry surfaces

Single-row telemetry writes (queryable via existing `telemetry` table):

- `event_kind='episode_close_emitted'` — every successful close (one per close).
- `event_kind='episode_reopen'` — every re-open within `T_reopen`.
- `event_kind='episode_reopen_anomaly'` — JSONL write past `T_reopen` against terminated session.
- `event_kind='close_aborted_stale_check_failed'` — Session-Amnesia guard fired (heartbeat or JSONL went fresh between detection and cleanup).
- `event_kind='boundary_cursor_replay'` — Angel restart resumed from cursor (one per session resumed).
- `event_kind='jsonl_watcher_unreachable'` — chokidar watcher emitted error / failed to bind. Plan-phase decides retry policy.

Plan-phase pins exact `detail` JSON shape per event_kind.

### Claude's Discretion (open for plan-phase)

- **Exact PID-liveness mechanism on Windows** — `process.kill(pid, 0)` is cross-platform but Windows differs from POSIX in ESRCH semantics. Plan-phase decides: cross-platform `process.kill(pid, 0)` with try/catch on EPERM/ESRCH, vs `tasklist` shell-out, vs a cross-platform npm helper.
- **Exact column types/defaults for `sessions` additions** — INTEGER NULL vs INTEGER DEFAULT 0; CHECK constraint shape if any.
- **Exact debounce window for chokidar event coalescing** — engineering doc references ~200ms ballpark; plan-phase confirms / overrides.
- **Watcher recovery policy** — on chokidar error event, retry with exponential backoff vs hard-restart Angel. Plan-phase pins.
- **`detail` JSON schema for each `event_kind`** — CONTEXT lists the kinds; plan-phase pins fields.
- **Whether `episode_closed` env event should also UPDATE `sessions.status='terminated'`** — sessions table already has a `status` column; consistency vs source-of-truth question. Plan-phase decides; CONTEXT does not pre-empt.

</decisions>

<specifics>
## Specific Ideas

- **Reuse, don't replace.** `getIdleSessions` in `src/angel/session-monitor.ts:25` already operates session-level with idle-threshold logic and 10-row bound. Phase 6's boundary detector should extend this pattern, not duplicate it. The new composition rule is a richer predicate over the same shape — same SELECT joins (`sessions LEFT JOIN observations`), same `LIMIT` discipline, new `last_heartbeat_ts` / `last_jsonl_write_ts` columns added to the predicate.
- **Reuse `writeEnvironmentalEvent`.** Phase 1 already shipped this helper in `src/core/episodic-events.ts` for environmental events with `provenance='environmental'`. Phase 6's `episode_closed` and `re_opened` rows are environmental events; they go through the same helper. No new write surface.
- **Reuse Angel tick cadence.** The 2-minute `heartbeatIntervalMs` (existing `src/angel/types.ts:136`) is the natural sweep cadence — no new timer, no new process. The boundary detector hooks into the existing heartbeat tick path.
- **Heartbeat hooks already exist for some events.** Phase 4 instrumented PostToolUse + session-start + session-end + Angel heartbeat against `episodic_events`. UserPromptSubmit / PreToolUse should be audited during plan-phase to confirm they update `last_heartbeat_ts`. If a hook is missing, it gets added; if a hook exists, the column update is one extra UPDATE next to existing logic.
- **The "session_id is owned by Claude Code" invariant** is load-bearing for re-open semantics. We don't synthesize session_ids; we observe them. This keeps the substrate clean — every row in `episodic_events`, `sessions`, `episode_boundary_cursor` is keyed off an externally-allocated id we just track.
- **Phase 1's `writeEnvironmentalEvent` writes provenance='environmental'**, which by the V25 CHECK constraint is structurally distinct from `organic` content. Reading future projections with `WHERE provenance='environmental'` cleanly partitions Angel-emitted boundary markers from agent-emitted episodic events. The Mem0 trap impossibility property (Phase 1's load-bearing claim) extends naturally to Phase 6's emissions.

</specifics>

<deferred>
## Deferred Ideas

- **Sub-session episode segmentation by detected transitions** (commit, deploy, `/endsession`, idle-shift). The L120 event-sourcing flag — "maybe a 6-hour session is two episodes" — is real, but acting on it requires either a heuristic for "transition" (untested at our scale) or new substrate (intent classifier, thread state). Either way it's additive over the substrate Phase 6 ships, not a substrate change. Future v6+ milestone owns this if it ever matters.
- **Real-time crash detection** (sub-30-min). Possible future enhancement: PID-watch via OS APIs (e.g., process exit hooks, `ETW` on Windows, `kqueue`/`inotify` on POSIX) emits `pid_dead` immediately on process death rather than waiting for `T_jsonl + T_grace`. Out of scope for v5 substrate-only; not blocking.
- **Conservative post-hoc synthesizer at episode close** (engineering doc's "v5.3 — Post-hoc synthesizer (degraded)"). Future v6+ may add. Phase 6 emits the trigger marker; consumer is downstream. Re-introducing in v5 violates the post-reframe substrate-only discipline.
- **Cross-project boundary detection** (open question #4 in engineering doc). Phase 6 is per-`(project, session_id)`. Cross-project recall scope is a future-milestone privacy/UX question, not a Phase 6 question.
- **Hard FK on `last_close_event_id`** in `episode_boundary_cursor`. Soft reference now; promote to FK with `ON DELETE SET NULL` if/when Phase 7 retirement work enables `PRAGMA foreign_keys = ON` project-wide.
- **Promotion of `experience_warning_triggers` reader surface** to consume `episode_closed` markers. Phase 7 territory; not blocking Phase 6.

</deferred>

<artifacts>
## Reference Artifacts (for plan-phase + research-phase)

- ROADMAP.md L81-83 — Phase 6 entry (canonical phase definition)
- `.planning/research/2026-04-30-v5-episodic-memory.md` L97-103, L136 — engineering-doc Recommendation #1, the load-bearing source for this phase's design
- `.planning/research/2026-04-30-v5-episodic-memory.md` L84-95 — Claude Code SessionEnd hook reliability dossier (issue numbers cited inline above)
- `.planning/research/2026-05-04-v5-bound-episodes-framing.md` — cognitive frame; episode-as-binding-unit
- `.planning/reframes/2026-05-05-multi-handle-kill.md` — substrate-only milestone discipline
- `.planning/phases/01-episode-substrate/01-04-substrate-readme.md` — `episodic_events` substrate operator README; `writeEnvironmentalEvent` is documented here
- `src/core/episodic-events.ts` — Phase 1 helpers (the write path Phase 6 reuses)
- `src/angel/session-monitor.ts:25` — existing `getIdleSessions` implementation (the pattern Phase 6 extends)
- `src/angel/types.ts:136-137` — `heartbeatIntervalMs` and `idleThresholdSeconds` defaults Phase 6 reuses
- `src/angel/heartbeat.ts:165` — existing heartbeat-tick call into `getIdleSessions` (the integration point)
- `package.json` — dependencies; chokidar add lands here

</artifacts>

---

*Phase: 06-crash-resilient-episode-boundary*
*Context gathered: 2026-05-05*
