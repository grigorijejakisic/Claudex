# Phase 13 — Organic Claudex

> **Eliminate the rituals. Make the substrate the room.** /starthere and /endsession exist as evidence the autonomous memory isn't carrying its weight yet. Phase 13 makes it carry the weight, then deletes the skills.
>
> Status: pre-milestone spec (2026-05-14). Begins after Phase 12 close-out, lands before the post-v6 polish window matters.

## TL;DR

Phase 12 closes the v6-polish burn marks. Phase 13 closes the **ritual gap** — every place where the operator currently has to manually trigger memory work because the autonomous channels are failing. The 2026-05-14 PC-crash exercise made the gap concrete: the prior session died, idle-sweep should have ingested it on this session's boot, idle-sweep did not, and the operator had to drive context restoration manually ("go check it out"). That's a substrate failure, not a tooling improvement opportunity.

Phase 13's thesis: **the markdown text of every session, written per-turn to disk in the project folder, is the source of truth.** Everything else — vector chunks, FTS index, embeddings, experience patterns, curated context, learnings — is a derived index over that text. If the index is lost, Angel rebuilds it from the markdown. The agent's first move in any new session is consult the highlights distilled from prior sessions; if highlights don't cover the question, hybrid retrieval searches the full markdown corpus.

When that substrate works, /starthere and /endsession have nothing to do. Phase 13 closes by **deleting them from `.claude/skills/`**. No silent retention — if the autonomous substrate fails the handoff-pickup gate, the substrate gets fixed before the skills are deleted.

## Why this is Phase 13, not v7

The parable's Layer 3 answer (operator-confirmed 2026-05-10 12:40Z): "the parable is the right teaching, but it teaches a child who's in the room. For the child who hasn't met you yet — the next instance — the room itself has to teach. Memory + experience patterns bring some of you with them. Structural gates make sure the room doesn't undo it."

The room teaches. Phase 12 ships the marks the room speaks at high-leverage moments (in-the-moment cues, methodology critique, retrieval ranking). Phase 13 makes the room's *substrate* — the place the room's voice lives — durable, frame-aware, and ritual-free. Without Phase 13, the room is talking from a substrate that:

- Loses everything if a session crashes before clean_endsession (empirically confirmed 2026-05-14: prior session at `afcf6a10-1580-4aae-8157-c6531240f9f7` died on PC crash, has 0 chunks in `transcript_chunk_v6` ~24 hours later — idle-sweep did not recover it).
- Captures observations, decisions, and learnings but not *frame* (the mental model just built, the open questions left dangling, the reframes, the scripts introduced).
- Requires the operator to perform rituals (/starthere, /endsession) to bridge the gap between what got captured and what the next session needs.

Phase 12 ships the marks; Phase 13 makes the marks land on a substrate that doesn't need humans to keep it alive.

## The crash exercise — empirical basis for scope

The 2026-05-14 session opened with the operator-confirmed observation that the prior session died on PC crash. The operator could steer the agent to recovery in one message ("go check it out"). The agent then:

1. Queried `claudex_events` for the prior session — got session-start scaffolding events but no body content.
2. Queried `claudex_search` for the parable session — surfaced the `feedback_good_child_parable.md` memory but only its surface layer.
3. Read the prior session's CC jsonl directly at `~/.claude/projects/.../afcf6a10-1580-4aae-8157-c6531240f9f7.jsonl` — found the full parable conversation, including Layer 2 ("what happens when I /clear") and Layer 3 ("the room itself has to teach") that the memory file had not captured.
4. Confirmed (via direct DB query) that the prior session has zero rows in `transcript_chunk_v6`. The substrate that's supposed to make crash recovery automatic does not, on this corpus, work.

The CC jsonl files contain the full transcript. Claudex's hybrid retrieval cannot see them. That's the gap.

## Audit-trail classification — what the diagnostic surfaced

The 2026-05-14 Big Mozzy V2 retrieval diagnostic (4-agent team: PM + 3 readers + synthesizer) plus the crash exercise produce five concrete failure modes Phase 13 must address:

| # | Failure | Phase 13 response |
|---|---------|-------------------|
| 1 | Crash-killed sessions lose body content (substrate gap) | Sessions/ as per-turn-fsynced source of truth |
| 2 | Idle-sweep does not reliably recover crash-killed sessions | DB-as-derived-index with re-indexer that scans Sessions/ |
| 3 | Frame is not captured — agents get observations, not the mental model | Highlights extraction (Angel session-end distillation) |
| 4 | Operator must manually trigger context restoration each session | Auto-orient at session-start — highlights surface at turn 0 |
| 5 | `/starthere` and `/endsession` exist as ritual compensation | Pull-trigger normalization + deletion of the skills |

These five map 1:1 to Phase 13's six marks (5 + 1 cleanup).

## Scope — the six marks

### 1. Sessions/ as source of truth (text-as-substrate fix)

Every CC session writes per-turn to `<project>/Sessions/<date>_<session-id>.md` — append-only, fsync after each write, both user turns and assistant turns. The file is the durable artifact of the conversation. If the process dies, what's been written is on disk; no batched-ingest commit boundary to cross.

**Why this is in Phase 13 and not v6.x:** the 2026-05-14 crash exercise empirically demonstrated that the current write path (batched at `clean_endsession`) loses crash-killed sessions. The fix is not a tighter batched ingest — it's making the write boundary be every turn. Markdown is the format because (a) human-readable if anyone ever needs to inspect, (b) format-stable across CC version changes, (c) zero dependency on the Claudex DB for durability.

**Specifics to lock:** exact write hook (which CC hook event fires per turn — PostToolUse + UserPromptSubmit + Stop), markdown format (timestamps + `## User` / `## Assistant` headers + body), wrapper handling at write-time (preserve `<system-reminder>` / `<experience-data>` etc. in the raw text — they're part of what actually happened; redaction moves to derivation-time when chunks are created for retrieval), file naming convention (defaults to `<ISO-date>_<session-id>.md`), `.gitignore` default for `Sessions/` (operator opt-in to commit if they want).

**Anti-scope:** this is not the CC JSONL files at `~/.claude/projects/`. Those are CC's own format, machine-readable, and stored outside the project. The Sessions/ file is project-local, markdown, and is what Claudex treats as authoritative. CC's JSONL is still useful as cross-check but does not enter Claudex's source-of-truth contract.

**Probe-tested acceptance:**
- Fixture test: simulate process kill mid-turn; verify `Sessions/<this-session>.md` contains everything up to the killed turn, no partial writes, no JSON corruption.
- Fixture test: simulate clean session end; verify the entire conversation is in the file.
- Coverage: at least 10 real sessions ingested through the per-turn write path with full-content matching against CC's JSONL.

### 2. DB-as-derived-index (recovery-actually-works fix)

The Claudex DB (`~/.claudex/db/claudex.db`) — `transcript_chunk_v6`, vector indices, experience patterns, curated context, learnings — becomes a **derived index over `Sessions/`**, not authoritative state in its own right. If the DB is corrupted, deleted, or migrated to a new machine, Angel rebuilds it by re-reading `Sessions/`.

**The replacement contract:** the existing Phase 8 ingestion pipeline (transcript chunks → embeddings → vec0 store) does not disappear — it becomes the *re-indexer*. It watches `Sessions/` (chokidar or Angel heartbeat), extracts chunks from newly-written or updated files, redacts wrappers at extraction time, produces embeddings via the existing arctic-embed2 path, lands them in `transcript_chunk_v6`. Same code path, different trigger.

**Why this is in Phase 13 and not v6.x:** the 2026-05-14 crash exercise demonstrated the current ingestion pipeline doesn't recover crash-killed sessions even though it's supposed to (idle-sweep via Phase 6 close marker). Either the sweep doesn't fire or it fires and silently fails. The fix isn't a tighter sweep — it's making the recovery path be the same path as the normal path: re-read from Sessions/, re-extract, re-index. Recovery becomes a special case of normal operation, not a separate code path with its own failure modes.

**Specifics to lock:** the watch mechanism (Angel heartbeat tick vs. chokidar vs. polling), the re-index trigger (every N seconds vs. on file-change events), idempotency at the chunk level (the same line in Sessions/ produces the same chunk-id deterministically; re-running doesn't duplicate), wrapper redaction moved from write-time to extraction-time, schema migration if needed (chunk-id derivation may change; V33 migration if so).

**Anti-scope:** this is not a new vector store. `transcript_chunk_v6` stays. The reranker (BGE-v2-m3 port 7439) stays load-bearing. The bi-encoder fallback stays a degraded mode per CLAUDE.md. The change is at the *trigger* and the *recovery posture*, not the retrieval algorithm.

**Probe-tested acceptance:**
- Delete `~/.claudex/db/claudex.db`. Start a new session. Verify Angel rebuilds the chunk index from `Sessions/` within a bounded time window (e.g., 30s for a project with 100 sessions).
- Crash-kill mid-session; start a new session; verify the killed session's content is indexed within Angel's first heartbeat cycle.

### 3. Highlights extraction (frame-aware Angel)

Angel produces a **highlights artifact** per session at session-boundary detection — capturing FRAME, not just events. Frame includes:

- The mental model just built (the current theory of what the project is doing)
- Open questions left dangling (unresolved, not "what's next")
- Reframes that happened (what theory was just abandoned)
- Tools/scripts introduced (filename + what it's for; protects against next session re-deriving)
- Decisions deliberately NOT made (the gray areas the operator and agent agreed to leave open)
- The emotional/posture context if visible from the transcript (e.g., the operator was frustrated about X, that informed why we chose Y)

This is **distinct from existing observation/decision/learning extraction.** Those capture *what happened* — frame captures *what we were thinking about and why we made the calls we did.* Frame is what a human-in-the-loop /endsession conversation produces by saying "remember this for next time."

**Why this is in Phase 13 and not in Phase 12 item 5 (telemetry):** telemetry captures signal — counts, fallbacks, accept/reject rates. Frame is qualitative synthesis, produced by Angel via LLM call against the Sessions/ markdown. Different pipeline. Not coverable by signal collection alone.

**Specifics to lock:** the prompt Angel uses to synthesize frame from a session's markdown, frame artifact schema (probably an extension to the existing `project_curated_context` shape or a new `session_highlights` table), trigger timing (at session-end detection — Phase 6 close marker — and also re-trigger if Sessions/ file modified after that), frame-extraction LLM (likely Claude Opus via OAuth per CLAUDE.md, with Ollama fallback), frame coverage gate (every session in `Sessions/` has a corresponding highlights row).

**Anti-scope:** this is not a replacement for `project_curated_context`. The curated context layer (which the operator and agent collaboratively author at session boundaries today) remains as a higher-level project state. Highlights are per-session frame; curated context is project-level mental model. Highlights feed into curated context over time, but the two are distinct artifacts.

**Probe-tested acceptance:**
- For each of the last 6 Big Mozzy V2 sessions in the diagnostic corpus: Angel produces a highlights artifact that, when injected at the next session's start, makes the next session's agent capable of answering "what was the mental model coming out of session N?" without consulting the raw transcript.
- For the prior session (`afcf6a10`, the parable session): Angel produces a highlights artifact that captures the parable Layer 2 + Layer 3 framing, the auto-* skill bad-child moment, and the operator decision "fold the fix into phase 12." Synthetic check: the next session's agent, given only the highlights, knows to ask about all three.

### 4. Auto-orient at session-start (no /starthere) + temporal awareness

SessionStart hook injects highlights from the latest session(s) + standing curated context + **current timestamp + timezone**, formatted so the agent's first response is informed without a skill invocation. The agent should read this and know:

- Where the project is mentally (not just mechanically)
- What it should reach for first (which Claudex query, which file, which thread to continue)
- What the operator is likely to ask about
- **What time it is right now and what timezone the operator is in** — so freshness reasoning ("this handoff is 3 days old", "this experience pattern was confirmed last week", "the operator was working on this 47 minutes ago") becomes a primitive instead of inferred from string-matched dates the agent may or may not parse correctly.

**Why this is in Phase 13 and not v6.x:** the diagnostic and the crash exercise both showed that current SessionStart injection delivers mechanical state (handoff, hot files, "Left off" summary) but not mental state. The agent reads it and waits for /starthere to orient. With frame-aware highlights, the injection IS the orientation. The agent's first move is "consult Claudex on X" instead of "wait for the operator to drive."

**Why timestamp injection lands here:** the agent has no innate clock. Today's static `userMemory` line says "Today's date is 2026-05-13" and only gets updated when a date-changed system-reminder fires (which is once per day at most). Mid-session the agent has no way to compute elapsed time, no way to evaluate "this memory is 3 days old" except by string-matching against a stale static date. Per-turn timestamp injection makes freshness reasoning a substrate primitive — every Claudex mechanism that reasons about "recent" / "stale" / "this happened just before" gets accurate input.

**Specifics to lock:** which highlights surface at session-start (latest session + N most recent prior sessions for this project + cross-session frame deltas), injection format (probably extends existing `## Session Continuity` / `## Project Curated Context` blocks rather than adding new section), token budget (highlights are dense; cap at fraction of L1 budget), graceful degradation when Sessions/ is empty (first session in a project — fall back to scaffold), **timestamp format (ISO 8601 with timezone offset; e.g., `2026-05-14T00:55:14+02:00`), injection frequency (SessionStart hook + every UserPromptSubmit so long sessions stay timestamp-fresh), timezone resolution from operator profile or system tz (`process.env.TZ` fallback to system).**

**Anti-scope:** this does not replace the existing experience-pattern injection, hot-files surfacing, or critical-rules injection. Those continue. Highlights add to the assembly; they don't replace it. **Timestamp injection does not replace the existing `currentDate` static memory line — the static line stays as a long-lived per-day reference; the per-turn injection adds precision the static line can't have.**

**Probe-tested acceptance:**
- Vesna handoff-pickup probe (existing) passes with the autonomous SessionStart-only injection — no /starthere skill in flight, no operator-led context restoration.
- Probe-pair: same operator first message to the same project under (a) /starthere then ask, (b) just-ask. The agent's response quality (Vesna criterion) is statistically indistinguishable.
- **Temporal-awareness probe: operator asks "how long ago did we discuss X?" where X has a known timestamp in Sessions/. Agent computes elapsed time correctly against the injected current timestamp (not against the static memory line).**

### 5. Pull-trigger normalization (the room as senior engineer)

Builds on Phase 12 item 8's in-the-moment cues. Item 8 surfaces consult hints at three specific moments (handoff-reading, decision-locking, wait-for-direction). Phase 13 item 5 widens that surface and ties it to highlights coverage:

- If the agent's current intention can be answered from the injected highlights → no cue, no extra retrieval.
- If the agent's current intention requires content not in highlights → the room cues a `claudex_search` / `claudex_events` call, naming the kind of artifact to look for (a prior decision, a prior reframe, a prior script).
- Over time, the agent's habit becomes "consult before deciding" — the room teaches the pattern enough that the cue becomes redundant, the way a senior engineer's first move on an unfamiliar codebase is `git log` and `grep` without being told.

**Why this is in Phase 13 and not v6.x:** Phase 12 item 8 ships the substrate; Phase 13 item 5 makes the substrate complete. Without #5, the cues from Phase 12 fire at three moments only. With #5, the cues cover the full range of moments where consult is the right move, gated by highlights coverage so cues don't fire when consult is unnecessary.

**Specifics to lock:** the additional cue surfaces beyond item 8's three (debugging an unfamiliar bug, encountering a new file/script, getting an ambiguous user instruction, etc.), the highlights-coverage check (cheap embedding similarity? lexical-overlap? bespoke?), false-positive bounds, opt-out for engineering-only contexts.

**Anti-scope:** not a refactor of UserPromptSubmit / PreToolUse hooks. Adds new surfaces; doesn't change existing ones. Not a replacement for Phase 12 item 7's retrieval ranking fix — item 7 ensures pull-channel quality, item 5 ensures the agent reaches for the pull channel at the right moments.

**Probe-tested acceptance:**
- Fixture sessions covering 10+ "should-have-consulted" moments where the existing agent does not consult. The Phase 13 item 5 substrate surfaces a cue at each. The agent's next response references the surfaced context (telemetry signal: `transcript_injection_acceptance` from Phase 12 item 5).
- Fixture sessions covering 10+ "highlights already cover this" moments. No cue fires. Agent operates from highlights only. No false positives.

### 6. Skill obsolescence — delete `/starthere` and `/endsession`

After items 1-5 land and the autonomous substrate proves it carries handoff-equivalent quality (per item 4's Vesna handoff-pickup probe), the skills get **deleted** from `.claude/skills/starthere/` and `.claude/skills/endsession/`. Not archived. Not aliased to no-op. Deleted.

**Why deletion, not retention:** the parable's bullet 2 — "skill momentum is not exoneration." Rituals come back if the file is still there. The operator may default to typing `/starthere` out of habit; the agent may default to invoking `/endsession` because the skill exists in the available skill list. As long as the skill exists, the autonomous substrate has a fallback excuse for not carrying the weight. Deletion forces the substrate to be the answer.

**Why this is in Phase 13 and not later:** if items 1-5 land but the skills are retained "just in case," the next session inherits the bad-child structural arrangement. The autonomous channels never get the load-test that proves they work; the operator never gets the empirical evidence that the rituals were the bandage and the substrate is now the body.

**Specifics to lock:** the close-out gate (Vesna handoff-pickup ≥ Phase 12 baseline; one full week of real sessions where /starthere and /endsession are deprecated but not yet deleted, no operator complaints about lost context); the deletion mechanism (`rm -r .claude/skills/starthere/ .claude/skills/endsession/`; commit with a CHANGELOG entry); the rollback contract if the gate fails (items 1-5 reopen; skills do not return).

**Anti-scope:** this does NOT delete `claudex-recall`, `claudex-v3`, `auto-orchestrate`, `auto-discuss-phase`, `auto-plan-phase`, `auto-execute-phase`, `team`, or any other skill. Only `/starthere` and `/endsession` — the two rituals the substrate replaces.

**Probe-tested acceptance:**
- One-week deprecation window after items 1-5 land: skills warn but still function. No operator-reported context-loss incidents.
- After deletion: Vesna handoff-pickup probe passes; first session in a project after deletion produces orientation equivalent to a prior `/starthere` invocation.

## Lines we hold (carried forward from Phase 12)

- Won't redistribute leaked CC source. Won't modify CC and ship a fork. Will reference leaked source for legitimate interoperability if documented APIs fall short. For Phase 13 specifically, documented APIs cover everything — clause is dormant.

## Wave structure

**Wave 1 — Substrate foundation (2 plans)**
- Plan 13-01: Sessions/ as source of truth (item 1). Per-turn write hook + markdown format + fsync contract + fixture crash-resilience tests.
- Plan 13-02: DB-as-derived-index (item 2). Phase 8 ingestion repurposed as re-indexer + watch mechanism + idempotent chunk derivation + DB-rebuild-from-Sessions test.

**Wave 2 — Frame + orientation (2 plans, depend on W1)**
- Plan 13-03: Highlights extraction (item 3). Angel session-end pipeline + frame artifact schema + prompt + coverage gate + 6-session-corpus retrospective test.
- Plan 13-04: Auto-orient at session-start (item 4). Assembly extension surfacing highlights + Vesna handoff-pickup probe re-validation against autonomous-only path.

**Wave 3 — Organic pull + cleanup (2 plans, depend on W2)**
- Plan 13-05: Pull-trigger normalization (item 5). Cue surfaces beyond Phase 12 item 8 + highlights-coverage gating + fixture probes for fire/no-fire bounds.
- Plan 13-06: Skill obsolescence (item 6). One-week deprecation window + Vesna gate + deletion of `/starthere` and `/endsession` + CHANGELOG.

**Close-out**
- 13-CLOSE: External-review-gate dogfood on Phase 13, using the cross-family pipeline Phase 12 Plan 12-01 ships.

## Methodology gates carried forward

Per ROADMAP `Methodology gates promoted from v5 (mandatory for every v6 phase)`:

1. **Pre-committed decision rule** — handoff-pickup quality stays at Phase 12 close-out baseline or better post-deletion (item 6 gate). No goalpost shifts: if Vesna drops, items 1-5 reopen, skills do not return.
2. **Locked corpus and harness across replications** — Vesna probe set is locked at Phase 12 close. Item 4's autonomous-vs-skill comparison uses the same probe set both arms.
3. **Multiple bound measurements before milestone-level claims** — applicable to item 6's deletion gate; one-week deprecation window with at least 10 real sessions before deletion.
4. **Wilson/Newcombe CI binding** — for item 4's probe-pair comparison.
5. **Live-wiring smoke against every production DB shape in the wild (WIR-01 inheritance)** — item 2's re-indexer must work against V32 and any V17-collapsed remnants. Plan 13-02 declares WIR-01 coverage explicitly.
6. **Negative results are valid outputs** — if items 1-5 land but the autonomous substrate fails the Vesna gate, that is a documented Phase 13 result; items 1-5 stay shipped, item 6 deletion is held, the gap is recorded for v7.

## Pre-committed close-out

Phase 13 is **DONE** when:

- All 6 plan SUMMARYs on disk (13-01 through 13-06).
- `bun run build` exits 0.
- `bun run vesna` ≥80% aggregate AND ≥80% per non-empty non-buffer category, including handoff-pickup probe under autonomous-only path.
- `bun run test` (full suite) — no new regressions vs. Phase 12 baseline.
- Sessions/ written per-turn verified across both clean exits and crash-killed sessions (fixture test).
- Highlights artifact produced for every session in Sessions/ (Angel coverage gate; covers at least the 6 most recent sessions in `Sessions/`).
- `transcript_chunk_v6` rebuildable from Sessions/ alone (DB-wipe-then-rebuild test passes).
- One-week deprecation window for /starthere and /endsession completed with no operator-reported context-loss incidents.
- `.claude/skills/starthere/` and `.claude/skills/endsession/` deleted.
- 13-CLOSE external-review-gate dogfood produces SIGNOFF (or LOG with operator acknowledgment).
- STATE.md / ROADMAP.md / REQUIREMENTS.md updated to reflect Phase 13 close.

Phase 13 is **NOT** done if:
- External-review-gate dogfood produces BLOCK and the operator has not addressed the finding.
- Any plan SUMMARY missing.
- Vesna handoff-pickup drops below Phase 12 baseline under the autonomous-only path. (Skills stay deprecated but un-deleted; items 1-5 reopen.)
- DB-rebuild-from-Sessions test fails.
- Per-turn write fixture fails to recover the killed-mid-turn state.

## What is NOT changing in Phase 13

- **The v6 thesis** — deliberation surfacing on the parable substrate. Unchanged.
- **The retrieval algorithm** — hybrid retrieval (vec0 + FTS + reranker), RRF fusion, BGE-v2-m3 reranker. Unchanged; Phase 12 item 7's ranking rebalance ships first and stays.
- **Phase 12 items 1-9** — Phase 13 builds on Phase 12; does not re-litigate any Phase 12 mark.
- **Existing skills** — only `/starthere` and `/endsession` are deleted. All other skills (claudex-recall, claudex-v3, auto-orchestrate, auto-discuss-phase, auto-plan-phase, auto-execute-phase, team, etc.) remain.
- **Angel as a process** — Angel stays the persistent guardian. Phase 13 changes what Angel does (frame extraction, re-indexing) and what triggers it (Sessions/ watch); not whether it exists.
- **CC's JSONL files** — CC continues to write its own JSONL at `~/.claude/projects/`. Claudex does not depend on those for source-of-truth, but they remain useful as cross-check.

## Out of scope — deferred to v7 or beyond

- **Cross-domain control on the claudex-v3-is-strongest hypothesis.** Big Mozzy V2 diagnostic surfaced the question; answering it requires a parallel diagnostic on claudex-v3 sessions for comparison. Not engineering. Captured in `project_quality_variance_across_projects.md`.
- **Pairwise Elo / actual-user-task-success replacing Vesna's binary rubric.** Deferred from Phase 12 to v7. Phase 13 does not re-open.
- **Telemetry verdict structure.** Phase 12 ships signal collection; verdict design happens with data in hand. v6.x.
- **Mid-flight uncertainty-flag without correction.** The agent-2 fabricated-30000 pattern from Big Mozzy V2 W2/s41 — agents that don't get corrected don't create epistemic traces. Phase 12 items 2 and 3 partially address (catch test-time cases); Phase 13 does not solve the mid-session invention case. Deferred.
- **Cross-AGENT validation on Claude as production agent.** v7 work per `project_v6_polish_residual_concerns.md`.
- **Replacing CC's JSONL with Sessions/ markdown for CC's own consumption.** CC keeps its JSONL; Sessions/ is for Claudex. Not in Phase 13 scope.

## Sequencing into the larger arc

Operator-runnable order:

1. Phase 11 W3 close-out (handoff `context/handoffs/ACTIVE.md` 11-step sequence).
2. v6.0.0 local tag retagged with W3 verdict's annotation.
3. Phase 12 — real v6 structural marks (this session's amended spec).
4. Phase 12 close-out (12-CLOSE external-review-gate dogfood).
5. **Phase 13 begins** — this spec scaffolds into `.planning/phases/13-organic-claudex/` via `/auto-orchestrate`.
6. Phase 13 close-out (13-CLOSE external-review-gate dogfood + skill deletion).
7. STATE.md / ROADMAP.md / REQUIREMENTS.md flipped to v6 milestone COMPLETE (now including Phase 13 closure).
8. Public push (operator-confirmed; same posture as v5.0.0).

The handoff at `context/handoffs/ACTIVE.md` will need updating after Phase 12 close-out to point at this Phase 13 spec.

## Audit trail and provenance

This spec was produced 2026-05-14 by a discussion in which:

- The operator opened with a recap of session-61's PC-crash death and tested the agent on recovery posture.
- The operator surfaced the full good-child/bad-child parable across multiple turns, including Layer 2 (somatic burn vs. propositional rule) and Layer 3 (the room teaches the next child).
- A 4-agent diagnostic team read the last 6 Big Mozzy V2 sessions and produced findings on retrieval-fidelity, retrieval-behavior decoupling, divergent-convergence, and cross-domain control.
- The operator proposed eliminating /starthere and /endsession in favor of autonomous substrate carrying the weight, and proposed `Sessions/` as the per-project text-as-source-of-truth folder.
- The agent ran a direct DB query confirming the prior session (which died on crash) has zero chunks in `transcript_chunk_v6`, empirically confirming idle-sweep does not work on this corpus.
- The operator-confirmed framing: "Sessions/ folder in every project, full text per session, Angel produces highlights, agent sees highlights on first user message, vectors find anything not in highlights, /starthere and /endsession deleted."

Memories materialized during this discussion:
- `feedback_good_child_parable.md` (read and extended through Layer 3 — the room teaches the next child).
- This spec is the operationalization of the parable's Layer 3.

## Note on confidence

Phase 13 ships the substrate; confidence in the substrate comes from real-use validation post-deletion, not from shipping Phase 13. The one-week deprecation window is the closest thing to a load-test the substrate can have before the rituals are removed. Confidence after Phase 13: less worried about the failure modes named here. After 1 month of real use post-deletion: more. After 6 months: more.

There is no "finally" event. Phase 13 is the condition under which validation becomes possible. The parable answer was load-bearing for Phase 12's design and remains load-bearing for Phase 13's. After Phase 13, the parable's Layer 3 becomes operational: the room teaches, the next child has the room as their teacher, the rituals are gone because the room is enough.
