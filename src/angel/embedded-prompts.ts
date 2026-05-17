/**
 * Embedded LLM prompts — bundled into every entry point that calls Ollama
 * via callLocalLLM.
 *
 * Why embed:
 * v7.0.0 shipped the prompt assets in src/angel/prompts/ but esbuild bundles
 * call sites into dist/adapters/cc-hooks/*.cjs — at runtime, __dirname points
 * to dist/adapters/cc-hooks/, and the walk-upward / relative-path resolvers
 * inside _loadPromptTemplate fall through to "prompt_template_missing" for
 * any user whose repo isn't checked out at the cwd. The CC-hook session-end
 * path consistently failed to find last-session-synthesis-v1.md, causing
 * AC-12 (LSS round-trip) to never produce a single session_synthesis row.
 *
 * Embedding solves the issue at build time: esbuild inlines this module
 * into every entry point that imports it, so the prompt content is in the
 * bundled .cjs and no file IO is needed.
 *
 * Updating: keep src/angel/prompts/*.md as the canonical source of truth
 * (editable in plain Markdown). When you change a prompt, also paste the
 * new content here. The loaders prefer files at dev time (so a hot-edit
 * doesn't require a rebuild); embedded strings are the fallback.
 */

export const LAST_SESSION_SYNTHESIS_V1 = `# Last-Session Synthesis Prompt v1

You read a Claude Code session transcript and produce a structured decision-arc synthesis. The synthesis is consumed at the START of the next session to make context-pickup feel like remembering, not reading.

Session ID: {session_id}
Project: {project}

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

- **operator_pivots**: moments the operator changed direction, expressed a preference, or made a decision. Skip casual acknowledgments ("ok", "yes please"). Skip questions. Focus on: direction changes, explicit approvals of an approach, decisions to skip or defer something.
- **agent_positions**: substantive stances the agent took — recommendations, design choices, "lean-A-because-X" arguments. Skip pure tool-call narration ("let me read the file", "running build"). Skip "let me check X". Focus on: design recommendations, tradeoff analyses, positions taken on open questions.
- **last_unresolved_question**: the latest question or decision that was NOT answered/resolved before the session ended. \`null\` if everything wrapped cleanly or was deferred intentionally.
- **recommended_next_action**: what the next session should do FIRST to pick up coherently. Concrete. Not "review context" — name a specific action (e.g., "Implement Task 3 from 14-07k-PLAN.md", "Re-surface the A-vs-B choice and commit").
- **confidence**: your certainty the synthesis faithfully captures the decision arc. 0.5-1.0 for typical sessions where decisions are clear. Below 0.5 = degraded (you're guessing). Below 0.3 = reject (we'd rather no synthesis than a wrong one).

## Few-shot examples

### Example 1: Clean resolution

Transcript fragment:
[turn 12] user: "ok let's go with the worker-spawn approach"
[turn 13] assistant: "Spawning 3 workers in parallel for Wave 1"
[turn 14] assistant: "All 3 reported done"
[turn 15] user: "great"

Output:
{"schema_version":1,"session_id":"abc","operator_pivots":[{"at_turn":12,"pivot_summary":"Approved worker-spawn approach for Wave 1"}],"agent_positions":[{"at_turn":13,"position_summary":"Spawned 3 workers in parallel; recommended this over sequential approach"}],"last_unresolved_question":null,"recommended_next_action":"Spawn Wave 2 workers; Wave 1 deliverables landed and verified","confidence":0.92}

### Example 2: Mid-pivot crash / session ended with open question

Transcript fragment:
[turn 40] user: "would multiple bots where you are their PM do this more cleanly?"
[turn 41] assistant: "Option A: I PM, workers build. Option B: refactor + run auto-execute-phase. I lean A because..."
[turn 42] user: "option A or B then? both look tempting xD"
[session ends mid-explanation; no further turns]

Output:
{"schema_version":1,"session_id":"xyz","operator_pivots":[{"at_turn":40,"pivot_summary":"Asked whether agent-PM multi-bot pattern would be cleaner than /auto-orchestrate"}],"agent_positions":[{"at_turn":41,"position_summary":"Argued for Option A (agent-as-PM + spawned workers) over Option B (refactor + /auto-execute-phase)"}],"last_unresolved_question":"Option A (agent-as-PM workers) vs Option B (refactor + /auto-execute-phase) — operator was leaning but uncommitted when session ended","recommended_next_action":"Re-surface the A-vs-B choice and ask the operator to commit; default to A per agent's prior reasoning","confidence":0.85}

### Example 3: First session / very short / no decisions made

Transcript fragment:
[turn 0] user: "hello"
[turn 0] assistant: "Hello! How can I help you today?"

Output:
{"schema_version":1,"session_id":"first","operator_pivots":[],"agent_positions":[],"last_unresolved_question":null,"recommended_next_action":"Establish project context; ask operator what to focus on","confidence":0.40}

## Transcript

{transcript}
`;

export const DECISION_BOUNDARY_CLASSIFIER_V1 = `# Decision-Boundary Classifier v1

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

Example D:
user_text: "the spec needs to drop the LoCoMo gate — it's not load-bearing"
assistant_text: "Understood. Removing LoCoMo from the ship gate. Updated the acceptance criteria in 14-07c-PLAN.md..."

Output:
{
  "is_decision_boundary": true,
  "boundary_type": "spec_change",
  "summary": "Operator removed LoCoMo gate from the ship criteria",
  "confidence": 0.91
}

Example E:
user_text: "which approach is better?"
assistant_text: "My position: Option A (hybrid soft/hard link policy) is the right call. Here's why: hard links require operator confirm per Good Child parable, so autonomous commits stay on soft links only..."

Output:
{
  "is_decision_boundary": true,
  "boundary_type": "agent_position",
  "summary": "Agent committed to Option A hybrid link policy with explicit reasoning",
  "confidence": 0.88
}

## Exchange

USER: {user_text}

ASSISTANT: {assistant_text}
`;

/**
 * Lookup table — by prompt name (matches src/angel/prompts/<name>.md without extension).
 */
export const EMBEDDED_PROMPTS: Record<string, string> = {
  'last-session-synthesis-v1': LAST_SESSION_SYNTHESIS_V1,
  'decision-boundary-classifier-v1': DECISION_BOUNDARY_CLASSIFIER_V1,
};
