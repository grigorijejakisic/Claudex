# Agent Self-Awareness: The State of the Art

## Research Report — 2026-03-13

This report surveys the frontier of AI agent self-awareness: systems where agents monitor their own context consumption, resource usage, and cognitive limitations, and adapt their behavior accordingly.

---

## 1. Executive Summary

Agent self-awareness is transitioning from an aspirational concept to a practical engineering requirement. As of early 2026, the field has produced:

- **Production systems** with threshold-based context monitoring (Claude Code, OpenAI Codex, Google ADK, ForgeCode, OpenCrabs)
- **Research frameworks** for budget-aware tool selection (BATS), token-budget-aware reasoning (TALE), and autonomous context compression (Focus, LangChain Deep Agents)
- **Foundational architectures** that treat context as a managed resource (MemGPT, RLM, Aeon)
- **Empirical evidence** that LLMs possess limited metacognitive capabilities, including confidence calibration and error anticipation, but lack spontaneous self-monitoring without explicit prompting

The dominant finding across all research: **agents do not naturally become self-aware of resource constraints**. Every successful implementation requires explicit scaffolding — whether through prompt-level budget signals, architectural primitives, or reinforcement learning. The gap between "an agent that can reason about its limitations when told to" and "an agent that spontaneously monitors and adapts" remains substantial.

---

## 2. Taxonomy of Agent Self-Awareness

### 2.1 Reactive Self-Awareness (Error-Driven)
The agent discovers its limits only when they are exceeded.
- **Mechanism**: API error handling (context_length_exceeded)
- **Examples**: Agentic Patterns auto-compaction, reactive retry loops
- **Complexity**: Low
- **Effectiveness**: Prevents crashes but causes information loss at worst moments

### 2.2 Threshold Self-Awareness (Metric-Driven)
The agent is told its resource state via external monitoring.
- **Mechanism**: Token counters, percentage thresholds, budget trackers
- **Examples**: Claude Code (80% auto-compact), OpenCrabs (80%/90% dual threshold), ForgeCode (configurable), Google ADK (event-count windows), BATS Budget Tracker
- **Complexity**: Medium
- **Effectiveness**: Prevents degradation but timing is heuristic-based

### 2.3 Autonomous Self-Awareness (Agent-Initiated)
The agent decides when to act on its own state assessment.
- **Mechanism**: Exposed compression/checkpoint tools that the agent invokes voluntarily
- **Examples**: LangChain Deep Agents, Focus (start_focus/complete_focus), MemGPT
- **Complexity**: High
- **Effectiveness**: Better timing but agents are conservative — they rarely trigger compression without aggressive prompting

### 2.4 Learned Self-Awareness (Training-Based)
The agent internalizes resource awareness through training.
- **Mechanism**: SFT/DPO/RL to embed budget consciousness into model weights
- **Examples**: TALE-PT, RLM (aspirational), ReMA
- **Complexity**: Very high
- **Effectiveness**: Potentially transformative but currently limited to narrow domains (math reasoning)

---

## 3. Key Systems and Implementations

### 3.1 BATS — Budget-Aware Test-time Scaling (Google DeepMind)
**Paper**: [arxiv:2511.17006](https://arxiv.org/abs/2511.17006)

**How the agent becomes aware**: A lightweight "Budget Tracker" plug-in appends a status block to every prompt showing remaining and used budgets per tool, plus policy guidelines calibrated to budget regimes (HIGH >=70%, MEDIUM 30-70%, LOW 10-30%, CRITICAL <10%).

**Signals used**: Remaining tool-call count per tool type, used/total ratios, budget regime classification.

**Behavioral adaptation**: At high budget, the agent explores broadly. At low budget, it narrows focus to verification of existing leads. The BATS framework adds a planning module that dynamically adjusts exploration breadth vs. verification depth, and a verification module that decides to "dig deeper" or "pivot" based on remaining resources.

**Results**: On BrowseComp: 24.6% accuracy vs. 12.6% ReAct baseline. Comparable accuracy at 10 tool calls vs. 100 for unaware agents. 40.4% fewer search calls, 21.4% fewer browse calls for equivalent performance.

**Key insight**: Simply granting agents a larger tool-call budget does NOT improve performance. Without budget awareness, agents hit a performance ceiling because they don't realize they still have resources left. Budget awareness alone (without BATS planning) already produces meaningful improvement.

**Implementation complexity**: Low (prompt-level, no fine-tuning required).

---

### 3.2 TALE — Token-Budget-Aware LLM Reasoning
**Paper**: [ACL 2025 Findings](https://aclanthology.org/2025.findings-acl.1274/) | [arxiv:2412.18547](https://arxiv.org/abs/2412.18547) | [Code](https://github.com/GeniusHTX/TALE)

**How the agent becomes aware**: Two approaches:
- **TALE-EP**: The LLM itself estimates reasoning complexity via zero-shot prompting ("estimate the minimum tokens needed"), then receives that budget in the prompt.
- **TALE-PT**: Post-training (SFT/DPO) on examples of budget-compliant reasoning to internalize awareness into model weights.

**Signals used**: Self-estimated token budget based on problem complexity analysis.

**Behavioral adaptation**: The model adjusts reasoning chain length to fit the estimated budget. A critical finding called "token elasticity": when budgets are too tight, models paradoxically produce longer outputs by abandoning compliance entirely. There exists an "ideal budget range" per problem where models naturally constrain reasoning without overthinking.

**Results**: TALE-EP achieves 81.03% accuracy with 67% fewer tokens vs. 83.75% for vanilla CoT. On simple problems (GSM8K-Zero), TALE-EP actually exceeds CoT accuracy (98.72%) while using only 22.67 tokens vs. 252.96.

**Key insight**: Models CAN reason about their own token consumption, but only within a viable budget window. Below that window, compliance collapses catastrophically.

**Implementation complexity**: TALE-EP is low (prompting). TALE-PT is high (requires training pipeline).

---

### 3.3 Focus — Active Context Compression
**Paper**: [arxiv:2601.07190](https://arxiv.org/abs/2601.07190)

**How the agent becomes aware**: Two primitives — `start_focus` (declare investigation scope) and `complete_focus` (summarize learnings, prune raw history) — exposed as tools. The agent has full autonomy over when to invoke them.

**Signals used**: The agent's own judgment about sub-task boundaries.

**Behavioral adaptation**: Creates a "sawtooth" context pattern — context grows during investigation, then drops sharply when the agent decides to consolidate. Learnings persist in a structured "Knowledge" block while raw interaction history is pruned.

**Critical finding**: Passive prompting FAILED. With minimal guidance, agents triggered only 1-2 compressions per task (6% savings, with accuracy degradation). Success required aggressive prompting: mandatory workflow instructions ("ALWAYS call start_focus before exploration"), periodic system reminders after 15 tool calls, and explicit structural guidance.

**Results**: 22.7% token reduction on SWE-bench instances with no accuracy loss. Per-instance variance was high: -18% to +57% savings depending on task type.

**Key insight**: Current LLMs lack intrinsic cost-awareness. They will NOT spontaneously optimize for efficiency without explicit scaffolding. This is perhaps the single most important finding for the field.

**Implementation complexity**: Medium (tool exposure + prompt engineering).

---

### 3.4 MemGPT / Letta — OS-Inspired Memory Management
**Paper**: [arxiv:2310.08560](https://arxiv.org/abs/2310.08560) | [Site](https://research.memgpt.ai/)

**How the agent becomes aware**: Treats the LLM as an operating system managing its own memory through a two-tier architecture: main context (in-context RAM) and external context (disk storage). The agent uses function calls to page information between tiers.

**Signals used**: Main context fullness, relevance assessments of stored memories.

**Behavioral adaptation**: The agent proactively moves less-relevant information to external storage and retrieves it when needed. Self-editing memory capabilities allow the agent to modify its own context through tool use.

**Key insight**: The OS metaphor is powerful — treating context as a managed resource rather than a passive log transforms agent capabilities for long-horizon tasks.

**Implementation complexity**: High (requires custom memory management infrastructure).

---

### 3.5 RLM — Recursive Language Models (Prime Intellect)
**Paper/Blog**: [Prime Intellect Blog](https://www.primeintellect.ai/blog/rlm) | [Code](https://github.com/PrimeIntellect-ai/verifiers)

**How the agent becomes aware**: The agent uses a persistent Python REPL to inspect and transform its input data, and calls sub-LLMs from within that REPL. Context is delegated rather than consumed directly.

**Signals used**: Programmatic context inspection rather than direct token awareness.

**Behavioral adaptation**: Instead of loading data into the context window, the agent writes Python code to process it externally. Sub-LLMs handle sub-tasks with fresh context windows. The main model's context stays lean.

**Current state**: The system demonstrates structural autonomy (operating within scaffolding) rather than true self-awareness. The authors state that "teaching models to manage their own context end-to-end through reinforcement learning will be the next major breakthrough" — implying this hasn't been achieved yet.

**Implementation complexity**: Very high (requires REPL environment, sub-LLM infrastructure, training pipeline).

---

### 3.6 LangChain Deep Agents — Autonomous Context Compression
**Blog**: [LangChain Blog](https://blog.langchain.com/autonomous-context-compression/)

**How the agent becomes aware**: A compression tool is exposed to the agent via middleware (`create_summarization_tool_middleware()`). The agent can invoke it at any time.

**Signals used**: The agent's own assessment of whether prior context is becoming irrelevant.

**Behavioral adaptation**: When invoked, the tool retains recent messages (10% of available context) and summarizes everything before that. Full history is retained in the virtual filesystem for recovery.

**Key finding**: Agents are conservative about triggering compaction but choose good moments when they do — typically at task boundaries or when prior context is superseded. This suggests agents CAN develop reasonable timing intuition for compression, even if they don't initiate it frequently enough.

**Implementation complexity**: Low-medium (SDK middleware integration).

---

### 3.7 Context Rot Detection MCP Service
**Repo**: [github.com/milos-product-maker/context-rot-detection](https://github.com/milos-product-maker/context-rot-detection)

**How the agent becomes aware**: An MCP tool (`check_my_health`) returns a 0-100 health score computed from four weighted signals:
- Token utilization quality (40%) — model-specific sigmoid degradation curve
- Retrieval accuracy (25%) — base accuracy minus lost-in-the-middle penalty
- Tool-call burden (20%) — compounding quality loss after 10+ tool calls
- Session length fatigue (15%) — time-based heuristic

**Signals used**: Token count vs. model-specific effective window, positional retrieval accuracy estimates, tool call count, session duration.

**Behavioral adaptation**: Returns prioritized recommendations (compact context, offload to memory, checkpoint, break into sub-tasks) with estimated quality gain per action (0-15 points). Maintains per-agent history in SQLite for degradation pattern tracking.

**Key insight**: This is the most explicit "self-awareness as a service" implementation found. It externalizes the metacognitive function into a tool the agent can query about its own cognitive health.

**Implementation complexity**: Low (MCP server, SQLite, heuristic-based).

---

### 3.8 Production Agent Implementations

**Claude Code**: Auto-compacts at ~80% of context window. Compaction behavior customizable via CLAUDE.md instructions. Claude models (Opus, Sonnet, Haiku) are trained with context awareness — they track remaining token budget throughout a conversation. External hooks like `vnx_context_monitor.sh` can block agent actions at 65% to force rotation before auto-compaction fires at 80%.

**OpenAI Codex**: Server-side compaction via `compact_threshold` parameter. Models like GPT-5.1-Codex-Max automatically compact when approaching limits. Known bug: compaction can loop indefinitely if it fails to reduce tokens below threshold.

**Google ADK**: Sliding window compaction based on event count (invocation intervals). Configurable `compaction_interval` and `overlap_size`. Uses `LlmEventSummarizer` with a dedicated model for summarization. Metadata preserved about what was compressed.

**OpenCrabs**: Dual-threshold system (80% triggers LLM compaction, 90% hard-truncates then compacts). Up to 3 retries on compaction failure. Compaction summary visible in chat as system message for transparency.

**ForgeCode**: Configurable token thresholds with async compaction running parallel to main conversation. Logarithmic sampling approach for token monitoring. Sliding window pattern identification for compactible sequences.

---

## 4. Academic Research Foundations

### 4.1 Metacognition in LLMs
**Paper**: [Evidence for Limited Metacognition in LLMs](https://arxiv.org/abs/2509.21545) (Ackerman, 2025)

Frontier LLMs since early 2024 show increasingly strong evidence of:
- Assessing and utilizing their own confidence in factual/reasoning tasks
- Anticipating what answers they would give

But these abilities are: limited in resolution, context-dependent, qualitatively different from human metacognition, and require explicit prompting to activate. Post-training may play a significant role in developing metacognitive abilities, with notable differences across models of similar raw capability.

### 4.2 Context Rot
**Research**: [Chroma Research](https://research.trychroma.com/context-rot)

Tested 18 LLMs across 5 experimental paradigms. Key findings:
- Performance degrades more quickly with lower semantic similarity between query and answer
- Degradation starts measurably at ~2,500 words; severe at 5,000-10,000
- Counterintuitively, shuffled (incoherent) haystacks perform BETTER than coherent ones
- Claude models abstain under uncertainty while GPT models hallucinate confidently
- Model-specific monitoring strategies are required — no universal heuristic works

### 4.3 ReMA — Meta-Thinking via Multi-Agent RL
**Paper**: [arxiv:2503.09501](https://arxiv.org/abs/2503.09501)

Hierarchical architecture: meta-thinking agent (strategic oversight) + reasoning agent (execution). Trained via multi-agent reinforcement learning (MARL). Meta-cognitive strategies emerge through training rather than being programmed. Reduced hallucinations by 43% vs. standard approaches.

### 4.4 ACON — Optimized Context Compression
**Paper**: [arxiv:2510.00615](https://arxiv.org/abs/2510.00615)

Gradient-free compression guideline optimization: given paired trajectories where full context succeeds but compressed fails, an LLM analyzes failure causes and updates compression guidelines. Reduces memory 26-54% while preserving 95%+ accuracy. Can be distilled into smaller models.

### 4.5 AgentFold — Proactive Context Folding
**Paper**: [arxiv:2510.24699](https://arxiv.org/abs/2510.24699)

Treats context as a "dynamic cognitive workspace to be actively sculpted." Learns multi-scale folding: granular condensation for vital details, deep consolidation for completed sub-tasks. AgentFold-30B achieves 36.2% on BrowseComp, surpassing DeepSeek-V3.1-671B.

### 4.6 Aeon — Neuro-Symbolic Memory Management
**Paper**: [arxiv:2601.15311](https://arxiv.org/abs/2601.15311)

Treats memory as an OS resource. Introduces Memory Palace (SIMD-accelerated spatial index) + Semantic Lookaside Buffer (predictive cache exploiting conversational locality). Sub-millisecond retrieval on conversational workloads.

### 4.7 Efficient On-Device Agents
**Paper**: [arxiv:2511.03728](https://arxiv.org/abs/2511.03728)

Adaptive context management for resource-constrained devices: dynamic memory via specialized LoRA adapters, minimalist tool schema serialization, just-in-time schema loading. Achieves 6x reduction in system prompt context and 10-25x reduction in context growth rate.

### 4.8 Reflexion — Verbal Reinforcement Learning
**Paper**: [arxiv:2303.11366](https://arxiv.org/abs/2303.11366)

The foundational framework for agent self-evaluation. Agents verbally reflect on task feedback and maintain reflective text in episodic memory. Self-evaluation via natural language classification or heuristics (same action repeated 3+ times, or 30+ actions taken). Improved AlfWorld tasks by 22%, HotPotQA by 20%.

---

## 5. Comparative Analysis: Context Compression Strategies

Factory.ai's production evaluation across 36,611+ messages provides the most rigorous comparison:

| Method | Overall Score | Accuracy | Context Awareness | Compression Ratio |
|--------|--------------|----------|------------------|-------------------|
| Factory (structured) | 3.70 | 4.04 | 4.01 | 98.6% |
| Anthropic (built-in) | 3.44 | 3.74 | 3.56 | ~98% |
| OpenAI (opaque) | 3.35 | 3.43 | 3.64 | 99.3% |

**Key finding**: Structured summarization with dedicated sections (files, decisions, next steps) outperforms generic approaches. The right optimization target is "tokens per task" not "tokens per request."

Reversible compaction (stripping information recoverable via tools) consistently outperforms lossy summarization. If the agent can read a file again, don't keep the file contents in the summary.

---

## 6. Synthesis: How Does Self-Awareness Actually Work?

### What signals agents use (ordered by sophistication):

1. **API errors** (reactive) — context_length_exceeded
2. **Token count vs. threshold** (threshold) — 80% of window
3. **Health scores** (composite) — weighted signals including token utilization, positional accuracy, tool call burden, session fatigue
4. **Budget regime classification** (strategic) — HIGH/MEDIUM/LOW/CRITICAL mapped to behavioral policies
5. **Self-estimated complexity** (introspective) — model judges its own needed reasoning depth
6. **Sub-task boundary detection** (autonomous) — model recognizes when to consolidate learnings
7. **Emergent metacognition** (trained) — confidence calibration, error anticipation via RL

### What behaviors change:

| Signal Level | Planning | Verbosity | Tool Selection | Memory Management |
|-------------|----------|-----------|---------------|-------------------|
| Full budget | Broad exploration | Normal | Best available | Accumulate |
| Medium budget | Focused exploration | Slightly concise | Cost-conscious | Monitor |
| Low budget | Verification only | Highly concise | Cheapest viable | Active pruning |
| Critical | Emergency summary | Minimal | Essential only | Checkpoint + rotate |

### Does it actually improve outcomes?

**YES, consistently and measurably:**
- BATS: 2x accuracy improvement over unaware baseline
- TALE: 67% token reduction with <3% accuracy loss
- Focus: 22.7% token reduction with no accuracy loss
- ACON: 26-54% memory reduction preserving 95%+ accuracy
- AgentFold-30B: Matches/exceeds 671B parameter models through better context management
- Budget Tracker alone: equivalent performance at 10 tool calls vs. 100 for unaware agents

---

## 7. The Gap: What Doesn't Exist Yet

### 7.1 Spontaneous Self-Monitoring
No system demonstrates an agent that naturally monitors its own cognitive state without being explicitly prompted or scaffolded to do so. The Focus paper's finding is definitive: passive prompting fails. Agents must be told to be self-aware.

### 7.2 Cross-Domain Budget Awareness
TALE works for math reasoning. BATS works for web search. No system generalizes budget awareness across arbitrary task types.

### 7.3 Predictive Degradation
Current systems detect degradation after it begins (or at fixed thresholds). No system predicts when degradation WILL occur based on task characteristics and adjusts proactively.

### 7.4 Collaborative Self-Awareness
In multi-agent systems, agents don't share information about each other's cognitive states. An orchestrator doesn't know which sub-agent is approaching context limits.

### 7.5 True Metacognitive Training at Scale
ReMA and TALE-PT show that self-awareness can be trained, but only Prime Intellect's RLM vision (RL-based end-to-end context management) attempts this at the level of general-purpose context management — and even they acknowledge it hasn't been achieved yet.

---

## 8. Implementation Recommendations

### For immediate production use:
1. **Implement dual-threshold compaction** (OpenCrabs pattern: 80% LLM-compaction, 90% hard-truncate)
2. **Add budget tracking to all tool-using agents** (BATS Budget Tracker pattern — prompt-level, zero infrastructure)
3. **Expose a compression tool** (LangChain pattern — let the agent choose when, with aggressive prompting to encourage usage)
4. **Use structured summarization** (Factory pattern — dedicated sections for files, decisions, next steps)
5. **Implement reversible compaction** where possible (strip file contents the agent can re-read)

### For medium-term research:
1. **Context health monitoring** as a first-class primitive (Context Rot Detection pattern)
2. **Budget regime policies** that map resource levels to behavioral changes (BATS HIGH/MEDIUM/LOW/CRITICAL)
3. **Aggressive sub-task prompting** for Focus-style autonomous compression (mandatory, not optional)

### For long-term investment:
1. **TALE-PT-style post-training** to internalize budget awareness into model weights
2. **RLM-style RL training** for end-to-end context management
3. **ReMA-style meta-thinking** architectures for autonomous metacognition

---

## 9. Sources

### Academic Papers
- [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366) — Shinn et al., 2023
- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) — Packer et al., 2023
- [Self-Reflection in LLM Agents: Effects on Problem-Solving Performance](https://arxiv.org/abs/2405.06682) — 2024
- [Evidence for Limited Metacognition in LLMs](https://arxiv.org/abs/2509.21545) — Ackerman, 2025
- [ACON: Optimizing Context Compression for Long-horizon LLM Agents](https://arxiv.org/abs/2510.00615) — Kang et al., 2025
- [AgentFold: Long-Horizon Web Agents with Proactive Context Management](https://arxiv.org/abs/2510.24699) — 2025
- [Budget-Aware Tool-Use Enables Effective Agent Scaling (BATS)](https://arxiv.org/abs/2511.17006) — Google DeepMind, 2025
- [Efficient On-Device Agents via Adaptive Context Management](https://arxiv.org/abs/2511.03728) — 2025
- [Token-Budget-Aware LLM Reasoning (TALE)](https://arxiv.org/abs/2412.18547) — ACL 2025 Findings
- [ReMA: Learning to Meta-think for LLMs with Multi-Agent RL](https://arxiv.org/abs/2503.09501) — NeurIPS 2025
- [Active Context Compression: Autonomous Memory Management (Focus)](https://arxiv.org/abs/2601.07190) — Verma, 2026
- [Aeon: High-Performance Neuro-Symbolic Memory Management](https://arxiv.org/abs/2601.15311) — 2026

### Industry Implementations and Blog Posts
- [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — Anthropic, 2025
- [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — Anthropic, 2025
- [Autonomous Context Compression](https://blog.langchain.com/autonomous-context-compression/) — LangChain
- [Evaluating Context Compression for AI Agents](https://factory.ai/news/evaluating-compression) — Factory.ai
- [Compressing Context](https://factory.ai/news/compressing-context) — Factory.ai
- [Context Rot: How Increasing Input Tokens Impacts LLM Performance](https://research.trychroma.com/context-rot) — Chroma Research
- [Recursive Language Models: The Paradigm of 2026](https://primeintellect.ai/blog/rlm) — Prime Intellect
- [Context Rot in Claude Code: How to Fix It With Automatic Rotation](https://vincentvandeth.nl/blog/context-rot-claude-code-automatic-rotation)
- [Context Window Auto-Compaction Pattern](https://agentic-patterns.com/patterns/context-window-auto-compaction/)
- [Metacognitive Capabilities in LLMs](https://www.emergentmind.com/topics/metacognitive-capabilities-in-llms)
- [The Context Window Problem: Scaling Agents Beyond Token Limits](https://factory.ai/news/context-window-problem) — Factory.ai

### Tools and Repositories
- [TALE Implementation](https://github.com/GeniusHTX/TALE)
- [Context Rot Detection MCP Service](https://github.com/milos-product-maker/context-rot-detection)
- [Google ADK Context Compression](https://google.github.io/adk-docs/context/compaction/)
- [OpenCrabs Self-Hosted Agent](https://github.com/adolfousier/opencrabs)
- [ForgeCode Context Compaction](https://forgecode.dev/docs/context-compaction/)
- [ReMA Implementation](https://github.com/ziyuwan/ReMA-public)
- [Prime Intellect Verifiers](https://github.com/PrimeIntellect-ai/verifiers)
- [Claude API Compaction Docs](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [OpenAI Codex Compaction](https://developers.openai.com/api/docs/guides/compaction/)
- [Microsoft Agent Framework Compaction](https://learn.microsoft.com/en-us/agent-framework/agents/conversations/compaction)
