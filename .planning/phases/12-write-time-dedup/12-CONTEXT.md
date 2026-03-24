# Phase 12: Write-Time Deduplication — Context

**Research basis:** 21 parallel research agents (context/research/proactive-memory-research-2026-03.md)
**Spec:** context/specs/PROACTIVE_MEMORY.md Part 1

## Problem
Claudex has 22K observations. Many are near-duplicates across sessions. Every hook that captures observations adds more without checking for semantic overlap. Microsoft Research found 39% performance drop from context overload. This is the single highest-impact change.

## Solution (from research)
Check Qdrant for semantic duplicates (cosine >0.85) before inserting. Follows Mem0's ADD/UPDATE/DELETE/NOOP model at the write path. Agent Zero uses 0.7 for relatedness detection, 0.9 for replacement safety. We use 0.85 as the conservative middle ground.

## Key Files
- `src/core/observations.ts` — `insertObservation()` at line 56 is the single write path
- `src/embeddings/embed-pipeline.ts` — `embedQuery()` for embedding new observations
- `src/embeddings/qdrant-client.ts` — `searchArtifacts()` for similarity check

## Constraints
- Never block writes if Qdrant is unavailable — fall through to normal insert
- Same-session duplicates → SKIP (return existing ID)
- Cross-session same-content → UPDATE existing (increment access_count)
- Cross-session contradicting → INSERT new + link as supersedes
- Must be fast (<50ms typical) — don't slow down hook execution
