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
