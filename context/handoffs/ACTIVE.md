---
status: active
phase: "14-07 v7.0.0 spec READY for /auto-orchestrate Wave 1 dispatch (operator-gated)"
summary: v7.0.0 spec authored + verified + corrected on 2026-05-16. Wave 0 mostly shipped (auto-commit hooks LIVE, CLAUDE.md verify-before-done rule LIVE, /verify skill REGISTERED procedural form; w0d sections.ts split is FORWARD work gating Wave 2/3 entry). 9 spec docs corrected for file paths, function names, schema mapping (14-07a loss-map from RCA-3), worker split (W1-W5 for 15 caller files), experience-tier direction (option C). 14-07b has 18 W-worker tasks (verified XML well-formed). Locked Decisions 8 (Wave 0) and 9 (experience-tier preserve cross-project) added. Auto-commit hooks tested via exact-registered-command invocation (session-start tag confirmed firing). /verify run end-to-end against today's diff — VERIFIED. Wave 1 dispatch gated only on operator skim + fresh-session hook test + `/auto-orchestrate` invocation.
topic: 2026-05-16-v7-ready-for-wave1-dispatch
created_at_epoch_ms: 1779816600000
---

# 2026-05-16 — v7.0.0 spec complete; Wave 1 dispatch operator-gated

**What we found:** Today's session re-framed v7.0.0 from "V17 unification + knowledge-graph linking" (the 2026-05-15 sketch) to **session-start coherence as the user-facing goal** with three waves serving it. Operator-confirmed re-frame 2026-05-16 12:08 after the agent surfaced that session-start "felt like reading, not remembering" even with the existing substrate. Spec authored end-to-end in one session: 15 deliverables, ~thousands of lines, production-quality plan format matching v6.6.0 conventions. Three operator review gates embedded inside Wave 2 (14-07f UX simulation) + Wave 3 (14-07h migration tool dry-run) + final ship (14-07j qualitative gate on big-mozzy + claudex-v3).

**What we decided:**

1. **v7.0.0 = three waves, strict-sequential execution.** Locked Decision 7 in CONTEXT (operator-confirmed 2026-05-16 12:25). Wave 1 substrate unification ships fully before Wave 2 knowledge graph dispatches; Wave 2 ships fully before Wave 3 session-start coherence dispatches. Trade-off: slightly slower wall-clock than parallel-overlap, but execution simplicity for /auto-orchestrate.
2. **Wave 3 (session-start coherence) is part of v7.0.0**, not split as v6.7.0 intervening release. Per operator confirmation 2026-05-16 12:08.
3. **Regenerator + experience-pattern project-scoping folded into 14-07h** (not split as v6.6.1). Per operator confirmation 2026-05-16 12:14.
4. **Hard-link writer = option C hybrid** carries forward (Locked Decision 2 from yesterday). Soft links autonomous (14-07d); hard links propose-confirm-commit per Good Child policy (14-07f).
5. **14 position-unless-flagged decisions** baked into the spec — the agent took positions across Wave 1 (V17 ID derivation, read-only enforcement, re-vectorization threshold), Wave 2 (project denormalization, decay threshold, boost formula + tier weights, boost flag-off, proposer rate limits, provenance exclusions, hop caps), and Wave 3 (experience scope default, lesson relevance weights, top-K + budget, codebase-context annotation format). All interruptible by operator before Wave 1 dispatch.
6. **"Take position unless flagged"** confirmed 2026-05-16 12:14 as a default behavior pattern to use *always* — see `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/feedback_take_position_unless_flagged.md`.
7. **"Periodic work updates during autonomous spans"** confirmed 2026-05-16 12:51 — see `feedback_periodic_work_updates.md`. Brief progress updates at wave/milestone boundaries.

**What's next:** Operator-gated action items:

- **v6.6.0 push** — annotated tag at `a3b3a42` locally; carries forward from yesterday's gate. Same posture as v5.0.0 and v6.0.0.
- **v7.0.0 spec review** — read through `.planning/phases/14-substrate-coherence/14-07-CONTEXT.md` + the 14 wave/plan docs; flag any positions-unless-flagged you want pivoted before Wave 1 dispatches.
- **/auto-orchestrate Wave 1 dispatch** — user-triggered slash command; the agent cannot launch it. Per WAVE1-COORDINATION the workers are: A solo (14-07a schema) → B1/B2/B3 parallel (14-07b caller migration across ~22 sites split by code path) → C solo (14-07c cutover + benchmark gate).
- **(Optional) cross-family review** — /codex-review or /gemini-review the spec for second eyes before Wave 1 dispatches.

After Wave 1 lands (legacy artifacts read-only mirror + V17 unified + benchmarks non-regressed), Wave 2 dispatches. After Wave 2 (link substrate + claudex_trace MCP + Provenance Chain assembly surface), Wave 3 dispatches. After Wave 3 (regenerator fixed + lessons trigger frontmatter + link-aware inline-expansion), the v7.0.0 final ship gate runs — including the **qualitative operator-confirmation gate: does session-start feel "remembered" not "read"?** Operator-runnable on big-mozzy + claudex-v3.

**Where to look:** `.planning/phases/14-substrate-coherence/14-07-CONTEXT.md` (phase-level spec with 7 locked decisions); `.planning/phases/14-substrate-coherence/14-07-WAVE1-COORDINATION.md` (Wave 1 PM contract); `.planning/phases/14-substrate-coherence/14-07-WAVE2-COORDINATION.md` (Wave 2 PM contract); `.planning/phases/14-substrate-coherence/14-07-WAVE3-COORDINATION.md` (Wave 3 PM contract); the 11 PLAN.md files (14-07a/b/c, 14-07-LINKS-SCHEMA, 14-07d/e/f/g, 14-07h/i/j); `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/feedback_take_position_unless_flagged.md` (durable operator preference); `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/feedback_periodic_work_updates.md` (durable operator preference); `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-CLAUDEXv3/memory/project_v7_hard_link_writer_is_good_child.md` (Good Child hybrid policy).

## Operator Gates

Honor each gate before acting on the corresponding queued item.

- **v6.6.0 public push**: operator-gated; tag at `a3b3a42` locally. Carries forward from yesterday.
- **v6.0.0 public push**: still operator-gated from the prior cycle (Phase 13's retag pending). Carries forward.
- **v7.0.0 Wave 1 /auto-orchestrate dispatch**: operator-gated; agent cannot launch slash commands. **Spec is READY as of 2026-05-16 17:31** — all preconditions met from agent side; only operator skim + fresh-session hook empirical test remain before invoke.
- **v7.0.0 Wave 1c cutover** (`14-07c`): operator-gated via `--apply` + typed `CONFIRM` prompt; never auto-runs.
- **v7.0.0 14-07f hard-link UX**: operator review of the simulation script output (`bun src/scripts/simulate-hard-link-ux.ts`) is required before enabling `CLAUDEX_HARD_LINK_PROPOSER` flag in production.
- **v7.0.0 14-07h migration tool dry-run** (`migrate-lesson-trigger.ts`): operator reviews dry-run output against existing lesson files before any live run.
- **v7.0.0 final ship qualitative gate**: operator confirms session-start feels "remembered" not "read" on big-mozzy-v2 + claudex-v3. No measurement substitutes.
- **migrate-handoff.ts CLI runs on real projects**: operator-runnable; out of scope for v7.0.0 (carry-over to separate operator-runnable surface).
- **migrate-lesson-frontmatter.ts CLI runs**: superseded by `migrate-lesson-trigger.ts` in 14-07h; operator-runnable.
- **Stray feedback_reach_for_memory_on_memory_shaped_questions.md** carry-over from 2026-05-14 — written autonomously without operator review per the persona-tuning-manual-track rule. Sign-off or rewrite still pending.

## Positions-unless-flagged in v7.0.0 spec (interruptible before Wave 1 dispatch)

The agent took 14 positions in the spec where multiple defensible options existed. Operator may pivot any of them by flagging before Wave 1 dispatches.

| Wave | Plan | Position | Alternative |
|---|---|---|---|
| 1 | 14-07a | V17 ID = sha256 32-char hex from legacy fields | Blob-convert from V17 BLOBs |
| 1 | 14-07a | Read-only legacy enforcement = SQLite triggers | App-layer guards |
| 1 | 14-07a | Re-vectorization via arctic-embed2 from scratch | Blob-convert |
| 1 | 14-07c | Re-vectorization failure threshold = 5% | Tunable |
| 2 | LINKS-SCHEMA | Link rows denormalize `project` at write-time | Read-time JOIN |
| 2 | LINKS-SCHEMA | DECAY_THRESHOLD = 3 rejections | Tunable |
| 2 | 14-07e | Boost = `original × (1 + 0.1 × tier_mult / hop)`, hard 1.0 / soft 0.5 | Different weights / formula |
| 2 | 14-07e | Link-distance boost ships flag-OFF | Ship flag-ON |
| 2 | 14-07e | Reranker preserves source channel match_kind | Mark as 'reranker' |
| 2 | 14-07f | Proposer: max 10/run, rate 1/min/session | Tunable |
| 2 | 14-07g | Provenance walker excludes `contradicts` | Include with separate section |
| 2 | 14-07g | MAX_PROVENANCE_HOPS = 4 | Tunable |
| 2 | 14-07g | Heuristic-gated rendering (pivot mentions decision) | Always-on |
| 3 | 14-07h | Experience-tier passive injection = same-project-only default | Cross-project with `[cross-project]` label |
| 3 | 14-07i | Codebase-context annotation = raw query + score | NL-synthesis via LLM |
| 3 | 14-07j | Lesson relevance = 0.6 × trigger + 0.4 × link distance | 50/50 or 80/20 |
| 3 | 14-07j | Top-K inline = 3 (cap 5), 400 token budget | Tunable |
| 3 | 14-07f / 14-07i | Annotation format = position-unless-flagged | NL-synthesis adds cost |
