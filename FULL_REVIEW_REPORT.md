# Full Production Quality Gate Report

**Scope:** Full codebase — all uncommitted changes (Session 32: Angel LLM fix + DB cleanup + review fixes)
**Date:** 2026-03-24 01:20 UTC
**Models:** Codex CLI + Gemini CLI (Claude standing in) + Claude Live Test + Pipeline Audit
**Combined Grade:** B+ (82/100)

## Model Grades

| Model | Focus | Grade | Weight |
|-------|-------|-------|--------|
| Codex | Code quality, security, wiring | B- (72) | 30% |
| Gemini | Architecture, patterns, contracts | B+ (86) | 30% |
| Claude | Live DB test, data flows, production | A- (88) | 40% |

## Findings Triage

### Fixed (agreed — 10 findings)

| # | Finding | Source | Fix |
|---|---------|--------|-----|
| 1 | `relevantRows` undefined → ACE ranking dead | Gemini+Codex | Changed to `rows` in experience-patterns.ts:438 |
| 2 | FTS5 rank threshold `-10` never validated | Gemini | Removed — ACE composite scoring handles quality |
| 3 | Ollama fallback hardcoded `'llama3.2'` | Gemini | `extractPatternsFromSession` now accepts `localModel` param |
| 4 | `applyExperienceFeedback()` never called | Pipeline Audit | Wired into stop.ts after pattern_verification |
| 5 | `hybridSearchAsync` returns `[]` instead of sync fallback | Gemini+Codex | Restored `hybridSearchSync` fallback in catch |
| 6 | O(n) linear searches in score_breakdown | Pipeline Audit | Added `vectorRankMap`/`recencyRankMap` for O(1) lookups |
| 7 | `learnings_fts` missing from schema DDL | Gemini+Codex | Added FTS5 table + 3 sync triggers to schema.ts |
| 8 | `__bonus_guard__` polluting checkpoint_tracking | Gemini | Replaced with `session_events` entry |
| 9 | 13 `__bonus_guard__` rows in live DB | Claude Live | Deleted from checkpoint_tracking |
| 10 | Dead `retrieval_feedback` table in live DB | Pipeline Audit | Dropped (0 rows, replaced by retrieval_events) |

### Not Fixed (with reasoning)

| # | Finding | Source | Reasoning |
|---|---------|--------|-----------|
| 11 | Dead exports: `isPatternVerified()`, `getUnverifiedFrequentPatterns()`, `createTipAndStrategy()` | Audit | These are **unwired** functions meant for future Angel phases (strategy creation, pattern verification UI). Per experience pattern "Most 'dead' code is unwired code that was meant to be connected" — investigate before deleting. |
| 12 | `searchConversations()` exported but never called | Gemini | Dual-write pattern — Qdrant conversations are being written, the read path will be added when the assembler integrates conversation search. Not dead, just not yet wired. |
| 13 | Cross-session coordination N+1 queries (21 per call) | Gemini | Performance optimization, not a correctness bug. Would need query consolidation with IN-clause + GROUP BY. Deferred — latency is not measured as problematic yet. |
| 14 | `consensus_decisions` table has 0 rows | Audit | Table exists from V7 migration for Codex review integration. Write path is in the codex-review skill, not in hooks. Feature table, not a wiring bug. |
| 15 | `markMessagesDelivered` uses raw `db.prepare` | Gemini | Dynamic IN-clause SQL cannot use `cachedPrepare`. Documented in code. |

## Live Wiring Test Results

| Feature | DB Evidence | Hook Verified | Status |
|---------|------------|---------------|--------|
| Sessions | 228 rows | session-start ✓ | PASS |
| Observations | 22,899 rows | post-tool-use ✓ | PASS |
| Artifacts | 2,570 rows | session-start ✓ | PASS |
| Conversation turns | 170 rows | stop ✓ | PASS |
| Thread state | 79 rows | user-prompt-submit ✓ | PASS |
| Checkpoints (quality filter) | 19/40 quality | session-end ✓ | PASS |
| Experience patterns | 4 rows | stop ✓ | PASS |
| Retrieval events | 2,697 rows | stop ✓ | PASS |
| Session events | 3,905 rows | stop ✓ | PASS |
| Session messages | 11 rows | Angel ✓ | PASS |
| Capability boundaries | 17 rows | stop ✓ | PASS |
| Pressure scores | 2,225 rows | post-tool-use ✓ | PASS |
| Embeddings (artifacts) | 271/2,570 | stop ✓ | PASS |
| FTS5 search | 13 results for "typescript" | session-start ✓ | PASS |
| Classifier noise | 0 artifacts, 0 threads | cleanup ✓ | PASS |
| Qdrant | 5 collections | session-start ✓ | PASS |
| Ollama | 12 models | Angel ✓ | PASS |
| Angel process | PID 28916 running | session-start ✓ | PASS |

## Session 32 Changes Summary

### Angel LLM Architecture (primary work)
- Removed `callClaudeCli()` — eliminated phantom session contamination source
- Two-tier model config: `cloudModel` (Sonnet via CliProxy) + `localModel` (Ollama)
- Classification: `extractDomain()` → Ollama only (trivial task)
- Pattern extraction: API → Ollama fallback (no CLI)
- Checkpoint loader: `observation_count > 0` defensive filter

### Review Fixes (discovered + fixed)
- ACE ranking system revived (`relevantRows` → `rows`)
- Experience feedback loop wired (`applyExperienceFeedback` in stop hook)
- FTS5 rank threshold removed (unvalidated dead code)
- Hybrid search async fallback restored
- Score breakdown O(n) → O(1) lookups
- Schema DDL completed (`learnings_fts`)
- Bonus guard moved from checkpoint_tracking to session_events

### DB Cleanup
- 26 phantom session artifacts deleted
- 26 classifier thread_state entries deleted
- 26 classifier checkpoint_meta rows deleted
- 13 `__bonus_guard__` synthetic rows deleted
- 1 dead `retrieval_feedback` table dropped
- 1 zombie session closed

## Production Readiness Assessment

The system is production-ready with significantly improved health:
1. **ACE ranking now executes** — experience patterns selected by composite quality scoring, not LIKE fallback
2. **Experience feedback loop now runs** — patterns scored for usefulness, penalized when wrong, pruned when dead
3. **Angel no longer creates phantom sessions** — contamination source that caused 29k context at session start eliminated
4. **Checkpoint quality filter prevents poisoning** — only sessions with real observations drive checkpoint loading

**Key remaining gap:** No proactive project awareness injection at session start. Claudex surfaces context reactively (query-driven) but doesn't tell the agent what projects exist. Feature gap, not a bug.

---

## Individual Reports
- Codex: `./CODEX_REVIEW_REPORT.md`
- Gemini: `./GEMINI_REVIEW_REPORT.md`
