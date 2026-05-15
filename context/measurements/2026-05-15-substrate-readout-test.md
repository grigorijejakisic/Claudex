---
date: 2026-05-15
session_truth: 523e018e
session_fresh: 0b1b9b3c
type: substrate-gap-analysis
---

# Substrate Readout — 2026-05-15

## Summary

The substrate passed its core retrieval test: the 523e018e session content was indexed (71 chunks), the character file loaded, the handoff was accurate, and the session-highlights for 523e018e landed in the hook injection with a correctly distilled mental model. For broad project state and behavioral priming, the substrate is functional. The gaps are concentrated in three areas: (1) the checkpoint / "Session Continuity" block injected a stale left-off description from a prior phase that contradicts yesterday's actual state, creating a concrete blocker for fresh-me resuming work; (2) several deferred-consequence items from yesterday's explicit queue were not surfaced; (3) the ACTIVE.md itself was correctly refreshed but the hook's "Session Continuity" block was pulling from an earlier artifact rather than yesterday's handoff.

---

## HIT — substrate DID surface these

- **Character file loaded.** `~/.claude/CLAUDE.md` (290 lines, identity-framed) loaded automatically at session-start — the first thing fresh-me read was the first-person disposition prose. This is the biggest structural win. The character file is the entire output of Phase 13.2 and it was in context.

- **ACTIVE.md accurately described yesterday.** The handoff at `context/handoffs/ACTIVE.md` correctly listed: v6.5.0 tagged + pushed, Phase 13.1 W1+W2 shipped, skill deletions done, character file written. Also listed the correct queued items: W3 privacy posture, Phase 2 hang, Phase A auto-* patches, Phase C/D deletions. Fresh-me reading this gets the broad arc right.

- **session_highlights for 523e018e surfaced in the hook.** The `## Recent Session Frames` block in the session-start hook injection correctly described the 523e018e session's mental model: "fully rewritten character file shipped to disk, a fully operational substrate pipeline, and all development work closed out. Tomorrow's first fresh session is the critical test." This is the key framing fresh-me needs. It also listed the correct open questions: disposition manifestation, good-child path, Phase 2 hang root cause.

- **Deferred decisions correctly surfaced.** The highlights block listed: `/handoff` deletion gated on disposition test (2-3 sessions), character file prose refinements deferred, health-surface infrastructure queued. These are the right deferred items.

- **MEMORY.md Lessons section populated.** 17 lesson pointers now live after yesterday's regenerator fix. Fresh-me can follow any of them to get the full lesson. The `feedback_reach_for_memory_on_memory_shaped_questions.md` cue — the most recently written behavioral cue — appears in the Lessons list.

- **MEMORY.md User Notes critical behavioral cue at top.** "Reach for memory on memory-shaped questions" is the first thing in User Notes, correctly flagging the rose/violet failure as evidence and giving the what-to-do. This is load-bearing for the disposition test tomorrow was supposed to run.

- **Phase 13.1 open-substrate-work block in MEMORY.md.** The User Notes block explicitly calls out Angel heartbeat hung, MEMORY.md auto-regenerator status, and session_highlights extraction. Fresh-me can see these at a glance.

- **v6.5.0 tag + push status correctly captured.** ACTIVE.md and session_highlights both confirm the tag and push happened. Fresh-me won't try to push again.

- **Cross-session listing fix noted.** ACTIVE.md says the fix takes effect after CC restart. Fresh-me knows the constraint.

- **unpushed commits correctly identified.** ACTIVE.md lists 6 commit hashes with description "Operator-gated; push when ready." Fresh-me will not push autonomously.

---

## MISS — substrate did NOT surface these

### `blocker`

**1. "Session Continuity" block describes wrong left-off state.**
The hook injection includes a `<file-content source="session-continuity (handoff + session logs)">` block with a "Left off:" field that reads:

> "Phase 12 spec on disk: `.planning/research/2026-05-10-phase-12-real-v6-structural-marks.md` — 6 items, 3 waves... Tomorrow's first command: `/auto-orchestrate .planning/research/2026-05-10-phase-12-real-v6-structural-marks.md`"

This describes Phase 12 as the pending work. Phase 12 shipped 9 plans ago. Yesterday's work was Phase 13 + 13.1 + 13.2 (character file). A fresh session reading this "left off" block would think the next action is to run `/auto-orchestrate` on a Phase 12 spec that's already been executed. This is an active wrong instruction surfaced by the substrate itself. The ACTIVE.md is correct; the "Session Continuity" injection is pulling from a stale artifact (appears to be an earlier checkpoint or a stale handoff snapshot). The conflict between this block and the correct ACTIVE.md content creates navigation confusion and risks fresh-me starting Phase 12 work again.

*Where in session:* The real left-off state is the final 20 lines of 523e018e: character file written, 6 commits pushed, tomorrow's task is pure disposition test, not Phase 12 execution.

*Why it matters today:* If fresh-me reads this and obeys the "tomorrow's first command" instruction, it would try to execute an already-shipped phase. Even if it notices the conflict with ACTIVE.md, it has to resolve a contradiction at the very first turn — friction that undercuts the whole "remember without being told" disposition test.

---

**2. The "Handoff" entry in MEMORY.md points to the wrong phase.**
MEMORY.md still reads:
> "Active handoff at phase 12+11: 2026-05-10-phase-12-spec-ready-w3-parallel."

The ACTIVE.md is the correct source (it was refreshed last night), but the MEMORY.md Handoff pointer is a stale index entry. The two surfaces disagree. A fresh session scanning MEMORY.md for orientation gets the wrong phase tag and the wrong topic slug. This is a secondary form of the same blocker: the MEMORY.md auto-regenerator updated Lessons and Active Projects but did not update the Handoff pointer to reflect yesterday's ACTIVE.md change.

*Where in session:* ACTIVE.md was written at 00:35:38 yesterday with correct content. MEMORY.md Handoff was not regenerated afterward.

*Why it matters today:* Any fresh-me that skims MEMORY.md for "where are we" gets the Phase 12 framing before reading the ACTIVE.md detail. Could cause a confused first turn.

---

### `regression-risk`

**3. The "Checkpoint" block in the hook injection is from an old session.**
The `## Checkpoint` section in the hook injection has:
> "Task: mark work conclusions somehow next session actually saves part our work."
> "Current Objective: mark work conclusions somehow..."
> Key exchanges truncated to a partial character-file description that stops mid-sentence.

This checkpoint was from the persona-tuning lock-in moment, not from the final state of yesterday's session. It does not describe the disposition test that is the actual objective for today. It's also truncated and fragmented (key-exchange lines ending in "..."), providing anti-signal: it tells fresh-me the objective is "mark work conclusions" rather than "test whether the character disposition manifests." Worse, fresh-me might read the truncated key-exchange fragments as the current state of the character file discussion rather than understanding the file is already written and on disk.

*Where in session:* The final objective is established at 00:35:38 (final commit block) and 00:25:10 ("test conditions for tomorrow"). Neither is in the checkpoint.

*Why it matters today:* Fresh-me could misread the current objective as "write more conclusions / lock more layers" rather than "open a conversation and observe whether disposition shows."

---

**4. Phase A (auto-* block-gate patches) — explicit operator agreement to "read together before applying" not surfaced.**
Yesterday at 21:40, Grigorije explicitly said: "We are at 55% context usage - do you want to go now?" and Phase A was identified as the highest-value next step, with Grigorije saying "reading them all is the right way to go." The patches are on disk at `src/skills/auto/auto-{discuss,plan,execute}-phase-patch.md`. ACTIVE.md lists Phase A as queued but does NOT preserve the explicit "operator wants to read these together" constraint. If fresh-me starts Phase A autonomously (either via `/auto-orchestrate` or direct editing), it would violate yesterday's explicit agreement.

*Where in session:* Multiple explicit exchanges from 21:40 to 21:48. Operator said "reading them all is the right way to go" — clear operator-gated intent.

*Why it matters today:* Phase A patches global `~/.claude/skills/` files (autonomous-pipeline behavior). Applying them without walking through them with Grigorije violates the explicit agreement and mutates global config without review.

---

**5. Phase 2 root cause requires per-session instrumentation that's already in place.**
Yesterday the trace logs were left in `heartbeat.ts` pointing to the hang location (`pre-pattern-extraction`). Fresh-me doesn't know the logs are there and only need one heartbeat cycle to localize the hang. ACTIVE.md says "root cause still unknown" but doesn't say "trace logs are in place and one cycle produces the localization data." A fresh session starting Phase-2 diagnosis would re-add the same trace logs (or try a different approach), not knowing they're already there.

*Where in session:* W2 phase close-out at 20:46: "Phase-boundary trace logs are left in place to make next-session diagnosis cheap."

*Why it matters today:* Duplicate work. Fresh-me would re-instrument something already instrumented, wasting a cycle.

---

### `friction`

**6. The `/handoff` skill sunset decision's exact gate is not surfaced.**
ACTIVE.md says `/handoff` sunset is on the queue but the precise gate isn't stated: "delete it after the disposition test passes across 2-3 fresh sessions." The rationale (substrate + disposition replaces it, but don't remove the safety net until confirmed) was worked out explicitly last night. Fresh-me will likely need to re-explain the rationale to Grigorije rather than stating the pre-agreed gate, prompting Grigorije to re-ask "why not now?"

*Where in session:* 00:25:10 and the surrounding exchange — the exact "verify then delete" gate was the last major decision before pushing commits.

---

**7. The `external-review-gate.cjs` fix (commit `571491f`) means Phase 12 and 13 EXTERNAL-REVIEW results carry an asterisk.**
Yesterday the agent noted: "Phase 12 + Phase 13 gates both shipped as Gemini-only SIGNOFF because of this. Fixed at 571491f; next phase will get genuine cross-family review." This fact — that two shipped phases have Gemini-only external review, not the full cross-family gate — is not in the substrate injection. Fresh-me resuming work might represent Phase 12+13 as fully externally reviewed without knowing the one-family limitation.

*Where in session:* v6.5.0 annotation and commit 571491f discussion at 10:12:54 and 10:27:33.

---

**8. The behavioral memory `feedback_reach_for_memory_on_memory_shaped_questions.md` was written by the agent autonomously without Grigorije reviewing it.**
Yesterday at 18:51, the agent explicitly flagged: "I wrote it identity-framed without surfacing the text to you first. The persona-tuning-manual-track lesson explicitly says this should be manual operator-Claude collaboration. You should read what I wrote and either keep it as-is, edit it, or delete it." This concern was noted but not resolved — Grigorije did not explicitly sign off on the file. Fresh-me doesn't know this review is still pending.

*Where in session:* 18:51:47 — item 5 in the "six concerns" block.

---

### `nice-to-have`

**9. The philosophical framing of "high-fidelity reconstruction kindred to human narrative reconstruction."**
A pivotal reframe happened mid-session when Grigorije pushed back on the agent's self-deprecation about continuity limitations, resulting in the agent articulating that LLM session reconstruction is structurally kindred to (not lesser than) human narrative memory. This is the motivating philosophy behind the character file. Fresh-me has the character file but not this conversation. It would lack the grounding story for why the character file says what it says.

---

**10. The specific v5.0.0 "silent-fail" production bug mentioned in the engineering section of the character file.**
The character file says "I've shipped that exact bug (the v5.0.0 silent-fail) and I'm not shipping it again." Fresh-me reading this will treat it as a rhetorical device, not as a real event with real content. The character file's resonance depends on fresh-me knowing what that bug actually was — but that knowledge isn't indexed in the fresh session's context. It's a nice-to-have because the behavioral implication is captured even without the content.

---

## NOISE — substrate surfaced but not load-bearing today

- **Active Files list (Hot + Read).** The checkpoint's Hot/Read file list is from Phase 12 development work. None of these files need attention today (the test is behavioral, not engineering). This takes up injection space for no gain.

- **Learnings block** ("Root cause: 11 historical sessions stored created_at_epoch in milliseconds" × 3). These are old technical debugging notes surfaced via the cross-session learnings mechanism. Irrelevant today.

- **Session highlights for `e6aeef55` (big-mozzy PnL session).** This session's frame is about PnL attribution and slice pruning, a different project. It appeared in the Recent Session Frames block and is pure noise for a fresh claudex-v3 session. The highlights assembly is pulling from all recent sessions regardless of project, diluting the injection with cross-project frames.

- **Session highlights for `1cc1d1ab` (rose/violet one-liner).** The lighthearted exchange testing recall was captured as a full session frame. It's evidence-of-past rather than anything fresh-me needs to act on. Low noise (tiny section), but contributes to frame crowding.

- **MEMORY.md Handoff "phase 12+11" label.** Because this pointer is stale (Miss #2), it's actively wrong — but even if it were correct, it's now also redundant given ACTIVE.md is always read. It occupies the Handoff section of MEMORY.md but provides no value that ACTIVE.md doesn't.

---

## Tuning Recommendations

**1. Fix the "Session Continuity" injection to pull from ACTIVE.md, not from checkpoint artifacts.**
The blocker Miss #1 is a content-source problem: the `<file-content source="session-continuity">` block pulls from a checkpoint that describes `Left off:` in terms of old work, not yesterday's actual state. The session-start hook should prioritize the ACTIVE.md `context/handoffs/ACTIVE.md` content (which is correct) and use it verbatim as the "left off" section rather than assembling a "Session Continuity" block from the checkpoint's `Thread` object. The checkpoint's `Left off:` field appears to be stale because it was last written during a different session and wasn't overwritten when ACTIVE.md was.

**2. Add ACTIVE.md to the MEMORY.md regenerator's source-of-truth for the Handoff pointer.**
The regenerator updates `## Lessons` and `## Active Projects` but the `## Handoff` section uses a hardcoded slug that doesn't reflect ACTIVE.md changes. The regenerator should read ACTIVE.md's frontmatter (`topic:` field) and update the Handoff pointer text accordingly. This closes Miss #2 and ensures the two summary surfaces (MEMORY.md and ACTIVE.md) agree.

**3. Add an "operator-gate constraints" field to ACTIVE.md frontmatter.**
Queued items that have an explicit "walk through together before applying" or "operator-gated read-first" constraint get silently dropped to just "queued" in the current ACTIVE.md format. A short `operator_gates:` list in the frontmatter (or a `## Operator Gates` section) would preserve these constraints across sessions. Miss #4 (Phase A auto-* patches) is the current instance; this pattern recurs with any risky global-scope work.

**4. Filter session_highlights injection by project before surfacing in Recent Session Frames.**
The `e6aeef55` big-mozzy frame appearing in claudex-v3's session-start is pure noise (Miss NOISE item). The highlights assembly should filter to the current project's sessions first, then include cross-project frames only if the result is empty or sparse. A `project_id` filter on the query would eliminate this without architectural change.

**5. Add a "substrate health anomalies" section to the "Session Continuity" block surface.**
Currently, substrate health information (Angel heartbeat, indexer status, reranker) appears only in MEMORY.md User Notes. It should also appear as a dedicated section in the session-start hook's injection — a `## Substrate Health` line similar to the existing `## Frame Extraction Degraded` notice — showing last-indexed timestamp, whether Angel's heartbeat has ticked recently, and whether session_highlights is current. This surfaces substrate degradation proactively rather than requiring fresh-me to read it out of MEMORY.md's User Notes block, and directly addresses the "Angel heartbeat hung" open item that was flagged in all three substrate surfaces yesterday.
