# Context Management Research Synthesis

**Date:** 2026-03-13
**Scope:** 10 parallel research agents, 400+ sources surveyed
**Purpose:** Identify validated patterns for Claudex v3 context management upgrades

---

## The 15 Validated Principles

These findings appeared across 3+ independent sources with empirical evidence:

### 1. "The context window is L1 cache, not memory"
**Sources:** Pichay (R10), MemGPT (R2), Factory.ai (R5)
The context window is the most expensive, smallest tier. Build L2-L4 below it. We already have L4 (SQLite observations) and partial L2 (FTS5 retrieval). Missing: L2 working set with fault-driven pinning, L3 compressed session history.

### 2. Budget awareness is near-free and 2x effective
**Sources:** BATS/DeepMind (R5), Focus paper (R9), VNX system (R1)
Simply appending remaining budget info to each prompt → 40% fewer tool calls, 31% lower cost, 2x accuracy. An unaware agent at 100 tool calls = an aware agent at 10. Implementation cost: near zero (~20 tokens/turn).

### 3. Agents do NOT spontaneously self-monitor
**Sources:** Focus paper (R9), JetBrains (R6), all practitioner reports
With passive prompting, agents triggered only 1-2 compressions per task (6% savings). Success requires aggressive scaffolding — mandatory workflow instructions, periodic reminders. Hook-based approach is correct.

### 4. Observation masking beats LLM summarization
**Sources:** JetBrains NeurIPS (R6, R3, R8), SWE-agent (R3, R10)
52% cheaper, 2.6% better solve rates. Tool outputs = 84% of context tokens. Summarization causes "trajectory elongation" — agents don't realize they're stuck because failures are smoothed over. Simple > sophisticated.

### 5. Move state outside context, re-inject after compaction
**Sources:** All 10 reports converge on this
"Compaction is lossy and there is no way to make it lossless. The winning strategy is to move critical state outside the context window and re-inject it after compaction fires." Every high-satisfaction system follows: external persistence + triggered re-injection.

### 6. Tiered memory hierarchy is the convergent architecture
**Sources:** MemGPT (R2), Pichay (R10), Mem0/Graphiti (R7), CrewAI (R7)
Hot (in-context, budgeted) → Warm (on-demand retrieval) → Cold (persistent files) → Archive (historical). Two-threshold eviction: warn at 70%, flush at 100%.

### 7. Composite scoring for retrieval
**Sources:** A-MAC (R4), CrewAI (R7), Mem0 (R7)
`score = semantic * 0.5 + recency * 0.3 + importance * 0.2`. Recency decay: `0.5^(age_days / half_life)`. Type Prior is the dominant signal — categorizing content type (decision/error vs acknowledgment) provides most filtering value without LLM calls.

### 8. The quadratic cost trap
**Sources:** R8 (production data), R5 (demand paging paper)
Tool results reprocessed at 84x median across a session. Cache reads = 87% of costs at scale. A Reflexion loop of 10 cycles = 50x tokens of single pass. Sub-agent isolation is the killer mitigation.

### 9. Context rotation at 60-65%, not 80%+
**Sources:** VNX system (R1), SFEIR (R8), Chroma research (R8)
At 65% usage, agent writes "clear, structured state with specific details." At 78%, agent writes "vague summaries missing critical information." Performance peaks at 500-2,500 words; degrades severely after 5,000+.

### 10. Memory is a lifecycle, not a store
**Sources:** All Tier 1 systems (R7), Hindsight (R7), ACE (R7), CrewAI (R7)
Encode → Consolidate → Recall → Reflect → Forget. Not just insert → retrieve. ACE's self-improving playbooks prune underperforming strategies. CrewAI's explicit "Forget" operation solves memory pollution.

### 11. Lazy loading / demand paging
**Sources:** R1 (54% reduction), R3 (Cursor 46.9%), R10 (SWE-Pruner)
"Don't put things in the prompt, put them in files and let the agent find them." Trigger tables replace verbose documentation. SWE-Pruner: 0.6B middleware filter, 23-54% reduction, <1% quality loss.

### 12. KV-cache awareness
**Sources:** Manus (R2), demand paging paper (R5)
Stable prefixes, append-only contexts, deterministic serialization. Mask tools, don't remove them (breaks cache). 10x cost difference cached vs uncached. 100:1 input-to-output token ratio means cache efficiency dominates.

### 13. Lost-in-the-Middle effect
**Sources:** Stanford (R5), Chroma (R8)
>30% quality degradation for middle-positioned content. High-priority content at context boundaries (beginning and end). Newer Chroma research suggests total volume matters more than position.

### 14. Recitation prevents attention drift
**Sources:** Manus (R2), Anthropic harness (R8)
Updating todo.md/progress files during tasks pushes objectives into recent attention span. Average task ~50 tool calls; without recitation, models lose the plot.

### 15. Artifact tracking is unsolved by compression
**Sources:** Factory.ai (R8), all compression evaluations
All compression methods score only 2.19-2.45/5.0 on tracking which files were created/modified. Dedicated file-state tracking outside summarization is required. Our PostToolUse hook already does this — this is a strength.

---

## What Claudex v3 Already Has (Validated)

| What We Have | Validated By | Assessment |
|---|---|---|
| SQLite + FTS5 for observation storage | R4 (best for local-first), R7 (Mem0 pattern) | Correct architecture. Sub-3ms retrieval. |
| Budget-proportional assembly (4000 tokens) | R5 (BATS), R10 (Pichay) | Correct approach. Extend to full lifecycle. |
| Boundary-only injection (session start + post-compaction) | R6 (external persistence + re-injection) | Exactly what the field converges on. |
| PostToolUse observation extraction | R8 (artifact tracking), R4 (admission scoring) | Unique strength. Enhance with type classification. |
| Topic shift detection with cooldown | R7 (Mem0 scope transitions) | Novel. Now DB-persistent after fix team. |
| Importance scoring on observations | R4 (A-MAC), R7 (CrewAI composite) | Good foundation. Add recency decay. |
| File pressure tracking | R3 (Aider repo map concept) | Analogous to Aider's reference graph. |
| PreCompact checkpoint writing | R6 (checkpoint+resume best pattern) | Correct. Extend with observation masking. |
| Telemetry with session_id | R7 (all production systems need observability) | Recently fixed. Needs query tooling. |

---

## The 10 Upgrades

### UPGRADE 1: Context Gauge Injection (Every Turn)
**Validated by:** R5 (BATS: 2x accuracy), R9 (Focus: agents need scaffolding), R1 (VNX: 65% rotation)
**What:** UserPromptSubmit injects 1-line budget signal on EVERY turn, even when no other injection occurs.
**Format:**
```
[Context: 47k/200k (23%) | Budget: normal | Sources: checkpoint, learnings]
```
**Graduated pressure zones:**
- Normal (<50%): gauge only
- Advisory (50-65%): gauge + "consider sub-agents for heavy work"
- Warning (65-80%): gauge + auto-checkpoint + "wrap up current task"
- Critical (>80%): gauge + force handover + trigger session wrap-up
**Implementation:** user-prompt-submit.ts — extend gauge section to always emit, add pressure zone logic
**Cost:** ~20-40 tokens per turn
**Expected impact:** 40% fewer unnecessary tool calls, prevents context waste

### UPGRADE 2: Observation Masking in PreCompact
**Validated by:** R6 (JetBrains: 52% cheaper, +2.6% solve rate), R3 (SWE-agent: 84% of tokens are tool outputs), R8 (simple beats sophisticated)
**What:** Before compaction fires, strip old tool outputs from context. Keep last N turns verbatim, replace older observations with 1-line placeholders.
**Why better than summarization:** No hallucination risk, no trajectory elongation, cheaper, preserves action/reasoning chain.
**Implementation:** PreCompact hook — iterate conversation history, replace tool_result blocks older than 10 turns with `[Tool output removed — see observation DB for details]`
**Cost:** Zero additional tokens (reduces tokens)
**Expected impact:** 50%+ reduction in compaction input, cleaner summaries

### UPGRADE 3: Session Continuity Assembly Section
**Validated by:** R6 (checkpoint+resume), R1 (dev-docs pattern), R8 (Anthropic harness: git + progress files)
**What:** New assembly section (priority 2.5) that reads ACTIVE.md + latest session log, compresses to ~300 tokens.
**Content:**
- Current task (1 line)
- Progress (3-5 bullet points)
- Next action (1 line)
- Key decisions still pending (1-2 lines)
**Implementation:** New section renderer in sections.ts, new assembly priority in assembler.ts
**Replaces:** /starthere's 8+ Read calls for handoff + session logs
**Expected impact:** /starthere from ~40k tokens to ~500 tokens

### UPGRADE 4: Post-Compaction Trust Directive
**Validated by:** R1 (100% rule violation post-compaction), R6 (post_compact_reminder pattern), R9 (agents need explicit scaffolding)
**What:** Post-compaction assembly adds a header listing injected sources with directive not to re-read.
**Format:**
```
[CONTEXT RESTORED — Injected: identity, checkpoint (turn 47), session continuity,
learnings (5), hot files (8), FTS5 (6). Trust this content. Do NOT re-read these files.
Continue from: <current task summary>]
```
**Implementation:** assembler.ts — add trust header to post-compaction full assembly output
**Cost:** ~50 tokens
**Expected impact:** Prevents 30k+ redundant re-reads after compaction

### UPGRADE 5: Graduated Pressure Response
**Validated by:** R10 (Pichay: 93% reduction with demand paging), R1 (VNX: rotation at 65%), R5 (graduated zones)
**What:** Different system behaviors at different context utilization levels.
**Zones:**
- **Green (<50%):** Normal operation, gauge-only injection
- **Yellow (50-65%):** Advisory hints, suggest sub-agents for exploration, auto-checkpoint
- **Orange (65-80%):** Auto-compress handoff, warn user, prepare for rotation
- **Red (>80%):** Force structured handover document, block new large operations, trigger wrap-up
**Implementation:** Extend gauge logic in user-prompt-submit.ts, add zone-aware behavior to PreToolUse
**Expected impact:** Clean handovers at 65% instead of lossy compaction at 83.5%

### UPGRADE 6: Admission Scoring Enhancement
**Validated by:** R4 (A-MAC: Type Prior is dominant signal), R7 (CrewAI: encode with importance), R10 (MemoryOS: heat-based scoring)
**What:** Enhance observation extraction with Type Prior classification.
**Categories (high → low):**
- Decisions, errors, architectural choices → importance 0.8-1.0
- New patterns, configuration changes → importance 0.5-0.7
- Routine tool outputs, acknowledgments → importance 0.1-0.3
**Implementation:** Enhance quality gate in each extractor (type classification is cheap — keyword/pattern matching, no LLM needed)
**Expected impact:** Higher quality observations, less memory bloat, better FTS5 retrieval

### UPGRADE 7: Composite Retrieval Scoring
**Validated by:** R4 (hybrid search), R7 (CrewAI formula), R7 (Graphiti: temporal awareness)
**What:** FTS5 results scored with composite formula instead of pure text relevance.
**Formula:** `score = relevance * 0.5 + recency * 0.3 + importance * 0.2`
**Recency decay:** `recency = 0.5^(age_hours / 24)` (half-life of 24 hours)
**Implementation:** Modify FTS5 result ranking in assembler.ts — already have importance and timestamp, just need the formula
**Expected impact:** More relevant context injection, fewer stale observations

### UPGRADE 8: Handoff Compression (80-line cap)
**Validated by:** R6 (all sources: move details outside), R8 (Factory.ai: compression ratio is wrong target)
**What:** Hard 80-line limit on ACTIVE.md. Detailed research/reasoning in separate files.
**Template change:**
- "What I Was Working On" → 2-3 lines max
- "Progress Made" → completed items get 1 line each
- "Context That Won't Be Obvious" → 3 bullets max
- Detailed analysis → `context/reasoning/` files (referenced, not inlined)
**Implementation:** Update /handoff skill template + validation
**Expected impact:** 3-5k tokens saved per session start

### UPGRADE 9: Recitation at Checkpoints
**Validated by:** R2 (Manus: recitation prevents drift), R8 (Anthropic harness: progress files)
**What:** Checkpoint writer includes a "current objective" micro-summary that gets injected as part of the checkpoint assembly section.
**Format:** 1-2 lines: what task is active, what step we're on, what's next.
**Why:** After 50+ tool calls, models lose the plot. Recitation pushes objectives into recent attention.
**Implementation:** Extend checkpoint writer to include objective field, render in checkpoint section
**Expected impact:** Prevents drift in long sessions, maintains task focus

### UPGRADE 10: /starthere as Trigger Table
**Validated by:** R1 (54% reduction with lazy loading), R3 (Cursor: 46.9% reduction with discovery-based approach)
**What:** /starthere becomes a minimal trigger table, not a sequential file-loading procedure.
**If assembly is active:** "Assembly pipeline has injected your context. Scope: project. Task: <from continuity section>. What work are we doing?"
**If assembly is NOT active (fallback):** Load only: scope detection + handoff (2 reads max). Everything else on-demand.
**Implementation:** Skill rewrite — 80% shorter
**Expected impact:** 15-35k tokens saved per session start

---

## Implementation Priority

| # | Upgrade | Tokens Saved | Effort | Dependencies |
|---|---------|-------------|--------|-------------|
| 1 | Context Gauge (every turn) | ~30-40% fewer wasted calls | Low | None |
| 2 | Post-Compaction Trust Directive | ~30k per compaction | Low | None |
| 3 | Handoff Compression (80-line cap) | ~3-5k per session | Low | None (skill change only) |
| 4 | Session Continuity Section | ~35k per session start | Medium | New assembly section |
| 5 | /starthere as Trigger Table | ~15-35k per session | Medium | Upgrade 4 ideally first |
| 6 | Observation Masking in PreCompact | ~50% compaction cost | Medium | Hook modification |
| 7 | Graduated Pressure Response | Prevents ~50k waste at 80%+ | Medium | Upgrade 1 first |
| 8 | Admission Scoring Enhancement | Better retrieval quality | Medium | Extractor changes |
| 9 | Composite Retrieval Scoring | More relevant injection | Low-Medium | assembler.ts change |
| 10 | Recitation at Checkpoints | Prevents drift | Low | checkpoint writer |

### UPGRADE 11: Tool Cost Estimation in Gauge
**Validated by:** R5 (BATS: budget awareness = 2x accuracy), R9 (agents need cost signals)
**Solves:** Problem 1 (41.7k Explore agent waste)
**What:** Gauge line includes average token cost per tool type.
**Format:**
```
[Context: 47k/200k (23%) | Costs: Agent ~35k, Read ~2k, Bash ~1k | Zone: normal]
```
**Implementation:** Track rolling average cost per tool type in telemetry table. Top-3 injected in gauge. user-prompt-submit.ts.
**Cost:** ~30 tokens per turn
**Expected impact:** Model sees price before deciding. Prefers Read+Bash (3k) over Explore agent (35k) for simple tasks.

### UPGRADE 12: Verified Facts in Checkpoint
**Validated by:** R8 (Anthropic harness: progress files), R2 (Manus: keep errors in context)
**Solves:** Problem 4 (redundant verification)
**What:** Checkpoint tracks a `verified_facts` list — "tests passed at commit X", "review processed", "agent Y completed Z".
**Post-compaction assembly includes this list** so the model doesn't re-verify.
**Implementation:** Extend checkpoint writer + checkpoint assembly section. ~100 tokens.
**Expected impact:** Eliminates redundant test runs, re-analysis of already-processed results.

### UPGRADE 13: Custom Compaction Instructions
**Validated by:** R6 (pause_after_compaction API), R1 (100% rule violation post-compaction), R3 (SWE-agent: observation masking)
**Solves:** Problem 3 (compaction recovery dead reads)
**What:** Use CC's `compact-2026-01-12` beta API to provide custom compaction instructions that:
- Mandate preservation of file paths, error messages, architectural decisions verbatim
- Strip tool output older than 10 turns (observation masking before summarization)
- Include explicit "do not reproduce code blocks verbatim" to prevent death spirals (GitHub #24677)
- Reference our checkpoint as the authoritative state source
**Implementation:** Hook into compaction via custom instructions config. PreCompact hook already writes checkpoint — add compaction instruction template.
**Expected impact:** Higher quality compaction summaries, prevents death spirals, preserves critical details.

### UPGRADE 14: Response Budget Hint
**Validated by:** R9 (TALE: 67% reasoning compression with <3% accuracy loss when budget given), R9 (Focus: agents need scaffolding)
**Solves:** Problem 5 (response verbosity)
**What:** Gauge includes response budget hint based on pressure zone and user preferences.
**Zones:**
- Normal: no hint (user preferences in CLAUDE.md are sufficient)
- Advisory: `[Respond concisely: ≤10 lines]`
- Warning: `[Respond concisely: ≤5 lines, essentials only]`
- Critical: `[Respond in ≤3 lines. Save context.]`
**Implementation:** Extend gauge injection in user-prompt-submit.ts. ~10 additional tokens.
**Expected impact:** Model compresses responses as context fills. TALE research: 67% compression with <3% quality loss.

---

| # | Upgrade | Tokens Saved | Effort | Dependencies |
|---|---------|-------------|--------|-------------|
| 1 | Context Gauge (every turn) | ~30-40% fewer wasted calls | Low | None |
| 2 | Post-Compaction Trust Directive | ~30k per compaction | Low | None |
| 3 | Handoff Compression (80-line cap) | ~3-5k per session | Low | None (skill change only) |
| 10 | Recitation at Checkpoints | Prevents drift | Low | checkpoint writer |
| 11 | Tool Cost Estimation in Gauge | Prevents 30k+ agent waste | Low | Telemetry data |
| 12 | Verified Facts in Checkpoint | Prevents redundant work | Low | checkpoint writer |
| 13 | Custom Compaction Instructions | Higher quality summaries | Low-Medium | CC API beta |
| 14 | Response Budget Hint | 67% response compression at high util | Low | Upgrade 1 |
| 4 | Session Continuity Section | ~35k per session start | Medium | New assembly section |
| 5 | /starthere as Trigger Table | ~15-35k per session | Medium | Upgrade 4 ideally first |
| 9 | Composite Retrieval Scoring | More relevant injection | Low-Medium | assembler.ts change |
| 6 | Observation Masking in PreCompact | ~50% compaction cost | Medium | Hook modification |
| 7 | Graduated Pressure Response | Prevents ~50k waste at 80%+ | Medium | Upgrade 1 first |
| 8 | Admission Scoring Enhancement | Better retrieval quality | Medium | Extractor changes |

**Wave 1 (quick wins, no dependencies):** Upgrades 1, 2, 3, 10, 11, 12, 13, 14
**Wave 2 (assembly pipeline extensions):** Upgrades 4, 5, 9
**Wave 3 (hook modifications):** Upgrades 6, 7, 8

---

## What We're NOT Doing Now (And Why) — But May Do Later

| Approach | Status | Rationale |
|---|---|---|
| MemGPT-style agent self-managed memory | Skip | R4: "unreliable tool invocation." R9: agents don't self-monitor. Our hook-based approach is more reliable. |
| Knowledge graph (Graphiti-style) | **Phase 4 (future)** | Valuable for shared/multi-user Claudex. Lightweight graph on SQLite (no Neo4j). Temporal fact validity, relationship-aware retrieval. After Waves 1-3 foundation is solid. |
| Vector embeddings for all retrieval | Skip | R4: top-3 with FTS5 outperforms top-10 with vectors. We already have optional embeddings for topic shift. |
| LLM-based compression/summarization | Skip | R6 (JetBrains): observation masking is cheaper and more effective. Summarization causes trajectory elongation. |
| Full OS kernel (AIOS-style) | Skip | Architectural astronautics. Take the principles, skip the abstraction. |

---

## Sources Summary

- **10 research agents**, **400+ sources** surveyed
- **Key papers:** Pichay demand paging (2026), MemGPT (2023), BATS (2025), JetBrains complexity trap (2025), Focus (2025), A-MAC (2025), Lost-in-the-Middle (2023)
- **Key production systems:** Mem0 (49.7k stars), Letta (21.6k stars), Graphiti (23.7k stars), LangGraph (26.3k stars), CrewAI (25.7k stars)
- **Key practitioner sources:** Manus (millions of users), Anthropic engineering blog, Factory.ai, Spotify engineering, VNX rotation system, Cursor A/B testing
- **Individual research reports:** See `context/reasoning/` and `research/` directories
