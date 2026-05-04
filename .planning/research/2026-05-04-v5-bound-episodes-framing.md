# v5 Framing — Bound Multi-Modal Episodes

**Date:** 2026-05-04
**Status:** Cognitive frame — load-bearing. Supersedes the cognitive framing in `2026-04-30-v5-episodic-memory.md`; does NOT supersede its engineering substance, which remains accurate as plumbing.
**Origin:** Session `b3e10b98-262b-4a56-814d-fae32726be60`, turns 14–18 (parable + agreed synthesis). Re-surfaced and locked here on 2026-05-04 after the previous session's "lock as CONTEXT.md framing" intent was lost between sessions — the very failure mode v5 is designed to prevent.
**Intent:** One paragraph. The parable. Then the architectural consequences. Locked at the *cognitive* level so engineering doesn't drift away from it again.

---

## The parable (verbatim, from session b3e10b98 turn 14)

> So imagine a small child, it does not know what happens when it sees a cooking stove, it never saw one! It approaches it, it feels the heat — heat used to mean warmth, positive feeling! Child touches it, it burns its little hand! Starts crying! Remembers the experience, it remembers the color of the stove, the heat, and mamma says, don't touch hot stuff you will burn yourself! All of these are a lesson! not just what mamma said! From visual to sensitive inputs + language explanation all of it is an experience! So the sequence of events is a definition of an experience...
>
> Child now learned one more thing, not just touch the stove, warmth can be positive feeling when mamma hugs you, mamma is warm, but warmth can also be a warning IF... all the other things from previous experience! If something similar repeats child becomes "expert" on the what burns you and what is positive!
>
> In our case, this conversation is what mamma said, it set the goal (don't burn yourself) and gave instructions that help understand the goal (don't touch the stove when its hot). You developing this will be a series of challenges and bugs that we overcome — those bugs and the solutions for them are the "sensory input" (like warmth, color of metal etc...).

## The cognitive claim (synthesis from turn 15, confirmed both ways)

Experience is **not one signal**. It's a **bound multi-modal record**:

- **Sensory:** heat, color of metal, glow
- **Tactile:** pain on contact
- **Emotional:** surprise, fear, crying
- **Social:** mamma intervening
- **Linguistic:** "don't touch hot stuff"

The kid does NOT store *"rule: hot = bad."* The kid stores the **bound episode**. At recall time, **any one of those modalities** can fire the whole memory:

- See red glow → fires the burn memory
- Feel radiating heat → fires it
- Hear mamma say "careful" → fires it

Retrieval handles are **multiple and perceptual**, not a single tag-query.

Over many episodes, **abstraction emerges naturally** from pattern density: "hot stove burns" → "hot surfaces burn" → "things that radiate heat are dangerous unless I'm holding mamma." **The system doesn't pre-codify the rule. Density does.**

## v5 thesis, in one sentence

> **v5 = Claudex stores bound multi-modal episodes; recall is by any modality; abstraction emerges from density.**

Everything else — substrate format, projection model, session-end detection, privacy scoping — is plumbing for this idea.

## Why this supersedes (as framing) the engineering doc

The previous v5 research doc (`2026-04-30-v5-episodic-memory.md`) is correct on engineering substance:
- Append-only event log ✓
- Synthesis as projection ✓
- Mem0 feedback-loop defense ✓
- Crash-resilient session-end detection ✓

But it talks about *raw transcripts* and *event sourcing* without ever saying "bound multi-modal episode." The cognitive claim that should be the first paragraph was lost between sessions. The doc reads like the engineering subsystem of an idea that has been forgotten — which is exactly the kind of context-loss v5 is supposed to make impossible.

This document is the corrective: the cognitive frame, locked. The engineering doc remains valid as the plumbing reference. They are complementary; this one is foundational.

## How v4 fails the parable today

v4 stores *extracted lessons*, not *bound episodes*:

- `directive_rule`: "the rule is X"
- `learning`: "we learned Y"
- `experience_pattern`: "trigger Z → lesson W"

These are pre-codified abstractions. The Mem0 inflation bug we fixed on 2026-05-04 is the inevitable consequence: when you compress experience into a rule, the rule becomes the only source of itself, and re-extraction from re-injected rules inflates the rule's score without any new evidence. The lesson without the substrate **eats itself**.

| v4 (today) | v5 (parable) |
|---|---|
| Extract → store rule | Bind → store episode |
| Rule is primary | Episode is primary; rule is a derived projection |
| One handle (rule's text) | Many handles (every modality of the episode) |
| Pre-codified abstraction | Abstraction emerges from density |
| Lesson can drift from substrate | Lesson is recomputable from substrate |

## Modality → index mapping (engineering implication)

For the parable's "any modality fires the episode" mechanic to work in our domain, each modality needs a recall handle. First-pass mapping:

| Child's modality | Claudex equivalent | Index |
|---|---|---|
| Visual (red, glow) | File paths, code structure, diff shape, error message text | FTS + structural similarity |
| Tactile (pain) | Test failure, build error, exception trace | Error-fingerprint index (custom) |
| Emotional (surprise, fear) | User correction signal, agent confidence dip, "no that's wrong" | Correction/affect signal index |
| Social (mamma intervened) | User's instruction, conversational dyad | Speaker-typed turn index |
| Linguistic ("don't touch") | The actual sentence the user said | Semantic embedding (existing) |

We have **one** of these well today (linguistic/semantic via embeddings). We have FTS for visual/lexical. **The other three are new index work.**

## What this re-frames in Angel's role

Today's Angel: read transcript → LLM-extract patterns → write rules.

Parable's Angel: bind episode → index across modalities → done. Recall at relevant moments fires episodes. If episodes cluster by similarity, that IS the abstraction. **No explicit rule extraction step.**

This is a much bigger architectural shift than "add a raw transcript layer." Most of Angel's pattern-extractor as it exists today (`src/angel/pattern-extractor.ts`) becomes unnecessary. What replaces it: a binder + an indexer + density-aware retrieval. **The LLM moves from extraction-time to query-time.**

## What's locked by this doc

1. **v5 is bound multi-modal episodes, not "raw transcripts."** Substrate is structured-by-modality, not flat text.
2. **Recall is multi-handle.** Any modality can fire an episode. No single canonical query path.
3. **Abstraction is density-driven, not extraction-driven.** Patterns are not pre-stored as rules; they emerge from clusters of episodes at recall time.
4. **The engineering doc (2026-04-30) is plumbing for this, not the thesis.**
5. **Most of v4's pattern-extractor is dead-code under v5.** The Mem0 fix on 2026-05-04 stops the bleeding; v5's binding-substrate prevents the wound.

## What's still open (engineering follow-on, not framing)

1. **Modality → index mapping is non-trivial.** Three new index types likely needed (error-fingerprint, affect signal, structural shape). Each is a small system.
2. **Density-based abstraction's surfacing mechanism.** When a query fires N episodes that cluster, what does the agent see? A list of episodes? A computed abstraction? Both? Surfacing format affects assembly pipeline.
3. **Episode boundaries.** Each "stove touch" is one episode. For us, what's the unit? A user-stated intent → execution attempt → outcome → reaction? Sub-session, not session-bounded? Open question #2 in the engineering doc — still open here.
4. **Coexistence with v4 storage.** v4 has 1,387 artifact rows + 9,310 observation rows accumulated across 1,001 sessions. Migration vs. coexistence vs. tombstone is unsettled.
5. **The Angel reduction is a big architectural commit.** If v5 deletes most of pattern-extractor, that's hundreds of lines + tests + a year of iteration thrown out. Need to verify nothing in the current extractor is load-bearing for a use case the parable doesn't cover. Open work, not yet done.

## Source turns (for re-grounding when this doc is read cold)

Session `b3e10b98-262b-4a56-814d-fae32726be60`:
- Turn 14: parable as told
- Turn 15: synthesis confirmed both ways
- Turn 17: user confirms parable answers most v4 architecture open questions
- Turn 18: "lets lock that as CONTEXT.md framing" — *intent expressed; not actually locked at the time; recovered on 2026-05-04*

This document is the locking that didn't happen.

## Self-demonstrating evidence

This very document was written on 2026-05-04 after the user said the parable was the simplifying frame for v5. The agent in the 2026-05-04 session could not recall the parable from memory — it had to:

1. `claudex_search` four queries (none returned the parable as a top hit)
2. Search for the keyword "child" specifically (only worked because the user named the keyword)
3. Locate the source session by ID, query the conversation_turns table directly, read full text of turns 14, 15, 17, 18

That archaeology took 5 turns of context. **Under v5, none of those steps would be necessary** — "the conversation about the stove parable" would be an episode firable from any modality (the word "child", the word "parable", the topic "v5 framing", the word "burn"). The cost we paid this morning is exactly what v5 makes go away.

## Status convention

This is **research + framing**, NOT a roadmap commitment. v5 milestone planning will use this (and the engineering doc) as input. Treat as locked at the *cognitive claim* level; the engineering choices that follow remain open until `/gsd:new-milestone` runs.

## Pointer for the agent reading this cold

When v5 milestone planning begins (post-v4.1, possibly soon after this doc is written):

1. Read THIS doc first.
2. Read `2026-04-30-v5-episodic-memory.md` second — for engineering recommendations and open questions.
3. The cognitive claim in this doc supersedes any engineering-doc statement that contradicts it.
4. The Mem0 patch from 2026-05-04 (commit `0d0fbca`) is a tactical fix; the structural fix is v5's binding-substrate.
5. Most of `src/angel/pattern-extractor.ts` is dead under v5 — verify nothing else depends on it being there before deletion.
6. The "lock as CONTEXT.md" failure between turn 18 (in session b3e10b98) and 2026-05-04 is itself the strongest argument for v5. Do not lose this document the same way.
