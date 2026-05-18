---
author: claudex-v3 session d2237451 (continuation, 2026-05-18 evening)
created_at: 2026-05-18T22:18+02:00
status: design proposal — next planning round
operator_authorization: "Prepare 'single memory front door' for the next session" (2026-05-18T22:15+02:00)
---

# Single Memory Front Door — v8 Design Proposal

## The criticism that drove this

Fresh-agent test 2026-05-18 (round 3) — the agent successfully retrieved past PC crashes but said honestly:

> *"An organic memory system would let me ask 'when did I last crash' and the substrate would pick the right index. Right now I'm a librarian who memorized the call-number system, not someone who just remembers."*

The v7 ship closed real gaps (LSS, CHR, V43 epoch unification, episodic channel, materialized session_summary, reconcile mechanism). But the surface remained **tool-shaped**: agents must know which of 8+ MCP tools to reach for, in which order, with which arg shape. Even with the routing tree in MCP instructions, the agent reached for `claudex_search` by reflex when the question was "WHEN did X happen" (event-shape → should route to `claudex_recent_sessions`).

The cheap routing-prompt fixes shipped this round (1, 2, 3, 4) make the failure mode less load-bearing, but they don't change the shape — they patch around it.

## The thesis

A v8 design should expose ONE memory front door that internally dispatches across surfaces. The agent asks "what do you want to remember" and the substrate routes it. The tools we have today become internal dispatchers, not the public API.

Shape:

```
claudex_recall(query)  →  {
  // Internal dispatcher figures out:
  //   - Is this episodic (event-shape) → session_termination
  //   - Is this conceptual → hybrid retrieval (FTS + vec + recency)
  //   - Is this an artifact-id lookup → direct ID resolve
  //   - Is this current-session timeline → claudex_events
  //   - Is this a specific session by ID → session_summary + termination + signals
  //
  // Returns a structured response that includes:
  //   - Primary hits (top N relevant items)
  //   - Provenance (which surface fired, why)
  //   - Adjacent context (signals, blockers, recovery framings)
  //   - Confidence (high/medium/low)
}
```

## Why this is v8, not v7-patch

Three reasons:

1. **The tools themselves are correct.** `claudex_recent_sessions`, `claudex_search`, `claudex_events`, `claudex_recall` — each does its job well. The mistake is putting routing decisions on the agent. Wrapping them into one dispatcher is a NEW surface, not a refactor of existing ones.

2. **The routing rules are non-trivial.** "When did X happen?" → events. "What did we decide?" → concepts. "Remember when…" → could be either. The classifier needs to be deterministic enough that the agent can trust it AND smart enough to handle ambiguity (fall back to multiple surfaces in ranked order). That's a meaningful intelligence layer — likely an LLM-driven classifier on the question shape, OR a tightly-tested regex set with explicit overrides.

3. **The output shape needs invention.** Today's tools each return their own JSON. A unified front door returns a unified shape with provenance + confidence + adjacent-context. That's a new contract for downstream consumers (the agent's behavior, the assembly cascade, dashboards). v7 stabilized the existing contracts; v8 introduces a new one without breaking them.

## Open design questions

These are what the next planning round should resolve:

### Q1 — Classifier shape

**Option A: deterministic regex/heuristic.** Fast, testable, predictable, but covers a finite set of shapes. Fails on novel phrasings.

**Option B: LLM-driven router.** Sonnet-tier classification ($X per call). High recall, handles novel phrasings, but adds latency + cost per query.

**Option C: hybrid.** Regex covers the 80% common shapes deterministically; falls back to LLM for the ambiguous 20%. Best-of-both, more moving parts.

Tentative position: **C**, with the regex baseline being the v8-ship gate and LLM fallback added in v8.1.

### Q2 — Composability

Should the front door RETURN multiple-surface results merged, or PICK ONE surface and return that?

The recursive-corpus problem (round 3 fresh-agent test) says **merging is dangerous when surfaces have different shapes.** If `session_termination` returns 5 crashes and `session_events.user_framing` returns 6 operator complaints about crashes, the agent has to know which is which. Merged-with-provenance maybe works; pick-one is simpler but loses signal.

Tentative position: **return one primary surface + adjacent-context from related surfaces.** "Primary" is chosen by classifier; "adjacent" is structured separately ("here are 5 crashes; ALSO 6 operator framings mentioning crashes — if you want to drill in").

### Q3 — Migration path

Old tools (`claudex_search`, `claudex_recent_sessions`, etc.) stay for power-users (operator-debugging, scripts, programmatic access). The new `claudex_recall` becomes the agent-facing primary. MCP instructions point at the new one; old ones documented as advanced/specific-purpose.

Risk: agents trained on the old surface continue using it. Possible mitigation: emit a soft-deprecation message when old tools are called for question-shapes the new front door would handle better.

### Q4 — Confidence semantics

When the front door returns "low confidence", what does that mean operationally? Agent should:
- Fall back to direct tool calls?
- Surface the uncertainty to the operator?
- Try a different surface in the next turn?

Tentative position: return a `confidence: 'high' | 'medium' | 'low'` field plus a `next_steps` hint ("if this isn't what you wanted, try claudex_search directly"). Agent reads the hint, operator never has to.

## What's already in place that supports this

- `isEpisodicQuery()` + `isEventQuery()` in hybrid-retrieval.ts — regex baseline for the classifier (Q1 Option A).
- `searchEpisodicChannel` with synth-row + materialized-row mix — already aware of episodic vs conceptual.
- `claudex_recent_sessions` with `derived` provenance flag — knows when its data is real vs inferred.
- `reconcileTerminationClassifications` — substrate gets more accurate over time, so the front door's data improves automatically.
- MCP instructions are now sharp on routing — provides ground-truth for the classifier's expected behavior.

## What v8 would need to add

- New MCP tool `claudex_recall` (different from current — current would rename to `claudex_recall_by_id`).
- Classifier function `classifyQuery(query) → { surface, confidence, fallbacks }`.
- Composer function `composeResponse(primary, adjacent, provenance) → UnifiedResponse`.
- Unified response type with provenance + confidence + adjacent-context.
- Migration path documentation for downstream consumers.

## What v8 should NOT do

- Replace the existing tools. They stay as internal dispatchers + advanced API.
- Add caching/memoization. The classifier should be deterministic per query; caching adds drift.
- Add LLM-driven retrieval ranking. The reranker layer is separate work. Front door is routing-only.

## Operator decision points for the next session

1. **Greenlight v8 as a milestone** (separate from v7 hardening). Y/N.
2. **Pick Q1 (classifier shape)** — A, B, or C.
3. **Pick Q2 (composability)** — single surface or merged-with-provenance.
4. **Set the success criterion.** Tentative: "fresh agent answers any of the 4 canonical question shapes (event-when, concept-what, current-timeline, by-id) with one tool call, no fallback, no tempfile detour."

## Files this proposal will eventually touch (read-only inspection only — no edits yet)

- `src/mcp/recall-server.ts` (new dispatcher tool + renamed by-id tool)
- `src/intelligence/query-classifier.ts` (NEW, ~200 lines — classifier function)
- `src/core/hybrid-retrieval.ts` (existing surface, called from dispatcher)
- `src/core/session-termination.ts` (existing surface)
- `src/tests/mcp/claudex-recall-dispatcher.test.ts` (NEW — gate suite)
- `.planning/phases/15-single-memory-front-door/` (NEW phase)

## Pickup signal for next session

When the operator says "let's start the v8 front door" / "let's tackle the single memory door" / "v8 design" — read this file, then start the planning round with the four operator decision points above.
