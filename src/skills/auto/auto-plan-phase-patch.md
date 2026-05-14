# Patch: auto-plan-phase — silence-means-escalate fix

**Status:** APPLIED 2026-05-15 — patch content appended to `~/.claude/skills/auto-plan-phase/SKILL.md` as a clearly-labeled "Operator-applied patch" section at the end of the file. Reversible by deleting that section. Tomorrow tests whether the appended rules are picked up at skill-invocation time.
**Phase:** 12-real-v6-structural-marks
**Context:** 12-CONTEXT.md Q [12-09/Q1] operator-locked answers

## Problem

The skill currently fills operator-silence with defaults when SendMessage questions go unanswered. During plan-phase, the critical failure mode is: receiving no CONTEXT.md response → defaulting to "Continue without context" → writing PLAN.md files without operator input on structural decisions.

## Shared module

All three auto-* skills import `src/skills/auto/block-gate.ts` for:
- `classifyQuestion(question, activeTopics, skillClassification)` → 'BLOCK'|'FLAG'
- `checkOpenBlockers(questionLog)` → open BLOCK questions
- `shouldWriteArtifact(questionLog)` → false if any BLOCK is open
- `buildBlockedMarker(skill, phase, openBlockers, artifactPath)` → blocked message
- `buildTerminalBlockMessage(skill, phase, openBlockers)` → terminal shutdown message
- `recordBlockGateFired(event)` → telemetry to ~/.claudex/block-gate-log.jsonl

## Skill process structure (plan-phase)

Steps where changes are needed:
- Step 4 `Load CONTEXT.md` — sends SendMessage when CONTEXT.md is missing (BLOCK: no context = no plan)
- Step 5 `Handle Research` — sends SendMessage when research is blocked (FLAG: can skip)
- Step 6 `Check Existing Plans` — displays options (FLAG: planner decides)
- Step 9 `Handle Planner Return` — handles CHECKPOINT REACHED (BLOCK: checkpoint:decision type)
- Step 11 `Handle Checker Return` — issues found, may need orchestrator input (FLAG: revision loop)
- Step 12 `Revision Loop` — max iterations offer (FLAG: orchestrator can force proceed)
- The planner agent writes PLAN.md files — the orchestrator here writes no artifact directly

## Required changes to SKILL.md

### 1. Classify the "no CONTEXT.md" question as BLOCK

In Step 4 (`Load CONTEXT.md`), when sending SendMessage for missing context:

```
The missing-CONTEXT.md question is classified as BLOCK:
  classifyQuestion(
    'No CONTEXT.md found. Plans will use research and requirements only — user design preferences excluded.',
    activeTopics,
    'FLAG'
  )
  → auto-promoted to BLOCK by "methodology" fixed-category floor
    (planning methodology without design decisions is a structural choice)

BLOCK IDLE PROTOCOL applies:
  - Send the question to orchestrator
  - Skill idles; does NOT default to "Continue without context"
  - At ~10-min intervals: restate "Awaiting answer on CONTEXT.md choice before planning begins"
  - After ~30 min: send buildTerminalBlockMessage('auto-plan-phase', phase, openBlockers)
  - Orchestrator AskUserQuestion escalation
  - Skill shuts down — does NOT spawn planner with silent default
```

### 2. Classify the "checkpoint:decision" return as BLOCK

In Step 9 (`Handle Planner Return`), when planner returns `## CHECKPOINT REACHED`:

```
Checkpoint returns are classified by type:
  - checkpoint:human-verify → FLAG (skill can surface and proceed after acknowledgment)
  - checkpoint:decision → BLOCK (structural choice; must not be defaulted)
  - checkpoint:human-action → FLAG (action is manual but decision is already made)

For checkpoint:decision:
  classifyQuestion(checkpoint_content, activeTopics, 'BLOCK') → always BLOCK

BLOCK IDLE PROTOCOL applies:
  - Present checkpoint content to orchestrator via SendMessage
  - Skill idles; does NOT auto-pick an option
  - At ~10-min intervals: restate the decision
  - After ~30 min: buildTerminalBlockMessage; orchestrator escalation
```

### 3. Add question-before-write ordering discipline

Add ordering note before Step 9 (`Handle Planner Return`):

```
ORDERING DISCIPLINE: The skill asks BLOCK questions before the planner agent writes PLAN.md.
The spawn-planner step (Step 8) is preceded by CONTEXT.md validation.
If the CONTEXT.md question is BLOCK and open, Step 8 (spawn planner) does not execute.
```

### 4. Add write gate for the "planning complete" path

When the planner agent returns "PLANNING COMPLETE", the orchestrator verifies files on disk.
Insert BLOCK gate before the disk verification / proceed-to-step-10 path:

```
WRITE GATE CHECK (after planner returns PLANNING COMPLETE):
if (checkOpenBlockers(questionLog).length > 0):
  // BLOCK question was asked but not answered — planner should not have been spawned
  // This is a defensive check for race conditions or resumed sessions
  send buildBlockedMarker(
    skill='auto-plan-phase',
    phase,
    openBlockers=checkOpenBlockers(questionLog),
    attemptedArtifactPath=`${phase_dir}/*-PLAN.md`
  ) to orchestrator
  call recordBlockGateFired({ skill, phase, question_id, attempted_artifact_path, timestamp_ms })
  RETURN — do not proceed to Step 10 (plan checker) or Step 13 (present final status)
```

### 5. Add artifact recording format

The plan-phase skill writes PLAN.md files via the planner agent. Instruct the planner agent:

```
In the planner prompt, add to <planning_context>:

## Operator-Locked Answers (BLOCK-class)
<!-- Filled by auto-plan-phase orchestrator when operator answered a BLOCK question -->
{if blocked_questions_answered}
- Q [{phase}/CONTEXT-MISSING]: Context decision: {operator_answer}
{/if}

## Defaults Used (FLAG-class)
<!-- Filled by auto-plan-phase orchestrator for FLAG questions auto-resolved with defaults -->
{if flag_defaults_used}
- Q [{phase}/SKIP-RESEARCH]: Research skipped (flag default — existing research used)
{/if}
```

## Active-conversation-topics detection

Same as discuss-phase: extract nouns from the last 5 operator messages in this session.
Pass to `classifyQuestion` as `activeTopics`.

## What MUST NOT happen (enforced by this patch)

- Spawning the planner agent while a BLOCK question (no-CONTEXT.md, checkpoint:decision) is open → blocked by idle protocol
- Proceeding past "CHECKPOINT REACHED" with checkpoint:decision type via silent default → blocked by BLOCK classification
- "Eventually defaulting" to "Continue without context" when operator does not respond → impossible: no timeout produces a FLAG-default for BLOCK

## Insertion points in SKILL.md (by step number)

| Change | Step | Location |
|--------|------|----------|
| BLOCK classification for no-CONTEXT.md | Step 4 | Before SendMessage call |
| BLOCK idle protocol for no-CONTEXT.md | Step 4 | After SendMessage call |
| BLOCK classification for checkpoint:decision | Step 9 | In CHECKPOINT REACHED handler |
| BLOCK idle protocol for checkpoint:decision | Step 9 | After SendMessage for checkpoint |
| Ordering discipline note | Between Step 4 and Step 8 | New note block |
| Write gate (defensive) | Step 9, after PLANNING COMPLETE | Before disk verification |
