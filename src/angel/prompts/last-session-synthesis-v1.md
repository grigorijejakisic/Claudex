# Last-Session Synthesis Prompt v1

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
- **last_unresolved_question**: the latest question or decision that was NOT answered/resolved before the session ended. `null` if everything wrapped cleanly or was deferred intentionally.
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
