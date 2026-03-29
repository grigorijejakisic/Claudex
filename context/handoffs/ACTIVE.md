---
schema: claudex/handoff
version: 1
handoff_id: claudex-v3-handoff-40
status: active
session_id: 8fac41a9-022f-4c16-83a5-f4120e8dc096
created_at: 2026-03-30T00:30:00+02:00
priority: high
---

## Intent

Session 40 fixed 18 production bugs, shipped MemRL + Codebase Indexer, upgraded Angel extraction to Sonnet with 6-phase pipeline. Codex review found 17 more bugs. Fix ALL of them next session.

## What's Left To Do

**PRIORITY 1: Fix all 17 remaining bugs (from Codex review)**

### HIGH (fix first)
1. **MCP search RRF 0-based rank** — `1/(K+0)` for top result, hybrid-retrieval uses `1/(K+1)`. Fix: start rank at 1.
   - `src/mcp/recall-server.ts:104`

2. **MCP search source weights dominate relevance** — fixed multipliers mean weak decision matches outrank strong artifact matches. hybrid_score signal discarded.
   - `src/mcp/recall-server.ts:96,225,299,313`

3. **Intent mode double-accounting** — counts meta events into continuation, then adds classified intents at 2x. Biases toward continuation.
   - `src/intelligence/intent-predictor.ts:410-424`

### MEDIUM
4. **Reference detection prefix false positives** — 4-char prefix `includes()` no word boundary. "edit" matches "credit".
   - `src/intelligence/retrieval-feedback.ts:435-445`

5. **FTS5 proper noun weight dead** — `new Set()` deduplicates. Weight claim is false.
   - `src/core/hybrid-retrieval.ts:199-201`

6. **Temporal channel ignores globalScope/excludeSuperseded** — hardcodes filters.
   - `src/core/hybrid-retrieval.ts:605`

7. **MCP search pagination unreliable** — per-channel caps truncate before merge.
   - `src/mcp/recall-server.ts:123,160,222,253`

8. **Session resolution ambiguity** — picks most recent active, wrong in multi-session.
   - `src/mcp/recall-server.ts:543,549,579`

9. **Auto-restart no process guard** — can spawn multiple instances.
   - `src/angel/heartbeat.ts:392,399`

10. **Conversation vector score mixed scale** — not rank-normalized like other channels.
    - `src/mcp/recall-server.ts:201`

### LOW
11. **Unused `client`/`model` params** — dead after CliProxy migration.
    - `src/angel/pattern-extractor.ts:383-384`

12. **`completedSuccessfully` computed but unused**.
    - `src/angel/pattern-extractor.ts:237`

13. **Codebase context label** says "last session" but uses 24h cutoff.
    - `src/assembly/assembler.ts:600`

14. **Call graph scope tracking** — `^}` regex misattributes nested functions.
    - `src/indexer/codebase-indexer.ts:151`

15. **Indexer walks .py/.rs but only parses TS/JS**.
    - `src/indexer/codebase-indexer.ts:188,227`

16. **Greedy JSON parse** — `match(/\{[\s\S]*\}/)` can grab wrong content.
    - `src/angel/pattern-extractor.ts:452`

17. **Stale string match in Angel reprocessing** — checks `'no corrections found'`.
    - `src/angel/heartbeat.ts:194`

## Context That Won't Be Obvious
- MemRL Q-values have never trained (flags scope bug fixed this session). First real training happens next session.
- Codebase indexer: 256 files in code_index table. Angel re-indexes each heartbeat cycle.
- Pattern graduation (always-inject cap at 5) added but hasn't fired yet — needs Angel restart.
- Reranker port is 7439 (not 7440). Fixed this session.
- /endsession skill updated to NOT write completion markers.
- Amp spec at C:\Users\Grigorije\Desktop\SPEC-local-intelligence-amplifier.md — Phase 1 reverted (snowflake already better on GPU), Phases 2+3 shipped.
