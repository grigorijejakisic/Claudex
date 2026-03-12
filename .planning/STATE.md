# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-10)

**Core value:** LLMs retain operational context across sessions and compaction events without manual effort
**Current focus:** Phase 5 - Assembly Pipeline (COMPLETE)

## Current Position

Phase: 5 of 11 (Assembly Pipeline) -- COMPLETE
Plan: 2 of 2 in current phase -- COMPLETE
Status: Phase 5 Complete -- Token estimator, section formatters, assembly orchestrator all done
Last activity: 2026-03-12 -- Completed 05-02 assembly orchestrator

Progress: [▓▓▓▓▓▓▓▓░░] 73%

## Performance Metrics

**Velocity:**
- Total plans completed: 17
- Average duration: 4min
- Total execution time: 57min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 00 | 2 | 6min | 3min |
| 01 | 3 | 11min | 4min |
| 02 | 2 | 8min | 4min |
| 03 | 2 | 7min | 4min |
| 04 | 2 | 7min | 4min |
| 06 | 2 | 6min | 3min |
| 05 | 2 | 7min | 4min |
| 07 | 2 | 5min | 3min |

**Recent Trend:**
- Last 5 plans: 3min, 3min, 2min, 3min, 4min
- Trend: stable

*Updated after each plan completion*
| Phase 00 P02 | 3min | 2 tasks | 11 files |
| Phase 01 P01 | 5min | 2 tasks | 4 files |
| Phase 01 P02 | 3min | 2 tasks | 5 files |
| Phase 01 P03 | 3min | 2 tasks | 8 files |
| Phase 02 P01 | 4min | 2 tasks | 6 files |
| Phase 02 P02 | 4min | 2 tasks | 14 files |
| Phase 03 P01 | 3min | 1 task | 2 files |
| Phase 03 P02 | 4min | 3 tasks | 6 files |
| Phase 04 P01 | 3min | 2 tasks | 6 files |
| Phase 04 P02 | 4min | 3 tasks | 6 files |
| Phase 06 P01 | 3min | 2 tasks | 4 files |
| Phase 06 P02 | 3min | 2 tasks | 4 files |
| Phase 07 P01 | 3min | 2 tasks | 8 files |
| Phase 07 P02 | 2min | 1 task | 3 files |
| Phase 05 P01 | 3min | 2 tasks | 4 files |
| Phase 05 P02 | 4min | 1 task | 2 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Init]: 12-phase structure aligned with ARCHITECTURE.md Section 14
- [Init]: Wave-based parallel execution (4 waves + 2 sequential phases)
- [Init]: Comprehensive depth -- all 12 architecture phases preserved as roadmap phases
- [00-01]: bun.lock (v1.3+ default) instead of bun.lockb binary format
- [00-01]: build.ts pre-filters to existing entry points for clean scaffolding output
- [00-01]: vitest/globals in tsconfig types for test file compilation
- [00-02]: Test script uses vitest run (not bun test) for vi.spyOn mock support
- [00-02]: deepMerge is simple 10-line recursive function, no lodash dependency
- [00-02]: Two process.platform checks used: atomicWriteFile EPERM + scope-detector case-insensitive
- [Phase 01]: ATTACH/DETACH outside transaction boundary: SQLite forbids ATTACH inside explicit transactions
- [Phase 01]: WARM->COLD conversion during copy step, not post-copy, due to v3 CHECK constraints
- [Phase 01]: Non-JSON files_modified converted to [] during copy, fixed from v2 source in step 7
- [01-03]: INSERT OR IGNORE for decision dedup via UNIQUE(session_id, fingerprint) constraint
- [01-03]: ON CONFLICT DO UPDATE for learning promotion (increment promotion_count on duplicate)
- [01-03]: HOT/COLD threshold at 0.5 for pressure scores, COLD demotion at 0.1 during decay
- [01-03]: INSERT OR REPLACE for thread_state upserts (single-row-per-session pattern)
- [01-02]: BM25 temporal re-ranking: finalScore = bm25Rank * exp(-ageDays/30), ascending sort
- [01-02]: Telemetry emitTelemetry is fully non-throwing via try/catch (never crashes caller)
- [01-02]: Prune strategy: two-pass deletion (age-based for non-error, count-based for error events)
- [02-01]: Base64 redaction excludes pure hex strings (hex hashes are not secrets)
- [02-01]: PII patterns use negative lookbehind/lookahead to avoid matching inside UUIDs
- [02-01]: Credit card pattern uses boundary assertions to prevent UUID false positives
- [02-02]: ExtractionResult interface in separate types.ts for shared import across extractors
- [02-02]: ExtractorFn type alias enables Record<string, ExtractorFn> dispatch map
- [02-02]: Dedup uses SQL LIKE on files_modified JSON (simple, sufficient for MVP)
- [02-02]: All extractors handle both snake_case and camelCase input keys (file_path/filePath)
- [03-01]: normalizeForDedup separate from text-utils normalize (strips punctuation, dedup-specific)
- [03-01]: Inline Porter stemmer (~50 lines), no external dependency
- [03-01]: Jaccard threshold >= 0.5 per Architecture 6.3
- [03-02]: Tier 3 rejection regex uses lookahead (?=\s|$) instead of trailing \b for punctuation patterns
- [03-02]: Thread tracker collapses tool entries; only user/agent roles in key_exchanges
- [03-02]: Topic set once per session, not overwritten
- [04-01]: EmbeddingProvider caches availability to avoid repeated health checks
- [04-01]: Model name matching allows prefix (nomic-embed-text:latest matches nomic-embed-text)
- [04-01]: Template init all-or-nothing: any embed fail returns null
- [04-02]: Topic-shift Layer 1 always first (cheapest, highest precision)
- [04-02]: Sliding window avgRecent uses 0 when empty (conservative)
- [04-02]: Decision capture fail-open on embed failure (candidate kept)
- [04-02]: Enrichment safety-net: LLM can never silently drop heuristic data
- [04-02]: detectEnrichmentProvider auto: Ollama first, then OpenClaw native
- [06-01]: ULID via ulid package (26-char Crockford base32, monotonic, collision-free)
- [06-01]: extractOpenItems captures text after TODO/FIXME/HACK/still need/need to patterns
- [06-01]: Writer reads decisions (LIMIT 15), thread_state, hot files, learnings in single flow
- [06-01]: Enrichment failure is non-fatal (heuristic checkpoint preserved)
- [06-02]: recoverFromDb: committed rows re-mirrored, pending rows deleted
- [06-02]: followHopChain: Set<string> for cycle detection, max 3 hops
- [06-02]: applyPreset: ALWAYS = meta+working+topic, RESUME = all except gsd, GSD = full
- [07-01]: Token gauge reads tail ~8KB of transcript JSONL for efficient CC path
- [07-01]: Window detector returns 1M only for claude-opus-4/sonnet-4 with >195k observed tokens
- [07-01]: EI formula: baseWeight * accessFactor * decayFactor * connectivityBonus (4 factors)
- [07-01]: Pruning immune: importance >= 5, or access_count >= 3 within 180 days
- [07-01]: Pressure decay: stratified HOT 7d, COLD 3d half-lives, reclassify at 0.851
- [07-02]: parseStateMd handles both "Phase: N of M" and "Phase: N" formats
- [07-02]: getPhaseFiles extracts files_modified from YAML frontmatter for pressure boost
- [05-01]: Token estimator re-exports from shared/text-utils.ts (no code duplication)
- [05-01]: formatHotFilesSection filters by 0.851 threshold inside the formatter
- [05-01]: formatTopicPivotSection caps learnings at 3 items
- [05-02]: Three-tier degradation: full assembly -> checkpoint-only (loadFromFile) -> identity-only -> empty
- [05-02]: Post-redaction reclaim re-attempts at most one skipped section
- [05-02]: Reference mode activates when remaining budget < 500 after priority 5
- [05-02]: assembleRegularPrompt priority: post-compaction > topic-shift > gauge > zero

### Pending Todos

None yet.

### Blockers/Concerns

None yet.

## Session Continuity

Last session: 2026-03-12
Stopped at: Completed 05-02-PLAN.md (Phase 05 complete)
Resume file: .planning/phases/05-assembly-pipeline/05-02-SUMMARY.md

## Claudex Metrics
<!-- AUTO-GENERATED by Claudex. Do not edit manually. -->
| Metric | Value |
|--------|-------|
| Observations | 438 |
| Top Files | `<project>/.planning/STATE.md` (HOT 1.00), `<project>/ARCHITECTURE.md` (HOT 1.00), `C:\Users\[USER]\.claude\teams\auto-gsd-pipeline\inboxes\team-lead.json` (HOT 0.90), `<project>/context/sessions/2026-03-10_session-2.md` (HOT 0.86), `<project>/.planning/ROADMAP.md` (HOT 0.72) |
| Coverage | 100% (107/107 files tracked) |
| Updated | 2026-03-12T10:51:42.650Z |
