# Cross-Phase Intelligence

**Updated:** 2026-03-13T00:59:22.615Z

## Recurring File Patterns

### `package.json`
- **00-repository-setup**: created (Phase 0 Plan 1: Project Scaffold Summary)
- **00-repository-setup**: modified (Phase 0 Plan 2: Shared Utilities Summary)

## Decision History

### Claudex v2 Internal
- (2026-03-09) One core, two swappable runtime adapters (CC hooks + OpenClaw bridge)
- (2026-03-09) Capability-aware event model: host-neutral RuntimeEvent + RuntimeCapabilities declaration (v1.1, accepted Codex's feedback over initial pushback)
- (2026-03-09) Enrichment disabled on CC hooks via capability check (deadlock risk: hook calling CLIProxyAPI while CC waits)
- (2026-03-09) Topic-shift micro-injection (keyword Jaccard ＜ 0.15, max 800 token pivot blocks) to address boundary-only gaps
- (2026-03-09) Archive tables (ALTER TABLE RENAME) instead of DROP for migration safety, with 30-day retention
- (2026-03-09) One codebase for all platforms — 2-3 process.platform checks, not separate repos
- (2026-03-09) NULL uniqueness fix: COALESCE sentinel '__global__' instead of nullable project column
- (2026-03-09) files_modified stored as JSON array with json_valid() CHECK, not comma-separated text
- (2026-03-09) Stop hook restored in v1.1 (needed for afterTurn event on CC where message_end doesn't exist)
- (2026-03-10) v3 is standalone-first: fresh install is primary, v2 migration is optional user-prompted path
- (2026-03-10) Disagree with Codex on event ordering/idempotency (sequential single-process, not distributed)
- (2026-03-10) Disagree with Codex on OpenClaw CM import path (CM has no data worth migrating)
- (2026-03-10) Disagree with Codex on Section 3.4 adapter exclusivity (Codex hallucinated — no Section 3.4 exists)
- (2026-03-10) after_turn is canonical decision capture point, after_tool only for high-confidence Tier 1/4
- (2026-03-10) Aggregate latency SLA: 600ms common, 1000ms injection, 3000ms compaction
- (2026-03-10) Primer will be created from ARCHITECTURE.md (not a separate quick-start in the arch doc)
- (2026-03-10) GSD research=false — the 2330-line architecture IS the research; domain research would add noise
- (2026-03-10) GSD auto_advance=true — enables /auto-orchestrate to run all phases without manual gate approvals
- (2026-03-11) Plain functions with `db: Database` param (no singletons, no class repos)
- (2026-03-11) FTS5 temporal re-ranking: `bm25Rank * exp(-ageDays/30)` (30-day half-life)
- (2026-03-11) Adapter-owned connection lifecycle (storage module has no opinion)
- (2026-03-11) v2 migration SQL in Phase 1, interactive CLI deferred to Phase 8
- (2026-03-11) Observation titles: `{toolName}: {key_detail}` format, max 120 chars
- (2026-03-11) Category classification: keyword map, first match wins, 10 groups -＞ 11 categories
- (2026-03-11) Redaction: safety-first (over-redact ＞ under-redact), base64 ＞ 32 chars redacted
- (2026-03-11) Content truncation: 2000 chars per observation via truncateText()
- (2026-03-11) MCP inbox workaround: clear stale inbox JSON before each teammate transition
- (2026-03-12) Codex findings re-triaged with project context: 4 findings rejected (tool output injection is the feature, adapter duplication is intentional, mutable bctx is fine for single-threaded, timeout on localhost is not realistic)
- (2026-03-12) Open-source production lens applied: scope-detector, config validation, baseUrl restriction all treated as real issues
- (2026-03-12) /team chosen over /auto-orchestrate for bug fixes: pre-specified work doesn't need discovery phases
- (2026-03-12) 6 workers parallel (1 per module group) — single wave, no dependencies

