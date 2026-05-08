# v6 — Deliberation Surfacing

> *Make the agent touch the stove, not be told about it.*
> Status: pre-milestone thesis (2026-05-08). Not yet kicked off via `/gsd:new-milestone`. Reviewable artifact.

## TL;DR

**v5 closed the lying-memory surface. v6 closes the lazy-memory surface.**

- v5 made memory *trustworthy* — provenance, no extraction-time abstraction, no fabricated structure (Mem0 trap structurally impossible).
- v5 left memory *under-engaged* — retrieval surfaces summaries; agents apply summaries generically; the agent doesn't *think*, it *restates*.
- v6 surfaces the **moment** at retrieval time (the transcript span where a decision was forged, where a lesson was learned) instead of the summary about the moment. The substrate is too rich to compress into a generic answer; the agent is forced to engage.

## Source thesis (from PROJECT.md, locked 2026-05-04)

PROJECT.md's "The Parable (Cognitive Frame)" section captures the core:

> A small child sees a stove, feels heat, touches, burns, cries; mamma intervenes. The child stores not *"rule: hot = bad"* but the **bound multi-modal record** — color of the stove, heat, pain, surprise, mamma's words. At recall, any one modality fires the whole memory.

The parable had three legs at v5 start:

| Leg | What | Status |
|---|---|---|
| 1 | Bound multi-modal episode storage | **SHIPPED** (Phase 1, V25 `episodic_events` with provenance) |
| 2 | Recall by any modality (multi-handle fusion) | **KILLED 2026-05-05** (3 KILL bound measurements at scale; `2026-05-05-multi-handle-kill.md`) |
| 3 | Abstraction-from-density (offline pattern emergence) | **KILLED 2026-05-05** (intra-project density 0.2418 < 0.30 threshold across both Phase 2.1 tiers) |

**What the parable survives intact even after the kills:**

The child doesn't apply a stored rule when seeing a new stove. The child *relives the moment* — pain, mamma's words, the radiating heat — and *that* governs behavior. Experiential recall beats propositional recall.

v5 shipped *storing* the experience. v5 did **not** ship *recalling* the experience. Retrieval today still surfaces summaries (CONTEXT.md, learnings, decisions, experience_patterns) — propositional artifacts, not the moments that produced them. v6 closes that gap.

## The cleaner pitch

**v6 = extending the Critical Reminders principle from rules to deliberation and lessons.**

Layer-by-layer applicability of the parable in this codebase:

| Layer | Telling (insufficient) | Touching (load-bearing) |
|---|---|---|
| **1. Rules** | Inject CLAUDE.md once at turn 1 → agent forgets by turn 50 (proven failure: Lacuna Betting session 3, learning `aee9461`) | **Critical Reminders** (Session 44, decision `106`/`110`) — surface relevant rules just-in-time at the moment of action with decay TTL + activity gating + first-encounter injection. **Already shipped. Already proven.** |
| **2. Decisions** | Read summary "Phase 2.1: KILL × 2" → restate generically | Read the actual transcript where the kill verdict was forged — what was at stake, what was almost decided, why 0.30 was picked, what would have to change to revisit. **v6.** |
| **3. Lessons** | Read a learning bullet → bounce off | Read the actual conversation where the lesson was learned — see the agent get burned, see the user's correction, see the moment the rule crystallized. **v6.** |

Layer 1 is solved. Layers 2 and 3 are v6.

This framing matters because **v6 is not a new bet**. Critical Reminders proved the parable at Layer 1 in production. v6 extends a proven principle. Risk asymmetry follows.

## Mechanism — why this isn't just "more memory"

Three load-bearing consequences of forcing the LLM out of summary-mode:

### 1. Receipts replace authority

A summary is *invoked* ("we decided X"). A transcript is *cited* ("on turn 47 we picked X because Y, and Y is still true, see for yourself"). Authority is brittle when current circumstances drift; receipts let the next agent verify whether the original reasoning still applies. Generic application of stale summaries fails silently; primary-source retrieval surfaces the conditional.

### 2. Counterfactual reasoning becomes possible

With only summaries, you can't ask "what would we have decided if condition X were different?" — there's nothing to perturb. With transcripts, the deliberation is in the substrate, so the agent can re-run reasoning under different priors. That's a capability the current system doesn't have.

### 3. Drift detection becomes structural, not luck

If a summary's enabling condition has quietly changed, the next agent applies the verdict generically and the drift hides. With transcripts, enabling conditions are *in the text*. The agent can match against current state and surface the divergence: *"We killed multi-handle because density was 0.24 < 0.30 — but the corpus we measured was n=20 across three projects; current corpus is 10× that and the density may have shifted. Worth re-running."*

## What v6 is NOT

- **Not a revival of multi-handle recall.** That thesis (any-modality-fires-whole-memory at retrieval time) is KILLED at our scale. v6 uses conventional v4 hybrid-retrieval (semantic + FTS + reranker) applied to a different corpus (transcript chunks). No new retrieval theses.
- **Not abstraction-from-density.** That thesis (cluster matching episodes, surface high-density clusters) is KILLED. v6 stores raw transcripts and retrieves spans on query — no offline pattern emergence.
- **Not extraction-time pattern creation.** Mem0-trap stays structurally closed. The parseWrappers + V28 + V31 disciplines apply at ingestion: redaction at the boundary, no fabricated structure.
- **Not a Vesna replacement.** Vesna's correctness probes remain the ship gate; v6 needs *additional* engagement metrics, not substituted ones.

## Substrate v6 needs (mostly already shipped)

| Component | Status |
|---|---|
| Phase 1 episodic_events with provenance enum (V25) | ✓ shipped |
| Phase 4 extraction-time pattern creation deleted (V28 trigger) | ✓ shipped |
| Phase 6 clean session boundaries (V29 + chokidar watcher + heartbeat hooks + atomic close marker) | ✓ shipped |
| `transcript_chunk` table slot (preserved-as-legacy in Phase 7 per CONTEXT decision 1) | ✓ exists, currently unused |
| arctic-embed2 + sqlite-vec for chunk embeddings | ✓ reuse existing path |
| BGE-reranker-v2-m3 (port 7439) for cross-substrate reranking | ✓ reuse existing service |
| `parseWrappers` source-of-truth for ingestion redaction | ✓ Phase 1 / Phase 7 |

**Net new substrate work for v6:** ingestion pipeline that hooks the `clean_endsession` close marker → reads the JSONL → chunks (turn boundaries / tool-call boundaries / ~500–1500 tokens) → embeds → writes to a vec0-backed `transcript_chunk` (or similar). That's the entirety of the storage-side novelty.

## What v6 builds (over and above substrate)

1. **Ingestion pipeline.** Hook into Phase 6's atomic `clean_endsession` close marker → ingest the full session JSONL → chunk on natural boundaries → embed via existing arctic-embed2 path → land in vec0 + FTS5. Redaction at ingestion (parseWrappers; secrets; PII; system-reminder noise).
2. **Artifact → transcript routing.** When retrieval surfaces an artifact (CONTEXT.md decision, SUMMARY.md outcome, learning, experience pattern), optionally fan out to the transcript chunks that *informed* that artifact — joined by `session_id` + time window. The artifact layer becomes the index; the transcripts become the corpus.
3. **Assembly integration.** Include surfaced transcript spans in the prompt assembly alongside summaries. Budget management — transcript spans are token-heavy, so vectoring precision matters more than for summaries. Reuse existing reranker; do not invent new ranking.
4. **Engagement measurement methodology.** Vesna's correctness gates are necessary but not sufficient — generic-shaped answers can pass Vesna and still be useless. v6 must operationalize engagement (see below).

## Empirical question (pre-committed before any phase plan)

> Does next-session task performance improve when the agent has access to verbatim historical deliberation, vs. summary-only baseline? Measured how, with what corpus, with what decision rule?

This is the v6 equivalent of Phase 2's pre-committed decision rule. Same methodology promoted to v5 standard practice (pre-committed decision rule, locked corpus, multiple bound measurements, Wilson/Newcombe CI binding).

### Operationalizations to consider (pick at least one for the binding decision rule)

- **Vesna engagement-extension probes.** New probe class: drift-detection. Synthetic cases where current state differs from the conditions that produced a past decision. Summary-only context: agent applies the verdict generically (FAIL). Transcript context: agent surfaces the divergence (PASS). Bind: lower-CI of Δ(transcript − summary) > 0 across N probes.
- **Citation density.** Operationalize "engagement" as quoted-phrase density from primary sources. Higher density = engaged. Bind: Δ(transcript − summary) > threshold T with Wilson CI lower bound > 0.
- **Specificity contrast.** Synthetic A/B: agent answers a project-specific query with project context vs. with that context replaced by a different project's context. If the answers don't meaningfully differ, the agent was being lazy. Bind: distinctness metric Δ > threshold.
- **Counterfactual capability.** Probe class: "what changes about decision X if condition Y were different?" Summary-only baseline: agent can't engage. Transcript context: agent can re-derive. Bind: pass rate Δ.

The decision rule must be locked **before** measurement begins. Same shape Phase 2's `02-CONTEXT.md` locked the multi-handle decision rule before the empirical run.

### Conditional outcomes (pre-committed shape)

- **Bound positive on the chosen metric:** v6 ships transcript-as-source. Substrate + routing + assembly integration land. Tag v6.0.0.
- **Bound negative:** v6 ships the **substrate alone** (ingestion + chunking + embedding + Phase 6 hook) and documents the negative result as another receipt — same shape as Phase 2/2.1 KILL. The substrate is reusable for future retrieval theses; the engagement bet just didn't bind at this scale. Tag v6.0.0 with the kill in the annotation, leading.
- **Inconclusive (point-delta positive but Wilson CI doesn't bind):** Phase 2.1 corpus expansion shape. Re-run with a larger corpus before final verdict.

## Risk profile

| Risk | Mitigation |
|---|---|
| Token bloat at retrieval (transcript spans are heavy) | Chunked indexing + reranker filtering; coarse-then-fine vectoring; budget cap per query; surface only top-K spans |
| Privacy / sensitivity of raw transcripts (secrets, PII, prompt injections) | Redaction at ingestion via parseWrappers + secret-scrubbing pre-embedding; mirror v5 wrapper-tag discipline at the new write path |
| Mem0-trap re-opening at the new ingestion surface | Same V28/V31 trigger pattern: structural impossibility, not just a code rule. Closed-enum CHECK on chunk provenance |
| Test gap that allowed v5.0.0's silent fail | Live-wiring ship gate from day 1 (see methodology section) |
| Aggregator non-determinism (Phase 4/6/7 close-out pattern) | Continue the documented "revert as known noise" close-out discipline; queue for v6.x cleanup once root-caused |

## Methodology gates promoted from v5 (mandatory for every v6 phase)

1. **Pre-committed decision rule** in CONTEXT.md before any empirical run.
2. **Locked corpus and harness** across replications.
3. **Multiple bound measurements** before milestone-level claims (one experience is not abstraction).
4. **Wilson/Newcombe CI binding** for noise rejection at small n.
5. **Live-wiring smoke against every production DB shape currently in the wild** (V17-collapsed at minimum). New mandatory gate, learned from v5.0.0's silent-fail. Every engineering phase must include "production-shape integration test" alongside the existing unit/integration ones.
6. **Negative results are valid outputs.** "This didn't bind, here's the receipt" is a successful empirical-phase outcome.

## Rough phase shape (formalized via `/gsd:new-milestone`)

This is shape, not a plan. Actual phases get authored by `/gsd:new-milestone` + `/gsd:plan-phase`.

| Phase | Type | Substantive work |
|---|---|---|
| **v6 P1 — Transcript ingestion substrate** | engineering | V32 schema (transcript_chunk table promotion + vec0 binding), JSONL watcher hook into Phase 6 boundary close, redaction-at-ingestion, chunking strategy locked, embeddings backfill from existing JSONL archive, Vesna preserved at 21/21 |
| **v6 P2 — Empirical measurement** | empirical | Lock corpus + harness; pre-commit decision rule; build engagement probes (drift / citation / specificity / counterfactual — pick the one that operationalizes); A/B with-transcript vs. without; multiple bound runs; Wilson CI; aggregate to `.planning/aggregates/deliberation-surfacing.{md,json}` |
| **v6 P3 — Conditional ship** | engineering OR documentation | If P2 bound positive: assembly integration + artifact-to-transcript routing + Vesna probe extension to 24+ + ship gate validation + v6.0.0 tag. If P2 bound negative: KILL receipt + substrate-alone ship + v6.0.0 tag with the kill leading the annotation |

## Connections to existing artifacts

- `.planning/PROJECT.md` — "The Parable (Cognitive Frame)" section, locked 2026-05-04. Source thesis.
- `.planning/research/2026-05-04-v5-bound-episodes-framing.md` — original v5 framing (three legs).
- `.planning/research/2026-04-30-v5-episodic-memory.md` — v5 engineering substrate research.
- `.planning/reframes/2026-05-05-multi-handle-kill.md` — the kill that narrowed v5 to substrate-only and opened the v6 gap.
- `CHANGELOG.md` — v5.0.0 (substrate ship) and v5.0.1 (V17 view-mode hot-fix that surfaced the live-wiring gate gap).
- Session 44 (decisions `106`, `110`) — Critical Reminders prior art proving the parable at Layer 1.
- Learning `aee9461` — Lacuna Betting session 3 failure proving session-start-only injection insufficient.
- Phase 7 `transcript_chunk` preserve-as-legacy decision (CONTEXT.md decision 1).

## Open questions before `/gsd:new-milestone`

1. **Engagement metric operationalization.** Pick one or two from the list above as the primary binding signal. Citation density is easiest to compute but easiest to game. Drift-detection probes are the strongest case but require building synthetic drift fixtures. Specificity contrast is novel and requires a method paper. Counterfactual capability is the most ambitious and may not bind.
2. **Chunk granularity.** Turn boundaries (one chunk per user/assistant turn)? Tool-call boundaries (one chunk per tool invocation + result)? Fixed token windows (~500–1500)? Each has different retrieval/specificity tradeoffs.
3. **Backfill scope.** v6 P1 has access to the user's full historical JSONL archive (~1000+ sessions). Do we backfill all of it, just claudex-v3 project sessions, just the last N days? Backfill cost vs. coverage of past deliberation.
4. **Reranker fitness for transcript chunks.** BGE-v2-m3 was trained on web/document corpora. Conversation chunks are a different distribution. May or may not rerank well; need to measure as part of P1 substrate validation, not in P2 empirical phase.
5. **Surface to user during retrieval — visibility?** Should the agent indicate "I'm citing turn 47 of session X" when surfacing transcript spans? Connects to the Phase 7 advisory-narration discipline (the "When You Recall — Narrate" pattern in MCP instructions).
6. **Storage cost trajectory.** ~1MB per session × ~1000 sessions ≈ 1GB plain text + embeddings. Trivial today but unbounded growth. v6 may need a retention-policy layer (eventually correlate with the missing "salience-weighted forgetting" leg of memory architecture).

---

*Author: Claude Opus 4.7 (1M context). Co-authored across 2026-05-08 session 8f8ef0c7 with Grigorije Jakisic. Spec is reviewable; implementation gates on `/gsd:new-milestone` + user approval.*
