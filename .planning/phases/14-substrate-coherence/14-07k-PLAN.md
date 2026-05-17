---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: 07k
type: execute
wave: 3
depends_on: ["07a", "07d", "07h"]
files_modified:
  - src/angel/last-session-synthesis.ts (NEW)
  - src/angel/prompts/last-session-synthesis-v1.md (NEW)
  - src/assembly/sections/last-session-synthesis.ts (NEW)
  - src/assembly/assembler.ts (call new section in cascade)
  - src/adapters/cc-hooks/session-end.ts (trigger LSS after pattern summary)
  - src/scripts/backfill-session-synthesis.ts (NEW — operator-runnable CLI)
  - src/tests/angel/last-session-synthesis.test.ts (NEW)
  - src/tests/assembly/last-session-synthesis-section.test.ts (NEW)
  - src/tests/scripts/backfill-session-synthesis.test.ts (NEW)
autonomous: true
operator_review_gate: false
requirements: []

must_haves:
  truths:
    - "Last-Session Synthesis (LSS) is the load-bearing mechanism behind the v7 qualitative ship gate — 'does session-start feel remembered, not read?'. Pattern-extraction (existing `synthesizeSessionSummary`) is shallow; LSS adds LLM-driven structured extraction over the actual session JSONL transcript. LSS augments — does NOT replace — the existing string summary."
    - "Output is STRUCTURED, version-pinned JSON: `{ schema_version: 1, session_id, operator_pivots: [{ at_turn, pivot_summary }], agent_positions: [{ at_turn, position_summary }], last_unresolved_question: string|null, recommended_next_action: string, confidence: 0-1, prompt_version, llm_model, generated_at_epoch_ms }`. The structure is load-bearing for session-start rendering AND for the qualitative ship gate's measurability."
    - "Transcript input is read via `canonical-session-ir.fromClaudeCode(jsonlPath)` (existing). Filter to user + assistant text content; skip tool-call narration noise. Truncate to fit Ollama context window (configurable; default last 8K tokens of dialogue)."
    - "LLM call uses `llama-client.callLocalLLM` (Ollama — hook-safe per the hook-deadlock rule). Cloud LLM is NOT used at session-end hook time. Model is configurable via `ANGEL_LLM_MODEL` env (default `llama3.1:8b`); format='json'; max_tokens=1024."
    - "Persistence is V17 artifact with `kind='session_synthesis'`, `project=<project>`, `title=<derived from operator_pivots[0] or last_unresolved_question>`, `body=<full synthesis JSON>`, `created_at_epoch=<session_end_epoch_sec>`. Artifact ID = deterministic `sha256(session_id + 'session_synthesis')` for idempotency. UPSERT semantics — re-running synthesis on the same session updates the existing row."
    - "Trigger is the session-end CC hook (`src/adapters/cc-hooks/session-end.ts`). LSS runs AFTER the existing `synthesizeSessionSummary` + `saveSessionSummary` path. Non-blocking: LSS failure does NOT block session-end completion; one telemetry row emitted (`event_kind='lss_synthesis_failed'`, `detail.reason` = one of `llm_unreachable | llm_timeout | parse_failed | schema_invalid | persistence_failed | confidence_below_threshold`)."
    - "Session-start render: new `formatLastSessionSynthesisSection(params)` in `src/assembly/sections/last-session-synthesis.ts`. Reads the most-recent `session_synthesis` artifact for the current project. Renders as the FIRST first-class block at session-start, BEFORE the existing handoff summary surface (assembler cascade priority P0)."
    - "Render format (concrete): a section titled `## Last Session — Synthesis` with four short labeled blocks: `Operator's pivots:` (bulleted), `Agent's positions:` (bulleted), `Unresolved:` (one line or `—`), `Next action:` (one line). Production-quality formatting; no markdown noise; tight token budget (~400 tokens cap)."
    - "Fallback discipline: when no prior synthesis exists (first session of project; LSS not yet run on prior session; LSS failed at prior session-end), section renders NOTHING — no placeholder, no 'Synthesis pending', no error message. The operator does not see scaffolding."
    - "Backfill CLI at `src/scripts/backfill-session-synthesis.ts`: `bun src/scripts/backfill-session-synthesis.ts --project <name> [--since YYYY-MM-DD] [--dry-run] [--force]`. Walks session JSONLs in date range, calls `synthesizeLastSession` for each, persists artifacts. Idempotent. `--force` re-runs even for sessions that already have synthesis (prompt-version bump scenario)."
    - "Prompt template is version-pinned at `src/angel/prompts/last-session-synthesis-v1.md`. The synthesis artifact stores `prompt_version` so future prompt revisions can be replayed over historical sessions via backfill `--force`. A schema-version bump (1 → 2) triggers a migration path inside the section renderer."
    - "Confidence floor = 0.5. Synthesis with `confidence < 0.5` is persisted with `body.degraded = true` and the section renderer surfaces a one-line `[low-confidence synthesis]` annotation. Below 0.3, the synthesis is rejected (telemetry; not persisted)."
    - "Cross-project denormalization: synthesis is per-(project, session). Renderer scopes lookup to current project. Multi-project sessions (rare per existing architecture) emit one synthesis artifact per project they touched."
  artifacts:
    - path: "src/angel/last-session-synthesis.ts"
      provides: "LSS extraction module. Exports `synthesizeLastSession`, `parseLLMSynthesisOutput`, `validateSynthesisSchema`, `persistSynthesisArtifact`, `deriveSynthesisArtifactId`."
      contains: "synthesizeLastSession|parseLLMSynthesisOutput|validateSynthesisSchema|persistSynthesisArtifact"
    - path: "src/angel/prompts/last-session-synthesis-v1.md"
      provides: "Versioned LLM prompt template with system instructions + 3 few-shot examples (clean-resolution end, mid-pivot end, first-session-of-project)."
      contains: "schema_version|operator_pivots|agent_positions|last_unresolved_question|recommended_next_action|confidence"
    - path: "src/assembly/sections/last-session-synthesis.ts"
      provides: "Session-start render section. `formatLastSessionSynthesisSection(params)` reads most-recent synthesis artifact for project and emits the P0 block, or returns empty string when absent."
      contains: "formatLastSessionSynthesisSection"
    - path: "src/assembly/assembler.ts"
      provides: "Existing assembler; modified to call `formatLastSessionSynthesisSection` at P0 priority position in the cascade."
      contains: "formatLastSessionSynthesisSection"
    - path: "src/adapters/cc-hooks/session-end.ts"
      provides: "Existing session-end hook; extended to call `synthesizeLastSession` after `synthesizeSessionSummary` + `saveSessionSummary`. Non-blocking."
      contains: "synthesizeLastSession"
    - path: "src/scripts/backfill-session-synthesis.ts"
      provides: "Operator-runnable CLI for backfilling LSS on historical sessions. Dry-run default, `--force` for prompt-version replay."
      contains: "backfillSynthesis|listSessionsWithoutSynthesis|backfillOne"
  key_links:
    - from: "src/adapters/cc-hooks/session-end.ts"
      to: "src/angel/last-session-synthesis.ts (synthesizeLastSession)"
      via: "Session-end hook triggers LSS after existing pattern summary"
      pattern: "synthesizeLastSession"
    - from: "src/angel/last-session-synthesis.ts"
      to: "src/intelligence/canonical-session-ir.ts (fromClaudeCode)"
      via: "Read JSONL into canonical IR for LLM input"
      pattern: "fromClaudeCode"
    - from: "src/angel/last-session-synthesis.ts"
      to: "src/angel/llama-client.ts (callLocalLLM)"
      via: "Ollama LLM call for synthesis extraction"
      pattern: "callLocalLLM"
    - from: "src/angel/last-session-synthesis.ts"
      to: "V17 artifact (kind='session_synthesis')"
      via: "Persistence via UPSERT on deterministic artifact ID"
      pattern: "kind='session_synthesis'"
    - from: "src/assembly/sections/last-session-synthesis.ts"
      to: "V17 artifact (kind='session_synthesis')"
      via: "Reads most-recent synthesis for current project at session-start"
      pattern: "kind='session_synthesis'"
---

<objective>
Close the synthesis gap. The missing layer between "stored facts" and "felt-remembered" at session-start.

**Before:** Session-start surfaces stored facts — handoff doc (potentially stale), memory pointers (slugs), topic fingerprints (tokens). Agent assembles meaning from fragments. Felt like reading.

**After:** Session-start surfaces a synthesized arc — operator's pivots, agent's positions, last unresolved question, recommended next action. Felt like remembering.

The qualitative ship gate (per CONTEXT: "does session-start feel remembered, not read?") gets a concrete mechanism. Not just better surfaces of stored facts — actual synthesis.

This plan exists because of a specific failure mode observed 2026-05-17: PC crashed during yesterday's v7 spec session; this morning, session-start gave fragments (stale handoff frozen at 18:13 Option-B-confirmed; topic fingerprints; memory slugs); agent assembled the wrong picture and only corrected after operator nudge. LSS makes that morning the exception, not the rule.

| What this plan provides | Why |
|---|---|
| LLM-driven structured synthesis | Pattern-extraction is shallow; LLM captures decision arc |
| Version-pinned prompt template | Replay-able over historical sessions on prompt revision |
| V17 artifact persistence | Production storage (not flat-file MVP) |
| Session-end trigger | Synthesis runs when session closes; non-blocking |
| Backfill CLI | Operator-runnable for historical sessions |
| Session-start P0 render | First-class block, above handoff |
| Silent-fallback discipline | No scaffolding when synthesis absent |
| Confidence floor + degraded mode | Honest about LLM uncertainty |
</objective>

<execution_context>
@C:/Users/Grigorije/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/Grigorije/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/14-substrate-coherence/14-07-CONTEXT.md
@.planning/phases/14-substrate-coherence/14-07-WAVE3-COORDINATION.md
@.planning/phases/14-substrate-coherence/14-07a-PLAN.md
@.planning/phases/14-substrate-coherence/14-07-VERIFICATION-PASS.md
@src/intelligence/canonical-session-ir.ts
@src/angel/llama-client.ts
@src/core/session-events.ts
@src/angel/highlights-extractor.ts
@src/adapters/cc-hooks/session-end.ts
@~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/feedback_production_not_versioning_or_mvp.md
</context>

<anti_scope>
- Do NOT replace `synthesizeSessionSummary` (existing pattern-extraction) — LSS augments, never replaces
- Do NOT modify `handoff-writer.ts` — 14-07l owns continuous handoff refresh; this plan owns the synthesis layer only
- Do NOT change the existing memory pointers / topic fingerprints rendering — LSS is additive
- Do NOT add a "Synthesis pending" placeholder when LSS absent — silent fallback discipline
- Do NOT modify the JSONL transcript files (read-only)
- Do NOT block session-end on LSS — failures are non-blocking with explicit telemetry
- Do NOT use cloud LLM for hook-triggered synthesis — Ollama only per hook-deadlock rule
- Do NOT bypass V17 artifact storage with flat-file shim — production quality, not MVP
- Do NOT inline the LSS prompt — version-pinned external file always
- Do NOT skip schema validation — confidence floor + structure validation are hard gates
- Do NOT modify session-start cascade ordering — only insert the new P0 section at the documented position
- Do NOT cross-project bleed synthesis at session-start render — strict project scope
</anti_scope>

<tasks>

<task type="auto">
  <name>Task 1: LSS extraction module at src/angel/last-session-synthesis.ts</name>
  <files>src/angel/last-session-synthesis.ts</files>
  <action>
Create the LSS extraction module.

Public surface:

```typescript
import type { Database } from 'better-sqlite3';

export interface OperatorPivot { at_turn: number; pivot_summary: string; }
export interface AgentPosition { at_turn: number; position_summary: string; }

export interface LastSessionSynthesis {
  schema_version: 1;
  session_id: string;
  operator_pivots: OperatorPivot[];
  agent_positions: AgentPosition[];
  last_unresolved_question: string | null;
  recommended_next_action: string;
  confidence: number;        // 0-1
  prompt_version: string;    // e.g. 'v1'
  llm_model: string;
  generated_at_epoch_ms: number;
  degraded?: boolean;         // true if confidence ∈ [0.3, 0.5)
}

export interface SynthesizeOpts {
  project: string;
  jsonl_path?: string;
  prompt_version?: string;
  llm_model?: string;
  max_dialogue_tokens?: number;  // default 8192
}

export async function synthesizeLastSession(
  sessionId: string,
  db: Database,
  opts: SynthesizeOpts,
): Promise<LastSessionSynthesis | null>;

export function parseLLMSynthesisOutput(
  llmText: string,
  sessionId: string,
  promptVersion: string,
  llmModel: string,
): LastSessionSynthesis | null;

export function validateSynthesisSchema(s: unknown): s is LastSessionSynthesis;

export function persistSynthesisArtifact(
  db: Database,
  synthesis: LastSessionSynthesis,
  project: string,
): { artifact_id: string; updated: boolean };

export function deriveSynthesisArtifactId(sessionId: string): string;
```

Implementation pattern (production-quality, full error handling):

```typescript
export async function synthesizeLastSession(sessionId, db, opts) {
  const startMs = Date.now();
  try {
    // 1. Resolve JSONL path
    const jsonlPath = opts.jsonl_path ?? resolveJsonlPath(sessionId, opts.project);
    if (!fs.existsSync(jsonlPath)) {
      emitTelemetry(db, { event_kind: 'lss_synthesis_failed', session_id: sessionId, detail: { reason: 'jsonl_missing', path: jsonlPath } });
      return null;
    }

    // 2. Read + canonicalize
    const canonical = fromClaudeCode(jsonlPath);
    if (!canonical || canonical.messages.length === 0) {
      emitTelemetry(db, { event_kind: 'lss_synthesis_failed', session_id: sessionId, detail: { reason: 'empty_transcript' } });
      return null;
    }

    // 3. Filter to dialogue (user + assistant text), skip tool noise
    const dialogue = filterToDialogue(canonical.messages);

    // 4. Truncate to context window
    const transcript = truncateToTokens(dialogue, opts.max_dialogue_tokens ?? 8192);

    // 5. Load + substitute prompt
    const promptVersion = opts.prompt_version ?? 'v1';
    const promptTemplate = loadPromptTemplate(promptVersion);
    const prompt = substitutePlaceholders(promptTemplate, { transcript, session_id: sessionId, project: opts.project });

    // 6. LLM call (Ollama)
    const llmModel = opts.llm_model ?? process.env.ANGEL_LLM_MODEL ?? 'llama3.1:8b';
    const llmText = await callLocalLLM({ prompt, model: llmModel, format: 'json', max_tokens: 1024, timeout_ms: 30_000 });
    if (!llmText) {
      emitTelemetry(db, { event_kind: 'lss_synthesis_failed', session_id: sessionId, detail: { reason: 'llm_unreachable', model: llmModel } });
      return null;
    }

    // 7. Parse + validate
    const synthesis = parseLLMSynthesisOutput(llmText, sessionId, promptVersion, llmModel);
    if (!synthesis) {
      // parse helper already emitted telemetry
      return null;
    }

    // 8. Confidence gate
    if (synthesis.confidence < 0.3) {
      emitTelemetry(db, { event_kind: 'lss_synthesis_failed', session_id: sessionId, detail: { reason: 'confidence_below_threshold', confidence: synthesis.confidence } });
      return null;
    }
    if (synthesis.confidence < 0.5) {
      synthesis.degraded = true;
    }

    // 9. Persist
    const persistResult = persistSynthesisArtifact(db, synthesis, opts.project);
    emitTelemetry(db, {
      event_kind: 'lss_synthesis_complete',
      session_id: sessionId,
      detail: { artifact_id: persistResult.artifact_id, updated: persistResult.updated, confidence: synthesis.confidence, latency_ms: Date.now() - startMs },
    });
    return synthesis;
  } catch (err) {
    emitTelemetry(db, { event_kind: 'lss_synthesis_failed', session_id: sessionId, detail: { reason: 'exception', error: String(err) } });
    return null;
  }
}
```

`deriveSynthesisArtifactId(sessionId)` returns `sha256(sessionId + 'session_synthesis').slice(0, 32)` — hex32 matching V17 ID conventions per 14-07a.

`persistSynthesisArtifact` runs:
```sql
INSERT INTO artifact (id, kind, project, title, body, created_at_epoch)
VALUES (?, 'session_synthesis', ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  body=excluded.body,
  created_at_epoch=excluded.created_at_epoch,
  title=excluded.title
```
Returns `{ artifact_id, updated: <true if pre-existing> }`.
  </action>
  <verification>
- `synthesizeLastSession` returns valid `LastSessionSynthesis` for a fixture JSONL with a clear decision arc
- Returns null + emits telemetry on each failure path (jsonl_missing, empty_transcript, llm_unreachable, parse_failed, confidence_below_threshold, exception)
- Re-running on a session that already has synthesis returns updated=true; same artifact_id
- `parseLLMSynthesisOutput` rejects malformed JSON, missing fields, wrong types — telemetry per case
- `validateSynthesisSchema` correctly classifies valid + invalid shapes
- `deriveSynthesisArtifactId` is deterministic (same input → same output)
- No exception escapes `synthesizeLastSession` even on cascading failure
  </verification>
</task>

<task type="auto">
  <name>Task 2: Version-pinned prompt template src/angel/prompts/last-session-synthesis-v1.md</name>
  <files>src/angel/prompts/last-session-synthesis-v1.md</files>
  <action>
Create the prompt template with system instructions + 3 few-shot examples.

Structure:

```markdown
# Last-Session Synthesis Prompt v1

You read a Claude Code session transcript and produce a structured decision-arc synthesis. The synthesis is consumed at the START of the next session to make context-pickup feel like remembering, not reading.

Output STRICT JSON only — no surrounding markdown, no commentary, no code fences:

{
  "schema_version": 1,
  "session_id": "<echo the session_id input>",
  "operator_pivots": [
    { "at_turn": <int>, "pivot_summary": "<one tight sentence>" }
  ],
  "agent_positions": [
    { "at_turn": <int>, "position_summary": "<one tight sentence>" }
  ],
  "last_unresolved_question": "<one sentence | null>",
  "recommended_next_action": "<one concrete next action>",
  "confidence": <0.0-1.0>
}

## Rules

- **operator_pivots**: moments the operator changed direction, expressed a preference, or made a decision. Skip casual acknowledgments ("ok", "yes please"). Skip questions.
- **agent_positions**: substantive stances the agent took — recommendations, design choices, lean-A-because-X. Skip pure tool-call narration. Skip "let me check X".
- **last_unresolved_question**: the latest question or decision that was NOT answered/resolved before the session ended. `null` if everything wrapped cleanly.
- **recommended_next_action**: what the next session should do FIRST to pick up coherently. Concrete. Not "review context" — name a specific action.
- **confidence**: your certainty the synthesis is faithful to the transcript. 0.5-1.0 for typical sessions. Below 0.5 = degraded; below 0.3 = reject (we'd rather no synthesis than a wrong one).

## Few-shot examples

### Example 1: Clean resolution

Transcript fragment:
[turn 12] operator: "ok let's go with the worker-spawn approach"
[turn 13] assistant: "Spawning 3 workers in parallel for Wave 1"
[turn 14] assistant: "All 3 reported done"
[turn 15] operator: "great"

Output:
{
  "schema_version": 1,
  "session_id": "abc",
  "operator_pivots": [{ "at_turn": 12, "pivot_summary": "Approved worker-spawn approach for Wave 1" }],
  "agent_positions": [{ "at_turn": 13, "position_summary": "Spawned 3 workers in parallel" }],
  "last_unresolved_question": null,
  "recommended_next_action": "Spawn Wave 2 workers; Wave 1 deliverables landed and verified",
  "confidence": 0.92
}

### Example 2: Mid-pivot crash

Transcript fragment:
[turn 40] operator: "would multiple bots where you are their PM do this more cleanly?"
[turn 41] assistant: "Option A: I PM, workers build. Here's why honestly..."
[turn 42] operator: "option A or be then? both look tempting xD"
[session ends mid-explanation; no further turns]

Output:
{
  "schema_version": 1,
  "session_id": "xyz",
  "operator_pivots": [
    { "at_turn": 40, "pivot_summary": "Asked whether agent-PM'd multi-bot pattern would be cleaner than /auto-orchestrate" }
  ],
  "agent_positions": [
    { "at_turn": 41, "position_summary": "Argued for Option A (agent-as-PM + spawned workers) over Option B (refactor + /auto-execute-phase)" }
  ],
  "last_unresolved_question": "Option A (agent-as-PM workers) vs Option B (refactor + /auto-execute-phase) — operator was leaning but uncommitted when session ended",
  "recommended_next_action": "Re-surface the A-vs-B choice and ask the operator to commit; default to A per agent's prior reasoning",
  "confidence": 0.85
}

### Example 3: First session / no prior context

[Transcript empty or just opening exchange]

Output:
{
  "schema_version": 1,
  "session_id": "first",
  "operator_pivots": [],
  "agent_positions": [],
  "last_unresolved_question": null,
  "recommended_next_action": "Establish project context; ask operator what to focus on",
  "confidence": 0.40
}

## Transcript

{transcript}
```

Placeholders: `{transcript}`, `{session_id}`, `{project}` substituted before LLM call.
  </action>
  <verification>
- File exists with the version v1 in its path
- Template has all three placeholders
- Few-shot examples cover: clean-resolution, mid-pivot crash, first-session-or-empty
- Template explicitly forbids markdown wrapping / code fences in output
- Schema matches the TypeScript `LastSessionSynthesis` interface exactly
  </verification>
</task>

<task type="auto">
  <name>Task 3: Session-start render section src/assembly/sections/last-session-synthesis.ts</name>
  <files>src/assembly/sections/last-session-synthesis.ts</files>
  <action>
Create the session-start render section. Lives in the modular sections/ directory (post-w0d split structure).

```typescript
import type { Database } from 'better-sqlite3';

export interface FormatLSSParams {
  db: Database;
  project: string;
}

/**
 * Phase 14-07k — session-start render of the most-recent LastSessionSynthesis.
 *
 * Reads V17 artifact (kind='session_synthesis') for the current project.
 * Returns the rendered section, or empty string when no synthesis exists.
 * Silent fallback discipline — no placeholder, no error.
 *
 * Section priority: P0 (top of session-start, above the handoff summary).
 */
export function formatLastSessionSynthesisSection(p: FormatLSSParams): string;
```

Implementation:

1. Query V17 artifact: `SELECT body, created_at_epoch FROM artifact WHERE project = ? AND kind = 'session_synthesis' ORDER BY created_at_epoch DESC LIMIT 1`
2. If no row: return empty string (silent fallback)
3. Parse `body` as `LastSessionSynthesis` JSON; on parse failure return empty string + telemetry `event_kind='lss_render_failed', detail.reason='parse'`
4. Format as:

```
## Last Session — Synthesis

**Operator's pivots:**
- <pivot_summary>
- <pivot_summary>

**Agent's positions:**
- <position_summary>
- <position_summary>

**Unresolved:** <last_unresolved_question or "—">

**Next action:** <recommended_next_action>
```

5. If `synthesis.degraded === true`: prepend `_[low-confidence synthesis — verify against transcript before relying]_` as a one-line annotation under the heading.
6. Cap render to ~400 tokens (truncate per-list bullet count if needed; favor most-recent pivots/positions by `at_turn` desc).
7. Add cascade priority P0 metadata so assembler.ts orders this section first.
  </action>
  <verification>
- Returns empty string when no synthesis row exists
- Returns formatted section when synthesis exists with valid body
- Returns empty string + telemetry when body is malformed JSON
- Degraded synthesis shows the annotation line
- Cross-project scoping correct: project A's synthesis does not surface in project B's session-start
- Token cap respected; truncation favors recent pivots/positions
  </verification>
</task>

<task type="auto">
  <name>Task 4: Wire into assembler cascade src/assembly/assembler.ts</name>
  <files>src/assembly/assembler.ts</files>
  <action>
Modify assembler to call `formatLastSessionSynthesisSection` at P0 priority — BEFORE the existing handoff summary surface and BEFORE Claudex Ready / Reranker Health / Substrate Health.

The session-start cascade ordering becomes (P0 highest):
1. **P0:** Last Session Synthesis (new — this plan)
2. P0.5: Claudex Ready / Reranker Health / Substrate Health (existing)
3. P1+: Handoff summary, identity, recent frames, ... (existing)

Anti-scope reminder: do NOT reorder any existing sections beyond inserting the new P0 above them. The cascade structure is locked per 14-07-CONTEXT § Locked Decisions.
  </action>
  <verification>
- Assembler imports `formatLastSessionSynthesisSection` from `src/assembly/sections/last-session-synthesis.ts`
- Section is called with the correct params (db, project) per current cascade convention
- Output order: LSS section appears first in session-start output when present
- Existing section order unchanged
- Session-start tests pass with + without synthesis present
  </verification>
</task>

<task type="auto">
  <name>Task 5: Hook into session-end at src/adapters/cc-hooks/session-end.ts</name>
  <files>src/adapters/cc-hooks/session-end.ts</files>
  <action>
Extend the existing session-end hook to trigger `synthesizeLastSession` AFTER the existing `synthesizeSessionSummary` + `saveSessionSummary` path. Non-blocking — fire-and-forget pattern is NOT allowed here (hooks must await), but LSS failure must NOT raise.

```typescript
// existing pattern summary
const events = getSessionEvents(db, sessionId);
const summary = synthesizeSessionSummary(events);
if (summary) saveSessionSummary(db, sessionId, summary);

// 14-07k: LLM-driven structured synthesis (non-blocking on failure)
try {
  await synthesizeLastSession(sessionId, db, { project });
} catch {
  // synthesizeLastSession is itself non-throwing, but defensive guard
}
```

Ensure the hook still completes cleanly when LSS fails (e.g., Ollama down).
  </action>
  <verification>
- Hook awaits LSS but doesn't fail on LSS error
- When Ollama is reachable: synthesis artifact appears in DB after hook completes
- When Ollama is down: hook completes; one telemetry row `lss_synthesis_failed` with reason `llm_unreachable`
- Hook latency increase ≤ 30s typical (LSS timeout config)
  </verification>
</task>

<task type="auto">
  <name>Task 6: Backfill CLI src/scripts/backfill-session-synthesis.ts</name>
  <files>src/scripts/backfill-session-synthesis.ts</files>
  <action>
Create the operator-runnable backfill CLI.

```typescript
/**
 * Phase 14-07k — backfill LSS for prior sessions.
 *
 * Usage:
 *   bun src/scripts/backfill-session-synthesis.ts --project <name> [--since YYYY-MM-DD] [--dry-run] [--force]
 *
 * --dry-run    (default): list sessions that WOULD be synthesized; do not write
 * --force      : re-run synthesis for sessions that already have synthesis (prompt-version replay)
 * --since DATE : only sessions on/after DATE (default: 30 days ago)
 *
 * Exit codes:
 *   0 — success (or dry-run completed)
 *   1 — partial failure (some sessions failed; details printed)
 *   2 — invalid args
 *   3 — DB / IO error
 */
```

Phases:
1. Parse args; validate
2. Enumerate sessions for project in date range from `sessions` table
3. For each session: check if `session_synthesis` artifact already exists; skip unless `--force`
4. Dry-run: print list of sessions to synthesize; exit 0
5. Apply: call `synthesizeLastSession(sessionId, db, { project })`; collect successes/failures; emit summary
6. Exit 0 if all succeeded, 1 if any failed
  </action>
  <verification>
- `--dry-run` lists sessions without writing
- `--force` re-runs on sessions that already have synthesis
- Default skips sessions with existing synthesis
- Partial failure: continues processing remaining sessions; exit 1 at end
- Date filtering correct (`--since` inclusive)
- Empty result set: clean exit 0 with message
  </verification>
</task>

<task type="auto">
  <name>Task 7: Tests across all three layers</name>
  <files>src/tests/angel/last-session-synthesis.test.ts, src/tests/assembly/last-session-synthesis-section.test.ts, src/tests/scripts/backfill-session-synthesis.test.ts</files>
  <action>
**`src/tests/angel/last-session-synthesis.test.ts`** — module-level tests, mocked LLM:
1. `synthesizeLastSession: happy path → valid synthesis + persist + telemetry`
2. `synthesizeLastSession: jsonl missing → null + telemetry reason=jsonl_missing`
3. `synthesizeLastSession: empty transcript → null + telemetry reason=empty_transcript`
4. `synthesizeLastSession: LLM unreachable → null + telemetry reason=llm_unreachable`
5. `synthesizeLastSession: LLM returns malformed JSON → null + telemetry reason=parse_failed`
6. `synthesizeLastSession: confidence < 0.3 → null + telemetry reason=confidence_below_threshold`
7. `synthesizeLastSession: confidence ∈ [0.3, 0.5) → persisted with degraded=true`
8. `synthesizeLastSession: re-run on existing session → updated=true; same artifact_id`
9. `parseLLMSynthesisOutput: missing field → null + telemetry`
10. `parseLLMSynthesisOutput: wrong type for confidence → null + telemetry`
11. `validateSynthesisSchema: valid + invalid shape classification`
12. `deriveSynthesisArtifactId: deterministic`
13. `persistSynthesisArtifact: UPSERT semantics correct`
14. `Non-throwing: every cascading-failure path completes without exception`

**`src/tests/assembly/last-session-synthesis-section.test.ts`** — render tests:
1. `Empty when no synthesis row exists`
2. `Renders correctly when synthesis present`
3. `Empty + telemetry when body is malformed JSON`
4. `Degraded annotation shown when synthesis.degraded === true`
5. `Project scoping: project A synthesis does not appear in project B render`
6. `Token cap: long synthesis truncated to ~400 tokens`
7. `Truncation favors most-recent pivots/positions (by at_turn desc)`

**`src/tests/scripts/backfill-session-synthesis.test.ts`** — CLI tests:
1. `--dry-run lists sessions without writing`
2. `Default skips sessions with existing synthesis`
3. `--force re-runs even with existing synthesis`
4. `--since filters correctly`
5. `Partial failure: continues + exit 1`
6. `Invalid args: exit 2 with usage`
  </action>
  <verification>
- All ~25+ tests pass
- Mocking strategy isolates LSS from real Ollama (DI on LLM client)
- Coverage includes every telemetry-emitting failure path
  </verification>
</task>

<task type="auto">
  <name>Task 8: Build + test sweep + /verify</name>
  <files></files>
  <action>
- `bun run build` — must succeed
- `npx vitest run src/tests/angel/last-session-synthesis.test.ts src/tests/assembly/last-session-synthesis-section.test.ts src/tests/scripts/backfill-session-synthesis.test.ts` — all pass
- `npx vitest run` — full suite green
- `bun run vesna` — SC#1 passes against Wave-1 baseline (LSS adds a new section at session-start; vesna probes for behavioral correctness should not regress)
- Run `/verify` skill — capture diff, run tests on changed files, grep for assumed names (especially `formatLastSessionSynthesisSection`, `synthesizeLastSession`, `kind='session_synthesis'`)
- **Live integration smoke (operator-visible):** end this plan's execution by triggering session-end on a fresh test session and confirming a `session_synthesis` artifact appears in DB. Then start a new session and confirm the section renders at the top.
  </action>
  <verification>
- Build green
- All new tests pass
- Full vitest suite green (no regressions; pre-existing failures documented)
- Vesna SC#1 ≥ Wave-1 baseline
- `/verify` shows N claims / M verified / K unverified with K=0 (or documented unverifieds)
- Live smoke: synthesis artifact present in DB; rendered at session-start
  </verification>
</task>

</tasks>

<acceptance_criteria>
- AC-1: `synthesizeLastSession` produces structured `LastSessionSynthesis` per schema for fixture transcripts
- AC-2: Persistence is V17 artifact with `kind='session_synthesis'`, deterministic ID, UPSERT semantics
- AC-3: Session-end hook triggers LSS non-blockingly; failure emits exactly one telemetry row
- AC-4: Session-start renders the most-recent synthesis as a P0 section above existing surfaces
- AC-5: Silent fallback when no synthesis present (no placeholder, no error message visible to operator)
- AC-6: Confidence floor enforced (< 0.3 reject; [0.3, 0.5) degraded; ≥ 0.5 normal)
- AC-7: Backfill CLI runs correctly (dry-run, apply, force, since-filter)
- AC-8: Prompt template version-pinned at `prompts/last-session-synthesis-v1.md`; future revisions follow `-v2.md` pattern
- AC-9: All ~25+ tests pass; no regressions in full suite
- AC-10: Cross-project scoping correct (project A's synthesis doesn't bleed into project B)
- AC-11: Build green; vesna SC#1 ≥ Wave-1 baseline
- AC-12: Live smoke: synthesis artifact in DB + rendered at next session-start
</acceptance_criteria>

<risks>
- **Risk 1: Ollama llama3.1:8b synthesis quality is too shallow for the decision-arc extraction task.** Mitigation: few-shot prompt template + confidence floor + degraded annotation. If post-ship live results show consistent confidence < 0.5, escalation path is to upgrade to llama3.1:70b OR add a heuristic-augmented prompt (extract operator messages first, then LLM-summarize each cluster). Operator-observable via the degraded annotation in the render.
- **Risk 2: LLM JSON output is occasionally malformed.** Mitigation: format='json' Ollama parameter + parse-and-validate path + per-failure telemetry. Backfill CLI lets the operator retry.
- **Risk 3: Session-end hook latency increases noticeably (Ollama call adds latency).** Mitigation: 30s timeout; LLM call is the LAST step in session-end (after summary); failure is silent + non-blocking. If latency proves problematic in practice, move LSS to Angel's heartbeat tick (operator-visible delay ≤ 1 heartbeat interval, ~10 min).
- **Risk 4: Cross-session bleed in render (project A's synthesis surfaces in project B).** Mitigation: explicit `project = ?` in the artifact query; cross-project test in test suite.
- **Risk 5: Prompt template revision breaks historical synthesis.** Mitigation: schema_version + prompt_version stored per artifact; renderer handles version skew; backfill `--force` re-runs with new prompt.
- **Risk 6: V17 artifact storage not ready (14-07a not landed).** Mitigation: depends_on contract — this plan does NOT dispatch until 14-07a's V17 substrate is in. Worker reads V17 schema as the only artifact path; no flat-file shim.
- **Risk 7: Vesna SC#1 regresses because session-start gets a new top section (existing probes' fixtures expect specific section ordering).** Mitigation: probes that test session-start output must be updated to accept the new P0 section, OR the section must be optional-by-default until probes are updated. Worker: audit Vesna probe fixtures first; coordinate with vesna update.
- **Risk 8: Synthesis surfaces operator-private content that shouldn't be persisted long-term.** Mitigation: this plan does not introduce new data — it synthesizes from existing JSONL transcripts that are already on disk. No new privacy surface.
</risks>

<external_review_gate>
Codex + Gemini cross-family review focuses on:
- (a) Synthesis prompt fidelity — does the LLM output reliably match the documented schema for diverse session shapes?
- (b) Non-blocking discipline — can any failure path block session-end hook completion?
- (c) Idempotency — does re-running synthesis on the same session always UPDATE, never duplicate?
- (d) Cross-project scoping — is there any code path that could bleed synthesis across projects?
- (e) Render fallback — is the silent-when-absent discipline holding across all empty/error paths?
- (f) Backfill CLI safety — is `--force` correctly gated; does it ever destroy data that can't be regenerated?

NO-SIGNOFF triggers PM escalation per WAVE3-COORDINATION's rules.
</external_review_gate>

<methodology_gates>
1. Pre-committed AC matrix above (this plan satisfies)
2. Tests written alongside code — ~25+ tests across module, render, CLI
3. Live-wiring smoke: AC-12 requires live session-end → DB → next session-start rendering verification
4. No "MVP" shortcuts — V17 storage from day one (no flat-file shim); version-pinned prompt; confidence floor + degraded mode honest about LLM uncertainty
5. Negative results valid: if synthesis confidence is consistently low across diverse sessions, escalate to PM rather than hide
6. Cross-family external review per the gate above
7. No time estimates anywhere
8. The qualitative ship gate's mechanism is concrete — operator can probe "what was the last unresolved question?" and the rendered LSS should answer faithfully
</methodology_gates>
