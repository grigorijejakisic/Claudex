---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: 07l
type: execute
wave: 3
depends_on: ["07a", "07d"]
files_modified:
  - src/angel/handoff-decision-watcher.ts (NEW)
  - src/angel/handoff-writer.ts (extend with recordDecisionShift)
  - src/adapters/cc-hooks/stop.ts (trigger decision-shift detection per turn)
  - src/intelligence/directive-detector.ts (extend for decision-boundary classification — additive)
  - src/tests/angel/handoff-decision-watcher.test.ts (NEW)
  - src/tests/angel/handoff-writer-decision-shift.test.ts (NEW)
  - src/tests/integration/continuous-handoff.test.ts (NEW)
autonomous: true
operator_review_gate: false
requirements: []

must_haves:
  truths:
    - "Continuous Handoff Refresh (CHR) updates `ACTIVE.md` on decision-boundary events instead of session-end-only. The failure this fixes: PC died mid-session 2026-05-16; `ACTIVE.md` was frozen at the 18:13 Option-B-confirmed state; the 18:44 Option-A pivot was never recorded; next-session agent (2026-05-17) trusted a stale snapshot. CHR makes the handoff reflect the LATEST operator position in near-real-time."
    - "Decision-boundary detection is LLM-classified per user-assistant turn via `callLocalLLM` (Ollama — hook-safe). Classifier output: `{ is_decision_boundary: bool, boundary_type: 'operator_pivot' | 'operator_confirm' | 'agent_position' | 'spec_change' | null, summary: string|null, confidence: 0-1 }`. Classification is per-turn; cheap LLM call (target ≤ 2s typical)."
    - "Detection trigger: the `stop` CC hook (fires at end of each agent turn). Throttle: at most one boundary-detection LLM call per stop event. Skip when no user message exists in the turn (agent-only turns are not decision boundaries by definition)."
    - "Boundary classification builds on `src/intelligence/directive-detector.ts` (existing). The detector is extended (NOT replaced) with a `classifyDecisionBoundary` helper that adds the boundary-type taxonomy on top of the existing directive shape. Existing directive-detector consumers are untouched."
    - "Handoff update path: `handoff-writer.ts` gains `recordDecisionShift({ db, project, boundary_type, summary, source_turn_uuid })`. This re-renders the `ACTIVE.md` body's `What we decided` + `What's next` sections with the new boundary appended. The header's `created_at_epoch_ms` is preserved (this is a *refresh*, not a new handoff); a new `last_refresh_epoch_ms` field is added to the header for observability."
    - "Atomic write semantics: existing `tmp + rename` pattern in handoff-writer is preserved. CHR re-renders the FULL `ACTIVE.md` from current state; partial writes are impossible. If the hook fails mid-render, `ACTIVE.md` is unchanged on disk."
    - "Throttle: at most one `recordDecisionShift` per minute per session. Multiple boundary signals within the throttle window are coalesced into a single update with the most-recent summary. Throttle state lives in-memory per Angel process; persists across CC sessions via `handoff_refresh_state` table (small)."
    - "Decision-boundary emission also writes a `supersedes` soft-link in the link graph (integrates with 14-07d's soft-link writers). Each refresh links the new ACTIVE.md state to the prior state. This makes the handoff's edit history traversable as a soft-link chain — no information lost between refreshes."
    - "Confidence floor: boundary detection with `confidence < 0.5` is logged via telemetry but does NOT trigger a handoff refresh. ≥ 0.5 = autonomous refresh per soft-link Good Child policy (handoff is observed-state recording, not a load-bearing decision). ≥ 0.85 = high-confidence; emits a session message to the operator indicating the handoff was refreshed."
    - "Crash-resilience: handoff state is on disk after every refresh. If the PC dies mid-session, the most-recent refresh is the handoff. The pre-pivot stale state cannot persist past one decision boundary."
    - "Telemetry: every detection emits `event_kind='chr_boundary_detected'` with `detail.{is_boundary, boundary_type, confidence, summary, throttled, refreshed}`. Operator can audit refresh frequency + accuracy via the telemetry table."
    - "Operator override: env var `CLAUDEX_CHR_DISABLED=1` disables CHR entirely (falls back to session-end-only). Useful for debugging or if the LLM classifier proves noisy in early production."
  artifacts:
    - path: "src/angel/handoff-decision-watcher.ts"
      provides: "Per-turn boundary detection. `classifyTurnAsDecisionBoundary(turnText, db, ctx)` calls LLM + applies throttle + emits telemetry + invokes `recordDecisionShift` when warranted."
      contains: "classifyTurnAsDecisionBoundary|loadBoundaryPrompt|applyThrottle|maybeRefreshHandoff"
    - path: "src/angel/handoff-writer.ts"
      provides: "Existing handoff writer; extended with `recordDecisionShift({ db, project, boundary_type, summary, source_turn_uuid })`. Existing `writeHandoff` contract unchanged. Header schema extended with `last_refresh_epoch_ms` field (optional; backward-compatible)."
      contains: "recordDecisionShift|HandoffHeader.last_refresh_epoch_ms"
    - path: "src/intelligence/directive-detector.ts"
      provides: "Existing directive detector; extended with `classifyDecisionBoundary(text): BoundaryClassification` (additive — does not modify existing exports)."
      contains: "classifyDecisionBoundary|BoundaryClassification"
    - path: "src/adapters/cc-hooks/stop.ts"
      provides: "Existing stop hook; extended to call `classifyTurnAsDecisionBoundary` for the just-completed turn. Non-blocking on failure."
      contains: "classifyTurnAsDecisionBoundary"
    - path: "src/angel/prompts/decision-boundary-classifier-v1.md"
      provides: "Versioned LLM prompt for boundary classification with few-shot examples."
      contains: "is_decision_boundary|boundary_type|operator_pivot|operator_confirm|agent_position|spec_change"
  key_links:
    - from: "src/adapters/cc-hooks/stop.ts"
      to: "src/angel/handoff-decision-watcher.ts (classifyTurnAsDecisionBoundary)"
      via: "Per-turn boundary detection invocation from stop hook"
      pattern: "classifyTurnAsDecisionBoundary"
    - from: "src/angel/handoff-decision-watcher.ts"
      to: "src/angel/handoff-writer.ts (recordDecisionShift)"
      via: "Boundary detected → handoff refresh"
      pattern: "recordDecisionShift"
    - from: "src/angel/handoff-decision-watcher.ts"
      to: "src/intelligence/directive-detector.ts (classifyDecisionBoundary)"
      via: "LLM-based boundary classification"
      pattern: "classifyDecisionBoundary"
    - from: "src/angel/handoff-writer.ts (recordDecisionShift)"
      to: "src/intelligence/soft-link-writers.ts (recordSupersedes) — from 14-07d"
      via: "Each refresh emits supersedes link to prior handoff state for chain-traversal"
      pattern: "recordSupersedes"
---

<objective>
Close the staleness gap in the handoff. Today: `ACTIVE.md` is written at session-end. If the PC dies mid-session, the last handoff is whatever-was-written-before-the-pivot. CHR makes the handoff refresh on decision boundaries — operator pivots, agent commits, spec changes — so the snapshot reflects reality at most one boundary stale.

**Before:** Handoff = session-end snapshot. Mid-session crash → stale handoff at next session start. The 2026-05-16 PC-death pattern reproduces forever.

**After:** Handoff = continuously refreshed snapshot. Mid-session crash → handoff reflects the most-recent boundary. The agent next-morning sees the operator's latest position, not the snapshot frozen four hours before death.

This plan exists because of the exact failure mode observed 2026-05-17 morning: yesterday's session pivoted from Option B (18:13) to leaning Option A (18:44); PC died; handoff was frozen at 18:13; today's agent walked toward Option B until the operator corrected. CHR fixes this class.

| What this plan provides | Why |
|---|---|
| Per-turn boundary detection | Pivots get recorded near-real-time |
| LLM-classified boundary types | operator_pivot vs operator_confirm vs agent_position — context preserved |
| Throttled refresh | At most 1 update/min/session — no churn |
| Atomic ACTIVE.md write | Crash mid-render leaves prior state intact |
| Supersedes soft-link chain | Edit history traversable via 14-07d's link graph |
| Confidence-gated autonomy | < 0.5 logs but no refresh; ≥ 0.85 notifies operator |
| Operator disable env | `CLAUDEX_CHR_DISABLED=1` for debugging |
| Crash-resilient by design | Disk state is canonical after every boundary |
</objective>

<execution_context>
@C:/Users/Grigorije/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/Grigorije/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/14-substrate-coherence/14-07-CONTEXT.md
@.planning/phases/14-substrate-coherence/14-07-WAVE3-COORDINATION.md
@.planning/phases/14-substrate-coherence/14-07d-PLAN.md
@.planning/phases/14-substrate-coherence/14-07-VERIFICATION-PASS.md
@src/angel/handoff-writer.ts
@src/intelligence/directive-detector.ts
@src/adapters/cc-hooks/stop.ts
@src/angel/llama-client.ts
@~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/project_v7_hard_link_writer_is_good_child.md
@~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/feedback_production_not_versioning_or_mvp.md
</context>

<anti_scope>
- Do NOT replace `writeHandoff` — CHR adds `recordDecisionShift` alongside the existing session-end path
- Do NOT modify the handoff body format / locked-order sections — CHR re-renders to the same template
- Do NOT change `directive-detector`'s existing exports — only add `classifyDecisionBoundary` as additive surface
- Do NOT block the stop hook on CHR — failure is non-blocking with telemetry
- Do NOT use cloud LLM in the stop hook — Ollama per hook-deadlock rule
- Do NOT introduce a separate handoff file format — `ACTIVE.md` remains the single source
- Do NOT skip the throttle — refresh-spam from rapid turns is a real risk; throttle is load-bearing
- Do NOT bypass V17 artifact substrate — handoff is already a V17 artifact post-Wave-1; CHR refreshes via the same path
- Do NOT modify the synthesis section (14-07k owns LSS render) — CHR is orthogonal
- Do NOT add hard-link proposals — soft-link supersedes only (Good Child autonomous tier)
- Do NOT redesign decision-boundary taxonomy mid-execution — the 4 boundary_types are locked
</anti_scope>

<tasks>

<task type="auto">
  <name>Task 1: Extend directive-detector with classifyDecisionBoundary</name>
  <files>src/intelligence/directive-detector.ts</files>
  <action>
Add additive helper for boundary classification. Existing directive-detector surface unchanged.

```typescript
export type BoundaryType = 'operator_pivot' | 'operator_confirm' | 'agent_position' | 'spec_change';

export interface BoundaryClassification {
  is_decision_boundary: boolean;
  boundary_type: BoundaryType | null;
  summary: string | null;          // one-sentence; null if not a boundary
  confidence: number;               // 0-1
  prompt_version: string;
  llm_model: string;
}

export interface ClassifyBoundaryOpts {
  user_text: string | null;        // null = agent-only turn (skip)
  assistant_text: string;
  prompt_version?: string;         // default 'v1'
  llm_model?: string;              // default env or 'llama3.1:8b'
  signal: AbortSignal;             // for timeout
}

export async function classifyDecisionBoundary(
  opts: ClassifyBoundaryOpts,
): Promise<BoundaryClassification | null>;
```

Implementation:
- If `user_text` is null (agent-only turn) → return `{ is_decision_boundary: false, boundary_type: null, summary: null, confidence: 1.0, ...}` (cheap skip)
- Load `src/angel/prompts/decision-boundary-classifier-v1.md`
- Substitute `{user_text}` + `{assistant_text}` placeholders
- Call `callLocalLLM({ prompt, model, format: 'json', max_tokens: 256, timeout_ms: 5_000 })`
- Parse + validate output; return null on parse failure (caller emits telemetry)
- Non-throwing; AbortSignal honored
  </action>
  <verification>
- Agent-only turn → returns non-boundary with confidence 1.0 (no LLM call)
- User-assistant turn with operator pivot → classified as `operator_pivot` with summary
- User-assistant turn with casual "ok" → classified as not-a-boundary
- LLM unreachable → returns null (caller telemetry)
- Malformed LLM output → returns null
- AbortSignal aborts the LLM call within timeout
- Existing directive-detector tests still pass (additive change)
  </verification>
</task>

<task type="auto">
  <name>Task 2: Versioned classifier prompt src/angel/prompts/decision-boundary-classifier-v1.md</name>
  <files>src/angel/prompts/decision-boundary-classifier-v1.md</files>
  <action>
Versioned prompt template with few-shot examples.

```markdown
# Decision-Boundary Classifier v1

You read one user-assistant exchange and decide whether it is a DECISION BOUNDARY worth recording in the handoff document.

Output STRICT JSON only:

{
  "is_decision_boundary": <bool>,
  "boundary_type": "operator_pivot" | "operator_confirm" | "agent_position" | "spec_change" | null,
  "summary": "<one short sentence | null>",
  "confidence": <0.0-1.0>
}

## Boundary types

- **operator_pivot**: operator changed direction. Example: "actually let's go with /team instead"
- **operator_confirm**: operator explicitly approved/committed to a path. Example: "yes, do it", "yes go with the team"
- **agent_position**: agent took a substantive stance with reasoning. Example: "My pick: Option A. Here's why honestly..."
- **spec_change**: spec doc was modified, scope was added/removed, requirements changed

## NOT boundaries (false-positive guard)

- Tool-call narration ("Reading file X", "Running build")
- Casual acknowledgments ("ok", "thanks", "got it")
- Information lookups (operator asks a factual question that doesn't change direction)
- Routine status updates (no decision encoded)

## Few-shot examples

Example A:
user_text: "than option A, lets go with the team - we have to ship this ASAP!"
assistant_text: "Going with /team. Per the skill's hard gate I need to state the deployment plan..."

Output:
{
  "is_decision_boundary": true,
  "boundary_type": "operator_confirm",
  "summary": "Operator committed to Option A (/team dispatch) — ship ASAP",
  "confidence": 0.92
}

Example B:
user_text: "what's the test count?"
assistant_text: "27/28 passing per the diagnostic."

Output:
{
  "is_decision_boundary": false,
  "boundary_type": null,
  "summary": null,
  "confidence": 0.95
}

Example C:
user_text: "we should not use /auto-orchestrate for this"
assistant_text: "Agreed — /team is the better fit because [...]"

Output:
{
  "is_decision_boundary": true,
  "boundary_type": "operator_pivot",
  "summary": "Operator pivoted away from /auto-orchestrate toward /team",
  "confidence": 0.90
}

## Exchange

USER: {user_text}

ASSISTANT: {assistant_text}
```
  </action>
  <verification>
- File exists at version-pinned path
- Placeholders present
- Few-shot examples cover all 4 boundary types + a non-boundary
- Schema matches the TypeScript `BoundaryClassification` interface
  </verification>
</task>

<task type="auto">
  <name>Task 3: Decision-watcher orchestration src/angel/handoff-decision-watcher.ts</name>
  <files>src/angel/handoff-decision-watcher.ts</files>
  <action>
Create the watcher orchestration module.

```typescript
import type { Database } from 'better-sqlite3';
import { classifyDecisionBoundary } from '../intelligence/directive-detector.js';
import { recordDecisionShift } from './handoff-writer.js';
import { emitTelemetry } from '../observability/telemetry.js';

export interface WatcherContext {
  db: Database;
  project: string;
  session_id: string;
  user_text: string | null;
  assistant_text: string;
  source_turn_uuid: string;
}

/**
 * Phase 14-07l — per-turn boundary detection.
 * Called from stop hook. Non-blocking; throttled.
 */
export async function classifyTurnAsDecisionBoundary(
  ctx: WatcherContext,
): Promise<{ refreshed: boolean; throttled: boolean; boundary_type: string | null }>;
```

Implementation flow:
1. If CHR disabled via env (`CLAUDEX_CHR_DISABLED=1`): return `{ refreshed: false, throttled: false, boundary_type: null }` immediately
2. Check throttle (`handoff_refresh_state` table; key = session_id; cooldown = 60s)
3. If throttled: skip LLM call; emit telemetry `chr_throttled` (low-rate); return
4. Call `classifyDecisionBoundary({ user_text, assistant_text, signal })`
5. If null (LLM failure) → telemetry `chr_classify_failed`; return non-refresh
6. If not a boundary OR confidence < 0.5 → telemetry `chr_no_boundary`; return non-refresh
7. Boundary detected with confidence ≥ 0.5:
   - Call `recordDecisionShift({ db, project, boundary_type, summary, source_turn_uuid })`
   - Update throttle state (set last_refresh_epoch_ms = now)
   - If confidence ≥ 0.85: emit a session message to the operator: "Handoff refreshed: [summary]"
   - Telemetry `chr_boundary_detected` with full detail
   - Return `{ refreshed: true, throttled: false, boundary_type }`
8. Non-throwing: catch all paths
  </action>
  <verification>
- CHR disabled env: returns immediately, no LLM call
- Throttled: skips LLM, emits telemetry
- Non-boundary: no refresh, telemetry chr_no_boundary
- Low-confidence boundary (0.3-0.5): no refresh, telemetry only
- High-confidence (≥ 0.5): refresh + telemetry chr_boundary_detected
- Very-high-confidence (≥ 0.85): also emits session message
- LLM failure: returns non-refresh; telemetry chr_classify_failed
- Concurrent invocations: throttle prevents double refresh
  </verification>
</task>

<task type="auto">
  <name>Task 4: handoff-writer recordDecisionShift</name>
  <files>src/angel/handoff-writer.ts</files>
  <action>
Add `recordDecisionShift` to handoff-writer. Existing `writeHandoff` unchanged; header schema gains optional `last_refresh_epoch_ms`.

```typescript
export interface RecordDecisionShiftParams {
  db: Database;
  project: string;
  boundary_type: 'operator_pivot' | 'operator_confirm' | 'agent_position' | 'spec_change';
  summary: string;
  source_turn_uuid: string;
}

/**
 * Refresh the active ACTIVE.md handoff with a new decision-boundary entry.
 *
 * Reads current ACTIVE.md state; appends/updates the relevant section
 * (`What we decided` for operator_confirm/agent_position; `What's next` for
 * operator_pivot/spec_change); re-renders the full body; atomically writes
 * via tmp+rename.
 *
 * Emits a supersedes soft-link from the new handoff state to the prior
 * state (via 14-07d's recordSupersedes — both handoff states are V17
 * artifacts post-Wave-1).
 *
 * Header `last_refresh_epoch_ms` is updated. `created_at_epoch_ms` is
 * preserved (this is a refresh, not a new handoff).
 *
 * Idempotent within throttle window — coalesces multiple boundaries.
 */
export function recordDecisionShift(
  p: RecordDecisionShiftParams,
): { refreshed: boolean; new_artifact_id: string; prior_artifact_id: string | null };
```

Also extend `HandoffHeader` interface with optional `last_refresh_epoch_ms?: number` (backward-compatible — old handoffs without this field render unchanged).

Section update logic:
- `operator_pivot` / `spec_change` → append to `What's next` (these change forward direction)
- `operator_confirm` / `agent_position` → append to `What we decided` (these record committed state)

Each appended line:
```
- [<ISO timestamp>] [<boundary_type>] <summary>
```

Atomic write: render full body string → write to `ACTIVE.md.tmp` → rename to `ACTIVE.md`. Existing handoff-writer atomic-write helper is reused.
  </action>
  <verification>
- recordDecisionShift updates ACTIVE.md atomically
- Header `last_refresh_epoch_ms` is set
- `created_at_epoch_ms` is preserved
- Boundary appended to the correct section per type
- Prior ACTIVE.md state is preserved on render failure (atomicity)
- supersedes soft-link emitted (via 14-07d's recordSupersedes)
- New V17 artifact created for the refreshed state (handoff is V17 post-Wave-1)
- Idempotent: re-running with same source_turn_uuid does not duplicate the line
  </verification>
</task>

<task type="auto">
  <name>Task 5: Stop hook integration src/adapters/cc-hooks/stop.ts</name>
  <files>src/adapters/cc-hooks/stop.ts</files>
  <action>
Extend the stop hook to call `classifyTurnAsDecisionBoundary` for the just-completed turn.

```typescript
// existing stop-hook flow ...

// 14-07l: CHR — classify the just-completed turn for decision-boundary
try {
  const { user_text, assistant_text, source_turn_uuid } = extractTurnContent(payload);
  await classifyTurnAsDecisionBoundary({
    db,
    project,
    session_id: sessionId,
    user_text,
    assistant_text,
    source_turn_uuid,
  });
} catch {
  // classifyTurnAsDecisionBoundary is itself non-throwing; defensive guard only
}
```

`extractTurnContent(payload)` parses the stop-hook payload to retrieve the user message (if any) and assistant message text from the just-completed turn. Returns `{ user_text: null, ... }` when agent-only.

The hook must complete within its existing latency budget; the LLM call has its own 5s timeout.
  </action>
  <verification>
- Stop hook awaits CHR but doesn't fail on CHR error
- Agent-only turn: CHR skips LLM (cheap path)
- User-assistant turn with boundary: ACTIVE.md updated; soft-link emitted
- Hook latency increase ≤ ~5s typical when boundary detection runs
- When Ollama down: hook completes; telemetry chr_classify_failed
  </verification>
</task>

<task type="auto">
  <name>Task 6: handoff_refresh_state table + state helpers</name>
  <files>src/angel/handoff-decision-watcher.ts (state helpers), src/core/migration-steps.ts (table DDL for V37+)</files>
  <action>
Create a small state table for throttle tracking.

DDL (added to V37+ migration alongside 14-07a's V17 substrate — coordinate with 14-07a worker if not yet present):

```sql
CREATE TABLE IF NOT EXISTS handoff_refresh_state (
  session_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  last_refresh_epoch_ms INTEGER NOT NULL,
  refresh_count INTEGER NOT NULL DEFAULT 0,
  updated_at_epoch_ms INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
CREATE INDEX IF NOT EXISTS idx_handoff_refresh_session ON handoff_refresh_state(session_id);
```

State helpers in `handoff-decision-watcher.ts`:
```typescript
function getThrottleState(db: Database, sessionId: string): { last_refresh_epoch_ms: number; refresh_count: number } | null;
function updateThrottleState(db: Database, sessionId: string, project: string): void;
function isThrottled(db: Database, sessionId: string, cooldown_ms = 60_000): boolean;
```

Note: If 14-07a's V37 migration is already shipped without this table, add it via a follow-on migration step (V38) coordinated with this plan's dispatch. PM resolves which migration version owns the table.
  </action>
  <verification>
- handoff_refresh_state table created (migration idempotent)
- isThrottled returns true within 60s of last refresh
- updateThrottleState upserts correctly
- Index used for session_id lookup (verified via EXPLAIN)
  </verification>
</task>

<task type="auto">
  <name>Task 7: Tests across watcher + writer + integration</name>
  <files>src/tests/angel/handoff-decision-watcher.test.ts, src/tests/angel/handoff-writer-decision-shift.test.ts, src/tests/integration/continuous-handoff.test.ts</files>
  <action>
**`handoff-decision-watcher.test.ts`** — orchestration tests (mocked LLM):
1. `CLAUDEX_CHR_DISABLED=1: returns immediately, no LLM call`
2. `Agent-only turn: skips LLM, returns non-refresh`
3. `User-assistant turn → high-confidence boundary → refresh + telemetry`
4. `Low-confidence boundary (< 0.5): no refresh, telemetry only`
5. `Very-high-confidence (≥ 0.85): refresh + session message emitted`
6. `Throttle: second call within 60s skipped, telemetry chr_throttled`
7. `LLM failure: returns non-refresh, telemetry chr_classify_failed`
8. `Non-throwing on every cascading failure path`

**`handoff-writer-decision-shift.test.ts`** — writer-level tests:
1. `recordDecisionShift: updates ACTIVE.md atomically`
2. `Boundary type routing: operator_pivot → What's next section`
3. `Boundary type routing: operator_confirm → What we decided section`
4. `last_refresh_epoch_ms set; created_at_epoch_ms preserved`
5. `Idempotent on same source_turn_uuid (no duplicate line)`
6. `Prior state preserved on render failure`
7. `supersedes soft-link emitted via recordSupersedes`
8. `New V17 artifact created for refreshed state`

**`continuous-handoff.test.ts`** — integration tests:
1. `Full flow: stop hook → boundary detected → ACTIVE.md updated → soft-link in graph`
2. `Crash-resilience: simulate process kill between detect and write → ACTIVE.md unchanged`
3. `Multi-turn session: only boundary turns trigger refresh; agent-only / non-boundary don't`
4. `Refresh chain: 3 refreshes produce 3 supersedes links forming a chain`
5. `Cross-project: project A's CHR doesn't refresh project B's handoff`
6. `Operator-disable env: CHR completely off for entire session`
  </action>
  <verification>
- All ~20+ tests pass
- LLM mocked via DI (no real Ollama)
- DB fixtures isolated per test
- Integration tests cover the realistic stop-hook flow
  </verification>
</task>

<task type="auto">
  <name>Task 8: Build + test sweep + /verify + live integration smoke</name>
  <files></files>
  <action>
- `bun run build` — must succeed
- `npx vitest run src/tests/angel/handoff-decision-watcher.test.ts src/tests/angel/handoff-writer-decision-shift.test.ts src/tests/integration/continuous-handoff.test.ts` — all pass
- `npx vitest run` — full suite green
- `bun run vesna` — SC#1 passes (CHR adds boundary detection per turn; should not regress vesna probes)
- Run `/verify` — capture diff, run tests on changed files, grep for assumed names (especially `recordDecisionShift`, `classifyDecisionBoundary`, `classifyTurnAsDecisionBoundary`, `handoff_refresh_state`)
- **Live integration smoke (operator-visible):** start a fresh test session; have a fixture user-message that simulates an operator pivot; verify within seconds: (a) ACTIVE.md updated with new boundary line in `What's next`, (b) telemetry row `chr_boundary_detected` with high confidence, (c) supersedes soft-link in soft_link table.
  </action>
  <verification>
- Build green
- All new tests pass; ~20+
- Full suite green; no regressions
- Vesna SC#1 ≥ Wave-1 baseline
- `/verify` shows N/N/0
- Live smoke confirms end-to-end CHR flow
  </verification>
</task>

</tasks>

<acceptance_criteria>
- AC-1: `classifyDecisionBoundary` returns `BoundaryClassification` for diverse turn shapes; correctly classifies all 4 boundary types + non-boundaries
- AC-2: `classifyTurnAsDecisionBoundary` orchestrates detection → throttle → refresh → telemetry correctly
- AC-3: `recordDecisionShift` updates `ACTIVE.md` atomically with header `last_refresh_epoch_ms`; preserves `created_at_epoch_ms`
- AC-4: Stop hook calls CHR non-blockingly; hook completes within latency budget on every path
- AC-5: Throttle (60s default) prevents excessive refresh
- AC-6: supersedes soft-link emitted per refresh (chain via 14-07d's recordSupersedes)
- AC-7: Confidence floor: < 0.5 logs only; ≥ 0.5 refreshes; ≥ 0.85 emits session message to operator
- AC-8: `CLAUDEX_CHR_DISABLED=1` cleanly disables all CHR behavior
- AC-9: `handoff_refresh_state` table exists with throttle helpers
- AC-10: All ~20+ tests pass; no regressions
- AC-11: Live integration smoke: pivot → ACTIVE.md updated → soft-link in graph
- AC-12: Build green; vesna SC#1 ≥ Wave-1 baseline
</acceptance_criteria>

<risks>
- **Risk 1: LLM classifier false-positives surge** (e.g., classifying every "ok" as operator_confirm). Mitigation: confidence floor at 0.5 + few-shot examples specifically guarding against routine acknowledgments. Operator-observable via `chr_no_boundary` vs `chr_boundary_detected` telemetry ratio.
- **Risk 2: Per-turn LLM call slows down every turn** (~2-5s added to stop hook). Mitigation: 5s timeout; non-blocking; throttle prevents back-to-back boundaries. If operator observes meaningful latency increase, escalation: move to a sampled / async path via Angel heartbeat (every Nth turn instead of every turn).
- **Risk 3: Throttle coalesces important boundaries** (rapid pivots within 60s lose detail). Mitigation: most-recent summary wins; lost-detail boundaries are captured in telemetry (`chr_throttled` with detail.summary) — operator can audit and adjust cooldown via env if needed.
- **Risk 4: ACTIVE.md grows unboundedly as boundaries accumulate**. Mitigation: 14-07l does NOT add a bound (boundaries are signal, not noise). If growth becomes operationally painful, a follow-on plan adds a rollover/archive policy (out of scope here).
- **Risk 5: Race between session-end writeHandoff and concurrent CHR refresh**. Mitigation: atomic tmp+rename in both paths; last-writer-wins on disk is acceptable (session-end will incorporate latest boundary anyway).
- **Risk 6: Operator finds CHR noisy in early production**. Mitigation: env disable (`CLAUDEX_CHR_DISABLED=1`) + confidence-≥-0.85 session-message gate (operator only notified for very high confidence). Tunable knobs documented.
- **Risk 7: Cross-project bleed (project A boundary updates project B's handoff)**. Mitigation: explicit project scoping in watcher + writer; integration test covers this.
- **Risk 8: 14-07d not yet landed when CHR ships in Wave 3** (supersedes soft-link dependency). Mitigation: depends_on contract — this plan does NOT dispatch until 14-07d's link substrate is in. Soft-link emission is non-optional from day one — no flat-file shim, per production posture.
- **Risk 9: handoff_refresh_state table conflicts with 14-07a's V37 migration ownership**. Mitigation: coordinate during dispatch — either 14-07a includes this table (preferred), or 14-07l adds it via V38 follow-on migration. PM resolves at wave entry.
</risks>

<external_review_gate>
Codex + Gemini cross-family review focuses on:
- (a) Classifier prompt fidelity — does the LLM reliably distinguish boundary types vs casual acknowledgments?
- (b) Non-blocking discipline — can any failure path block the stop hook?
- (c) Throttle correctness — does the throttle window cleanly prevent refresh-spam without losing important boundaries?
- (d) Atomicity — is the ACTIVE.md write actually atomic across all paths (verify tmp+rename usage)?
- (e) Cross-project scoping — is there any path where project A's boundary could update project B's handoff?
- (f) Confidence gating — is the ≥ 0.85 session-message threshold tuned correctly to not spam the operator?
- (g) supersedes chain integrity — can a refresh chain be traversed from any state back to its origin?

NO-SIGNOFF triggers PM escalation per WAVE3-COORDINATION's rules.
</external_review_gate>

<methodology_gates>
1. Pre-committed AC matrix above (this plan satisfies)
2. Tests written alongside code — ~20+ across watcher, writer, integration
3. Live-wiring smoke: AC-11 requires real stop-hook flow producing real ACTIVE.md updates
4. No "MVP" shortcuts — version-pinned prompt; LLM-driven classification (not regex shortcuts); atomic writes; soft-link integration from day one
5. Negative results valid: if classifier proves noisy across diverse sessions, escalation to PM rather than hide via threshold-cranking
6. Cross-family external review per the gate above
7. No time estimates anywhere
8. Crash-resilience: the disk after every boundary is the canonical state; pre-pivot stale is impossible past one boundary detection
</methodology_gates>
