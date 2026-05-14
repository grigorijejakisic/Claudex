# Patch: auto-discuss-phase — silence-means-escalate fix

**Status:** APPROVED — apply to `~/.claude/skills/auto-discuss-phase/SKILL.md`
**Phase:** 12-real-v6-structural-marks
**Context:** 12-CONTEXT.md Q [12-09/Q1] operator-locked answers

## Problem

The skill currently fills operator-silence with "Claude's Discretion" defaults when SendMessage questions go unanswered within the skill's internal timeout window. Concrete failure: 2026-05-10 discuss-12 filled six gray areas with defaults and committed 12-CONTEXT.md while operator input was in flight.

## Shared module

All three auto-* skills import `src/skills/auto/block-gate.ts` for:
- `classifyQuestion(question, activeTopics, skillClassification)` → 'BLOCK'|'FLAG'
- `checkOpenBlockers(questionLog)` → open BLOCK questions
- `shouldWriteArtifact(questionLog)` → false if any BLOCK is open
- `buildBlockedMarker(skill, phase, openBlockers, artifactPath)` → blocked message
- `buildTerminalBlockMessage(skill, phase, openBlockers)` → terminal shutdown message
- `recordBlockGateFired(event)` → telemetry to ~/.claudex/block-gate-log.jsonl

## Skill process structure (discuss-phase)

Steps where changes are needed:
- `present_gray_areas` — sends SendMessage with area choices (multiSelect)
- `discuss_areas` — sends SendMessage for each decision question (4 questions per area)
- `write_context` — writes CONTEXT.md (the artifact write step)

## Required changes to SKILL.md

### 1. Add question classification in `discuss_areas` step

In the `discuss_areas` step, when building decision questions for each area:

**Before sending each question via SendMessage:**

```
For each question to ask:
1. Classify: call classifyQuestion(question, activeTopics, 'FLAG') → BLOCK or FLAG
   - activeTopics = key nouns extracted from the operator's last 5 messages in this session
   - Default skill classification for discuss-phase questions is 'FLAG'
   - Exception: if question touches scope / methodology / prerequisite / wave structure / active topic → auto-promoted to BLOCK by the fixed-category floor
2. If BLOCK:
   - Send via SendMessage; mark as open BLOCK in questionLog
   - DO NOT ask additional questions while this BLOCK is open
   - DO NOT move to the next gray area while this BLOCK is open
   - Idle and wait (see BLOCK idle behavior below)
3. If FLAG:
   - Send via SendMessage; mark as open FLAG in questionLog
   - If orchestrator does not respond within ~5 min: proceed with documented default
   - Record default in the "Defaults Used" section of CONTEXT.md
```

### 2. Add question-before-write ordering discipline

In `<process>`, add this ordering note before `write_context`:

```
ORDERING DISCIPLINE: All questions are asked before CONTEXT.md is written.
The write_context step is the FINAL step. No CONTEXT.md is written while
any BLOCK question is open. This is enforced by the runtime write gate below.
```

### 3. Add BLOCK idle behavior

Insert into `discuss_areas` step, after the SendMessage for a BLOCK question:

```
BLOCK IDLE PROTOCOL (when awaiting BLOCK answer):
- Skill idles without writing
- At ~10-min intervals: send polite restate via SendMessage:
  content: "Still awaiting your answer on: [question summary]. This is a BLOCK-class question
            — skill will not proceed or write CONTEXT.md until answered."
  to: "orchestrator"
- After ~30 min total no-response:
  1. Send buildTerminalBlockMessage(skill='auto-discuss-phase', phase, openBlockers) via SendMessage to orchestrator
  2. Orchestrator surfaces via AskUserQuestion to user
  3. Skill shuts down idle loop — does NOT write a default-filled CONTEXT.md
```

### 4. Add runtime write gate

In `write_context` step, insert at the TOP before any file writing:

```
WRITE GATE CHECK:
if (!shouldWriteArtifact(questionLog)):
  send buildBlockedMarker(
    skill='auto-discuss-phase',
    phase,
    openBlockers=checkOpenBlockers(questionLog),
    attemptedArtifactPath=`${phase_dir}/${padded_phase}-CONTEXT.md`
  ) to orchestrator
  call recordBlockGateFired({
    skill: 'auto-discuss-phase',
    phase,
    question_id: openBlockers[0].id,
    attempted_artifact_path: `${phase_dir}/${padded_phase}-CONTEXT.md`,
    timestamp_ms: Date.now()
  })
  RETURN without writing. DO NOT proceed to verify or git_commit.
```

### 5. Add artifact recording format

In the CONTEXT.md template, add two sections after `<decisions>`:

```markdown
## Operator-Locked Answers (BLOCK-class)
<!-- Questions that required operator input before writing could proceed -->
- **Q [{phase}/{Q-id}]:** [question summary]
  - Answer: [operator response]
  - Reasoning: [why this classification was BLOCK]
  - Timestamp: [ISO]

## Defaults Used (FLAG-class)
<!-- Questions where FLAG classification allowed proceeding with a documented default -->
- **Q [{phase}/{Q-id}]:** [question summary]
  - Default chosen: [value]
  - Reasoning: [why this default is safe per spec/codebase patterns]
  - Operator-override path: [how to revisit if needed]
```

## Active-conversation-topics detection

The fixed-category floor (auto-BLOCK) includes "active-conversation topics". Extract them:

```
const activeTopics = extractActiveTopics():
  // Read last 5 operator messages from current session
  // Tokenize: extract nouns and technical terms (≥5 chars, non-stopword)
  // Pass the resulting string array to classifyQuestion as activeTopics
```

## What MUST NOT happen (enforced by this patch)

- Writing CONTEXT.md while a BLOCK question is open → blocked by runtime write gate
- Moving to the next gray area while a BLOCK is open → blocked by one-at-a-time BLOCK discipline
- "Eventually defaulting" a BLOCK question → impossible: no timeout produces a default for BLOCK
- Proceeding to `git_commit` step while write gate returned false → impossible: function returns early

## Insertion points in SKILL.md (by step name)

| Change | Step | Location |
|--------|------|----------|
| Question classification | `discuss_areas` | After "For each area: 1. Announce the area:" |
| BLOCK idle protocol | `discuss_areas` | After SendMessage call for BLOCK question |
| Write gate check | `write_context` | First line of step, before `mkdir -p` |
| Artifact recording format | `write_context` | CONTEXT.md template — after `<decisions>` block |
| Ordering discipline note | Between `discuss_areas` and `write_context` | New comment/note block |
