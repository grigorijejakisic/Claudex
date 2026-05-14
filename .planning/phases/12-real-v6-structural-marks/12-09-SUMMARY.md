---
plan: 12-09
phase: 12-real-v6-structural-marks
wave: 3
status: complete
requires: []
provides:
  - block-gate.ts: classifyQuestion, checkOpenBlockers, shouldWriteArtifact, buildBlockedMarker, buildTerminalBlockMessage, recordBlockGateFired
  - auto-discuss-phase-patch.md: exact SKILL.md modifications for silence-means-escalate fix
  - auto-plan-phase-patch.md: exact SKILL.md modifications including methodology/prerequisite fixed-category floors
  - auto-execute-phase-patch.md: exact SKILL.md modifications including architectural-deviation BLOCK rule
affects:
  - auto-discuss-phase, auto-plan-phase, auto-execute-phase behavior (when operator applies patches)
  - Silence-means-escalate behavior for all three auto-* skills
key_files:
  - src/skills/auto/block-gate.ts
  - src/skills/auto/auto-discuss-phase-patch.md
  - src/skills/auto/auto-plan-phase-patch.md
  - src/skills/auto/auto-execute-phase-patch.md
  - src/tests/skills/auto/block-gate.test.ts
---

# 12-09 Summary — Auto-* Skill Silence-Means-Escalate Fix

## What Was Built

**`src/skills/auto/block-gate.ts`** — shared module for all three auto-* skills:
- `classifyQuestion(question, activeTopics)` — returns `'BLOCK'` | `'FLAG'`. Fixed-category floor: scope decisions, methodology choices, prerequisite dependencies, wave-structure decisions, active-conversation topics → auto-promoted to BLOCK regardless of skill's own classification.
- `checkOpenBlockers(questionLog)` — returns open BLOCK questions that have not been answered.
- `shouldWriteArtifact(questionLog)` — returns false if any BLOCK question is open.
- `buildBlockedMarker(question, category)` — structured BLOCK annotation for skill output.
- `buildTerminalBlockMessage(question)` — terminal escalation message for ~30-min timeout.
- `recordBlockGateFired(event)` — writes `block_gate_fired` event to `~/.claudex/block-gate-log.jsonl`.

**Three patch documents** — exact SKILL.md modifications for each auto-* skill, precise enough for the next `/auto-plan-phase` or `/auto-execute-phase` invocation to apply without ambiguity:
- `auto-discuss-phase-patch.md`: BLOCK gate in `discuss_areas`, question-before-write ordering, idle/escalate behavior
- `auto-plan-phase-patch.md`: "no CONTEXT.md" as BLOCK via methodology fixed-category floor; `checkpoint:decision` as BLOCK
- `auto-execute-phase-patch.md`: previous-phase unresolved blockers as BLOCK via prerequisite floor; Rule 4 architectural deviations as BLOCK by definition; `checkpoint:decision` as BLOCK

## Why Patch Documents Instead of Direct SKILL.md Modifications

The SKILL.md files live in `~/.claude/skills/` (global user directory), outside the project CWD. Plan executors operate in the project directory. The patch documents in `src/skills/auto/` are the authoritative spec; the operator applies them to the SKILL.md files as a final step.

## Decision Notes

1. **The 2026-05-10 session concretely demonstrated the failure** — `discuss-12` filled six gray areas with "Claude's Discretion" defaults and committed `12-CONTEXT.md` while operator input was in flight. The fix is structural: BLOCK questions halt artifact writing.

2. **BLOCK wait behavior spec**: idle without writing → polite restate at ~10-min intervals → terminal `blocked_on_operator` SendMessage after ~30 min with orchestrator AskUserQuestion escalation. Silence is escalation, not default.

3. **Fixed-category floor is the key mechanism** — prevents skills from reclassifying BLOCK-worthy questions as FLAG or "discretion." Scope decisions and methodology choices are always BLOCK, period.

4. **Flag ≠ Block** — FLAG questions are noted and allow proceeding with annotation. BLOCK questions halt artifact writing until answered. This distinction is load-bearing.

## Tests

14 tests pass: BLOCK/FLAG classification, fixed-category floor promotion, open-blocker detection, shouldWriteArtifact gates correctly, FLAG does not block writing.
