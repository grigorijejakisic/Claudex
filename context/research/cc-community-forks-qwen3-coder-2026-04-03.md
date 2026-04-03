# Street Knowledge: CC Community Forks, Token Optimization & Qwen3 Coder
**Research date:** 2026-04-03
**Topic:** Community Claude Code forks (memory/persistence, token optimization, multi-model routing) + Qwen3 Coder integration

---

## Executive Summary

The Claude Code ecosystem has exploded into a mature community layer. Three major patterns dominate: (1) "supercharged CLAUDE.md" repos that wire skills/hooks/agents without touching the binary, (2) transparent API proxies that intercept CC's Anthropic calls and route to cheaper/local models, and (3) standalone MCP servers that bolt persistent memory onto CC's ephemeral context. Qwen3-Coder-Next is the highest-signal open-weight coding model as of early 2026: 70.6% SWE-Bench Verified (vs Sonnet 4.6's 79.6%), available on OpenRouter at **$0.12/M input / $0.75/M output** — roughly 20x cheaper than Sonnet. Tool-calling reliability under local quantized Ollama deployment is the main failure mode to engineer around.

---

## Layer 1: What Exists (Implementations)

### 1.1 Community CC Extension Frameworks

**everything-claude-code** (affaan-m / WorldFlowAI)
- URL: https://github.com/affaan-m/everything-claude-code
- Stars: ~100K (confirmed 100K milestone March 2026)
- What it is: Agent harness with 28 specialist sub-agents, 119 skills, 60 commands. Works across CC, Cursor, Codex, OpenCode from single repo.
- Memory: v2 continuous learning extracts session patterns into "instincts" with confidence scoring, import/export, and upgrade path to full skills.
- What to steal: The instinct confidence scoring pattern — extracted patterns don't become permanent until validated across N sessions.

**awesome-claude-code** (hesreallyhim)
- URL: https://github.com/hesreallyhim/awesome-claude-code
- Curated directory, not a framework. Best index of what the community has built.
- Tracks: hooks, MCP servers, orchestrators, GUI tools, memory systems.

**awesome-claude-code-toolkit** (rohitg00)
- URL: https://github.com/rohitg00/awesome-claude-code-toolkit
- Stars: not confirmed
- 135 agents, 35 skills, 42 commands, 150+ plugins, 19 hooks, 15 rules, 8 MCP configs.
- Notably more aggressive scope than everything-claude-code.

**Claudify**
- URL: via awesome-claude-code issues #1266
- Ships with 1,727 skills across 31 categories, 9 specialist agents with persistent memory, 21 slash commands, 9 safety hooks, self-improving knowledge base, 6-tier memory architecture.
- Most sophisticated memory architecture found in the wild.

### 1.2 Memory / Persistence Systems

**claude-map-reduce-memory** (agynio)
- URL: https://github.com/agynio/claude-map-reduce-memory
- Architecture: PreToolUse hook fires before EVERY tool call. Reads transcript + upcoming call, runs scatter-gather retrieval across fixed-size note chunks (one Haiku call per chunk, parallel), deduplicates against already-injected [MEMORY] hints in transcript. Only new hints are injected.
- Key insight: Relevance-based retrieval via small LLM reasoning (not string matching). Context stays bounded because it deduplicates against the live transcript.
- Solves: MEMORY.md per-repo falloff-by-position problem.

**mcp-memory-service** (doobidoo)
- URL: https://github.com/doobidoo/mcp-memory-service (wiki has CC hook integration guide)
- Hook docs: https://github.com/doobidoo/mcp-memory-service/wiki/Claude-Code-v7.1.3-Enhanced-Memory-Hooks
- MCP server approach — memory stored in MCP, retrieved via natural language triggers in hooks.

**everything-claude-code/hooks/memory-persistence**
- URL: https://github.com/affaan-m/everything-claude-code/tree/main/hooks/memory-persistence
- Session lifecycle hooks for save/load patterns.

**claude-mem** (thedotmack)
- URL: https://github.com/thedotmack/claude-mem
- Simpler per-session memory persistence.

### 1.3 Multi-Model Routing

**claude-code-router** (musistudio)
- URL: https://github.com/musistudio/claude-code-router
- Stars: 31,400
- Architecture: Transparent API proxy that intercepts CC's Anthropic calls and routes to configured providers. Does NOT modify CC binary.
- Routing rule types:
  - `default` → deepseek-chat (cheap, fast)
  - `background` → ollama/qwen2.5-coder (local, free)
  - `think` → deepseek-reasoner (reasoning tasks)
  - `longContext` → google/gemini-2.5-pro (60k+ token inputs)
  - `webSearch` → gemini-2.5-flash (web-enabled)
- Supported providers: OpenRouter, DeepSeek, Ollama, Gemini, Volcengine, ModelScope, DashScope, AIHubMix
- Key env vars: `ANTHROPIC_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` (subagent/worker override), `ANTHROPIC_CUSTOM_MODEL_OPTION` (adds custom entry to /model picker)
- Limitation: Routing is deterministic per config, NOT automatic fallback. Must configure manually.
- Activity: 763 open issues, 99 PRs, actively maintained.

**OpenRouter native CC integration**
- URL: https://openrouter.ai/docs/guides/coding-agents/claude-code-integration
- Can point CC's `ANTHROPIC_BASE_URL` at OpenRouter. Free models available: Qwen3-Coder (262K context), DeepSeek R1, gpt-oss-20b.
- Privacy note: Free models on OpenRouter require explicitly enabling in privacy settings or data goes to 3rd parties.

### 1.4 Token Optimization MCPs

**token-optimizer-mcp** (ooples)
- URL: https://github.com/ooples/token-optimizer-mcp
- Stars: 27 (released Oct 2025 — still small but functional)
- Claims 95%+ token reduction via Brotli compression + SQLite caching + accurate token counting.
- MCP server approach — Claude uses it via tool calls.

**Context optimization gist** (johnlindquist)
- URL: https://gist.github.com/johnlindquist/849b813e76039a908d962b2f0923dc9a
- 54% reduction in initial context tokens (7,584 → 3,434) by lazy-loading tool docs. Key insight: Claude doesn't need full docs upfront, just triggers to know WHEN to load detail.

**MCP Response Analyzer pattern** (Medium article)
- URL: https://medium.com/@pierreyohann16/optimizing-token-efficiency-in-claude-code-workflows-managing-large-model-context-protocol-f41eafdab423
- 97% savings by routing oversized MCP JSON responses through a file-based analyzer skill instead of dumping raw JSON into context.

### 1.5 Open Source CC Clones / Alternatives

**OpenCode** (anomalyco)
- URL: https://github.com/anomalyco/opencode
- Stars: 112K+ (largest OSS coding agent community)
- Built from CC source leak (March 31, 2026) + clean-room TypeScript rewrite.
- Supports 75+ providers. TUI built on OpenTUI (TypeScript + Zig backend). Syntax-highlighted inline diffs.
- Claudex is referenced alongside it as compatible.

**Qwen Code** (QwenLM)
- URL: https://github.com/QwenLM/qwen-code
- Forked from Gemini CLI, enhanced parser + tool support for Qwen-Coder models.
- VS Code extension (Beta). Supports Qwen OAuth (free), API keys, and OpenAI-compatible endpoints.
- Model providers doc: https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/
- This is Alibaba's official CC-equivalent for Qwen3-Coder models.

---

## Layer 2: Why It Works (Science & Theory)

### 2.1 Memory Architecture Theory

**ACON: Optimizing Context Compression for Long-horizon LLM Agents** (Oct 2025)
- arxiv: https://arxiv.org/abs/2510.00615
- Dynamically condenses observations + interaction histories via guideline optimization (failure analysis in natural language). Gradient-free, can distill into smaller models.
- Practical implication: The "compress on failure" pattern — optimize what to retain by learning from what caused errors.

**Agentic Memory: Unified Long-Term and Short-Term Memory Management** (Jan 2026)
- arxiv: https://arxiv.org/abs/2601.01885
- AgeMem: exposes memory ops as tool-based actions, trains via 3-stage progressive RL (GRPO). Integrates into agent policy, not bolted on.
- Practical: Memory as first-class tool calls, not injected hints. Aligns with Claudex's tool-based approach.

**Memory in the Age of AI Agents — Survey** (Dec 2025)
- arxiv: https://arxiv.org/abs/2512.13564
- Two strategies when context exceeds KV cache: (1) KV compression (quantize/prune/offload), (2) external long-term memory (database offload). Both are valid but solve different problems.
- The field is "rapidly expanding but increasingly fragmented."

**A-Mem: Agentic Memory for LLM Agents** (Feb 2025)
- arxiv: https://arxiv.org/pdf/2502.12110
- Treats memory as an agent capability, not infrastructure. Memory becomes part of the agent's action space.

### 2.2 Why Qwen3-Coder Works

- MoE (Mixture of Experts) sparse architecture: 80B total / 3B active params. Only activates relevant experts per token.
- Trained on "large collections of verifiable coding tasks paired with executable environments" — learns from environment feedback, not just supervised labels.
- Long-horizon RL on SWE-Bench: The model is explicitly trained on the evaluation distribution, which partially explains the high SWE-bench scores.
- Matryoshka embeddings + 256K native context (1M with Yarn extrapolation).

---

## Layer 3: What's Wrong (Failures & Anti-Patterns)

### 3.1 Claude Code Infrastructure Failures

**August–September 2025 infrastructure crisis**
- ~30% of CC users experienced at least one misrouted request.
- Root cause: Some Sonnet 4 requests routed to 1M-context-window server config. Affected 0.8% initially, cascaded.
- December 2025: 5 documented incidents in one month.
- January 26-28, 2026: Major quality regression from harness bug, confirmed by Anthropic.

**March 2026 quota drain**
- MAX subscribers reporting quota exhaustion in 19 minutes instead of 5 hours.
- Community found two cache bugs that can 10-20x API costs silently.
- The leaked source let people patch root causes — r/ClaudeAI thread: 1,800+ upvotes.

**Long context reliability cliff**
- Effective reliable range: ~200-256K tokens
- At 1M tokens: 1 in 4 retrievals fail
- At 1M: progressive degradation begins after 20% context fill

### 3.2 Claude Code Router Anti-Patterns

**Design flaw: Non-automatic routing**
- Routing is deterministic per config, no automatic quality fallback. If Qwen fails on a task, it stays with Qwen.
- Community reports: "routing to alternative models resulted in poor outcomes" for tool-heavy tasks.

**Quality degradation for tool calls**
- Claude Sonnet 4 was "the only one that got MCP tool integration right on the first try."
- Alternative models frequently produce malformed tool call JSON or pick wrong tool.

### 3.3 Qwen3-Coder Tool Calling Failures

**Tool count threshold bug** (GitHub: block/goose #6883)
- With ≤5 tools: native JSON tool calling works.
- With 6+ tools (Goose has 11 default): switches to XML-style text output. Completely breaks structured tool calling.
- Status: Known issue, not fully resolved in Ollama deployment.

**Qwen3-Coder 30B chat template bug** (GitHub: QwenLM/Qwen3-Coder #475)
- In FP8 quantization: model frequently omits initial `<tool_call>` tag when tool call follows text response.
- Fix: Use unsloth GGUF versions with corrected chat template (https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF).

**Long context hallucination** (llama.cpp discussion #20000)
- At ~80K tokens: repetition and hallucination from improper clamping of cumulative sum of decay.
- Practical limit for reliable output: ~60-80K tokens locally.

**MCP/tool calling loop break** (continue.dev #8744)
- When last message is assistant message WITH tool calls: renderer never emits `<|im_end|>` or generation prompt. Breaks entire tool call round-trip.
- Framework-specific — affects Continue.dev integration.

**Qwen3.5 Plus tool degradation** (QwenLM/Qwen3.5 #12)
- After first few successful tool calls: model starts outputting raw text instead of invoking tools. Via OpenRouter API.
- Appears to be a stateful regression across turns.

### 3.4 Token Optimization Anti-Patterns

**CLAUDE.md verbosity trap**
- If CLAUDE.md grows too large, it costs more tokens than it saves.
- Practical: Keep CLAUDE.md tight. Use lazy-load patterns for extended docs.

**Extended thinking default cost**
- Default extended thinking: 31,999 tokens/request. Cutting to 10,000 = 70% reduction in hidden thinking cost.
- Most tasks don't need full extended thinking budget.

**Pre-compaction panic**
- Auto-compaction is lossy. Community pattern: proactive clear at 50% context + structured recovery beats waiting for CC's auto-compaction.

---

## Layer 4: Adjacent Insights (Cross-Domain)

### 4.1 Distributed Systems: Consistent Hashing for Model Routing
The claude-code-router's task-type routing is essentially consistent hashing by request characteristics. Distributed systems use this to route to the "right node" without central coordination. The routing rules (think/background/longContext) map directly to "request class → shard." The gap: no health-aware routing. A production distributed system would monitor model failure rates and reroute. Applicable: Add health metrics to routing decisions — if qwen fails >20% of tool calls, promote to sonnet automatically.

### 4.2 Library Science: Tiered Archival for Memory
Physical library science tiered access (hot shelf → stacks → offsite archive) maps directly to agent memory: working context (hot) → session summary (warm) → long-term DB (cold). Claudex already implements this. The insight from library science that's underused: **weeding** — systematic removal of stale/incorrect memories. Most agent memory systems only add, never deprecate.

### 4.3 Game Design: Relevance Decay for Context
Game engines use LOD (Level of Detail) — render high-detail only what's in view, degrade what's far away. The scatter-gather map-reduce memory (agynio) implements this for context. The adjacent game design pattern: **interest management** in MMORPGs — only broadcast events to nearby players. Applied: Only inject memory hints relevant to the CURRENT TOOL CALL, not the session topic in general. agynio already does this; most other systems don't.

### 4.4 Recommender Systems: Collaborative Filtering for Agent Patterns
Spotify's collaborative filtering ("users like you also liked...") maps to: "agents solving similar problems used these tools/patterns." The `everything-claude-code` instinct system is early collaborative filtering — patterns validated across sessions gain confidence. Not yet cross-user. Gap: No shared community instinct pool.

---

## Layer 5: Frontier (What's Next)

**AgeMem — Memory as RL Tool Actions** (Jan 2026)
- arxiv: https://arxiv.org/abs/2601.01885
- Maturity: Early Research
- Memory operations exposed as tool calls, trained via GRPO. The agent LEARNS when to store/retrieve, not following hardcoded hooks.
- Risk: Requires RL training pipeline, not plug-and-play.
- Timeline: 6-12 months to production-ready adaptation.

**ACON Context Compression with Gradient-Free Distillation** (Oct 2025)
- arxiv: https://arxiv.org/abs/2510.00615
- Maturity: Prototype
- Compressor prompt is optimized from failure analysis, then distilled into a smaller model (e.g., Haiku) for cheap deployment. The compressor itself becomes a trained artifact.
- Timeline: Could be adapted to Claudex's summarization pipeline now.

**Qwen Code as OpenSource CC Fork** (QwenLM, early 2026)
- URL: https://github.com/QwenLM/qwen-code
- Maturity: Nearly Production
- Alibaba's official Qwen-based CC fork. Uses Qwen OAuth for free API access. Already working with Qwen3-Coder-Next.
- Risk: Tied to Qwen ecosystem. Tool calling bugs at high tool counts.
- Timeline: Production-viable now for Qwen-specific workflows.

**OpenCode (anomalyco) — CC Clone with 75+ Providers** (2026)
- URL: https://github.com/anomalyco/opencode
- Stars: 112K
- Maturity: Nearly Production
- Built from leaked CC source. Provider-agnostic. Zig+TypeScript TUI.
- Risk: Derived from leaked source — legal ambiguity for commercial use.
- Timeline: Already production-viable for personal use.

**Claudify's 6-Tier Memory Architecture**
- URL: via awesome-claude-code issues
- Maturity: Prototype
- Most sophisticated memory hierarchy in the wild. 1,727 skills + 9 agents + self-improving knowledge base.
- Risk: Single-maintainer, undocumented architecture.
- Timeline: Worth monitoring for patterns to adopt.

---

## Synthesis

### 1. Recommended Approach for Claudex

**Drop-in fallback when MAX tokens run out:**
- Use `claude-code-router` (31K stars, actively maintained) as a transparent proxy
- Configure `ANTHROPIC_BASE_URL` to point at the router
- Router sends `default` tasks → `qwen/qwen3-coder-next` on OpenRouter ($0.12/M input)
- Router sends `think`/complex tasks → stays on Sonnet (or DeepSeek reasoner as second fallback)
- Key env vars: `CLAUDE_CODE_SUBAGENT_MODEL=qwen/qwen3-coder-next` for background agents

**Cost reality check:**
- Sonnet 4.5: $3.00/M input, $15.00/M output
- Qwen3-Coder-Next via OpenRouter: $0.12/M input, $0.75/M output
- Ratio: ~25x cheaper on input, ~20x cheaper on output
- SWE-Bench gap: Sonnet 4.6 at 79.6% vs Qwen3-Coder-Next at 70.6% — ~9 point gap
- Verdict: For background/scaffolding tasks, the 20x cost savings outweighs the quality gap.

### 2. Build vs Borrow

| Component | Decision | Rationale |
|-----------|----------|-----------|
| Multi-model routing | **Borrow** claude-code-router | 31K stars, proven, config-only |
| Memory scatter-gather | **Borrow** agynio pattern | PreToolUse hook already proven |
| Token compression | **Adopt** lazy-load docs pattern | 54% reduction, 1-file change |
| Extended thinking budget | **Tune now** → 10K tokens | 70% cost reduction, immediate |
| MCP response filtering | **Build** (fits Claudex's hook system) | 97% savings on large MCP responses |
| Agent memory RL | **Watch** AgeMem arxiv | 6-12 months away |

### 3. Critical Anti-Patterns to Avoid

1. **Don't route tool-heavy tasks to Qwen via Ollama** — 6+ tools breaks structured JSON. Use cloud API (OpenRouter) where tool count limit is higher.
2. **Don't use default extended thinking** — 31,999 token budget. Cap at 10,000.
3. **Don't let CLAUDE.md grow** — verbosity trap. Keep it tight.
4. **Don't use auto-compaction without a recovery hook** — lossy, silent context destruction.
5. **Don't use Qwen3-Coder locally beyond ~60K token context** — hallucination/repetition cliff at 80K.
6. **Don't use unsloth GGUF Qwen without the updated chat template** — breaks tool call round-trips.

### 4. The Adjacent Insight Worth Adopting

**Interest management from MMO game engines.** Don't inject all relevant memories per session — inject only what's relevant to the CURRENT TOOL CALL. agynio's PreToolUse hook does this. Claudex's PostToolUse hook currently summarizes broadly. Narrowing injection to the specific tool context would reduce per-turn overhead without losing recall.

### 5. The Frontier Bet Worth Watching

**ACON's failure-analysis compressor distillation** — compress what gets retrieved based on what caused failures, then distill that compressor into a small model (Haiku/Qwen-3B). Cheap, gradient-free, and adaptable to Claudex's existing summarization step. Most actionable frontier item for this codebase.

### 6. Gaps Nobody Is Addressing

- **Cross-user instinct sharing** — every CC user rebuilds the same patterns from scratch. No community pool.
- **Health-aware model routing** — all routers are deterministic. No live quality signal monitoring.
- **Memory weeding** — systems add memories forever. No systematic deprecation of stale/wrong observations.
- **Quantized Qwen tool reliability at scale** — the 6-tool threshold bug is unresolved. No upstream fix.

---

## Key Repos (Quick Reference)

| Repo | Purpose | Stars | URL |
|------|---------|-------|-----|
| affaan-m/everything-claude-code | CC framework, 28 agents, 119 skills | ~100K | https://github.com/affaan-m/everything-claude-code |
| musistudio/claude-code-router | Multi-model proxy router | 31.4K | https://github.com/musistudio/claude-code-router |
| hesreallyhim/awesome-claude-code | Curated CC ecosystem index | - | https://github.com/hesreallyhim/awesome-claude-code |
| agynio/claude-map-reduce-memory | PreToolUse scatter-gather memory | - | https://github.com/agynio/claude-map-reduce-memory |
| anomalyco/opencode | OSS CC clone, 75+ providers | 112K | https://github.com/anomalyco/opencode |
| QwenLM/qwen-code | Qwen's CC fork | - | https://github.com/QwenLM/qwen-code |
| QwenLM/Qwen3-Coder | Qwen3-Coder model | - | https://github.com/QwenLM/Qwen3-Coder |
| ooples/token-optimizer-mcp | 95% token reduction MCP | 27 | https://github.com/ooples/token-optimizer-mcp |
| rohitg00/awesome-claude-code-toolkit | 135 agents, 150+ plugins | - | https://github.com/rohitg00/awesome-claude-code-toolkit |
| doobidoo/mcp-memory-service | MCP-based memory service | - | https://github.com/doobidoo/mcp-memory-service |

## Qwen3-Coder-Next — API Quick Reference

- Model ID (OpenRouter): `qwen/qwen3-coder-next`
- Input: $0.12/M tokens
- Output: $0.75/M tokens  
- Cached: $0.06/M tokens
- Context window: 262,144 tokens (native), up to 1M with Yarn
- Max output: 65,536 tokens
- SWE-Bench Verified: 70.6%
- Ollama: `ollama pull qwen3-coder-next` → `http://localhost:11434/api/chat`
- HuggingFace: https://huggingface.co/Qwen/Qwen3-Coder-Next
- GGUF (fixed chat template): https://huggingface.co/unsloth/Qwen3-Coder-Next-GGUF
