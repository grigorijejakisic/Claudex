# Full Production Quality Gate Report

**Scope:** Retrieval quality fixes — per-session suppression, vector search, embedding backfill, importance probe
**Date:** 2026-03-24 03:15 UTC
**Models:** Codex CLI + Gemini CLI (Claude standing in) + Claude Live Test
**Combined Grade:** A- (90/100)

## Model Grades

| Model | Focus | Grade | Weight |
|-------|-------|-------|--------|
| Codex | Code quality, security, wiring | A- (91) | 30% |
| Gemini | Architecture, patterns, contracts | B+ (87) | 30% |
| Claude | Live DB test, data flows, production | A- (92) | 40% |

## Findings Triage

### Fixed (agreed — 4 findings)

| # | Finding | Source | Fix |
|---|---------|--------|-----|
| 1 | `findMatchingPatternsHybrid` dead code | Gemini | Wired into user-prompt-submit (assembly turns) |
| 2 | Misleading "fire-and-forget" comment in file-ingester | Gemini+Codex | Corrected to "awaited" |
| 3 | Qdrant ID mismatch in `findMatchingPatternsHybrid` | Codex | Use `vr.payload?.pattern_id` instead of `String(vr.id)` |
| 4 | `detectFileConflicts` per-file N+1 queries | Gemini | Single JOIN-based query replaces per-file loop |

### Not Fixed (with reasoning)

None — all findings addressed.

## Live Wiring Test Results

| Feature | DB Evidence | Hook Verified | Status |
|---------|------------|---------------|--------|
| All 18 tables | Data present | All 5 hooks pass | PASS |
| Pattern suppression | session_injected_ids in flags | assembler ✓ | PASS |
| Hybrid pattern search | Wired in user-prompt-submit | ✓ | PASS |
| Importance probe | 1,658 high-importance artifacts | user-prompt-submit ✓ | PASS |
| Embedding backfill | 79 artifacts queued | file-ingester ✓ | PASS |
| Learning embedding | await in lifecycle.ts | ✓ | PASS |
| Error telemetry | conversation + journal paths | stop.ts ✓ | PASS |
| Qdrant | 5 collections | ✓ | PASS |
| Ollama | 12 models | ✓ | PASS |
| Angel | PID 28916 | ✓ | PASS |

## Session 32 Complete Changes Summary

### Round 1: Angel LLM Architecture (primary)
- Removed `callClaudeCli()` — eliminated phantom session contamination
- Two-tier model config: cloudModel (Sonnet) + localModel (Ollama)
- Checkpoint loader `observation_count > 0` filter
- DB cleanup: 26+26+26+13+1 noise entries

### Round 2: Intelligence Layer Revival (review-driven)
- ACE ranking revived (`relevantRows` → `rows`)
- Experience feedback loop wired (`applyExperienceFeedback` in stop hook)
- FTS5 rank threshold calibrated (-1.0, post-query, corpus-aware)
- Hybrid search async fallback restored
- Score breakdown O(n) → O(1) lookups
- Schema DDL completed (`learnings_fts`)
- Bonus guard moved to session_events
- `createTipAndStrategy` wired into Angel
- `getUnverifiedFrequentPatterns` wired into Angel heartbeat
- `isPatternVerified` removed (redundant)

### Round 3: Retrieval Quality (remaining gaps)
- Per-session pattern suppression (session_injected_ids)
- Hybrid pattern search (FTS5 + Qdrant vector)
- Regular-turn importance probe (importance >= 4)
- Embedding pipeline backfill (file ingester)
- Learning artifact embedding in lifecycle
- Error telemetry for embedding failures
- N+1 queries: getCrossSessionActivity 21→3, detectFileConflicts N+1→1
- Project overview section (Priority 4.25)

### Total: 92 test files, 1714 tests, all green

---

## Individual Reports
- Codex: `./CODEX_REVIEW_REPORT.md`
- Gemini: `./GEMINI_REVIEW_REPORT.md`
