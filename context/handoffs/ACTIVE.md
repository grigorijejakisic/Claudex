# Active Handoff — claudex-v3

> Commander's intent: user wants v3.5 Phase A (LoCoMo diagnosis) started, but that's blocked on a P2.1 injection bug observed this session.

## What's Left To Do

1. **Diagnose the broken P2.1 curated-context injection.**
   Session 49 seeded 7 entries (claudex-v3 ids 4–7 + global id 3 at the time, now id 271) and committed a handoff (`4b29587`) explicitly instructing: *"Verify /starthere renders the 7 seeded entries at P2.1. If not, the injection broke — diagnose that first."* Session 50's /starthere did NOT render a `## Project Curated Context` block. I worked around it via MCP `claudex_curated_context` manual fetch. Fix this before Phase A — the injection is load-bearing for the mental-model handoff mechanism Angel uses. Likely location: session-start hook assembler → curated-context fetcher in `src/assembly/assembler.ts` or the relevant section builder.

2. **Begin v3.5 Phase A — LoCoMo diagnosis (instrumentation only).**
   Spec: `context/specs/CLAUDEX_V3_5_CONSOLIDATION.md`. Goal: find where the 45% retrieval quality loss is happening (embedding? chunking? reranker? query formulation? judge?). Zero refactoring. Every subsequent phase passes a ≤2pp LoCoMo regression gate. Do NOT skip this step — session 49 explicitly flagged the "ship feature before diagnosing" pattern as the reason v3.5 exists.

## Context That Won't Be Obvious

- **Ollama Cloud swap landed this session (commit `c84dd61`).** Angel generation now runs on `glm-5.1:cloud` via local daemon `127.0.0.1:11434`. No `OLLAMA_API_KEY` needed — daemon auth is via SSH key from `ollama signin`. Overrides: env `OLLAMA_BASE_URL`, `OLLAMA_GEN_MODEL`. VRAM freed 31.9 GB → 5.2 GB. If Phase A needs to hammer the generation backend, cost/latency profile is now cloud, not 6–9 tok/s local.
- **The v3.5 spec lists "local llama-server setup" as a non-goal.** The swap preserved the supervisor class (added `cloudMode` short-circuit). If Phase A's diagnosis surfaces the need to unify the supervisor pattern, remember: don't rewrite, gate.
- **`reasoning_effort: "none"` is the client default.** If Phase A evaluations need the LLM's thinking trace visible (e.g., for error analysis), pass `enableThinking: true` per call — otherwise the model returns clean `content` and the reasoning is discarded.
