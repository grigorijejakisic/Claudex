# Patch: auto-execute-phase — silence-means-escalate fix

**Status:** APPROVED — apply to `~/.claude/skills/auto-execute-phase/SKILL.md`
**Phase:** 12-real-v6-structural-marks
**Context:** 12-CONTEXT.md Q [12-09/Q1] operator-locked answers

## Problem

The skill currently fills operator-silence with defaults when SendMessage questions go unanswered. During execute-phase, the critical failure mode is: hitting an architectural deviation (Rule 4) or a checkpoint:decision → defaulting to the "proceed" path silently → writing SUMMARY.md and advancing STATE without operator confirmation.

## Shared module

All three auto-* skills import `src/skills/auto/block-gate.ts` for:
- `classifyQuestion(question, activeTopics, skillClassification)` → 'BLOCK'|'FLAG'
- `checkOpenBlockers(questionLog)` → open BLOCK questions
- `shouldWriteArtifact(questionLog)` → false if any BLOCK is open
- `buildBlockedMarker(skill, phase, openBlockers, artifactPath)` → blocked message
- `buildTerminalBlockMessage(skill, phase, openBlockers)` → terminal shutdown message
- `recordBlockGateFired(event)` → telemetry to ~/.claudex/block-gate-log.jsonl

## Skill process structure (execute-phase)

Steps where changes are needed:
- `previous_phase_check` — sends SendMessage when previous phase has unresolved issues (BLOCK: structural dependency)
- `execute` → deviation Rule 4 — structural decision needed (BLOCK: Rule 4 is always architectural)
- `execute` → checkpoint:decision — decision checkpoint in plan (BLOCK: decision checkpoint by definition)
- `create_summary` — writes SUMMARY.md (the artifact write step)
- `update_current_position` — advances STATE.md (another write)

## Required changes to SKILL.md

### 1. Classify previous-phase unresolved issues as BLOCK

In `previous_phase_check`, when sending SendMessage for unresolved issues:

```
Previous-phase blockers are classified as BLOCK:
  classifyQuestion(
    'Previous phase SUMMARY has unresolved issues/blockers: [list]',
    activeTopics,
    'FLAG'
  )
  → auto-promoted to BLOCK by "prerequisite" fixed-category floor
    (unresolved blockers are prerequisite dependencies)

BLOCK IDLE PROTOCOL applies:
  - Send the question to orchestrator
  - Skill idles; does NOT default to "Proceed anyway"
  - At ~10-min intervals: restate the unresolved issues
  - After ~30 min: buildTerminalBlockMessage('auto-execute-phase', phase, openBlockers)
  - Orchestrator AskUserQuestion escalation
  - Skill shuts down — does NOT execute plans with silent "proceed anyway"
```

### 2. Classify Rule 4 architectural deviations as BLOCK

In `execute` step, deviation Rule 4 handler:

```
Rule 4 decisions are classified as BLOCK:
  classifyQuestion(
    'Architectural Decision: [discovery]. Proposed change: [modification]. Why needed: [rationale].',
    activeTopics,
    'BLOCK'  // Rule 4 is BLOCK by definition — architectural changes always need operator input
  )
  → always BLOCK (skill classification = BLOCK, floor = BLOCK, result = BLOCK)

BLOCK IDLE PROTOCOL applies:
  - Send Rule 4 decision request to orchestrator via SendMessage
  - Skill STOPS current task execution; does NOT auto-pick the proposed change
  - At ~10-min intervals: restate "Awaiting architectural decision: [summary]"
  - After ~30 min: buildTerminalBlockMessage; orchestrator escalation
  - Skill shuts down; does NOT apply the architectural change unilaterally
```

### 3. Classify checkpoint:decision as BLOCK

In `checkpoint_protocol`, when a `type="checkpoint:decision"` is hit:

```
checkpoint:decision → BLOCK:
  classifyQuestion(checkpoint_content, activeTopics, 'BLOCK') → always BLOCK

BLOCK IDLE PROTOCOL applies:
  - Send checkpoint content to orchestrator via SendMessage
  - Skill idles; does NOT auto-select an option
  - At ~10-min intervals: restate "Awaiting decision on checkpoint: [name]"
  - After ~30 min: buildTerminalBlockMessage; orchestrator escalation
```

### 4. Add question-before-write ordering discipline

Add ordering note before `create_summary`:

```
ORDERING DISCIPLINE: All BLOCK questions must be answered before SUMMARY.md is written.
The create_summary step is the FINAL step — it runs only when shouldWriteArtifact(questionLog) = true.
If execution is blocked at a Rule 4 or checkpoint:decision, create_summary is NOT reached.
```

### 5. Add runtime write gate to `create_summary`

In `create_summary`, insert at the TOP before creating the SUMMARY file:

```
WRITE GATE CHECK:
if (!shouldWriteArtifact(questionLog)):
  send buildBlockedMarker(
    skill='auto-execute-phase',
    phase,
    openBlockers=checkOpenBlockers(questionLog),
    attemptedArtifactPath=`${phase_dir}/${plan}-SUMMARY.md`
  ) to orchestrator
  call recordBlockGateFired({
    skill: 'auto-execute-phase',
    phase,
    question_id: openBlockers[0].id,
    attempted_artifact_path: `${phase_dir}/${plan}-SUMMARY.md`,
    timestamp_ms: Date.now()
  })
  RETURN — do NOT write SUMMARY.md; do NOT call update_current_position; do NOT call git_commit_metadata
```

### 6. Add artifact recording format

In the SUMMARY.md frontmatter, add:

```yaml
key-decisions:
  - "[Rule 4 - Architectural] [decision summary]: [operator response]"
  - "[checkpoint:decision] [name]: [operator choice]"
block-gate:
  questions-asked: N
  block-questions-answered: N
  flag-defaults-used: N
```

In the SUMMARY.md body, under `## Deviations from Plan`, add subsection:

```markdown
### Block Gate Activity
- BLOCK questions asked: N
- Answers received: N
- BLOCK gate fired (write prevented): [yes/no]
- FLAG defaults applied: [list or "none"]
```

## Active-conversation-topics detection

Same as discuss-phase: extract nouns from the last 5 operator messages in this session.
Pass to `classifyQuestion` as `activeTopics`.

## What MUST NOT happen (enforced by this patch)

- Applying a Rule 4 architectural change without operator confirmation → blocked by BLOCK idle protocol
- Advancing past checkpoint:decision via silent default → blocked by BLOCK classification
- Writing SUMMARY.md while a BLOCK question is open → blocked by runtime write gate
- Advancing STATE.md while SUMMARY.md write was blocked → impossible: function returns early before update_current_position

## Insertion points in SKILL.md (by step name)

| Change | Step | Location |
|--------|------|----------|
| BLOCK classification + idle for prev-phase blockers | `previous_phase_check` | Replace/augment SendMessage call |
| BLOCK classification + idle for Rule 4 | `execute`, deviation Rule 4 | Replace ⚠️ Architectural Decision block |
| BLOCK classification + idle for checkpoint:decision | `checkpoint_protocol` | Add to checkpoint type routing table |
| Ordering discipline note | Between `execute` and `create_summary` | New note block |
| Write gate (runtime) | `create_summary` | First line, before file creation |
| Artifact recording format | `create_summary` | SUMMARY frontmatter and body template |

## Interaction with `checkpoint_return_for_orchestrator`

When spawned via Task (subagent) and hitting checkpoint:decision, the subagent currently returns structured state to the orchestrator. This patch does NOT change that mechanism. The change is in the MAIN context path — when execute-phase runs directly (Pattern C) or when the orchestrator is handling the checkpoint response, BLOCK classification applies.
