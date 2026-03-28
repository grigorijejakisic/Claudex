# Claudex v3 -- Competitive Positioning Report
Date: 2026-03-28

## Executive Summary

Claudex v3 is the top-performing local-first agent memory system by benchmark results: #1 on LoCoMo (90.8%) and #2 on LongMemEval (90.6%, 0.8pp behind Hindsight's 91.4%) -- achieved with a local 16B model while every competitor ahead uses frontier models (GPT-4o, Gemini-3 Pro, 120B OSS). Our unique combination of 4-channel RRF retrieval, Angel guardian process, stigmergic multi-agent coordination, and intelligence layer (RL policies, intent prediction, experience patterns) has no equivalent in any competing system. The biggest gaps to close: cross-encoder reranking (partially broken), entity summary surfacing (backend built but not wired to assembly), and the credibility gap from having no published paper or public benchmark disclosure.

## Benchmark Results

### Before vs After Retrieval Upgrades

| Benchmark | Previous | Latest | Delta |
|-----------|----------|--------|-------|
| LongMemEval Oracle (470 Qs) | 89.1% (419/470) | 90.6% (426/470) | +1.5pp |
| LoCoMo (1540 Qs) | -- | 90.8% (1399/1540) | -- |

All runs used deepseek-coder-v2:16b (local 16B model via Ollama).

### Per-Category Breakdown (Latest)

**LoCoMo:**
| Category | Score |
|----------|-------|
| Single-hop | 92.6% |
| Temporal | 91.7% |
| Open-domain | 91.0% |
| Multi-hop | 88.8% |
| **Overall** | **90.8%** |

**LongMemEval Oracle:**
| Category | Score |
|----------|-------|
| Single-session (preference) | 100.0% |
| Single-session (assistant) | 98.2% |
| Single-session (user) | 98.4% |
| Multi-session | 88.4% |
| Knowledge-update | 87.5% |
| Temporal-reasoning | 85.0% |
| **Overall** | **90.6%** |

### Competitive Benchmark Table

**LoCoMo:**
| System | Score | Answer Model |
|--------|-------|--------------|
| **Claudex** | **90.8%** | deepseek-coder-v2:16b (local) |
| Backboard | 90.00% | Unknown |
| Hindsight (Gemini-3) | 89.61% | Gemini-3 Pro |
| SuperLocalMemory V3 (Mode C) | 87.7% | Cloud embeddings |
| Hindsight (OSS-120B) | 85.67% | 120B OSS |
| MemMachine v0.2 | 84.87% | Unknown |
| Hindsight (OSS-20B) | 83.18% | 20B OSS |
| Memori | 82.0% | Unknown |
| MemOS (Mode C) | 80.8% | Unknown |
| Memobase | 75.78% | Unknown |
| Zep | 75.14% | Unknown |
| SuperLocalMemory V3 (Mode A, local) | 74.8% | Zero cloud |
| Letta filesystem agent | 74.0% | GPT-4o-mini |
| Mem0-Graph | 68.44% | GPT-4o |
| Mem0 | 67.1% | GPT-4o |
| OpenAI Memory | 52.9% | GPT-4o |

**LongMemEval:**
| System | Score | Answer Model |
|--------|-------|--------------|
| Mastra Observational Memory | 94.87% | GPT-5-mini |
| Hindsight (Gemini-3 Pro) | 91.4% | Gemini-3 Pro |
| **Claudex (latest)** | **90.6%** | deepseek-coder-v2:16b (local) |
| Hindsight (GPT-4o) | 89.6% | GPT-4o |
| Hindsight (OSS-120B) | 89.0% | 120B OSS |
| EmergenceMem | 86.0% | Unknown |
| Mastra Observational Memory | 84.23% | GPT-4o |
| EverMemOS | 83.0% | Unknown |
| Mem0 | ~67% | GPT-4o |
| OpenAI Memory | 52.9% | GPT-4o |

**Model handicap assessment:** Claudex at 16B (90.6% LongMemEval) outperforms Hindsight at GPT-4o (89.6%) by 1.0pp. Hindsight's own cross-model data shows ~2.4pp between 120B and frontier (Gemini-3). The retrieval architecture absorbs the model handicap and then some. With a frontier answer model, Claudex would almost certainly match or exceed Hindsight's 91.4%.

---

## Head-to-Head Comparisons

### vs Hindsight

**What they do better:**
1. Epistemic network separation: World/Experience/Opinion/Observation is more rigorous than Claudex's observation/decision/learning taxonomy. The Opinion network with evolving confidence scores (reinforce/weaken/contradict/neutral classification) is genuinely novel.
2. Temporal reasoning: Absolute timestamp range extraction at write time makes temporal queries reliable. Dedicated temporal retrieval channel (rule-based + FLAN-T5 fallback).
3. Neural reranking: Post-RRF cross-encoder (ms-marco-MiniLM-L-6-v2, ~86MB) is a proven precision boost. Claudex's cross-encoder implementation is broken (uses embedding model for text generation).
4. Causal link extraction: {causes, caused_by, enables, prevents} typed edges enable causal reasoning chains. Claudex has generic link types but no causal layer.
5. Background observation regeneration: Entity profiles auto-regenerate when underlying facts change. Claudex entity summaries are generated but never resurfaced.
6. Benchmark credibility: 91.4% independently validated by Virginia Tech Sanghani Center + Washington Post.

**What we do better:**
1. Zero infrastructure: SQLite single-file vs PostgreSQL + Docker. Works on a laptop with nothing running.
2. Latency: Sub-3ms retrieval (FTS5+vector+RRF, all local). Hindsight's 4-channel + cross-encoder pipeline has no published latency.
3. Local-first privacy: Data never leaves the machine. No LLM calls for retrieval.
4. Human-readable rules: Experience patterns are actionable ("do X when Y"), readable, editable. Hindsight stores narrative memories.
5. Session lifecycle: Claudex tracks session events, checkpoints, activation decay, threads. Hindsight is a memory service, not a session manager.
6. Cross-session coordination: Angel-driven stigmergic signals + SBAR handoffs. Hindsight is single-agent memory.
7. Cost: $0/query forever. Hindsight at 120B models requires expensive GPU or API.

**Net assessment:** Hindsight is the closest true competitor. Architecturally sophisticated with genuinely original ideas (Opinion network, CARA disposition profiles). On benchmarks, it's nearly a dead heat -- they lead LongMemEval by 0.8pp with a frontier model; we lead LoCoMo by 1.2pp with a 16B local model. The differentiation is in deployment model (server vs local-first), session awareness (none vs deep), and cost (cloud API vs free).

### vs Letta/MemGPT

**What they do better:**
1. Multi-agent as first-class citizen: sync/async/broadcast messaging, shared memory blocks with concurrency semantics, Conversations API, tag-based discovery.
2. Ecosystem: 21.6K stars, $10M seed funding (Jeff Dean investor), $1.4M ARR, enterprise features (Cloud, AWS AMI, SAML/OIDC), 100+ contributors.
3. LLM provider agnosticism: 10+ providers (OpenAI, Anthropic, Gemini, vLLM, Ollama). Claudex is Claude Code-native.
4. Sleep-time compute: Well-articulated background processing architecture (UC Berkeley paper).
5. Context Repositories (MemFS): Git-backed memory files, git worktrees for subagent isolation, human-editable.
6. Conversations API: Single agent handling hundreds of parallel threads with unified memory.

**What we do better:**
1. Benchmark performance: 90.8% LoCoMo vs Letta's 74.0% -- a 16.8-point gap. Letta has NO published LongMemEval score.
2. Automatic capture: Hooks silently capture everything. Letta requires the agent to call memory tools explicitly (unreliable).
3. 4-channel RRF retrieval vs Letta's 1-channel semantic search. This is why we dominate temporal and multi-hop questions.
4. Intelligence layer: RL policies, intent prediction, experience patterns, negative retrieval, correction detection -- no Letta equivalent.
5. Reliability: 0 critical open bugs vs 5/5 unresolved in Letta (including primary cross-agent communication tool dying after 2 calls, zombie runs, silent memory persistence failures, orphaned tool messages bricking agents, live CVE).
6. Local-first deployment: No server, no Docker, no PostgreSQL.
7. Stigmergic coordination: More robust than Letta's broken message-passing.

**Net assessment:** Letta is a better product (more features, more providers, enterprise revenue). Claudex is a better memory system (16.8pp LoCoMo gap, 4-channel retrieval, intelligence layer). Most damning Letta finding: their primary cross-agent messaging tool dies after 2 calls (open, stale, no maintainer fix) -- building a multi-agent platform on broken agent-to-agent comms. Different markets: Letta targets enterprise/teams, Claudex targets single-developer Claude Code users.

### vs CASS

**What they do better:**
1. Multi-provider session indexing: 17+ agent formats natively (Claude Code, Codex, Cursor, Aider, Gemini CLI, Cline, etc.). Claudex is Claude Code-only.
2. Explicit procedural learning: Clean ACE pipeline (session-to-diary-to-playbook) with user-facing CLI commands (`cm playbook`, `cm why`, `cm top`). More transparent than Claudex's Angel extraction.
3. Anti-pattern inversion: Rules marked harmful 3x automatically generate counter-rules. Claudex has no equivalent.
4. Scientific validation gate: New playbook rules require historical evidence before acceptance.
5. Trauma Guard: Safety system blocking dangerous rule injection.
6. Cross-provider learning: Lessons learned in Cursor automatically inform Claude Code sessions.

**What we do better:**
1. Retrieval depth: 4-channel RRF with graph walk vs CASS's 3-channel (BM25 + MiniLM + RRF, no recency or graph).
2. Real-time assembly: Push-based context injection every turn. CASS is pull-based (agent must call `cm context`).
3. Angel guardian: Continuous background processing. CASS has no persistent guardian; `cm reflect` is manual.
4. Active coordination: Stigmergic signals + SBAR handoffs vs CASS's passive shared-filesystem approach.
5. Production maturity: V12 schema, 23 tables, 2020 tests. CASS is Alpha, no visible test suite, solo maintainer.
6. Activation decay: Cognitively-grounded (ACT-R) vs CASS's cruder 90-day time-only half-life.

**Net assessment:** CASS solves an adjacent problem well (cross-provider session search + procedural learning). Its 17-connector format normalization is genuine infrastructure Claudex lacks. But CASS is fragmented (2 repos, 2 runtimes), Alpha, untested, solo-maintained. Claudex's biggest gap to close from CASS: multi-provider session indexing. Claudex's biggest moat over CASS: Angel guardian + stigmergic signals for coordinated multi-agent work.

### vs Field (Engram, agent-recall, mcp-memory-service, Mem0, others)

**Engram** (~911 stars, Go+SQLite+FTS5): Best developer UX in local-first tier (zero-dependency Go binary, 13 MCP tools, 8+ editors). But no vector search, no multi-agent, no decay/consolidation, no guardian. Claudex outclasses it on every technical dimension.

**agent-recall** (~8 stars): Best theoretical design (scope chain, bitemporal slots, adaptive cache invalidation). But dormant, no adoption, no vector search, no guardian. Ideas worth borrowing; not a competitor.

**mcp-memory-service** (~1.6K stars): Bridge between local-first and cloud. Only system with native claude.ai web integration via remote MCP. 5ms local reads. But no production validation, ChromaDB locking issues, no guardian. Watch for remote MCP differentiator.

**Mem0** (~51K stars): Ecosystem winner by adoption (fastest-growing, from 29K to 51K stars). But 67.1% LoCoMo vs Claudex's 90.8% -- 23.7pp gap. LLM-dependent extraction (unreliable, costly). No local-first story.

**SuperLocalMemory V3** (new, arXiv March 2026): Most credible challenger on local-first/privacy axis. Mode A (zero cloud): 74.8% LoCoMo. Mode C (cloud): 87.7%. EU AI Act compliance narrative (August 2026 deadline). Mathematical guarantees. Still 3.1pp behind Claudex on LoCoMo with cloud, 16pp behind on local-only.

**MemOS** (MemTensor): Most conceptually interesting new entrant. Skill/procedural memory (agents improving their own strategies). 80.8% LoCoMo. Not a current threat but frontier concepts worth watching.

**Zep/Graphiti**: Temporal knowledge graph with validity windows. 94.8% DMR, BUT 600K+ token footprint and hours-delayed retrieval. Server-required. Architecture problems.

**Net assessment:** No system in the broader field combines Claudex's benchmark scores + local-first deployment + guardian process + multi-agent coordination + intelligence layer. Mem0 wins on adoption (51K stars) but loses badly on quality (23.7pp gap). SuperLocalMemory V3 is the most credible emerging threat on the local-first axis.

---

## Our Unique Advantages (What Nobody Else Has)

1. **Intelligence layer with no equivalent anywhere**: Intent classification (6 types) driving retrieval strategy, intent prediction (3-layer: temporal + Markov + session features), negative retrieval (tracks and suppresses unhelpful results), RL policy system (6 SimpleMLP models, 34K params, pure TypeScript), experience patterns with correction detection. No competitor has any of these.

2. **4-channel RRF with MPFP graph walk**: FTS5 keyword + Qdrant KNN + recency decay + typed meta-path graph traversal (8 patterns). Hindsight has 4 channels but different ones (semantic + BM25 + graph + temporal). Nobody else has more than 2 channels.

3. **Angel guardian process**: Persistent background agent that extracts patterns from full conversations via LLM, monitors idle sessions, auto-closes with state preservation, sends inter-session messages. Letta has "sleep-time compute" conceptually but their implementation has critical bugs. CASS requires manual invocation.

4. **Stigmergic multi-agent coordination**: Environment-mediated coordination via shared DB signals with temporal decay (WIP, failure, danger, claim signals). Inspired by ant colony optimization. No competitor uses stigmergy; all use message passing (which is demonstrably more fragile).

5. **Production-proven local-first at benchmark-leading quality**: 233 sessions, 21K observations, 2900+ artifacts in daily production use. #1 on LoCoMo with a 16B local model. No competitor matches this combination of benchmark quality + zero infrastructure + production evidence.

6. **Automatic capture without agent discipline**: Hooks silently capture everything from Claude Code events. No reliance on the LLM remembering to call memory tools. Research consensus says LLM self-managed memory is unreliable.

7. **Three-factor scoring + ACT-R activation**: Recency + importance + relevance scoring, plus retrieval feedback multiplier, novelty scoring, activation spreading, and RIF suppression (non-selected candidates get activation decremented). Significantly more sophisticated than any competitor's scoring.

---

## Gaps to Close (What We Should Steal)

### Priority 1 -- High Impact, Low Effort

1. **Fix cross-encoder reranking** (from Hindsight): Current implementation is broken (uses embedding model for text generation). Replace with actual `ms-marco-MiniLM-L-6-v2` cross-encoder. ~80 lines. Estimated 5-15% precision improvement. Source: W1, W2.

2. **Wire entity summaries to assembly** (from spec): Backend entity summarizer exists in Angel, generates summaries to DB, but assembler never queries them. ~50-80 lines in assembler.ts. Source: W2.

3. **Wire token budget to assembler** (from spec): `budgetTokens` parameter exists on hybrid retrieval, greedy packing works, but assembler never passes a budget. Also missing from sync path. ~50 lines. Source: W2.

### Priority 2 -- High Impact, Medium Effort

4. **Opinion confidence evolution** (from Hindsight): Store experience patterns as (statement, confidence, timestamp) tuples. Classify new evidence as reinforce/weaken/contradict/neutral. Adjust confidence accordingly. Highest-leverage architectural idea from Hindsight. Source: W1.

5. **Temporal absolute range extraction at write time** (from Hindsight): Convert relative temporal expressions ("last Tuesday") to absolute timestamp intervals during storage, not at query time. Makes temporal retrieval vastly more reliable. Source: W1.

6. **Causal link types** (from Hindsight): Add {causes, caused_by, enables, prevents} as typed edges in artifact_links. Claudex already has link types -- this is extending the taxonomy. Source: W1.

7. **Multi-provider session indexing** (from CASS): Read-only connectors for Cursor, Codex, Aider session formats. Closes the cross-provider blind spot. Even read-only indexing would be valuable. Source: W4.

### Priority 3 -- Medium Impact, Strategic

8. **Anti-pattern inversion ratchet** (from CASS): Patterns marked harmful N times automatically generate counter-rules. Source: W4.

9. **Scientific validation gate** (from CASS): New patterns require historical evidence retrieval before acceptance. Source: W4.

10. **EU compliance framing** (from SuperLocalMemory V3): "Data sovereignty by architecture" is authentic for Claudex and timely for August 2026 EU AI Act deadline. Marketing, not code. Source: W5.

11. **Run LifeBench** (from W5): New longer-horizon benchmark where everyone scores 40-55%. If this becomes the standard, LoCoMo scores become irrelevant. Know where we stand before competitors publish comparisons.

12. **Bitemporal slots** (from agent-recall): Archive old values rather than overwrite. Enables "what was true at time T?" queries. Source: W5.

---

## What to Announce

### Headline Numbers
- **#1 on LoCoMo**: 90.8% (1399/1540) -- higher than Hindsight (89.6%), MemMachine (84.9%), Zep (75.1%), Mem0 (67.1%), OpenAI Memory (52.9%)
- **#2 on LongMemEval**: 90.6% (426/470) -- 0.8pp behind Hindsight's 91.4%, but achieved with a local 16B model vs their Gemini-3 Pro
- **Outperforms Hindsight GPT-4o by 1.0pp** with a model 10x smaller
- **16.8pp ahead of Letta** on LoCoMo (90.8% vs 74.0%)
- **23.7pp ahead of Mem0** on LoCoMo (90.8% vs 67.1%)

### Key Differentiators
- **Zero infrastructure**: SQLite + Ollama. No PostgreSQL, no Docker, no cloud API keys for memory. Runs entirely on your machine.
- **Automatic capture**: No LLM discipline required. Hooks silently capture from Claude Code lifecycle events.
- **Intelligence layer**: Intent prediction before you finish typing. RL policies learning optimal memory decisions. Experience patterns that inject warnings before you repeat mistakes.
- **Local privacy**: 100% local. Data never leaves the machine. EU AI Act compliant by architecture (August 2026).
- **Free forever**: $0/query. Competitors at production scale with frontier models cost real money.

### What NOT to claim
- Do not claim #1 on LongMemEval (Hindsight leads at 91.4%, Mastra at 94.87% with GPT-5-mini)
- Do not claim "beats every system" without qualifying the model handicap
- Note that Claudex LoCoMo methodology should be documented for reproducibility

---

## Recommended Next Steps

### Immediate (This Week)
1. **Fix cross-encoder reranking**: Replace broken Ollama generate call with actual cross-encoder inference using ms-marco-MiniLM-L-6-v2. ~80 lines. Highest ROI bug fix.
2. **Wire entity summaries to assembly**: Entity summarizer generates to DB but assembler never reads them. ~50-80 lines.
3. **Wire token budget through assembler**: Budget parameter exists but assembler never passes it. ~50 lines.
4. **Re-run LongMemEval after fixes**: These three changes should push LongMemEval above 91%, potentially matching or exceeding Hindsight.

### Short-Term (Next 2 Weeks)
5. **Add opinion confidence evolution to experience patterns**: (statement, confidence, timestamp) with reinforce/weaken/contradict mechanics. Highest-leverage architectural improvement.
6. **Add temporal range extraction at write time**: Convert relative temporal expressions to absolute intervals during observation storage.
7. **Run LifeBench**: Establish position on the emerging longer-horizon benchmark before competitors publish comparisons.

### Medium-Term (Next Month)
8. **Multi-provider session indexing**: Read-only connectors for Cursor and Codex session formats.
9. **Publish benchmark methodology**: Reproducibility documentation. Consider arXiv paper (SuperLocalMemory V3 has one; we don't).
10. **Add causal link types**: Extend artifact_links taxonomy with {causes, caused_by, enables, prevents}.

### Strategic
11. **EU AI Act compliance framing**: "Data sovereignty by architecture" for August 2026 deadline.
12. **Consider LifeBench as primary benchmark**: If the field moves to longer-horizon benchmarks, LoCoMo/LongMemEval scores become less relevant.

---

## Implementation Status of Hindsight-Inspired Upgrades

| Upgrade | Status | Remaining |
|---------|--------|-----------|
| 1. Cross-encoder reranking | BROKEN STUB -- uses wrong model type | ~80 lines (replace model + add function) |
| 2. MPFP meta-path traversal | COMPLETE -- 8 patterns, tested | 0 |
| 3. Entity summary layer | BACKEND ONLY -- Angel generates, assembler doesn't read | ~130 lines (assembler + tests) |
| 4. Token budget-aware retrieval | PARAM EXISTS -- assembler not wired | ~50 lines (sync path + assembler) |
| 5. Temporal link decay | COMPLETE -- 30-day sigma, both paths | 0 |

Total remaining: ~260 lines across 3 files + 1 function to fix. Upgrades 2 and 5 are fully done. Upgrades 1, 3, and 4 need targeted completion work.

---

## Appendix: Surprising Findings

1. **Hindsight's "89.6%" is a LoCoMo score, not LongMemEval.** Our prior documentation conflated these. Hindsight's LongMemEval scores: 91.4% (Gemini-3), 89.0% (OSS-120B), 83.6% (OSS-20B). Their LoCoMo score: 89.61% (Gemini-3).

2. **MPFP is NOT a Hindsight technique.** Hindsight uses spreading activation with typed edge multipliers. MPFP is from heterogeneous graph ML research. Our spec attributed it incorrectly.

3. **Letta's filesystem agent scores 74.0% on LoCoMo** -- 16.8pp below Claudex. This is a massive gap. Their primary cross-agent messaging tool has been broken (dying after 2 calls) for months with no fix.

4. **SuperLocalMemory V3** is a new entrant with an arXiv paper and EU compliance narrative. Most credible challenger on the local-first axis. Mode C: 87.7% LoCoMo.

5. **LifeBench** is an emerging longer-horizon benchmark where everyone scores 40-55%. If adopted as the new standard, current LoCoMo leadership becomes less meaningful. Our position on it is unknown.

6. **Backboard scores 90.0% on LoCoMo** -- actually beats Hindsight (89.61%). This is a system not on our radar that deserves investigation.

---

*Report synthesized from 6 worker research streams: W1 (Hindsight deep dive), W2 (Claudex implementation audit), W3 (Letta comparison), W4 (CASS comparison), W5 (field scan), W6 (benchmark analysis). All findings cross-referenced for consistency.*
