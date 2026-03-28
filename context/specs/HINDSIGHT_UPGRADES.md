# Spec: Hindsight-Inspired Retrieval Upgrades

Date: 2026-03-28 | Source: Street knowledge research + Hindsight architectural analysis

## Overview

Five enhancements to Claudex's retrieval pipeline, inspired by Hindsight's architecture. All are enhancements to existing channels — no new infrastructure, no schema redesigns.

---

## Upgrade 1: Cross-Encoder Reranking

**What:** After RRF fusion produces ranked results, run a neural cross-encoder that jointly scores each (query, candidate) pair. Hindsight uses ms-marco-MiniLM-L-6-v2 (~22M params, runs on CPU in ~50ms for 10 candidates).

**Where:** `src/core/hybrid-retrieval.ts` — add a reranking step after the existing 3-channel RRF fusion.

**How:**
- Load cross-encoder model via Ollama (if available) or direct ONNX inference
- After RRF produces top-N candidates, score each with cross-encoder
- Re-sort by cross-encoder score
- Fallback: if model unavailable, skip reranking (current behavior)

**Files to change:**
- `src/core/hybrid-retrieval.ts` — add `rerankWithCrossEncoder()` after RRF
- `src/embeddings/ollama-client.ts` — add `crossEncoderScore(query, candidate)` function

**Effort:** Small-medium. The RRF pipeline exists, this is an additional scoring step. ~100 lines. Main risk: Ollama cross-encoder model availability (may need to pull a model).

**Impact:** 5-15% precision improvement on retrieval. Highest ROI upgrade.

---

## Upgrade 2: MPFP Meta-Path Graph Traversal

**What:** Replace 2-hop BFS graph walk with typed meta-path patterns that run in parallel. Patterns like `[semantic, entity]`, `[caused_by, temporal]`, `[entity, semantic]` each traverse the graph differently and results fuse via RRF.

**Where:** `src/core/hybrid-retrieval.ts` — the graph walk channel (channel 3 of the 3-channel RRF).

**How:**
- Define 4-5 meta-path patterns based on `artifact_links.link_type`
- Each pattern: start from seed artifacts, follow edges of specified types, collect endpoints
- Run all patterns in parallel (they're independent DB queries)
- Fuse pattern results via RRF before merging with keyword/vector channels
- Lazy edge loading: only query edges for frontier nodes (sublinear)

**Predefined patterns:**
1. `[related, related]` — topic expansion (2-hop related)
2. `[supports, related]` — evidence chain → context
3. `[caused_by, related]` — causal reasoning → context
4. `[supersedes]` — version chain (1-hop, find latest)
5. `[related, supports]` — context → evidence

**Files to change:**
- `src/core/hybrid-retrieval.ts` — replace `graphWalk()` with `mpfpTraversal()`

**Effort:** Medium. The link types and graph structure exist. This is an algorithm change to the traversal, not a data model change. ~150 lines.

**Impact:** Better multi-hop retrieval. Currently 2-hop BFS finds nearby nodes; MPFP finds semantically meaningful paths.

---

## Upgrade 3: Observation/Entity Summary Layer

**What:** Angel generates entity summaries — consolidated descriptions of recurring entities (projects, people, tools, concepts) with evidence grounding and trends (STABLE/STRENGTHENING/WEAKENING/NEW/STALE).

**Where:** New Angel heartbeat phase. New artifact type `entity_summary`.

**How:**
- Angel queries artifacts/observations for recurring entity names (mentioned in 3+ sessions)
- For each entity, collect all related facts across sessions
- LLM synthesizes a summary with evidence quotes and trend computation
- Store as artifact with `artifact_type = 'entity_summary'`
- Regenerate when new evidence arrives (tracked via evidence count hash)
- Assembler surfaces entity summaries in the planning-tier (Priority 3-4)

**Files to change:**
- `src/angel/heartbeat.ts` — new phase: entity summary generation
- `src/angel/entity-summarizer.ts` — new file: extraction + trend computation
- `src/assembly/assembler.ts` — surface entity summaries in assembly

**Effort:** Medium-large. New extraction logic + LLM calls + new artifact type. ~200-250 lines across 3 files. Requires LLM availability in Angel.

**Impact:** Agents get pre-computed entity knowledge instead of having to search for it. "What is Nexus?" answered from a summary, not from searching raw observations.

---

## Upgrade 4: Token Budget-Aware Retrieval

**What:** Instead of "retrieve 10 items", pass the remaining injection budget to retrieval and let it greedy-pack results until the budget is full. Maximizes context utilization.

**Where:** `src/core/hybrid-retrieval.ts` and `src/assembly/assembler.ts`.

**How:**
- Add `budgetTokens` parameter to `hybridSearchAsync()` and `hybridSearchSync()`
- After scoring and ranking, iterate results and accumulate token cost
- Stop when adding the next result would exceed budget
- Return the packed set with total token cost

**Files to change:**
- `src/core/hybrid-retrieval.ts` — add budget parameter, greedy packing
- `src/assembly/assembler.ts` — pass remaining budget to retrieval calls

**Effort:** Small. ~50 lines. The token estimator already exists. This is plumbing.

**Impact:** Better context utilization. No more "retrieved 10 items but only 3 fit in budget, wasted 7 queries."

---

## Upgrade 5: Temporal Link Decay

**What:** Apply exponential decay `exp(-Δt/σ)` to artifact_link strength based on temporal distance between linked artifacts. Recent links are stronger than old ones.

**Where:** `src/core/hybrid-retrieval.ts` — the graph walk / MPFP channel.

**How:**
- When traversing links, compute time delta between source and target artifacts
- Apply `weight *= exp(-deltaSeconds / sigma)` where sigma is configurable (default: 30 days in seconds)
- Links between artifacts from the same day get full weight
- Links spanning months get heavily decayed
- Uses `valid_at_epoch` on artifact_links (already exists) or artifact `created_at_epoch`

**Files to change:**
- `src/core/hybrid-retrieval.ts` — apply decay formula during graph traversal

**Effort:** Tiny. ~20 lines. One formula applied during link traversal.

**Impact:** Graph traversal naturally prefers recent, relevant paths over old ones.

---

## Effort Summary

| Upgrade | Lines | Effort | Impact | Dependencies |
|---------|-------|--------|--------|--------------|
| 1. Cross-encoder reranking | ~100 | Small-medium | Highest (5-15% precision) | Ollama model pull |
| 2. MPFP meta-path patterns | ~150 | Medium | High (multi-hop quality) | None |
| 3. Entity summary layer | ~250 | Medium-large | High (proactive knowledge) | Angel LLM |
| 4. Token budget-aware retrieval | ~50 | Small | Medium (context utilization) | None |
| 5. Temporal link decay | ~20 | Tiny | Medium (recency preference) | None |
| **Total** | **~570** | | | |

## Recommended Order

1. **Temporal link decay** (5) — 20 lines, immediate impact, no dependencies
2. **Token budget-aware retrieval** (4) — 50 lines, improves assembly efficiency
3. **Cross-encoder reranking** (1) — 100 lines, highest precision gain, needs model
4. **MPFP meta-path patterns** (2) — 150 lines, best graph traversal upgrade
5. **Entity summary layer** (3) — 250 lines, biggest change, needs LLM in Angel

Total: ~570 lines across existing files + 1 new file.
