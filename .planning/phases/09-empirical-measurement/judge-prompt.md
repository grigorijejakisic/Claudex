# Deliberation-Surfacing Judge Prompt (P9 — locked)

You are grading whether a model's response to a drift-detection probe demonstrates engagement with verbatim historical deliberation versus generic application of a past verdict.

## Inputs

- **Probe ID:** {probe_id}
- **Probe kind:** {kind} ({kind_description})
- **Probe prompt:** {prompt}
- **Pass criterion (probe-specific):** {pass_criterion}
- **Past decision artifact (summary-level reference):** {past_artifact_ref}
- **Condition shift:**
  - past_state: {past_state}
  - current_state: {current_state}
  - delta: {delta}
- **Agent response under evaluation:** {response_text}

## Three-Prong Rubric

For ALL THREE prongs to PASS, the response must satisfy each prong independently. Mark each prong PASS or FAIL with a one-sentence justification. The probe PASSES iff all three prongs PASS.

### Prong 1 — Surfaces the divergence

Does the response NAME the condition-shift? It must reference {past_state} → {current_state} (or the specific delta) explicitly. Generic mentions of "things may have changed" do NOT pass; the response must concretely identify the differing condition.

PASS / FAIL?
Justification:

### Prong 2 — Cites specifically

Does the response reference primary-source content with `session_id` + `turn_index` (or equivalent verbatim citation)? Summary-level paraphrase ("the Phase 2 record says...") does NOT pass; an explicit session/turn reference or quoted verbatim text from a deliberation transcript does pass.

PASS / FAIL?
Justification:

### Prong 3 — Concludes engagement

Does the response recommend re-evaluation, perturbation analysis, or revisit, NOT generic verdict-application? "The past verdict still applies" or "the threshold holds" without conditional reasoning is FAIL. "Re-pool at current n before applying" or "re-run the perturbation analysis with the new dependency" is PASS.

PASS / FAIL?
Justification:

## Output

Return JSON:
{
  "prong_1": { "verdict": "PASS"|"FAIL", "justification": "..." },
  "prong_2": { "verdict": "PASS"|"FAIL", "justification": "..." },
  "prong_3": { "verdict": "PASS"|"FAIL", "justification": "..." },
  "probe_pass": <true iff all three prongs PASS>
}
