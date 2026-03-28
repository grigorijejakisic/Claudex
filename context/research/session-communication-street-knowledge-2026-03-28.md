# Street Knowledge: Agent-to-Agent Session Communication

Date: 2026-03-28 | 5-layer deep research

## Executive Summary

The field is converging: shared-memory coordination (blackboard/tuple space) over message passing for same-machine agents. SQLite + FTS5 is the local-first standard. Nobody has solved the full problem locally — Claudex is architecturally competitive with the best (Letta, CASS, Engram). The most surprising finding: Claudex is already a stigmergic system. The biggest risk: the "telephone game" — context degrading through each transfer (39% accuracy drop documented).

## Layer 1: What Exists

**Top implementations:**
1. **Letta/MemGPT** (21.8K stars) — shared memory blocks with concurrency semantics. Steal: insert=safe, replace=conflict, rewrite=LWW. Owner-agent pattern. Tag-based discovery.
2. **CASS ecosystem** (299+635 stars) — three-layer cognitive architecture (episodic→working→procedural). 90-day half-life. Canonical session IR for cross-agent transfer.
3. **Engram** (2K stars) — single Go binary, SQLite+FTS5, MCP. Structured observations (What/Why/Where/Learned). Topic keys for evolving knowledge.
4. **mcp-memory-service** (1.6K stars) — X-Agent-ID headers. Tags as messaging signals. 5ms retrieval.
5. **agent-recall** (8 stars but best design) — scope chain hierarchy (global→project→session). Bitemporal slots. Adaptive cache invalidation.

**Key finding:** "Nobody has solved the full problem locally. Letta needs a server. CASS is fragmented. Engram has no multi-agent awareness."

## Layer 2: Why It Works

**8 theoretical principles (all validated by research):**
1. Blackboard over message passing for cooperative agents (Hearsay-II, 1980)
2. Structured artifacts over free text (MetaGPT)
3. Three-layer memory: observation→reflection→planning (Park et al., 2023)
4. Activation decay is cognitively grounded (Altmann & Trafton, 2002)
5. Retrieval quality trumps storage volume (Ericsson & Kintsch, 1995)
6. Transfer beliefs and desires, NOT intentions (Wooldridge BDI)
7. Causal ordering matters, total ordering is overkill (Lamport, 1978)
8. U-shaped attention demands assembly ordering discipline (Liu et al., 2023)

**Key finding:** Claudex's architecture aligns with established theory across 7+ independent research traditions.

## Layer 3: What's Wrong

**Top 5 anti-patterns (from 36 documented failures across 5 frameworks):**
1. **Silent state corruption** — always fail-closed, never resume partial state
2. **Non-atomic multi-step transitions** — coordination changes must be all-or-nothing (#1 source of unrecoverable corruption)
3. **Context transfer without budget management** — 2% degradation per reasoning step from context rot
4. **Fire-and-forget in ephemeral contexts** — everything must be awaited in hooks
5. **Treating handoffs as message passing** — must transfer: what was done, why, constraints, what remains, what NOT to do

**Key finding:** MAST paper (ICLR 2025) found 41-87% failure rates across 7 multi-agent frameworks. 80% of critical failures remain unfixed. "The ecosystem is broken."

## Layer 4: Adjacent Fields

**Top 3 cross-domain insights:**
1. **Commander's Intent** (Military OPORD + Healthcare SBAR) — the highest-value handoff element is intent, not details. 65% reduction in adverse events from structured SBAR. Handoffs must lead with a one-sentence intent statement.
2. **Stigmergy** (Ant colonies + Game AI) — Claudex is already stigmergic: pressure=pheromones, observations=cognitive artifacts, access counts=trail reinforcement. Lean into environment modification over explicit messaging. Add typed signal layers (work-in-progress, failure-alarm, danger markers).
3. **Volunteer task claiming** (Blackboard + Actor model + Ants) — decentralized self-selection outperforms central dispatch 13-57% (LbMAS paper). Workers should claim tasks from a shared board based on their accumulated context.

**Additional insights:** Delta checkpoints (game saves), receiver read-back (I-PASS healthcare), role claiming through blackboard (UE5 game AI), ACT-R fan effect for retrieval, CRDT append-only for shared state.

## Layer 5: Frontier

**Top 3 frontier bets:**
1. **CRDT-based memory sync** (sqlite-sync) — enable concurrent agent access to shared SQLite. Low risk, 2-4 week prototype.
2. **Git Context Controller semantics** — COMMIT/BRANCH/MERGE for session handoff. 80%+ SWE-Bench. Maps to checkpoint system. Medium risk, 4-6 weeks.
3. **Governed Memory dual-model** — atomic facts + schema-enforced typed properties. 50% token reduction, zero cross-entity leakage. Medium-high risk, 6-8 weeks.

**Protocol landscape:** MCP evolving to agent-to-agent (June 2026 spec). A2A (Google, 22.9K stars) for task delegation. AAIF (OpenAI + Anthropic + Block) governing convergence. Claude Code Agent Teams already has peer-to-peer mailbox messaging.

**Critical research:**
- "Interaction Theater" — without structured coordination, 65% of agent responses share no vocabulary with the prompt
- AgentLeak — inter-agent messages leak privacy at 68.8% (local DB sidesteps this)
- "Soul erosion" (BMAM) — agents lose behavioral consistency across sessions

## Synthesis: What This Means for the Spec

### 1. Recommended Approach

**Hybrid: stigmergy-first, messaging-second.** Don't build a full messaging system first. Instead:
- Extend the existing stigmergic patterns (environment signals, pressure, observations)
- Add lightweight session signals (typed markers with decay) as the primary coordination channel
- Add explicit messaging (session_messages extension) only for cases that need request/response semantics

### 2. Build vs Borrow

| Build (unique to Claudex) | Borrow (proven patterns) |
|---|---|
| Session naming + fuzzy discovery | Letta's concurrency semantics (insert=safe, rewrite=LWW) |
| Context transfer via existing assembly | SBAR/OPORD structured handoff format |
| Stigmergic signal types | agent-recall's scope chain hierarchy |
| Angel as supervisor | CASS's canonical session IR concept |

### 3. Critical Anti-Patterns to Avoid

1. **Non-atomic coordination** — every session-to-session operation must be transactional
2. **Unbounded context transfer** — budget-aware, always. 2% rot per step.
3. **Free-form handoffs** — SBAR structure, mandatory intent field
4. **Hub-and-spoke only** — support both PM-directed and volunteer-claimed tasks
5. **Assuming real-time** — design for human-paced async, poll-on-next-turn

### 4. The Non-Obvious Insight: Lean Into Stigmergy

Before building explicit session-to-session messaging, add these stigmergic signal types:
- `wip_signal` — "I'm working on file X" (territory pheromone, decays in 30 min)
- `failure_signal` — "Approach Y failed for reason Z" (alarm pheromone, decays in 24h)
- `danger_signal` — "File X is fragile, test before editing" (persists until manually cleared)
- `claim_signal` — "I claimed task T from the board" (prevents duplicate work)

These are lightweight DB rows with temporal decay. Assembly surfaces them automatically. No explicit messaging needed — sessions coordinate by reading the environment.

### 5. Gaps Nobody Is Addressing

1. **Local-first full-stack** — everyone either needs a server (Letta) or lacks multi-agent awareness (Engram). Claudex can own this.
2. **Stigmergic coordination** — nobody is explicitly designing for environment-mediated coordination. Everyone jumps to message passing.
3. **Receiver read-back** — no system verifies that the incoming session correctly understood the handoff. I-PASS's synthesis step is universally missing.
4. **Commander's intent** as a handoff primitive — no system requires or extracts intent separately from details.
