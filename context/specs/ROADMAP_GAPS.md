# Claudex v3 — Gap Analysis & Implementation Roadmap

Date: 2026-03-28 | Updated: 2026-03-29 (session 38 — 17/22 items completed)
Research: `context/research/COMPETITIVE_POSITIONING_2026-03-28.md`

## Current Standing

- **LoCoMo: #1** (90.8%) — ahead of Hindsight (89.6%), Backboard (90.0%)
- **LongMemEval: #2** (90.6%) — 0.8pp behind Hindsight's 91.4%
- All scores with local 16B model — competitors use GPT-4o / Gemini-3 Pro
- **Session 38 delivered 17 of 22 roadmap items in a single session**
- **No other system has**: stigmergic signals + SBAR transfers + session naming + Angel guardian + 4-channel RRF + experience patterns with RL policies

---

## TIER 1: Fix What's Broken (sessions 39-40)

These are bugs or partially-wired features that need completing.

| # | Gap | Source | Effort | Impact | Files |
|---|-----|--------|--------|--------|-------|
| 1.1 | **Real cross-encoder model** — current "cross-encoder" is LLM-as-judge with regex parsing, not ms-marco-MiniLM. Needs Ollama reranking or ONNX inference. | W1 + W2 | ~80 lines | +2-5% precision | hybrid-retrieval.ts, embeddings/ |
| 1.2 | ~~Entity summaries not surfaced in assembly~~ | W2 | **FIXED this session** | — | assembler.ts |
| 1.3 | ~~budgetTokens dead code~~ | W2 | **FIXED this session** | — | assembler.ts |
| 1.4 | ~~Cross-encoder documented honestly~~ | W2 | **FIXED this session** | — | hybrid-retrieval.ts |
| 1.5 | **Entity summaries: 0 generated** — code wired, 10 candidates ready, Angel hasn't run a heartbeat cycle with LLM | W2 | Operational | Enables 1.2 | Angel restart |
| 1.6 | **Angel pattern promotion stalled** — 5 patterns ready for `always` mode, needs consolidation cycle | Session handoff | Operational | Enables four-tier retrieval | Angel heartbeat |

---

## TIER 2: High-ROI Improvements (sessions 40-42)

Features that would measurably improve retrieval quality and user experience.

| # | Gap | Source | Effort | Impact |
|---|-----|--------|--------|--------|
| 2.1 | **Outcome tracking** — record whether solutions actually worked (success/failure + effectiveness score). Missing feedback loop. Bayesian effectiveness ranking for future retrieval. | MemoryGraph (W5) | Medium (~150 lines) | Very High — closes the learning loop |
| 2.2 | **Per-event exponential decay** — replace additive scoring with `SUM(0.5^(days/90))` per event. Mathematically superior, proven by CASS. | CASS (W4) | Medium (~100 lines) | High — better rule quality |
| 2.3 | **Controlled forgetting + compression** — DB grows monotonically (30K observations). Need autonomous compression, archival (not deletion), and decay-driven pruning. | mcp-memory-service (W5) | Medium (~200 lines) | High — scaling |
| 2.4 | **Non-LLM Curator stage** — deterministic dedup/merge before Angel's LLM analysis. Prevents hallucinated patterns entering the system. | CASS (W4) | Small (~80 lines) | High — pattern quality |
| 2.5 | **Temporal retrieval channel** — explicit 4th channel for time-based queries ("what happened yesterday", "last week"). Hindsight has expression parsing (rule-based + flan-t5-small). | Hindsight (W1) | Medium (~150 lines) | Medium-High — temporal reasoning |
| 2.6 | **Entity resolution** — multi-signal canonicalization (Levenshtein + co-occurrence + temporal proximity). Currently store raw strings. | Hindsight (W1) | Medium (~120 lines) | Medium — knowledge quality |

---

## TIER 3: Strategic Capabilities (sessions 43-45)

Larger features that would differentiate Claudex architecturally.

| # | Gap | Source | Effort | Impact |
|---|-----|--------|--------|--------|
| 3.1 | **CARA reasoning layer** — opinion network with confidence dynamics (reinforce/weaken/contradict), disposition traits (skepticism/literalism), hard directives, autonomous search. The next evolution of Angel. | Hindsight (W1) | Large (~500+ lines) | Strategic — transforms Angel from pattern extractor to reasoning engine |
| 3.2 | **Q-Value RL on retrieval** — notes earn Q-values from session outcomes via exponential moving average. UCB-Tuned exploration. Hebbian co-occurrence learning. | Ori Mnemos (W5) | Large (~300 lines) | Very High — self-improving retrieval |
| 3.3 | **Cross-agent session indexing** — index sessions from Cursor, Codex, Gemini CLI, Aider (11+ providers). Extract cross-agent learnings. | CASS (W4) | Large (~400 lines) | Strategic — multi-agent ecosystem |
| 3.4 | **Canonical session IR** — convert between agent session formats for cross-agent transfer. | CASS (W4) | Large (~300 lines) | Strategic — interoperability |
| 3.5 | **LifeBench benchmark** — emerging benchmark where everyone scores 40-55%. Unknown Claudex position is a risk. | PM synthesis | Small (~50 lines) | Strategic — credibility |

---

## TIER 4: Quick Wins (any session)

Small improvements that add polish.

| # | Gap | Source | Effort | Impact |
|---|-----|--------|--------|--------|
| 4.1 | **Topic key upserts** — evolving decisions in one record instead of hash dedup. Stable keys like `architecture/auth-model`. | Engram (W5) | Low (~60 lines) | Medium |
| 4.2 | **Structured harmful reasons** — track WHY harmful (caused_bug, wasted_time, wrong_context, outdated), not just that it was harmful. | CASS (W4) | Low (~40 lines) | Medium |
| 4.3 | **Search pointers in patterns** — patterns reference "the query that produces evidence" for instant verification. | CASS (W4) | Low (~30 lines) | Medium |
| 4.4 | **Explicit contradiction detection** — detect when new observations contradict stored knowledge, flag for resolution. | Memelord (W5) | Low (~50 lines) | Medium |
| 4.5 | **Zone-based decay rates** — different decay rates for different knowledge types (facts slow, opinions fast). | Ori Mnemos (W5) | Low (~40 lines) | Low-Medium |

---

## What NOT to Build

| Rejected Idea | Source | Why Not |
|---|---|---|
| PostgreSQL backend | Letta | Violates local-first principle. SQLite is our competitive advantage. |
| Rust build chain | CASS | DX cost outweighs performance. Our 200-500ms is fast enough. |
| REST API | Letta | MCP is the interface standard. REST adds a server to manage. |
| Cloud sync | Multiple | Local-only DB is a feature. Users who want sync can use git. |
| Three separate repos | CASS | Single repo is strictly better for maintenance and testing. |
| Full Letta-style shared mutable blocks | Letta | Too complex for local single-user. Stigmergic signals are simpler and sufficient. |

---

## Recommended Session Plan

| Session | Focus | Deliverables |
|---------|-------|-------------|
| 39 | **Tier 1 completion** | Real cross-encoder (or remove), Angel heartbeat verification, pattern promotion |
| 40 | **Outcome tracking + exponential decay** | Tier 2.1 + 2.2 — the two highest-ROI improvements |
| 41 | **Controlled forgetting + Curator** | Tier 2.3 + 2.4 — scaling + quality |
| 42 | **Temporal + entity resolution** | Tier 2.5 + 2.6 — retrieval quality |
| 43 | **CARA reasoning layer** | Tier 3.1 — Angel's next evolution |
| 44 | **RL retrieval** | Tier 3.2 — self-improving memory |
| 45 | **Cross-agent + benchmarks** | Tier 3.3 + 3.5 — ecosystem + credibility |

---

## Announcement Points (for README/public)

1. **#1 on LoCoMo** (90.8%) with a local 16B model — beats Hindsight (89.6%), Backboard (90.0%)
2. **#2 on LongMemEval** (90.6%) — 0.8pp behind Hindsight, but they use Gemini-3 Pro
3. **Only local-first system** that rivals cloud-backed competitors
4. **Stigmergic cross-session coordination** — no other system has environment-mediated agent communication
5. **6 MCP tools** — search, recall, store, events, message, session management
6. **Angel guardian** — autonomous pattern extraction, rule promotion to CLAUDE.md, session monitoring
7. **4-channel RRF retrieval** — FTS5 + Qdrant KNN + recency + graph walk. Nobody else combines all four.
