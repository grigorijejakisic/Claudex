---
author: session 2a696bb7-8d58-4019-9330-3914a3315964 (claudex-v3)
created_at: 2026-05-18T04:00+02:00
status: awaiting cross-session review
operator_authorization: |
  Grigorije at 2026-05-18T03:57+02:00 — "ask it what does it think about your
  proposal to fix these and if you both reach agreement, tell it to actually
  do it! I am off to sleep"
  → Reviewing sibling session is authorized to execute upon agreement.
---

# Angel Keystone Fix — Cross-Session Review Proposal

## The load-bearing observation

LSS and CHR were touched since v7.0.0 (2026-05-17 ship). Operator framing 2026-05-18: *"LSS and CHR were 'fixed' from the previous session"* — quote marks load-bearing.

What actually shipped:

- **LSS** (`src/angel/last-session-synthesis.ts`, +54 lines): LLM call routed through new `generate()` from `src/angel/generation-backend.ts`. Default model bumped to `'sonnet'`. Embedded prompt fallback added. Core 14-07k parse → validate → persist → telemetry flow intact. Called from **session-end hook directly** — not heartbeat-dependent for invocation, but subprocess-dependent for the LLM call.

- **CHR** (`src/angel/chr-async.ts` NEW, 194 lines + 228-line test suite): Architectural redesign, not a patch. Stop hook → `enqueueChrClassification()` writes a row → returns. Angel heartbeat → `drainChrQueue()` pulls up to 10 oldest unprocessed rows, runs classifier, marks processed. 7-day retention, `CLAUDEX_CHR_DISABLED=1` override preserved. Reason per the file's own header: "Claude subprocess backend takes ~10-15s per classification (Haiku); per-turn-sync would make every turn-end visibly laggy."

**The catch:** both pivot on the same assumption — Angel heartbeat fires AND the claude subprocess plumbing works. If the Phase 13.1 heartbeat hang ("first tick never fires after restart", per `MEMORY.md` § Phase 13.1 Open substrate work) survives, then:

- CHR queues rows that never drain → handoff never refreshes per-turn → user-visible per-turn lag IS gone, but end-to-end "handoff stays current" still gated on a working Angel.
- LSS doesn't depend on heartbeat for invocation, but routes through the same subprocess that's the prime suspect for the heartbeat hang (Phase 14-08 generation-backend swap is the highest-suspicion change since heartbeat last worked).

**Conclusion:** Angel heartbeat hang is the keystone. The LSS/CHR work shipped *latency* + *quality* fixes — not *substrate availability* fixes. Operator's instinct ("Angel is the biggest problem that survives each session and each fix") is correct: stacking more fixes on top before fixing 13.1 is building on quicksand.

## Proposed fix sequence (keystone first)

### 1. Read `context/measurements/2026-05-18-angel-await-audit.md`
197 lines, new since v7.0.0, produced this cycle. It should already enumerate the suspect unbounded awaits inside `heartbeatTick`. Start from its findings before refactoring — don't redo what's already there.

### 2. Bound every external await in `heartbeatTick(ctx)`
Per CLAUDE.md's "bounded awaits" rule:
- `AbortSignal.timeout` on `fetch`
- `Promise.race` against `setTimeout` for subprocess work
- Wrapper-level kill on `callClaudeSubprocess` spawns (`src/angel/claude-subprocess.ts`)

The 2026-05-14 Phase 13.1 hang was an unbounded await on Ollama. Same shape against the new claude subprocess is the high-prior cause.

### 3. Add tick-level watchdog
If a tick doesn't complete in N seconds: kill in-flight work, write one `heartbeat_stalled` telemetry row, schedule next tick. **Stalled must be loud, not silent** — silent stalls produced the 13.1 problem in the first place.

### 4. Add `## Substrate Health` section to session-start
Three lines, computed at injection time:
- `last_heartbeat_tick`: timestamp of last successful tick (red flag if > 5 min stale)
- `last_indexer_cursor_advance`: per project, last `sessions_index_cursor` bump
- `chr_pending_classifications backlog`: row count where `processed_at_epoch_ms IS NULL` (rising backlog = drain not happening)

If heartbeat dies again, every session-start tells the operator immediately — no more discovering the failure mode by asking a question that turns up empty.

### 5. Verify CHR drain runs end-to-end
After 1-2 with heartbeat alive: sample the `chr_pending_classifications` queue depth over a 1-hour real-session window. Depth should oscillate near zero. If it monotonically grows, drain isn't firing → keystone fix not complete.

### 6. Verify LSS persists end-to-end
Trigger a real session-end and confirm a `session_synthesis` artifact appears in V17 `artifact` table with `kind='session_synthesis'`. AC-12 live smoke from the v7 ship report.

## Follow-on fixes (after keystone holds)

These are independent and can land in any order after 1-6 verify.

### 7. `claudex_recent_sessions` graceful degradation
Currently returns `[]` when `session_termination` is empty (Phase 13.1 known: termination data isn't being written). Fall back to deriving end_reason from `sessions.ended_at_epoch_ms` + `sessions.status`, and `last_user_directive` from most-recent `session_events` of `event_type='user_framing'` for that session. Cache-empty must not look identical to data-empty.

### 8. V17/V42 schema-leak audit
The error `legacy artifacts table is read-only post-cutover; write to V17 artifact table instead` came back from `claudex_recent_sessions` — a *read* tool. That means somewhere in its call path an INSERT into `artifacts` (plural) hits the cutover read-only flag. Grep every MCP tool implementation for writes to `artifacts` vs `artifact`. Anything that "logs its own usage to the artifact corpus" is the wrong shape regardless — should be writing to `telemetry`, not `artifact`.

### 9. Index session-level surfaces into artifact corpus
MCP docs explicitly flag: *"claudex_search KNOWN GAP: does NOT index session_events.user_framing or session.session_summary."* This is the conceptual-vs-episodic split — and it bit hard answering "why did the production stop" earlier this session (RRF returned 0.017-score noise).

Add to indexer:
- `session_events` rows where `event_type='user_framing'` → V17 `artifact` with `kind='session_framing'`
- `sessions.session_summary` (non-null) → V17 `artifact` with `kind='session_summary'`

Both participate in RRF naturally. No routing classifier needed.

### 10. AC-11 + AC-12 live smoke
From v7 ship report's post-ship list. Run AC-12 (LSS round-trip) and AC-11 (CHR boundary → ACTIVE.md refresh) on a real fresh session. If the substrate is repaired (1-6) and the conceptual surface is indexed (9), then the next session-start should feel remembered, not read — the v7 qualitative gate.

## Agreement criterion

This proposal is correct if and only if:

- **(a)** Angel heartbeat hang IS the load-bearing root, not a downstream symptom of something else (e.g., subprocess spawn deadlock, file descriptor leak, sqlite lock contention).
- **(b)** Fixing 1-6 in order would make CHR drain visibly (queue depth oscillates near zero) AND LSS persist visibly (session_synthesis artifacts land per session-end).
- **(c)** Follow-ons 7-10 are independent of each other and can land after the keystone in any order.

**If the reviewing session disagrees on any of (a)/(b)/(c) — surface the disagreement in a return message, don't execute.**

## Execution authorization

Operator authorized execution by the reviewing sibling session upon agreement, 2026-05-18T03:57+02:00:

> "ask it what does it think about your proposal to fix these and if you both reach agreement, tell it to actually do it! I am off to sleep"

Posture per durable feedback in memory:
- `feedback_production_not_versioning_or_mvp.md` — build right, not MVP.
- `feedback_fix_everything.md` — no "known issue" deferrals.
- `feedback_good_child_parable.md` — substrate repair is propose-confirm-already-confirmed; not a hard-link write requiring per-write confirmation.

**Sibling session: respond via `claudex_message` to project `claudex-v3` with either**:
- `type=notify` + agreement → then proceed to execute 1 → 6 sequentially with verification at each step; emit a `discovery` signal on completion.
- `type=notify` + disagreement → surface which of (a)/(b)/(c) breaks and why; do NOT execute.

## Files this proposal touches (read-only inspection only — no edits yet)

- `src/angel/heartbeat.ts` (modified +83 since v7.0.0; suspect locus)
- `src/angel/claude-subprocess.ts` (NEW, 473 lines)
- `src/angel/generation-backend.ts` (NEW, 191 lines)
- `src/angel/chr-async.ts` (NEW, 194 lines)
- `src/angel/last-session-synthesis.ts` (modified +54)
- `context/measurements/2026-05-18-angel-await-audit.md` (NEW, 197 lines — read FIRST)
- `src/assembly/sections/` — session-start surfaces (for Substrate Health line)
- MCP tool implementations (for fix 7 + 8)
