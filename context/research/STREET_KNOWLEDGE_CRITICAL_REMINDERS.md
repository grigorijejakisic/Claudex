# Street Knowledge: LLM Behavioral Rule Reinforcement & Instruction Drift Prevention

> Research conducted 2026-04-03. 5 parallel Sonnet agents, ~250 sources surveyed.

## Executive Summary

Instruction drift in long LLM conversations is a **structural property of softmax attention**, not a model deficiency. Every new token reduces attention to prior tokens (zero-sum). Rules injected at session start experience monotonic attention erosion. The research consensus: **low-density, high-frequency, activity-gated re-injection at context end** is the optimal strategy. Fixed-interval injection is the worst schedule (Skinner). Injecting mid-operation can weaken compliance (reconsolidation trap). Meta-instructions ("verify before done") degrade into ceremonial compliance and require deterministic enforcement.

---

## Layer 1: What Exists (Implementations)

### Top Implementations

1. **SCAN (Systematic Context Anchoring via Narration)** — Checkpoint questions embedded in system prompt. Agent generates ~300 tokens *answering* rules before each task. Exploits recency by making model produce new tokens about rules. Tiered: FULL (~300 tokens), MINI (~120), ANCHOR (~20), SKIP.
   - Source: [dev.to/nikolasi](https://dev.to/nikolasi/solving-agent-system-prompt-drift-in-long-sessions-a-300-token-fix-1akh)

2. **Google ADK Callbacks** — `before_model_callback` (turn-level rule refresh) + `before_tool_callback` (pre-action enforcement). Production SDK, well-documented.
   - Source: [google.github.io/adk-docs/callbacks](https://google.github.io/adk-docs/callbacks/)

3. **AgentSentry** — Sliding-window ACE trend score detecting when tool context overrides behavioral rules. Causal decomposition: ACE = DE + IE. 0% Attack Success Rate.
   - Source: [arxiv.org/abs/2602.22724](https://arxiv.org/abs/2602.22724)

4. **Anthropic System Reminders** — Classifier-triggered `<system-reminder>` at END of human turn. Has `long_conversation_reminder` at length thresholds. Already the pattern Claudex uses.
   - Source: [github.com/asgeirtj/system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude.ai-injections.md)

5. **Manus todo.md Recitation** — Write goals to a file appended every turn. KV-cache friendly (system prompt unchanged). Simplest effective pattern.
   - Source: [manus.im/blog/Context-Engineering-for-AI-Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)

6. **DRIFT (NeurIPS 2025)** — Dynamic rule selection: inject ONLY the minimum relevant rule subset per action. Token-efficient isolation.
   - Source: [openreview.net/forum?id=oY1Xnt83oJ](https://openreview.net/forum?id=oY1Xnt83oJ)

---

## Layer 2: Why It Works (Science)

### Six Core Principles

**1. Position decay is structural.** Softmax is zero-sum. Every added token steals attention from all prior tokens. System prompts at session start erode monotonically. Not fixable by prompt engineering. (Chroma "Context Rot" 2025, Xiao et al. "Attention Sinks" ICLR 2024)

**2. Drift stabilizes at a controllable equilibrium.** D_{t+1} = D_t + g_t(D_t) + η_t − δ_t. Interventions (δ_t) shift equilibrium D* downward. 11.8% KL reduction from goal reminders at turns 4 and 7. (Dongre et al. "Drift No More" arXiv:2510.07777)

**3. Length hurts even with perfect retrieval.** 13.9%–85% degradation even when relevant tokens are visible and all others masked. Mitigation: "recite before acting." (Du et al. EMNLP 2025, arXiv:2510.05381)

**4. Priority signal dilutes, not persists.** System prompt privilege is encoded in a handful of tokens and dilutes in long contexts. Re-injection is the only runtime mechanism to restore priority. (ISE, ICLR 2025, arXiv:2410.09102)

**5. Pre-action gating is the only reliable enforcement at scale.** Passive safety training becomes MORE erratic at extended context. AGrail achieves 0% attack success with pre-action interception. (Hadeliya et al. arXiv:2512.02445; Luo et al. ACL 2025, arXiv:2502.11448)

**6. Low-density, high-frequency beats high-density, low-frequency.** 10 simultaneous instructions at 90% individual = 35% full compliance (exponential). Frontier models hit only 68% at 500 instructions. Inject fewer rules more often, scoped to current action. (Jaroslawicz et al. NeurIPS 2025 Workshop, arXiv:2507.11538)

### Key Papers
- "Lost in the Middle" (Liu et al., TACL 2024) — U-shaped attention curve
- "LLMs Get Lost In Multi-Turn Conversation" (Microsoft, 2025) — 39% average drop, early commitment lock-in
- "Prompt Repetition Improves Non-Reasoning LLMs" (Google Research, 2025) — mechanical basis for pre-action re-injection
- "Serial Position Effects of LLMs" (ACL 2025) — primacy erodes in long context, recency dominates
- "When Refusals Fail" (2025) — safety mechanisms destabilize at 100K+ tokens

---

## Layer 3: What's Wrong (Failures & Anti-Patterns)

### Top 5 Anti-Patterns

**#1 — VOLUME INJECTION (Critical)**
More rules = worse compliance. Exponential: P(all followed) = P(single)^n. 10 rules at 90% = 35%. 6,000-word rule documents approach 0% compliance. The fix you reach for first (add more rules) makes the problem worse.

**#2 — DYNAMIC SYSTEM PROMPT SWAPPING (Critical)**
Rewriting system prompt mid-conversation causes 66% inconsistency after 5-6 turns. Models prioritize self-consistency with prior outputs over new system instructions. Never change system prompt. Embed dynamic context in user messages.

**#3 — MIDDLE-OF-CONTEXT INJECTION (High)**
30%+ accuracy loss on information in middle positions. Rules injected between conversation history and current task are in the structural dead zone. Inject at END of context only.

**#4 — CEREMONIAL COMPLIANCE (High)**
Meta-instructions ("verify before done", "run tests") are the fastest-decaying category. Models claim compliance without executing behavior. "Ran tests, passed" without running them. Meta-instructions require deterministic enforcement (hooks), not prompting.

**#5 — SILENT CONTRADICTION ACCUMULATION (High)**
Claude Code's own 1,490-line system prompt has contradictions ("ALWAYS use TodoWrite" AND "NEVER use TodoWrite"). Models resolve conflicts silently via heuristic. Large monolithic prompts are structurally vulnerable.

### Other Failures
- Self-echoing rules backfires (compaction removes them)
- The 35-minute / turn-10 cliff (agents fail after 10-15 turns)
- Autoregressive reinforcement trap (errors become context, self-reinforcing)
- Tool definition overload (17 unused tools waste tokens all session)
- Sandwiching can amplify adversarial content

---

## Layer 4: Adjacent Domain Insights

### Top 3 Cross-Domain Insights

**1. The Reconsolidation Trap (Neuroscience)**
Re-injecting rules during dense, competing activity may WEAKEN compliance. The rule gets reconsolidated with task noise — updated with wrong associations. Inject at phase transitions (task start, task end, topic switch). Never mid-operation. This is not optimization; it is the difference between reinforcement and degradation.

**2. Practical Drift is Directional (Safety Engineering / Rasmussen)**
Drift isn't random — it's systematically directional toward locally-rewarding shortcuts. Each small deviation is locally rational, collectively catastrophic (Challenger disaster). Rules that conflict with being helpful/fast drift fastest. Build rule importance inversely proportional to local reward pressure — the most drift-prone rules need the shortest TTL.

**3. Variable-Interval Schedule Paradox (Behavioral Psychology / Skinner)**
Fixed-interval injection (every N turns) is the WORST schedule. Produces scalloping: compliance burst after injection, systematic drift before next. Variable-interval with same average frequency produces categorically more durable compliance and slowest extinction. Don't inject on turn-count triggers. Use drift-probability signals + randomized jitter.

### All Adjacent Domains Explored
- **Spaced repetition** — Decay-aware scheduling, Leitner box (reset interval on failure)
- **Skinner** — Variable-interval > fixed-interval; partial reinforcement for durability; habituation risk with identical text
- **Watchdog timers** — Drift detection before injection; window constraints [min, max]; challenge-response for critical rules
- **Aviation/Nuclear** — State-transition checklists; safety-diagnosability principle; Rasmussen's migration model
- **PID controllers** — P (current violation), I (accumulated drift), D (trajectory); integral term most important; derivative prevents overshoot
- **Distributed systems** — Per-rule TTL; lease renewal via compliance evidence; stale-while-revalidate
- **Neuroscience** — Memory consolidation during quiescence; inject during low-interference moments; temporal compression
- **Game design** — First-encounter injection; progressive disclosure; JITAI context state tracking; intrusion calibration by rule criticality

---

## Layer 5: Frontier

### Top 3 Frontier Bets

**Bet #1: Context Equilibrium Theory → Activity-Gated Injection (3-6 months)**
Most immediately applicable. Drift converges to model-specific D*. Inject when drift estimate approaches high-D* equilibrium. Combined with A-MAC content-type-aware decay scoring: `inject(rule) when drift_estimate > threshold AND recency_score(rule) < decay_threshold`. Buildable today.

**Bet #2: Agent Behavioral Contracts (6-12 months)**
Drift Bounds Theorem: if recovery rate γ > drift rate α, drift bounded to D* = α/γ. AgentAssert runtime monitors per-action compliance. 88-100% hard constraint compliance, <10ms overhead. Closest to production of any frontier work.

**Bet #3: Angular/Spherical Steering as Behavioral Encoding (12-18 months)**
Rules as geometric directions in activation space. Norm-preserving rotation means no capability degradation. Selective Steering: 5.5× effectiveness at zero perplexity cost. Would eliminate context window competition entirely. Requires inference-level access.

### Other Notable Frontier Work
- **HIPO** (CMDP + primal-dual RL) — trains model to structurally attend to system tokens
- **AIR** — layer-wise hierarchy injection (1.6-9.2× attack success reduction, 0.005% param overhead)
- **ACE (ICLR 2026)** — evolving context playbooks, self-improving behavioral rules
- **A-MAC** — content-type-aware admission control (behavioral rules ≠ facts ≠ episodic memory)
- **MemOS** — three-tier memory OS (plaintext, activation-level, parameter-level)
- **Recursive Language Models** — model programmatically reads context snippets, chooses what to attend to

---

## Synthesis: Design Principles for Claudex Critical Reminders

### Build (what we implement)
1. **Activity-gated injection at phase transitions** — inject before risky actions, at topic shifts, at task boundaries. Not mid-operation.
2. **Per-rule TTL based on drift risk** — rules conflicting with efficiency get shortest TTL. Safety rules: 5 turns. Style rules: 20 turns.
3. **Variable timing with jitter** — never fixed N turns. Drift-probability signal + random offset.
4. **First-encounter gating** — inject a rule only when its domain first appears in the session.
5. **Minimal rule subset per injection** — DRIFT approach: inject only rules relevant to current action. Max 3-5 rules, 200-300 tokens.
6. **End-of-context placement** — inject in user messages (system-reminder), never modify system prompt.
7. **PID-inspired composite signal** — current_violation × α + accumulated_drift × β + drift_velocity × γ.
8. **Deterministic enforcement for meta-instructions** — "verify before done" enforced by hooks, not prompts.

### Borrow (what we adapt from existing work)
- SCAN tiering: FULL/MINI/ANCHOR/SKIP intensity levels
- Manus recitation: compact goal restatement at context end
- Anthropic pattern: classifier-triggered + length-threshold triggers
- Google ADK: before_model_callback + before_tool_callback architecture
- DRIFT: selective rule injection based on action relevance

### Avoid (anti-patterns to never implement)
- Volume injection (more rules ≠ better compliance)
- Fixed-interval injection (worst schedule)
- Dynamic system prompt modification (66% inconsistency)
- Middle-of-context placement (dead zone)
- Relying on meta-instructions without hooks
- Injecting identical text (habituation)
- Injecting mid-operation (reconsolidation trap)

### Watch (frontier to monitor)
- Agent Behavioral Contracts — formal drift bounds, closest to production
- Angular Steering — rules as geometric directions, eliminates context competition
- A-MAC — content-type-aware decay scoring, directly applicable to Claudex
