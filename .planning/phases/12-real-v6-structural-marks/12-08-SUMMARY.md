---
plan: 12-08
phase: 12-real-v6-structural-marks
wave: 3
status: complete
requires: []
provides:
  - context-pull-cues.ts with three cue builder functions
  - detectsWaitForDirection with negative lookbehind fix
  - PreToolUse hook wired: handoff-read and decision-lock cues
  - Stop hook wired: wait-for-direction detection + cue delivery via systemMessage
affects:
  - Retrieval behavior at three key agent moments
  - 12-04 transcript_injection_acceptance signal (cue acceptance tracking)
key_files:
  - src/core/context-pull-cues.ts
  - src/adapters/cc-hooks/pre-tool-use.ts
  - src/adapters/cc-hooks/stop.ts
  - src/tests/adapters/cc-hooks/context-pull-cues.test.ts
---

# 12-08 Summary — Context-Pull Cues

## What Was Built

`src/core/context-pull-cues.ts` exports three cue builder functions and a wait-for-direction detector:

- `buildHandoffReadCue(db, handoffPath, sessionId)` — fires on PreToolUse Read matching handoff paths (`**/handoffs/**`, `**/ACTIVE*.md`). Injects top-3 project session continuity results.
- `buildDecisionLockCue(db, filePath, sessionId)` — fires on PreToolUse Write/Edit matching config/curated-context paths. Asks "did any prior session establish, contradict, or flag this value as UNVALIDATED?"
- `buildWaitForDirectionCue(db, sessionId)` — fires when Stop hook detects wait-for-direction stance. Surfaces unresolved investigation thread from active handoff.
- `detectsWaitForDirection(assistantResponse)` — pattern match with negative lookbehind to prevent false positive on "The agent was previously waiting for direction but has now resumed work."

**Hook wiring:**
- `pre-tool-use.ts` imports `buildHandoffReadCue` and `buildDecisionLockCue`; fires them on path-matched Read/Write/Edit; returns `additionalContext` field to inject into CC's system prompt.
- `stop.ts` imports `detectsWaitForDirection` and `buildWaitForDirectionCue`; appends cue to `systemMessage` return.

## Decision Notes

1. **All cues are advisory — never block the agent's action.** The parable's room teaches; it does not lock the door.

2. **Cue payload format: `[{kind}:{id}] {title} — {snippet}`** with Artifact-ID + provenance. Operator and agent can `claudex_recall(id)` for full content, enabling pull-on-demand beyond the 200-char snippet.

3. **detectsWaitForDirection lookbehind fix** — pattern `/(?<!previously )(waiting for (your )?direction)/i` prevents false-positive on "The agent was previously waiting for direction but has now resumed work." This was a real test failure caught during Phase 12 execution.

4. **Wait-for-direction delivery via systemMessage** — Stop hook delivers the cue in the same turn's response (not deferred to next UserPromptSubmit), using the hook's existing `systemMessage` return mechanism.

5. **Three trigger moments are the three documented burns from Big Mozzy V2** — handoff-reading (W1/s42 typed-decoder miss), decision-locking (W2/s41 fabricated `ttGateWindowMs`), wait-for-direction (W1/s42 bad-child moment). Each cue is a direct structural response to a documented failure.

## Tests

14 tests pass: detectsWaitForDirection detects all 3 patterns and rejects normal responses; buildHandoffReadCue fires on handoff paths and returns system-reminder wrapper; buildDecisionLockCue surfaces UNVALIDATED artifacts; buildWaitForDirectionCue returns valid cue format.
