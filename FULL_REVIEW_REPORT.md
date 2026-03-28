# Full Production Quality Gate Report

**Scope:** Full codebase (134 source files, 99 test files, 1969 tests)
**Date:** 2026-03-28 00:40 UTC
**Models:** Codex CLI + Gemini CLI + Claude Live Test
**Combined Grade: A- (86/100)**

## Model Grades

| Model | Focus | Grade | Weight | Score |
|-------|-------|-------|--------|-------|
| Codex | Code quality, security, wiring | A- (88) | 30% | 26.4 |
| Gemini | Architecture, patterns, contracts | A- (87) | 30% | 26.1 |
| Claude | Live DB test, data flows, production | A- (84) | 40% | 33.6 |

## Findings Triage

### Fixed (agreed)

| # | Source | Finding | Fix |
|---|--------|---------|-----|
| 1 | **All three + live test** | Session-start budget stuck at 8K — no context window detection at session-start. Root cause of "/starthere investigating codebase" issue | `window-detector.ts`: model-only 1M detection for Claude 4+. `session-start.ts`: passes model to `detectWindowSize`, passes `contextWindowTokens` to assembler. `constants.ts`: 1M scale increased 2x→3x. **Budget: 8K→24K for Claude 4+** |
| 2 | Codex (SEV-2) | `observability.enabled` missing from DEFAULT_CONFIG — silently disables telemetry pruning at session-start | Added `enabled: true` to `DEFAULT_CONFIG.observability` |
| 3 | Codex (SEV-3) | Dead modules: `structured-analysis.ts`, `contrastive-extraction.ts` — 200 lines never imported | Deleted both files |
| 4 | Codex (SEV-3) | `zod` imported but only available as transitive dependency | Added `zod: ^3.23.0` to `package.json` dependencies |
| 5 | Live test | Cross-project orphan cleanup broken — `AND project = ?` filter prevented cleaning Oracle/Nexus stale sessions | Removed project filter from orphan query; now cleans all stale sessions |

### Not Fixed (disagreed — with reasoning)

| # | Source | Finding | Reason |
|---|--------|---------|--------|
| 6 | Gemini (B1) | Dead tables `knowledge_gaps`, `artifact_access_log` | Forward schema for planned features (System 3 metacognition, ACT-R multi-access BLL). Empty tables have zero cost; removing them loses the migration path |
| 7 | Gemini (B2) | RL policy pipeline complete but no activation gate | By design — RL policy must prove improvement vs default policy on holdout data before activation. The gate is intentionally manual |
| 8 | Gemini (C2) | Post-compaction drops cross-project awareness | By design — post-compaction skips sections already in the LLM's context from the system prompt. Cross-project awareness is session-start only |
| 9 | Gemini (D1) | Topic text doesn't escape backticks | Low risk — topics truncated to 100 chars and sanitized. Backtick escaping could break legitimate code references |
| 10 | Codex (SEV-4) | Several exports only used internally + tests | Test ergonomics justify the exports |

### Investigated but not fixed (separate task)

| # | Source | Finding | Status |
|---|--------|---------|--------|
| 11 | Live test only | 63.2% of sessions (336/532) have 0 observations — all from `grigorije-0759758a` project | Hooks record telemetry/events, but observations table stays empty. Project detection issue for home-directory sessions. Needs separate investigation |
| 12 | Live test only | 73.5% historical artifact embedding gap (1037/3917) | Pipeline works now (99% last 24h). Historical backfill is separate batch task |

## Live Wiring Test Results

| Feature | DB Evidence | Hook Verified | Status |
|---------|------------|---------------|--------|
| Session creation | 532 sessions, latest active | session-start smoke pass | PASS |
| Observation capture | 28,531 observations across 47 projects | post-tool-use smoke pass | PASS |
| Artifact pipeline | 3,917 artifacts (26.5% embedded, 99% last 24h) | Embedding pipeline active | PASS |
| Qdrant vector search | 5 collections, all green (3,525 total points) | Collections responding | PASS |
| Experience patterns | 30 patterns (avg confidence 0.37) | FTS5 match + inject verified | PASS |
| Retrieval events | 7,497 events with feedback tracking | Recording on materialization | PASS |
| Thread state | 355 threads, topic tracking active | Topic shift detection working | PASS |
| Learnings | 78 learnings with FTS5 index | Promotion pipeline active | PASS |
| Decisions | 61 decisions with fingerprinting | Capture pipeline active | PASS |
| Injection budget | Before: 8K fixed. After: 24K for Claude 4+ | scaleBudget math verified | **FIXED** |
| Orphan cleanup | 2 stale sessions (Oracle, Nexus) will auto-close | Cross-project filter removed | **FIXED** |
| Observability pruning | Was silently disabled at session-start | `enabled: true` added | **FIXED** |
| Ollama embeddings | snowflake-arctic-embed2 + nomic-embed-text | Models responding | PASS |

## Production Readiness Assessment

The system is production-ready with the fixes applied. The critical user-reported issue ("agents forgetting 1M plan" / "/starthere investigating instead of retrieving") had a clear root cause: injection budget stuck at 8K because `detectWindowSize` required 195K+ observed tokens (impossible at session-start). Fix enables model-only detection for Claude 4+ and increases 1M scale from 2x to 3x = 24K budget — enough for all 14 priority sections.

Remaining risk: 0-observation issue for `grigorije-0759758a` sessions (63.2% of all sessions) indicates data capture gap for home-directory sessions. Separate investigation needed.

**Build:** Clean (91ms). **Tests:** 99 files, 1969 tests, all passing (13.5s). **Hooks:** All 5 smoke pass.

---

## Individual Reports
- Codex: `./CODEX_REVIEW_REPORT.md`
- Gemini: `./GEMINI_REVIEW_REPORT.md`
