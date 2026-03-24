---
schema: claudex/handoff
version: 2
handoff_id: claudex-v3-handoff-33
session_id: e8693a44-bea2-4408-b6a0-8fd2903cbaf0
scope: project:claudex-v3
created_at: 2026-03-24T03:30:00Z
---

# Handoff: Session 32 → Next

## Priority: Proactive Memory & Retrieval Redesign

The intelligence layer is now **wired and working** (session 32 fixed ACE ranking, feedback loop, embedding pipeline, pattern suppression). The next challenge is making it **proactive** — the system should predict what you need before you ask.

## What's Left To Do

### 1. Angel Heartbeat: Artifact Relationship Graph
**The `artifact_links` table exists (schema V10) but has 0 rows.**
- During heartbeat, compute cosine similarity between recent artifacts (embeddings exist)
- Populate `artifact_links` with `source_id, target_id, link_type, strength`
- Link types: `semantic_similar`, `same_topic`, `supersedes`, `corrects`
- This enables graph-walk retrieval: "show me everything related to X" instead of "show me keyword matches for X"

### 2. Angel Heartbeat: Observation Consolidation
**22,899 observations is noise. Most are routine tool calls.**
- Angel should synthesize clusters of observations into summary artifacts
- "50 observations from session X are really about 3 things: A, B, C"
- Summary artifacts retrieve better than individual observations
- Use Ollama for clustering, Sonnet for synthesis

### 3. Session-Start: Intent Prediction
**Currently searches by checkpoint topic. Should predict session intent.**
- Analyze: checkpoint state + recent thread + time patterns + unfinished handoffs
- Pre-materialize artifacts matching predicted intent (zero-latency at first prompt)
- "Last session ended mid-task on file X, user usually returns to unfinished work"

### 4. UserPromptSubmit: Intent Classification
**Currently treats every prompt the same. Should classify intent first.**
- Continuation vs. new topic vs. question about past work vs. command
- Different intents need different retrieval strategies
- Questions about past work → search conversation_turns + decisions
- Continuation → load related artifacts from current thread
- New topic → full hybrid search

### 5. Negative Retrieval Learning
**Track what was surfaced but NOT referenced (retrieval_events has this data).**
- Learn "observation-type artifacts are rarely referenced by this user"
- Learn "decisions and learnings are the high-value artifact types"
- Adjust retrieval scoring weights per artifact_type based on historical reference rates

## Context That Won't Be Obvious

- `artifact_links` table: `source_id INTEGER, target_id INTEGER, link_type TEXT, strength REAL, created_at_epoch INTEGER` — already in schema, already has indexes. Zero migration needed.
- Embeddings: 271/2,570 artifacts have embeddings now. The file ingester backfill (session 32) will embed 79 more on next session start. Coverage will improve but won't reach 100% without addressing the per-observation embedding path (currently only importance >= 3 observations get artifacts + embeddings).
- The Angel runs Ollama-only right now (CliProxy not available). For observation synthesis (#2), Ollama llama3.2 may not be sufficient — consider using Sonnet via CliProxy when available, with Ollama as fallback.
- The architecture principle decided in session 32: **hooks provide data, Angel provides intelligence, PA provides agency.** All 5 items above are Angel or hook work — no PA needed.

## The Road — Where This All Goes

```
Phase A: Proactive Retrieval (items 1-5 above)
  └── Angel + hooks only. No new architecture.
  └── Goal: system predicts what you need before you ask.
  └── Milestone: next session starts with <15K context, all of it relevant.

Phase B: Intelligent Memory Curation
  └── Angel consolidates 22K observations into ~500 high-quality summaries.
  └── LLM-as-judge (Mem0 pattern): Angel decides what's worth keeping vs. noise.
  └── Artifact graph enables "show me everything related to X" retrieval.
  └── Milestone: retrieval_events show >80% reference rate (up from ~4% today).

Phase C: Personal Assistant (Nexus Phase 5+)
  └── Always-on Agent SDK session with full CC capabilities.
  └── Reachable via phone (Nexus), Telegram, terminal.
  └── Uses Claudex as its memory — reads Angel's findings, acts on them.
  └── Can spawn agent teams, handle email/scheduling, morning briefings.
  └── This is the end goal: an entity that thinks about your needs proactively,
      acts on its own initiative, and uses the entire memory system we've built
      as its brain. Angel feeds it data. Hooks give it reflexes. The PA is the mind.
  └── Milestone: you wake up, open your phone, and the PA has already:
      - Summarized yesterday's work across all projects
      - Flagged a failing CI build it noticed overnight
      - Pre-loaded context for the task you're most likely to continue
      - Drafted responses to messages that came in while you slept
```

**The principle:** Each phase builds on the previous. Phase A makes retrieval work. Phase B makes the data worth retrieving. Phase C makes an entity that uses both to help you without being asked. We don't skip phases — each one is load-bearing for the next.

## Research Before Implementing

- ACT-R activation-based retrieval (already researched in session 30 — check Claudex DB for the web search results)
- Stanford Generative Agents paper — reflection + memory architecture
- How Mem0 does LLM-as-judge for "what's worth storing" (currently we store everything)
- Graph-based memory retrieval patterns (knowledge graphs vs. embedding similarity graphs)
- MemOS/MemTensor — persistent skill memory, cross-task reuse (researched in session 29)
- Agent SDK `query()` with `resume: sessionId` for persistent PA sessions (Nexus ARCHITECTURE.md has the spec)
