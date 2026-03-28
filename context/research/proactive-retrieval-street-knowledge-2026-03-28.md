# Street Knowledge: Proactive Memory Retrieval for Agent Systems
Date: 2026-03-28 | 5-layer research

## Executive Summary

Claudex stores experience patterns in SQLite + Qdrant vectors but retrieves them via FTS5 keyword matching only. Broad principles never match specific prompts. Research across 10+ production systems, cognitive science, 8 adjacent fields, and frontier papers converges on one architectural fix: **intent-based structural matching as a parallel retrieval channel**, with tier-dependent injection strategy.

## The Fix — Converged from All 5 Layers

### Architecture: Three retrieval tiers (not one)

| Tier | Retrieval Mode | When | Pattern |
|------|---------------|------|---------|
| **Always-inject** | No retrieval — pinned to context | Every assembly call | Letta Core Memory, ExpeL, Reflexion, TiMem L5, legal "constitutional" rules |
| **Intent-triggered** | Structural match on classified intent | When task category matches | Innate immune TLRs, Drools MAIN group, aviation checklists |
| **Reactive** | FTS5 keyword + Qdrant vector hybrid | When prompt content matches | Current system (FTS5 only — needs vector channel wired) |

### What we have vs what we need

| Component | Have? | Status |
|-----------|-------|--------|
| SQLite as primary store | YES | Validated by HN/production consensus |
| Qdrant vector embeddings | YES | Exist but NOT used for pattern retrieval |
| FTS5 keyword search | YES | Works but insufficient alone |
| RRF hybrid fusion | YES | Used for artifacts, NOT for patterns |
| Intent classifier | YES | `intent-classifier.ts` exists, not wired to patterns |
| Angel background process | YES | Maps to Letta's "sleep-time compute" |
| Pattern scoring/maturity | YES | candidate → established → proven pipeline |
| Proven principles injection | YES | Added today — session start only |
| `retrieval_mode` on patterns | NO | Needs schema addition |
| `trigger_intents` on patterns | NO | Needs schema addition |
| Intent-based pattern matching | NO | Needs new function |
| Vector search for patterns | NO | Qdrant has embeddings, channel not wired |
| Mid-session proven principles | NO | Only fires at session start |
| Angel consolidation/merging | NO | Extracts N patterns, never merges into 1 principle |

## Layer Summaries

### Layer 1: Implementations
- **Letta**: Always-pinned core memory + sleep-time compute agent. Most directly relevant.
- **LangMem**: `create_prompt_optimizer` — only system that literally rewrites system prompt from learned patterns.
- **GitHub Copilot**: Always-inject + just-in-time verification. Simple, effective.
- **Hindsight**: 4-strategy parallel retrieval with RRF. 91.4% LongMemEval. Mental models layer.
- **mem0**: 51K stars. Proactive write, reactive read. No always-inject.
- **MemOS**: Skill evolution chain (conversation → task → skill). Closest to Claudex architecture.

### Layer 2: Science
- **ACT-R spreading activation** — patterns should activate by semantic association, not keyword match
- **Prospective memory** — high-importance rules need "strategic monitoring" (always-inject); specific rules can be reactive
- **Complementary Learning Systems** — consolidation requires abstraction and merging, not just counting confirmations
- **DPR** — vector retrieval outperforms keyword for semantic understanding
- **ExpeL/Reflexion** — inject all high-tier rules unconditionally; bypass retrieval for top tier
- **Memory reconsolidation** — retrieval is also a write operation; update patterns on every surface

### Layer 3: Failures & Anti-Patterns
1. **Append-only without lifecycle** — CRITICAL. Must consolidate, decay, expire.
2. **Vector as sole retrieval** — has mathematical ceiling (DeepMind). Must be hybrid.
3. **Injecting without relevance gating** — irrelevant context actively degrades performance.
4. **No descriptive/prescriptive distinction** — observations ≠ rules ≠ directives.
5. **LLM extraction loses nuance** — conditional preferences become false absolutes.

### Layer 4: Adjacent Fields
1. **Innate immune system** — small taxonomy of ~10 task categories (like TLR types), rules tagged against them
2. **Rule engine MAIN group** — separate eval path for standing rules, structural matching on session state
3. **Aviation checklists** — rules declare workflow phases they apply to, injected at phase transitions

### Layer 5: Frontier
1. **TIMG** — strategy/recovery/optimization tips with causal attribution. +149% on complex tasks. Most directly applicable.
2. **ALMA** — meta-learns memory designs as executable code. Challenges hand-engineering.
3. **OpenViking** — L0/L1/L2 tiering. 82% token reduction. Most production-ready.
4. **TiMem** — 5-level temporal hierarchy with level-specific consolidation.
5. **LangMem prompt optimizer** — evolves system prompts from feedback.

## Implementation Roadmap

### Phase 1: Wire what exists (hours)
1. Wire vector search into `findMatchingPatterns` — use `findMatchingPatternsHybrid` as default
2. Extend proven principles injection to every assembly call, not just session start

### Phase 2: Add retrieval tiers (focused session)
3. Add `retrieval_mode` column to experience_patterns: `always` / `categorical` / `reactive`
4. Add `trigger_intents` column for categorical patterns
5. Create `matchStandingRules(classifiedIntent)` function parallel to FTS5
6. Angel assigns retrieval_mode at extraction time based on pattern breadth

### Phase 3: Angel consolidation upgrade (design session)
7. Cluster related patterns via Qdrant semantic similarity
8. Synthesize abstract principles from clusters (TIMG-style)
9. LangMem-style prompt optimization: promote proven principles into CLAUDE.md suggestions

## Key Papers & Sources
- ACT-R: Anderson et al. 2004 (doi:10.1037/0033-295X.111.4.1036)
- DPR: Karpukhin et al. 2020 (arxiv:2004.04906)
- ExpeL: Zhao et al. 2024 (arxiv:2308.10144)
- Reflexion: Shinn et al. 2023 (arxiv:2303.11366)
- Voyager: Wang et al. 2023 (arxiv:2305.16291)
- Hindsight: arxiv:2512.12818
- TIMG: arxiv:2603.10600
- TiMem: arxiv:2601.02845
- ALMA: arxiv:2602.07755
- DeepMind embedding limits: arxiv:2508.21038
- Letta sleep-time: letta.com/blog/sleep-time-compute
- LangMem: langchain-ai.github.io/langmem
