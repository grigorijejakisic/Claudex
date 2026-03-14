# Competitor Context Management Research
## How AI Coding Tools Solve the Context Problem
### Research Date: 2026-03-13

---

## Executive Summary

Every tool faces the same fundamental tension: LLMs need relevant code context to produce good edits, but context windows are finite and expensive. The approaches fall into three broad camps:

1. **Static indexing + retrieval** (Windsurf, Continue, Aider) — build an index of the codebase upfront, retrieve relevant chunks at query time
2. **Dynamic discovery** (Cursor) — give the agent tools to find its own context on-the-fly, minimizing upfront inclusion
3. **Conversation compression** (Cline, OpenHands, SWE-agent) — focus on managing the growing conversation history via summarization or truncation

No tool has fully solved the problem. User complaints about context loss are universal.

---

## 1. Cursor

### Approach: Dynamic Context Discovery

Cursor's key architectural bet (2026) is **dynamic context discovery** — providing fewer details upfront and letting the agent pull relevant context on its own, rather than pre-loading static context.

### Five Core Techniques

1. **Long tool responses as files**: Instead of truncating large outputs (lossy), Cursor writes tool responses to files. The agent uses `tail` to inspect endings, then reads more as needed. Avoids unnecessary summarization.

2. **Chat history as files for summarization quality**: When the context window fills, Cursor triggers summarization. But the agent can reference the original chat history files to recover details lost during compression. This is a key insight — summarization is lossy, so keep the originals accessible.

3. **Agent Skills as discoverable files**: Skills (bundled scripts/executables) have names and descriptions as static context, but the agent discovers their details via grep/semantic search dynamically.

4. **MCP Tool Discovery (46.9% token reduction)**: Instead of always including lengthy MCP tool descriptions in context, Cursor syncs them to folders organized by server. The agent receives only tool names as static context, then dynamically looks up descriptions when needed. A/B tested: **reduced total agent tokens by 46.9%**.

5. **Terminal output as files**: Terminal sessions sync to filesystem. Agent greps logs rather than having them dumped into context.

### Summarization

When context fills, Cursor triggers a summarization step. The agent gets a fresh context window with a compressed summary, plus a reference to the full history file it can search through to recover details.

### Token Budget

200K token context window. No public details on internal budget allocation.

### User Complaints (from Cursor Forums)

- Context loss mid-conversation — agent behaves as if starting fresh
- Performance cliff at ~80% context usage — agent starts dropping actions
- Removal of `@codebase` feature degraded context retrieval quality
- Long conversations cause drift; Cursor recommends new chat per task
- Users report the agent "forgets" rules and instructions in long sessions

### Key Insight for Us

**Files as the universal context primitive.** Cursor's entire 2026 strategy is: don't put things in the prompt, put them in files and let the agent discover them. The 46.9% token reduction from MCP tool discovery alone is striking. Their summarization + history-file-as-backup pattern is worth studying.

---

## 2. Aider

### Approach: Repository Map with Graph Ranking

Aider's signature technique is the **repo map** — a concise, automatically-generated map of the entire git repository showing the most important classes, functions, and their signatures.

### How the Repo Map Works

1. **Tree-sitter parsing**: Aider uses tree-sitter to parse source files into ASTs, extracting function/class/method definitions and their call signatures across all supported languages.

2. **Graph ranking algorithm**: Each source file is a node. Edges connect files with dependencies (imports, references). A PageRank-like algorithm identifies the most "important" identifiers — the ones most frequently referenced by other code.

3. **Token-budget-aware selection**: The map is trimmed to fit within a configurable token budget (default: **1,024 tokens** via `--map-tokens`). Only the highest-ranked symbols make the cut.

4. **Dynamic sizing**: When no files are actively in chat, Aider expands the map significantly to give the LLM a broader view. As files are added to context, the map shrinks to stay within budget.

### How the LLM Uses It

The LLM receives the repo map with every request. From the map, it can see class/method/function signatures across the entire codebase — often enough to understand APIs and relationships. When it needs more detail, it identifies which files to examine, and Aider offers to add them to chat context.

### Context Management

Aider distinguishes between:
- **"In chat" files**: Full content sent to the LLM (user explicitly adds them)
- **Repo map**: Compressed structural overview of everything else
- The LLM requests additional files as needed

### No Conversation Compaction

Aider doesn't appear to have sophisticated conversation summarization. It relies on the user starting new sessions for new tasks.

### Key Insight for Us

**The repo map is elegant.** A graph-ranked structural overview of the entire codebase at ~1K tokens is remarkably efficient. The key insight is that function signatures + dependency relationships are often sufficient — you don't need file contents until you're actually editing. The dynamic sizing (expand when nothing is in context, shrink as files are added) is smart budget management.

---

## 3. Cline

### Approach: Multi-Layer Context Management with Auto-Compact

Cline has the most explicitly documented context management architecture of any tool reviewed.

### Architecture

Four components work together:
- **ContextManager**: Per-task instance. Dynamic conversation history manipulation, truncation, optimization.
- **FileContextTracker**: Tracks external file changes, prevents stale context.
- **ModelContextTracker**: Historical logging of AI model usage patterns.
- **context-window-utils**: Precise token counting and context window calculations.

### Auto-Compact System

When context usage hits ~80% (configurable via `autoCondenseThreshold`):
1. LLM-based summarization generates a comprehensive summary of the conversation
2. The bloated history is replaced with the summary
3. Work continues from the summary
4. For supported models, this uses the existing prompt cache, so "it costs about the same as any other tool call"

**Fallback**: For models that don't support advanced summarization, Cline falls back to rule-based context truncation (just dropping older messages).

### Manual Controls

- `/smol` command: User-triggered summarization to free context space
- `.clinerules` file: Project-level rules specifying when to trigger context handoff (e.g., "if context usage exceeds 50%") and what information to carry over

### Context History Updates

Cline maintains a `contextHistoryUpdates` map tracking modifications to messages over time — text alterations, file content replacements — with timestamps. This is more sophisticated than simple append-only history.

### Token Budget Awareness

- Effective window is "typically 50-70% of the advertised limit"
- Code files average 250-400 tokens per KB
- Users can see context usage in real-time in the UI

### Key Insight for Us

**The `.clinerules` handoff pattern is interesting.** Letting users define project-specific rules for when and how to do context handoffs is a form of user-configurable context policy. The `contextHistoryUpdates` map (tracking message modifications over time) is more sophisticated than most — it enables understanding what changed rather than just what exists.

---

## 4. Windsurf

### Approach: RAG + Vector Embeddings + Real-Time Awareness

Windsurf has the most aggressive "always-on context" philosophy — the AI should know what you know at every point, without you re-explaining.

### Context Engine Architecture

1. **Local codebase indexing**: Files and functions are converted to 768-dimensional vector embeddings locally. Raw source is not sent — only embeddings power retrieval.

2. **M-Query retrieval**: Windsurf's proprietary technique that uses multiple parallel queries, cross-referencing different code perspectives and reranking. Claimed to improve precision over basic cosine similarity.

3. **Hybrid search**: Combines semantic vector search with traditional BM25 keyword search.

4. **Real-time tracking**: The context engine tracks your edits, terminal commands, clipboard activity, and navigation patterns in real time. Context updates as you work, not just when you prompt.

### Multi-Layer Context

- **Cascade context engine**: Real-time tracking of edits, commands, navigation
- **Rules files**: Project and global instructions (like .cursorrules / CLAUDE.md)
- **Memories**: Persistent facts that carry across sessions — when you correct the AI or establish a preference, Windsurf stores it as a memory for future sessions

### Modes

- **Chat mode**: Context = active file + conversation history + @-mentioned files
- **Agent mode**: Autonomous — reads/writes multiple files, runs commands, chains steps

### Performance

- 8GB RAM sufficient for <100K lines
- 16GB+ recommended for large monorepos
- Initial indexing takes 5-10 minutes on large repos (background-throttled)

### Key Insight for Us

**Persistent cross-session memories are novel.** Most tools treat each session as independent. Windsurf's approach of storing user corrections and preferences as persistent memories that automatically influence future sessions is a genuine differentiator. The real-time awareness (tracking edits/navigation/clipboard without explicit prompting) is ambitious but creates the "the AI knows what I know" feeling users want.

---

## 5. OpenHands (formerly OpenDevin)

### Approach: Event-Stream Architecture + Context Condensation

OpenHands uses an event-log abstraction — every action and observation is recorded, forming the agent's persistent memory.

### Context Condensation

The key 2025 innovation. When conversation grows beyond a threshold:

1. **Trigger**: At specific context size thresholds (not continuous)
2. **Summarize**: Intelligently compress older interactions while keeping recent exchanges intact
3. **Preserve**: User goals, agent progress, remaining tasks, critical files, failing tests
4. **Replace**: Swap verbose history with condensed summary

### Performance Results (SWE-bench Verified)

| Metric | Baseline | With Condensation |
|--------|----------|-------------------|
| Cost per-turn | Quadratic growth | Up to **50% reduction**, linear growth |
| Success rate | 53% | **54%** (slight improvement) |
| Scaling | Quadratic | **Linear** |

The critical finding: condensation doesn't just save tokens — it slightly **improves** success rate, suggesting that less noisy context helps the agent perform better.

### Cache Efficiency

Condensation triggers at thresholds rather than continuously, to "leverage cache efficiency by amortizing rebuilding costs across multiple turns." This is smart — you don't want to invalidate prompt caches every turn.

### Architecture (V1 SDK)

Modular: SDK, Tools, Workspace, Server packages. Event-sourced, stateless design. Native remote execution with secure sandboxing.

### Key Insight for Us

**Less context can mean better performance.** OpenHands' finding that condensation slightly improves success rate (53% -> 54%) while halving costs is important. Context bloat actively hurts quality. Their threshold-based triggering (to preserve prompt caching) is a practical engineering detail worth copying.

---

## 6. SWE-agent (Princeton/Stanford)

### Approach: Agent-Computer Interface Design + History Processing

SWE-agent's contribution is primarily about designing the *interface* between agent and environment to keep context lean.

### Context Management Techniques

1. **Observation collapsing**: Observations older than the last 5 turns are collapsed to a single line each. Since tool observations are ~84% of an average turn's tokens, this is massive savings.

2. **Error message deduplication**: All past error messages except the first are omitted.

3. **Explicit "no output" messages**: When a command produces no output, instead of silence, the agent sees "Your command ran successfully and did not produce any output" — preventing confusion and unnecessary retries.

4. **File viewer with windowing**: Rather than dumping entire files, SWE-agent shows files through a scrollable viewer with a fixed window size.

### Research Findings (from related papers)

A key finding from the "Complexity Trap" paper: **simple observation masking is as efficient as LLM summarization** for agent context management. The expensive approach (having an LLM summarize old turns) doesn't meaningfully outperform the cheap approach (just replacing old observations with placeholders).

The "Context as a Tool" (Cat) paper proposes structured context with three zones:
- **Stable task semantics**: The problem description (rarely changes)
- **Condensed long-term memory**: Compressed history of what happened
- **High-fidelity short-term interactions**: Recent turns in full detail

### Key Insight for Us

**Observation masking is surprisingly effective.** The finding that you can just replace old tool outputs with placeholders (no expensive LLM summarization needed) and get equivalent results is potentially the most actionable finding in this entire report. Also, the 84% stat — tool observations dominate context — suggests that managing tool output size is the highest-leverage optimization.

---

## 7. Continue.dev

### Approach: Pluggable Context Providers

Continue takes a modular, user-configured approach to context.

### Context Provider System

Type `@` to see a dropdown of available context providers:
- `@file` — any file in workspace
- `@code` — specific functions/classes from the project
- `@git` — changes on current branch
- `@currentFile` — currently open file
- `@terminal` — last terminal command + output
- `@open` — all open files
- `@repo-map` — Aider-style repository map (list of files + top-level signatures)
- `@url` — fetch and include web content
- MCP servers — any MCP-compatible context source

### Architecture

Each context provider implements a standard interface for retrieving and formatting contextual data. Custom providers can be built via HTTP endpoints (POST request, return ContextItems). Continue also supports MCP (Anthropic's Model Context Protocol) for standardized tool/context integration.

### No Automatic Context Management

Continue is largely manual — the user decides what context to include. There's no automatic file selection, no RAG indexing, no conversation summarization.

### Key Insight for Us

**The pluggable provider model is clean but limited.** Continue's approach works for users who know exactly what context they need, but it doesn't solve the problem of automatic relevance detection. The `@repo-map` provider (borrowed from Aider's concept) is notable — it shows that the repo map pattern has become something of an industry standard.

---

## Cross-Cutting Analysis

### What Goes in Context: Three Paradigms

| Strategy | Tools | Pros | Cons |
|----------|-------|------|------|
| **Agent discovers own context** | Cursor | Token-efficient, flexible, proven 46.9% reduction | Agent may miss relevant files, extra tool calls |
| **Pre-indexed retrieval (RAG)** | Windsurf, Continue | Finds semantically relevant code | Indexing overhead, embedding quality varies |
| **Structural map** | Aider, Continue | Cheap (1K tokens), shows relationships | Shallow — signatures only, no implementation |

### Context Overflow Handling

| Strategy | Tools | Mechanism |
|----------|-------|-----------|
| **LLM summarization** | Cline, OpenHands, Cursor | LLM compresses old conversation into summary |
| **Observation masking** | SWE-agent | Replace old tool outputs with placeholders |
| **History file reference** | Cursor | Summarize but keep full history in a file the agent can search |
| **Threshold-based trigger** | OpenHands, Cline | Trigger at 80% to preserve prompt caching |
| **Manual new session** | Aider, Continue | User starts fresh |

### Token Budget Systems

| Tool | Default Budget | User Control |
|------|---------------|--------------|
| Aider | 1K tokens for repo map (`--map-tokens`) | Yes, CLI flag |
| Cline | 80% auto-compact threshold | Yes, configurable threshold |
| Cursor | 200K window, dynamic | No direct control |
| Windsurf | Automatic RAG retrieval | No direct control |
| OpenHands | Threshold-based condensation | Limited |
| SWE-agent | Last 5 observations in full | Configurable in code |

### Universal User Complaints

Every tool suffers from:
1. **Context amnesia**: Agent forgets instructions/decisions from earlier in the conversation
2. **Performance cliff**: Quality degrades sharply past ~70-80% context usage
3. **Invisible context**: Users can't see what the agent actually has in context
4. **Stale context**: File changes made outside the tool aren't reflected
5. **Summarization lossy-ness**: Important details lost during compaction

---

## Techniques Worth Stealing

### Tier 1: High-Value, Proven

1. **Files as context primitive** (Cursor): Write large outputs to files instead of stuffing them in context. Let the agent grep/tail as needed. The 46.9% MCP token reduction proves this works.

2. **Observation masking over LLM summarization** (SWE-agent): Simple placeholder replacement for old tool outputs is as effective as expensive LLM summarization. Tool outputs are 84% of context — this is where the leverage is.

3. **Threshold-based condensation with cache preservation** (OpenHands): Don't condense continuously — trigger at thresholds to preserve prompt caching. Condensation can slightly *improve* success rate by reducing noise.

4. **Repo map** (Aider): Graph-ranked structural overview at ~1K tokens gives the LLM a "table of contents" for the entire codebase. Dynamic sizing based on what's already in context.

### Tier 2: Novel, Worth Experimenting With

5. **Persistent cross-session memories** (Windsurf): Store user corrections and preferences as memories that persist across sessions. Goes beyond per-project rules to learned behavior.

6. **Summarization + searchable history backup** (Cursor): Summarize for the prompt, but keep the full history in a file the agent can search when it needs to recover details. Belt-and-suspenders approach.

7. **User-configurable context policies** (Cline `.clinerules`): Let users define project-specific rules for when to trigger handoffs and what to preserve.

8. **Structured three-zone context** (Cat/SWE-agent research): Divide context into stable task description, condensed long-term memory, and full short-term interactions. More principled than just "old stuff gets summarized."

### Tier 3: Interesting but Heavy

9. **Real-time RAG with vector embeddings** (Windsurf): 768-dim embeddings + hybrid BM25/vector search. Powerful but requires local indexing infrastructure.

10. **Real-time awareness of user actions** (Windsurf): Track edits, navigation, clipboard, terminal without explicit prompting. Creates "the AI knows what I know" feeling but is IDE-specific.

---

## Recommendations for Claudex

Based on this research, the highest-ROI improvements for our context system would be:

1. **Implement observation masking for old tool outputs** — Replace tool outputs older than N turns with single-line placeholders. This is the cheapest, most proven technique and targets the biggest token consumer (84% of turn tokens are observations).

2. **Write large outputs to files, not context** — When a tool produces >N tokens of output, write to a temp file and give the agent a reference. Let it grep/tail as needed. Cursor proved this works.

3. **Add a repo map layer** — A tree-sitter-based structural overview of the codebase at 1-2K tokens, sent with each request. Aider's approach is proven and the concept has been adopted by Continue as well.

4. **Threshold-based condensation with cache awareness** — Trigger summarization at ~80% context, not continuously. Preserve prompt cache. OpenHands showed this maintains quality while cutting costs 50%.

5. **Keep full history searchable after summarization** — When we summarize, keep the original history accessible (as a file or searchable store). Cursor's approach prevents irrecoverable information loss.

---

## Sources

### Cursor
- [Dynamic Context Discovery Blog](https://cursor.com/blog/dynamic-context-discovery)
- [Context Learning Page](https://cursor.com/learn/context)
- [Cursor Forum: Loses Context](https://forum.cursor.com/t/unusable-loses-context/96583)
- [Cursor Forum: 80% Context Failure](https://forum.cursor.com/t/cursor-fails-to-work-once-80-context-is-passed/140056)
- [Cursor Forum: Context Retrieval Degraded](https://forum.cursor.com/t/cursor-context-retrieval-degraded/79196)

### Aider
- [Repository Map Docs](https://aider.chat/docs/repomap.html)
- [Building Better Repo Map with Tree-Sitter](https://aider.chat/2023/10/22/repomap.html)
- [Repo Map Context Issue #618](https://github.com/paul-gauthier/aider/issues/618)

### Cline
- [Context Management Docs](https://docs.cline.bot/prompting/understanding-context-management)
- [Auto Compact Docs](https://docs.cline.bot/features/auto-compact)
- [Context Window Explained Blog](https://cline.bot/blog/clines-context-window-explained-maximize-performance-minimize-cost)
- [Context Engineering Blog](https://cline.bot/blog/how-to-think-about-context-engineering-in-cline)
- [Dissecting Cline Context Management](https://medium.com/@balajibal/dissecting-cline-cline-context-management-260aec3d84cb)

### Windsurf
- [Cascade Docs](https://docs.windsurf.com/windsurf/cascade/cascade)
- [Context Awareness Overview](https://docs.windsurf.com/context-awareness/overview)
- [Flow Context Engine Explained](https://markaicode.com/windsurf-flow-context-engine/)
- [Windsurf Memories System](https://www.arsturn.com/blog/understanding-windsurf-memories-system-persistent-context)
- [Remote Indexing & Multi-Repo](https://windsurf.com/blog/remote-indexing-multirepo-announcement)

### OpenHands
- [Context Condensation Blog](https://openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents)
- [OpenHands SDK Paper (arXiv)](https://arxiv.org/html/2511.03690v1)
- [OpenHands Platform Paper (arXiv)](https://arxiv.org/abs/2407.16741)

### SWE-agent
- [SWE-agent GitHub](https://github.com/SWE-agent/SWE-agent)
- [SWE-agent NeurIPS 2024 Paper](https://proceedings.neurips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf)
- [Context as a Tool Paper (arXiv)](https://arxiv.org/html/2512.22087)
- [Complexity Trap Paper (arXiv)](https://arxiv.org/html/2508.21433v1)

### Continue.dev
- [Context Providers Docs](https://docs.continue.dev/customization/context-providers)
- [Chat Mode Context Selection](https://docs.continue.dev/ide-extensions/chat/context-selection)
- [Codebase & Documentation Awareness Guide](https://docs.continue.dev/guides/codebase-documentation-awareness)

### General
- [Context Engineering for AI Agents](https://www.getmaxim.ai/articles/context-engineering-for-ai-agents-production-optimization-strategies/)
- [Context Window Management Strategies](https://www.getmaxim.ai/articles/context-window-management-strategies-for-long-context-ai-agents-and-chatbots/)
