# Requirements: Claudex v3

**Defined:** 2026-03-10
**Core Value:** LLMs retain operational context across sessions and compaction events without manual effort

## v1 Requirements

### Storage

- [ ] **STOR-01**: System creates fresh SQLite database with full v3 schema on `claudex setup`
- [ ] **STOR-02**: Database uses WAL mode with NORMAL sync, 10k cache, foreign keys ON
- [ ] **STOR-03**: Multi-step writes wrapped in explicit transactions (all-or-nothing)
- [ ] **STOR-04**: FTS5 virtual table with porter stemmer for observation search
- [ ] **STOR-05**: All tables from Section 4.2 schema exist with correct constraints and indexes
- [ ] **STOR-06**: checkpoint_meta table tracks per-checkpoint lifecycle (pending/committed/mirrored)
- [ ] **STOR-07**: Telemetry table stores structured event data with JSON detail payloads
- [ ] **STOR-08**: Optional v2 migration path (user-prompted, backup first, archive unused tables)

### Extraction

- [ ] **EXTR-01**: Per-tool extractors for 10 tool types (Read, Edit, Write, Bash, Grep, Glob, WebFetch, WebSearch, Task, NotebookEdit)
- [ ] **EXTR-02**: Importance scoring (1-5) based on tool type, content length, and category
- [ ] **EXTR-03**: Three-layer redaction engine (secrets, paths, PII)
- [ ] **EXTR-04**: Quality gates filter low-signal observations (min length, non-zero results)
- [ ] **EXTR-05**: files_modified stored as JSON array with json_valid CHECK

### Intelligence

- [ ] **INTL-01**: Model-agnostic decision capture — Stage 1 regex patterns work across model families
- [ ] **INTL-02**: Decision capture Stage 2 — embedding classification via nomic-embed-text with 0.15 confidence threshold
- [ ] **INTL-03**: Decision capture triggers primarily on after_turn, supplemental on after_tool (Tier 1/4 only)
- [ ] **INTL-04**: Filler rejection drops non-decision candidates (reading/checking/navigation actions)
- [ ] **INTL-05**: Thread tracking maintains topic, summary, and rolling 8-exchange key_exchanges
- [ ] **INTL-06**: Thread gist extraction per rules (full text <120 chars, sentence truncation, tool-name lists)
- [ ] **INTL-07**: Semantic dedup 3-tier (normalized exact, Jaccard with stemming, substring containment)
- [ ] **INTL-08**: LLM enrichment refines heuristic checkpoint data with safety-net merge
- [ ] **INTL-09**: Cross-session learnings with promotion counting, max 50 per project, top 10 surfaced
- [ ] **INTL-10**: Enrichment auto-detects provider (Ollama on CC, native API preferred on OpenClaw)
- [ ] **INTL-11**: All embedding/enrichment gracefully falls back when Ollama unavailable

### Embeddings

- [ ] **EMBD-01**: Ollama nomic-embed-text client with graceful fallback
- [ ] **EMBD-02**: Cosine similarity computation with sliding window (last 3 prompts)
- [ ] **EMBD-03**: Precomputed decision/non-decision template embeddings for classification
- [ ] **EMBD-04**: Topic-shift detection: embedding similarity < 0.35 AND avgRecent < 0.40

### Assembly

- [ ] **ASMB-01**: Boundary-only injection — full assembly at session-start and post-compaction only
- [ ] **ASMB-02**: Topic-shift micro-injection (max 800 tokens pivot block)
- [ ] **ASMB-03**: Priority-budgeted sections (identity -> checkpoint -> learnings -> decisions -> pressure -> GSD -> FTS5 -> recent)
- [ ] **ASMB-04**: Token gauge injection at >= 70% utilization
- [ ] **ASMB-05**: Post-redaction budget reclaim
- [ ] **ASMB-06**: Most turns produce zero injection (gauge-only or empty)

### Checkpoint

- [ ] **CHKP-01**: ULID-based checkpoint IDs (monotonic, collision-free)
- [ ] **CHKP-02**: DB-first write flow: INSERT pending -> build YAML -> UPDATE committed -> enrich -> write file -> UPDATE mirrored
- [ ] **CHKP-03**: Checkpoint schema v3 with 9 sections (meta, working, decisions, files, thread, open_items, learnings, gsd)
- [ ] **CHKP-04**: Write triggers at utilization thresholds, compaction, and session-end
- [ ] **CHKP-05**: 60-second debounce between non-compaction writes
- [ ] **CHKP-06**: 3-hop recovery chain: DB recovery first, file fallback (latest.yaml -> dir scan -> hop chain)
- [ ] **CHKP-07**: Selective loading presets (ALWAYS, RESUME, GSD)
- [ ] **CHKP-08**: Atomic file writes (tmp + rename, Windows EPERM fallback)

### Supporting

- [ ] **SUPP-01**: Token gauge from transcript JSONL (CC) or SDK ctx.getContextUsage (OpenClaw)
- [ ] **SUPP-02**: Auto-detect 200k vs 1M context window
- [ ] **SUPP-03**: Decay engine with EI formula (importance * recency * access * co-occurrence)
- [ ] **SUPP-04**: Pressure score half-life decay
- [ ] **SUPP-05**: Pruning: soft-delete when over threshold, keep highest EI
- [ ] **SUPP-06**: GSD state reader (.planning/ filesystem, phase boost +0.10)

### Adapters

- [ ] **ADPT-01**: CC hook adapter maps 6 hooks to RuntimeEvent (SessionStart, UserPromptSubmit, PostToolUse, Stop, PreCompact, SessionEnd)
- [ ] **ADPT-02**: CC adapter declares CC_CAPABILITIES correctly (all fields from Section 3.1)
- [ ] **ADPT-03**: CC ephemeral process lifecycle: stdin JSON -> SQLite -> stdout JSON -> exit
- [ ] **ADPT-04**: OpenClaw bridge adapter registers via globalThis Symbol
- [ ] **ADPT-05**: OpenClaw adapter declares OPENCLAW_CAPABILITIES correctly
- [ ] **ADPT-06**: OpenClaw plugin activate() function works as standard plugin install
- [ ] **ADPT-07**: `claudex setup` CLI creates DB, patches ~/.claude/settings.json, offers optional v2 migration
- [ ] **ADPT-08**: Adapter auto-detection from environment (bridge exists -> OpenClaw, else -> CC)

### Observability

- [ ] **OBSV-01**: Every subsystem emits telemetry via this.telemetry.emit(kind, detail, latency)
- [ ] **OBSV-02**: 10 event kinds with typed JSON detail schemas
- [ ] **OBSV-03**: Telemetry queryable via standard SQL (session latency, decision precision, checkpoint lifecycle)
- [ ] **OBSV-04**: Retention: 7 days + last 1000 errors, pruned at sessionEnd and sessionInit

### Performance

- [ ] **PERF-01**: UserPromptSubmit < 100ms on non-injection turns, < 500ms on injection turns
- [ ] **PERF-02**: PostToolUse < 100ms per tool call
- [ ] **PERF-03**: Stop hook < 150ms
- [ ] **PERF-04**: Aggregate per-turn overhead < 600ms common case

### Quality

- [ ] **QUAL-01**: Defensive non-throwing — every public function catches errors, returns safe defaults
- [ ] **QUAL-02**: Three-tier degradation (full -> checkpoint-only -> identity-only)
- [ ] **QUAL-03**: Flat-file mirroring for all critical state
- [ ] **QUAL-04**: Scope-aware isolation (all queries filter by project)
- [ ] **QUAL-05**: One codebase, all platforms (2-3 process.platform checks)
- [ ] **QUAL-06**: Full vitest test suite covering all modules

## v2 Requirements

### Multi-Model Teams
- **TEAM-01**: OpenClaw routing different models to different agent roles
- **TEAM-02**: Opus + Sonnet + MiniMax + GLM sharing one Claudex context brain
- **TEAM-03**: Agent-scoped learnings (per agent_id in learnings table)

### Advanced Analytics
- **ANLZ-01**: Telemetry dashboard (web UI for querying telemetry)
- **ANLZ-02**: Decision quality metrics (precision/recall tracking)
- **ANLZ-03**: Observation value analysis (access patterns, surfacing rates)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Real-time inter-adapter sync | Mutual exclusion — one adapter at a time |
| Writing to CC's MEMORY.md | Model manages its own auto-memory |
| GUI / web dashboard | CLI-only tool, telemetry queryable via SQL |
| Multi-user support | Single-user personal tool |
| Cloud storage | SQLite local only |
| OpenClaw CM data import | CM has no historical data worth migrating |
| Event ordering / idempotency | Sequential single-process — events cannot arrive out of order |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| STOR-01 | Phase 1 | Pending |
| STOR-02 | Phase 1 | Pending |
| STOR-03 | Phase 1 | Pending |
| STOR-04 | Phase 1 | Pending |
| STOR-05 | Phase 1 | Pending |
| STOR-06 | Phase 1 | Pending |
| STOR-07 | Phase 1 | Pending |
| STOR-08 | Phase 1 | Pending |
| EXTR-01 | Phase 2 | Pending |
| EXTR-02 | Phase 2 | Pending |
| EXTR-03 | Phase 2 | Pending |
| EXTR-04 | Phase 2 | Pending |
| EXTR-05 | Phase 2 | Pending |
| INTL-01 | Phase 3 | Pending |
| INTL-02 | Phase 4 | Pending |
| INTL-03 | Phase 3 | Pending |
| INTL-04 | Phase 3 | Pending |
| INTL-05 | Phase 3 | Pending |
| INTL-06 | Phase 3 | Pending |
| INTL-07 | Phase 3 | Pending |
| INTL-08 | Phase 4 | Pending |
| INTL-09 | Phase 3 | Pending |
| INTL-10 | Phase 4 | Pending |
| INTL-11 | Phase 4 | Pending |
| EMBD-01 | Phase 4 | Pending |
| EMBD-02 | Phase 4 | Pending |
| EMBD-03 | Phase 4 | Pending |
| EMBD-04 | Phase 4 | Pending |
| ASMB-01 | Phase 5 | Pending |
| ASMB-02 | Phase 5 | Pending |
| ASMB-03 | Phase 5 | Pending |
| ASMB-04 | Phase 5 | Pending |
| ASMB-05 | Phase 5 | Pending |
| ASMB-06 | Phase 5 | Pending |
| CHKP-01 | Phase 6 | Pending |
| CHKP-02 | Phase 6 | Pending |
| CHKP-03 | Phase 6 | Pending |
| CHKP-04 | Phase 6 | Pending |
| CHKP-05 | Phase 6 | Pending |
| CHKP-06 | Phase 6 | Pending |
| CHKP-07 | Phase 6 | Pending |
| CHKP-08 | Phase 6 | Pending |
| SUPP-01 | Phase 7 | Pending |
| SUPP-02 | Phase 7 | Pending |
| SUPP-03 | Phase 7 | Pending |
| SUPP-04 | Phase 7 | Pending |
| SUPP-05 | Phase 7 | Pending |
| SUPP-06 | Phase 7 | Pending |
| ADPT-01 | Phase 8 | Pending |
| ADPT-02 | Phase 8 | Pending |
| ADPT-03 | Phase 8 | Pending |
| ADPT-04 | Phase 9 | Pending |
| ADPT-05 | Phase 9 | Pending |
| ADPT-06 | Phase 9 | Pending |
| ADPT-07 | Phase 8 | Pending |
| ADPT-08 | Phase 8 | Pending |
| OBSV-01 | Phase 1 | Pending |
| OBSV-02 | Phase 1 | Pending |
| OBSV-03 | Phase 10 | Pending |
| OBSV-04 | Phase 1 | Pending |
| PERF-01 | Phase 10 | Pending |
| PERF-02 | Phase 10 | Pending |
| PERF-03 | Phase 10 | Pending |
| PERF-04 | Phase 10 | Pending |
| QUAL-01 | Phase 0 | Pending |
| QUAL-02 | Phase 5 | Pending |
| QUAL-03 | Phase 6 | Pending |
| QUAL-04 | Phase 1 | Pending |
| QUAL-05 | Phase 0 | Pending |
| QUAL-06 | Phase 10 | Pending |

**Coverage:**
- v1 requirements: 70 total
- Mapped to phases: 70
- Unmapped: 0

---
*Requirements defined: 2026-03-10*
*Last updated: 2026-03-10 after roadmap creation*
