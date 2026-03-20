# Claudex v3 — Project Primer

## What Is This

Claudex v3 is a unified context management system that gives LLMs persistent memory across sessions and compaction events. It replaces two predecessors (Claudex v2 + OpenClaw's Context Manager) with a single codebase that runs on both Claude Code (as lifecycle hooks) and OpenClaw (as a bridge plugin). One core, two swappable runtime adapters, standalone install.

**Status**: All phases + 6 brain upgrades implemented + wiring audit fixes. Session 19: deep wiring audit verified all hooks fire within budget, trigger→FTS5→materialize→inject chain works, retrieval feedback scores. Fixed: session events expanded (Read/Grep/Glob/Bash/decisions/topics — was 90% invisible), correction detection widened (6 new patterns — was 0 patterns ever). MCP recall server configured at project level. 1613 tests, 86 test files. CLI: `claudex health`, `claudex projects-touched`, `claudex recall`.

## Core Architecture (30-second version)

```
Host (CC or OpenClaw)
  → Runtime Adapter (translates host events to RuntimeEvent)
  → Claudex Core
    → Storage (SQLite + WAL + FTS5)
    → Extraction (per-tool observation capture → artifact creation)
    → Intelligence (decisions, threads, dedup, enrichment, learnings)
    → Assembly (three-layer: structural + reference + materialization)
    → Artifacts (TTL lifecycle: fresh → packed → materialized)
    → Session Journal (flow entries, milestones, summaries)
    → Checkpoint (ULID + DB-first state machine)
    → Observability (structured telemetry + injection metrics)
```

## Assembly Model (Session 8)

Three-layer model replaces the old budget-cascade:

| Layer | Purpose | Always? |
|-------|---------|---------|
| Structural | Identity, project, checkpoint, session flow | Yes |
| Reference | Packed artifact summaries (metadata only) | When ≥5 artifacts |
| Materialization | FTS5-selected full content with provenance | Query-driven |
| Legacy fallback | Old cascade (learnings, hot files, GSD, FTS5) | When <5 artifacts |

Key: flow entries include "why" as retrieval hints. TTL-based lifecycle (fresh→packed→materialized). Compaction = packing (lossless).
Informed by IAM project artifact patterns (Teneral Agent Platform).

## 12 Design Principles

1. **Standalone-first** — `claudex setup` on clean machine, zero predecessor needed
2. **One system, two targets** — same core, different adapters for CC hooks vs OpenClaw bridge
3. **Capability-aware adapters** — adapters declare `RuntimeCapabilities`, core checks before using host features
4. **Boundary-only injection** — full assembly at session-start and post-compaction only; most turns get zero injection
5. **SQLite is the state bus** — hooks share state through DB, not files
6. **Mutual exclusion** — CC adapter OR OpenClaw adapter, never both simultaneously
7. **Enrichment everywhere** — CC via local Ollama (no deadlock), OpenClaw via native API
8. **Observability by design** — telemetry table, queryable audit trail
9. **Model-agnostic intelligence** — works across Claude, MiniMax, GLM, DeepSeek
10. **Defensive non-throwing** — every public function catches errors, returns safe defaults
11. **Flat-file mirroring** — human never locked out, every critical state has a readable file
12. **One codebase, all platforms** — 2-3 `process.platform` checks, not separate repos

## Key Decisions

| Decision | Why | Section |
|----------|-----|---------|
| Capability-aware adapters over optional fields | Prevents host-specific leaks in shared interfaces | 3.1 |
| Boundary-only injection | Both predecessors independently converged on this; per-turn injection is 90%+ waste | 7.1 |
| Ollama for CC enrichment | Calling CC's own API from inside a hook = deadlock; Ollama is a separate process | 6.4 |
| ULID checkpoint IDs | Directory-scan sequential counter races under concurrent writers | 8.3 |
| DB-first checkpoint state machine | pending→committed→mirrored guarantees recovery even if file write fails | 8.3 |
| Embedding cosine for topic-shift | Keyword Jaccard misses semantic similarity ("auth bug" ≠ "OAuth token refresh" = 0.0 overlap) | 7.3.1 |
| Two-stage decision capture | Regex (fast, free) generates candidates; embedding (5ms) filters false positives | 6.1 |
| Standalone-first, v2 migration optional | v3 should work as fresh install; not everyone has v2 history | 4.3 |
| `after_turn` as primary decision capture | Full turn text available = best signal; `after_tool` only for high-confidence Tier 1/4 | 6.1 |
| COALESCE sentinel `'__global__'` | NULL doesn't participate in SQLite UNIQUE constraints | 4.2 |
| `files_modified` as JSON array | Comma-separated text breaks on paths containing commas | 4.2 |

## Patterns and Conventions

- **Three-tier degradation**: Full assembly (DB + FTS5 + checkpoint) → checkpoint-only (YAML files) → identity-only (USER.md flat file)
- **Safety-net merge**: LLM enrichment can improve but never silently drop heuristic data (lowercase set-diff preserves uncovered entries)
- **Atomic writes**: tmp-file + rename pattern. Windows: copy+chmod+unlink fallback for EPERM
- **Scope-aware isolation**: All queries filter by project. Case-insensitive path comparison on Windows
- **Transaction policy**: Multi-step writes in explicit transactions (observation + pressure + thread in one tx)
- **Telemetry emission**: `this.telemetry.emit(kind, detail, latency)` — one line per call site, non-throwing

## Latency Budget

| Hook | Target | What it does |
|------|--------|-------------|
| `UserPromptSubmit` | <100ms (most), <500ms (injection) | Topic-shift check + gauge, or full assembly |
| `PostToolUse` | <100ms per call | Observation extraction + pressure + thread |
| `Stop` | <150ms | Decision capture + thread snapshot |
| **Aggregate per turn** | **<600ms common, <1000ms injection, <3000ms compaction** | |

## Gotchas

- **CC hook deadlock**: Never call CC's CLIProxyAPI (127.0.0.1:8317) from inside a hook. Use Ollama instead.
- **"Can you" is not a topic shift**: Normal request phrasing, not a pivot signal. Explicit regex uses "now let's", "switch to", "back to", etc.
- **NULL in UNIQUE constraints**: SQLite NULL ≠ NULL in UNIQUE. Always use `'__global__'` sentinel for non-project-scoped rows.
- **Ollama may not be running**: All embedding/enrichment code must have graceful fallback (Jaccard for detection, heuristic-only for enrichment).
- **84% of auto-captured observations are never accessed**: Quality gates matter more than capture volume.
- **Checkpoint recovery is two-layer**: DB-first (re-mirror committed rows at sessionInit), file fallback (latest.yaml → dir scan → hop chain).
- **better-sqlite3 on OpenClaw's jiti loader**: Pre-compile to `.cjs` with `createRequire()`. Proven pattern from mem0 plugin.
- **Fix regressions are common**: Bulk fix rounds (83 fixes, session 6) produced 5/7 new criticals as regressions. Always write fix-specific test cases BEFORE applying fixes (TDD for fixes). The cycle "fix → build → existing tests pass" is insufficient — existing tests don't cover the fix's own edge cases.
- **POSIX quoting doesn't work on Windows**: Shell command construction must use platform-aware quoting. POSIX `'\''` escaping is invalid in PowerShell/cmd.exe — characters like `&`/`|` are interpreted.
- **SQLite error messages vary**: `err.message.includes('already exists')` is brittle — SQLite uses different wording for rename conflicts (`there is already another table or index with this name`) and shadow table errors (`table may not be altered`). Centralize error classification.
- **Multi-project sessions**: Hooks route observations dynamically via `content-router.ts` (file paths, project name mentions). `/endsession` calls `claudex projects-touched` CLI to create per-project session logs and handoffs. Worker context enrichment (`worker-context.ts`) now includes user feedback memories and CLAUDE.md rules.

## File Structure (Key Modules)

```
src/
  core/           # Storage, CRUD, FTS5, telemetry, file-ingester, session-events
  extraction/     # Per-tool observation extractors + redaction + quality gates
  intelligence/   # Decisions, threads, dedup, enrichment, learnings, topic-shift,
                  # trigger-engine, retrieval-feedback
  embeddings/     # Ollama nomic-embed-text client, cosine similarity, templates
  observability/  # Structured telemetry emit/query/prune
  assembly/       # Priority-budgeted context assembly + worker context enrichment
  checkpoint/     # ULID writer (DB-first), 3-hop loader, inject renderer
  gauge/          # Token utilization (transcript-derived or SDK-derived)
  decay/          # EI formula, pressure half-life, pruning
  gsd/            # GSD integration (read-only)
  mcp/            # MCP recall server (4 tools: search, recall, store, events)
  shared/         # Types, paths, config, fs-helpers, constants
adapters/
  cc-hooks/       # 6 hook entry points + infrastructure + setup CLI
  openclaw-bridge/# globalThis registration + plugin activate()
```

## Implementation Plan (12 phases)

0. Repository setup (package.json, tsconfig, shared utilities)
1. Storage layer (SQLite, CRUD, FTS5, telemetry, fresh install + optional v2 migration)
2. Extraction pipeline (per-tool extractors, redaction, quality gates)
3. Intelligence — core (decisions, dedup, threads, learnings)
4. Intelligence — v1.2 (embeddings, topic-shift, enrichment via Ollama)
5. Assembly pipeline (priority-budgeted, boundary-only logic)
6. Checkpoint system (ULID, DB-first state machine, 3-hop recovery)
7. Supporting subsystems (gauge, decay, GSD)
8. CC hook adapter (6 hooks + setup CLI)
9. OpenClaw bridge adapter (plugin)
10. Integration testing (11 scenarios including fresh install, enrichment, topic-shift)
11. Deployment (fresh install both adapters, optional v2 migration, 1-week monitor)

## Reference Documents

<!-- READ WHEN markers for /starthere selective sub-doc loading -->

- `ARCHITECTURE.md` — READ WHEN: implementing any module, reviewing design, checking schema DDL, understanding any subsystem in depth. The authoritative 2330-line spec.
- `CODEX_REVIEW.md` — READ WHEN: reviewing v1.0 feedback history. Grade B-, all findings addressed in v1.1.
- `CODEX_REVIEW_V12.md` — READ WHEN: reviewing v1.2 feedback. Grade B+, accepted findings addressed in v1.2.1, disagreed findings documented in session log.
- `../claudex-analysis.md` — READ WHEN: understanding Claudex v2 internals for reference during implementation.
- `../openclaw-analysis.md` — READ WHEN: understanding OpenClaw CM internals for reference during implementation.
- `.planning/ROADMAP.md` — READ WHEN: checking phase structure, requirement mapping, execution order. 12 phases, 70 requirements.
- `.planning/REQUIREMENTS.md` — READ WHEN: verifying requirement coverage, checking REQ-IDs, traceability.

## Architecture Section Quick Reference

| Topic | Section | Lines |
|-------|---------|-------|
| Capability model + event types | 3.1 | 108-264 |
| CC hook adapter | 3.2 | 265-359 |
| OpenClaw bridge adapter | 3.3 | 360-474 |
| Full schema DDL | 4.2 | 520-709 |
| Fresh install + v2 migration | 4.3 | 710-789 |
| Observation extraction | 5 | 836-918 |
| Decision capture (2-stage) | 6.1 | 921-988 |
| Thread tracking | 6.2 | 1011-1064 |
| Enrichment (Ollama + native) | 6.4 | 1106-1202 |
| Assembly pipeline | 7 | 1227-1432 |
| Topic-shift detection | 7.3.1 | 1342-1418 |
| Checkpoint system | 8 | 1433-1583 |
| Observability / telemetry | 10c | 1715-1840 |
| Config schema | 11.1 | 1843-1911 |
| File structure | 12 | 1929-2055 |
| Implementation plan | 14 | 2079-2175 |
| Success criteria | 17 | 2187-2207 |
| Comparison table | App A | 2209-2245 |
| Source references | App B | 2249-2278 |
