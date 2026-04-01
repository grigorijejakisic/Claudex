---
schema: claudex/handoff
version: 1
handoff_id: claudex-v3-handoff-43
status: active
session_id: d8c2005c-5929-4918-ad38-088ceea77dc9
created_at: 2026-04-02T01:30:00+02:00
priority: high
---

# Handoff: CC Source Research Complete → Auto-Orchestrate 81 Upgrades

## What Was Done (Session 43)

Deep research into Claude Code internals using 26 parallel agents across 4 CC community repos (buildable, free, leaked, main). Produced 26 research files totaling ~500KB.

### Key Discoveries
1. **CC has 27 hook event types** — Claudex uses only 6. 20 undocumented hooks available.
2. **MCP server `instructions` field** injects at SYSTEM PROMPT level — better than hook additionalContext.
3. **CC's memory system makes a Sonnet API call EVERY TURN** for memory file selection (not grep-based). Disabling saves ~11K tokens/turn.
4. **No hook deduplication** — UserPromptSubmit accumulates 100KB+ over 50 turns.
5. **90+ feature flags** via bun:bundle system. 4 critical GrowthBook flags could activate server-side anytime.
6. **Dream/Angel symbiosis** — Angel can use Dream's forked-agent-with-cache-sharing for near-zero-cost Claude-level consolidation.
7. **Buddy** (Fenwick!) can be a Claudex notification UI via `companionReaction` AppState field.

### Architectural Principle (USER DIRECTIVE)
**COOPERATE with CC, don't fight it.** Use CC features as free resources. Angel curates input → CC processes → Angel consumes output. Only disable CC features that actively damage Claudex. Stored in Claudex DB: `claudex/cc-cooperation-principle`.

## What's Next — Run /auto-orchestrate

### The Spec
`context/research/SYNTHESIS.md` — **81 items across 10 categories:**

| Category | Items | Summary |
|---|---|---|
| Token Optimization | 8 | Disable CC memory, minimize injection, cache stability |
| New Hook Types | 17 | 20 undocumented hooks Claudex doesn't use |
| Hook Execution Capabilities | 10 | Async, interactive prompts, env injection, permissions |
| Injection Point Upgrades | 5 | System-prompt level, auto-priming, conditional rules |
| Conflict Prevention | 5 | GrowthBook flags, Dream/KAIROS/extractMemories |
| Cache Optimization | 4 | MCP trade-off, TTL, sentinel avoidance |
| Bug Workarounds | 8 | Known CC issues that affect Claudex |
| Extension Surfaces | 3 | Plugin system, channels, annotations |
| Angel/CC Integration | 15 | Dream symbiosis, Buddy notifications, skill bridges |
| Angel Engineering Patterns | 6 | Forked agents, cursor extraction, throttling |

### Research Files
- `context/research/cc-source/` — 19 files (CC source analysis)
- `context/research/cc-community/` — 7 files (street knowledge)
- `context/research/SYNTHESIS.md` — master spec (81 items)

### How to Proceed
1. Run `/auto-orchestrate` — SYNTHESIS.md is the spec
2. The orchestrator will crystallize the project (or use existing .planning/)
3. It will break 81 items into phases and execute discuss → plan → execute per phase
4. **USER DIRECTIVE: NO PRIORITIZATION.** Every single item gets implemented. Nothing deferred.
5. **USER DIRECTIVE: Show EVERYTHING found, explain EACH item, then DO ALL OF THEM.**

### User Feedback Rules (from this session)
- Always surface session transfers immediately — don't wait for user to ask
- Cooperate with CC features, don't fight them
- No prioritization — all items equal priority, all get done
- Fix everything, present clean state

## Context
- CC source repos: `~/Desktop/Projects/claude-code-buildable` (primary), `claude-code-free`, `claude-code-leaked`, `claude-code-main`
- Reranker service is down (Angel messages) — won't block implementation
- Buddy (Fenwick) is a rare shiny cactus with max snark
- Decision stored in Claudex DB: `claudex/cc-upgrade-milestone`, `claudex/cc-cooperation-principle`
