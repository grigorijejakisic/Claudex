---
schema: claudex/handoff
version: 1
handoff_id: claudex-v3-handoff-38
status: active
session_id: be1e3376-62a4-493b-b914-9ab3132afeca
created_at: 2026-03-28T19:30:00+01:00
priority: critical
---

## Intent

Claudex is #1 on LoCoMo (90.8%) and #2 on LongMemEval (90.6%) — with a local 16B model while competitors use GPT-4o and Gemini-3 Pro. But we have real gaps that a 7-agent competitive research team identified. Closing these gaps is the difference between being ahead and staying ahead. Every fix must be diligent and precise — no shortcuts, no "good enough."

## Critical Context

A full competitive analysis was completed against Hindsight, Letta (21.8K stars), CASS, Engram, MemoryGraph, Ori Mnemos, and 6 other systems. The findings are documented in three files that MUST be read before starting work:

1. **`context/specs/ROADMAP_GAPS.md`** — 4-tier prioritized gap list with effort/impact/files for each item. This is the master task list.
2. **`context/research/COMPETITIVE_POSITIONING_2026-03-28.md`** — full benchmark comparison, head-to-head analysis, what to announce.
3. **`context/research/hindsight-deep-dive-2026-03-28.md`** — Hindsight's actual architecture, CARA reasoning layer, 10 unadopted features.

Also reference: `context/research/session-communication-street-knowledge-2026-03-28.md` (5-layer research on session comms, 36 sources).

## What Session 38 Built

- **Migration cascade fix** — V10→V11 steps now individually try/caught
- **4 bugs fixed** from /full-review (sendMessage arg swap, Set.length on Set, stale ContentBlock type, missing import)
- **4 unwired exports wired** (findCausalEvent, storeCausalAttribution, updateRecallText, searchConversations)
- **Agent-to-agent session communication** — all 5 phases: stigmergic signals, session naming (project-sN-pid), cross-session messaging, SBAR transfer, UX wiring
- **6 MCP tools** — claudex_search, claudex_recall, claudex_store, claudex_events, claudex_message, claudex_session
- **5 slash commands** — /sessions, /name-session, /ask-session, /transfer-session, /signal
- **V12 schema** — session_signals table, sessions.name, session_messages extended with sender_type + request_id
- **CLAUDE.md protocol** — cross-session communication rules, all 6 tools documented
- **Entity summaries surfaced** in assembly at Priority 4.05
- **budgetTokens wired** from assembler to hybrid retrieval
- **Cross-encoder honestly documented** as LLM-as-judge (not real cross-encoder)

10 commits, ~2,500 lines. 2020/2020 tests. Build clean.

## What's Left To Do

**Read `context/specs/ROADMAP_GAPS.md` for the full 4-tier plan. Summary:**

### TIER 1: Fix What's Broken (THIS session)
1. **Real cross-encoder** — current implementation is LLM-as-judge with regex parsing, grade D+. Need either ms-marco-MiniLM-L-6-v2 via ONNX or Ollama reranking API. ~80 lines. This is the single highest-ROI fix for retrieval precision.
2. **Trigger Angel heartbeat** — entity summaries (10 candidates ready) and pattern promotion (5 candidates ready) are wired but Angel hasn't run a cycle. Verify both produce results.
3. **Test cross-session communication live** — open 2 sessions, send message, verify delivery + rendering + response. Never been tested with real multi-session interaction.

### TIER 2: High-ROI Improvements (next 2-3 sessions)
4. **Outcome tracking** — record if solutions worked, Bayesian effectiveness scoring (MemoryGraph's missing feedback loop)
5. **Per-event exponential decay** — replace additive with `0.5^(days/90)` (CASS, mathematically superior)
6. **Controlled forgetting** — 30K observations, DB grows monotonically, needs pruning
7. **Non-LLM Curator** — deterministic dedup before Angel LLM analysis
8. **Temporal retrieval channel** — explicit time-based queries
9. **Entity resolution** — canonicalize names

### TIER 3: Strategic (sessions 43-45)
10. **CARA reasoning layer** — Angel becomes a reasoning engine with opinion networks
11. **Q-Value RL retrieval** — self-improving memory (Ori Mnemos, 90% Recall@5)
12. **Cross-agent session indexing** — 11+ providers

## Warnings

- **The cross-encoder is NOT a cross-encoder.** It uses `nomic-embed-text` (embedding model) via Ollama's `/api/generate` (text generation). It asks the model to "rate relevance 0-10" and parses with regex. This is LLM-as-judge, not neural cross-encoding. Don't claim it's a cross-encoder in any public material.
- **MPFP is NOT from Hindsight.** Our spec mis-attributed it. Hindsight uses spreading activation. Our typed meta-path patterns may actually be better for our graph.
- **Hindsight's "89.6%" is LoCoMo, not LongMemEval.** Prior docs conflated these. On LoCoMo we beat them (90.8% vs 89.6%). On LongMemEval they lead (91.4% vs 90.6%).
- **Letta's cross-agent messaging is broken** — their `send_message_to_agent_async` dies after 2 calls (stale GitHub issue). Don't reference it as a working competitor feature.

## Proven Principle from This Session

**If a fix is small (5 lines or less), not doing it is laziness regardless of how insignificant the feature seems.** Stored in Claudex as learning. Apply proactively.
