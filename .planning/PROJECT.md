# Claudex v3

## What This Is

A unified context management system that gives LLMs persistent memory across sessions and compaction events. It runs as lifecycle hooks on Claude Code and as a bridge plugin on OpenClaw — one codebase, two deployment targets. Replaces both Claudex v2 and OpenClaw's Context Manager with a standalone system that works as a fresh install.

## Core Value

LLMs retain operational context (decisions, learnings, file awareness, conversation thread) across sessions and compaction events without manual effort — on both Claude Code and OpenClaw.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Standalone fresh install (`claudex setup` creates everything from scratch)
- [ ] SQLite storage with WAL mode, FTS5 search, explicit transactions
- [ ] Per-tool observation extraction (10 tool types) with quality gates and redaction
- [ ] Model-agnostic decision capture (2-stage: regex + embedding classification)
- [ ] Thread tracking with gist extraction and rolling conversation state
- [ ] Semantic deduplication (3-tier: normalize, Jaccard, substring)
- [ ] LLM enrichment on both adapters (CC via Ollama, OpenClaw via native API)
- [ ] Cross-session learnings with promotion counting
- [ ] Priority-budgeted context assembly (boundary-only injection)
- [ ] Embedding-enhanced topic-shift detection with Jaccard fallback
- [ ] ULID checkpoint IDs with DB-first state machine (pending/committed/mirrored)
- [ ] 3-hop checkpoint recovery chain (DB-first, file fallback)
- [ ] Token utilization gauge (transcript-derived or SDK-derived)
- [ ] Memory decay engine (EI formula + co-occurrence + pruning)
- [ ] GSD integration (read-only .planning/ state)
- [ ] Structured observability (telemetry SQLite table, queryable audit trail)
- [ ] CC hook adapter (6 hooks: SessionStart, UserPromptSubmit, PostToolUse, Stop, PreCompact, SessionEnd)
- [ ] OpenClaw bridge adapter (globalThis registration + plugin activate)
- [ ] Capability-aware adapter pattern (RuntimeCapabilities + RuntimeEvent)
- [ ] CC auto-memory policy (read, never write, feature flags for degradation)
- [ ] Optional v2 migration path (user-prompted, with backup)
- [ ] End-to-end latency SLA (<600ms common, <1000ms injection, <3000ms compaction)
- [ ] Full test suite (unit + integration)

### Out of Scope

- Real-time inter-adapter sync — mutual exclusion, one adapter at a time
- Writing to CC's MEMORY.md — model manages its own auto-memory
- GUI or web dashboard — CLI-only, telemetry queryable via SQL
- Multi-user support — single-user tool
- Cloud storage — SQLite local only

## Context

- **Predecessors**: Claudex v2 (CC hooks, SQLite + FTS5, observation extraction) and OpenClaw Context Manager (bridge plugin, decision heuristics, LLM enrichment, learnings)
- **Architecture**: ARCHITECTURE.md v1.2.1 (2330 lines) — complete specification reviewed by Codex GPT-5 (B+), self-graded A
- **Reviews**: CODEX_REVIEW.md (v1.0, B-), CODEX_REVIEW_V12.md (v1.2, B+)
- **Primer**: PROJECT_PRIMER.md — 149-line distillation for quick orientation
- **Predecessor analyses**: ../claudex-analysis.md (639 lines), ../openclaw-analysis.md (616 lines)
- **Key pattern**: Both predecessors independently converged on boundary-only injection — strong signal this is correct
- **Key stat**: 84% of auto-captured observations in v2 were never accessed — quality gates matter

## Constraints

- **Runtime**: TypeScript 5.8+ strict, Bun 1.3+ / Node.js
- **Platform**: Windows 11 Pro primary, must also work on Linux (one codebase)
- **Storage**: better-sqlite3 ^11.7.0 (native binding, external in esbuild)
- **Embeddings**: Ollama + nomic-embed-text (optional, graceful fallback)
- **Enrichment**: Local Ollama on CC (no CLIProxyAPI deadlock), native API or Ollama on OpenClaw
- **Latency**: Hook overhead must stay under 600ms/turn common case
- **Build**: esbuild → dist/*.mjs (6 hook bundles + setup.mjs + openclaw-plugin.mjs)
- **Dependencies**: Minimal — better-sqlite3, js-yaml, ulid. Dev: vitest, esbuild, tsx, typescript

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Capability-aware adapters over optional fields | Prevents host-specific leaks in shared interfaces | — Pending |
| Boundary-only injection | Both predecessors independently converged; per-turn is 90%+ waste | — Pending |
| Ollama for CC enrichment | CC API self-call from hook = deadlock; Ollama is separate process | — Pending |
| ULID checkpoint IDs | Directory-scan sequential counter races under concurrent writers | — Pending |
| DB-first checkpoint state machine | Guarantees recovery even if file write fails | — Pending |
| Embedding cosine for topic-shift | Keyword Jaccard misses semantic similarity | — Pending |
| Two-stage decision capture | Regex fast+free generates candidates; embedding filters false positives | — Pending |
| Standalone-first, v2 migration optional | Fresh install must work; not everyone has v2 history | — Pending |
| after_turn as primary decision capture | Full turn text = best signal; after_tool only for high-confidence Tier 1/4 | — Pending |
| COALESCE sentinel '__global__' | NULL doesn't participate in SQLite UNIQUE constraints | — Pending |

---
*Last updated: 2026-03-10 after initialization*
