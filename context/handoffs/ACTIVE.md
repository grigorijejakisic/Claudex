---
schema: claudex/handoff
version: 1
id: v3-context-efficiency-and-migration
session_id: manual-2026-03-13-2
scope: project:claudex-v3
status: active
created_at: 2026-03-13T02:30:00Z
updated_at: 2026-03-13T02:30:00Z
---

# Handoff: V3 Context Efficiency + V2 Migration & Termination

**Priority: HIGH**

## Current State
All phases implemented, 26 unified review fixes applied, 994 tests passing, build clean, pushed to GitHub (`4fdaaaa`). V3 hooks active in `~/.claude/settings.json`. V2 hooks manually stripped. Three setup bugs fixed (case-insensitive detection, v2 schema upgrade, active files cap).

**Problem discovered this session:** V3 burns through context far too fast. Root causes identified:
1. V2 + V3 hooks were BOTH firing (fixed — v2 stripped)
2. Checkpoint "Active Files" dumped 50+ stale entries (fixed — capped at 15+20)
3. Full identity + GSD state injected on every post-compaction (not yet optimized)
4. V2 data not properly migrated — v2 and v3 share same DB path with incompatible schemas

## HIGH PRIORITY: V2 Migration & Termination

### Migration
- V2 DB at `~/.claudex/db/claudex.db` (15,593 observations, 138 sessions, 2,005 pressure scores)
- V3 uses the SAME path — currently a hybrid (v2 schema + v3 data accumulating)
- `migrateFromV2()` in `migrations.ts` exists but has a same-DB guard that prevents it from running when source=target
- Need to: backup v2 DB, create fresh v3 DB, migrate data properly, verify integrity
- Schema differences: v2 `started_at_epoch` vs v3 `created_at_epoch`, v2 has extra columns (`id`, `started_at`, `ended_at` on sessions), v2 missing `source` column
- `upgradeV2SchemaInPlace()` handles column rename — may be sufficient, but verify all tables

### V2 Termination
- Delete v2 project directory (`C:/Users/Grigorije/Desktop/Projects/Claudex v2/`) or archive it
- Confirm no references to v2 paths remain in settings.json (already verified clean)
- Remove v2 from `~/.claudex/projects.json` if listed
- v2 dist files at `C:/Users/Grigorije/Desktop/Projects/Claudex v2/Claudex/dist/*.mjs` — no longer needed

## HIGH PRIORITY: Context Efficiency Audit

V3 must not waste a single unnecessary token. Every injection path needs audit:

### Injection Points to Audit
1. **SessionStart hook** — `assembleFullContext()` fires with full budget. Check what's included, trim what's redundant
2. **UserPromptSubmit hook** — `assembleRegularPrompt()`. Post-compaction fires full assembly. Normal turns should inject ZERO unless topic shift or gauge threshold
3. **PreCompact hook** — sets `post_compact_pending=1`. Verify this flag gets cleared properly
4. **PostToolUse hook** — observation capture. Check if it adds system-reminder bloat

### Known Bloat Sources
- **Identity section**: Full USER.md (~40 lines) injected on every post-compaction. Consider: inject only on session-start, skip on post-compaction (Claude already has it in context)
- **GSD State**: Large block with phase details. Already available via `.planning/STATE.md`. May be redundant in injection
- **Checkpoint Active Files**: Now capped (15+20) but still renders stale files from previous sessions. Consider: only include files touched in CURRENT session
- **Read files list**: Accumulates across entire session including agent reads. Grows unbounded in long sessions with many agents

### Token Budget Targets
- Session-start injection: ≤2000 tokens (identity + checkpoint + essentials)
- Post-compaction injection: ≤1500 tokens (checkpoint + gauge, NO identity re-injection)
- Regular turn: 0 tokens (unless topic shift or gauge threshold)
- Topic shift: ≤800 tokens (already configured)

### Metrics to Track
- Tokens injected per message (log in telemetry)
- Context utilization curve across session (how fast do we hit 50%, 75%, 90%)
- Number of compactions per session (fewer = better context efficiency)

## DEFERRED: Production Data Items (after 1 week real usage)
1. V2 migration real test with full data integrity verification
2. Error telemetry review — query for recurring errors, slow hooks
3. Assembly output tuning — section priorities, token budgets, degradation thresholds
4. Topic drift detection tuning — embedding cosine thresholds, Jaccard sensitivity

## Completed This Session
- [x] 26 unified review fixes (6 workers, all verified, 994/994 tests)
- [x] Committed and pushed phases 3-11 + fixes (`426724e`)
- [x] V2 hooks stripped from settings.json (6 entries removed)
- [x] `setup.ts` case-insensitive hook detection fix
- [x] `migrations.ts` upgradeV2SchemaInPlace (started_at_epoch → created_at_epoch)
- [x] `inject.ts` Active Files cap (15 hot + 20 read)
- [x] `claudex setup` runs cleanly
- [x] Data flow audit team results: `context/reasoning/data-flow-audit.md` + 5 worker reports

## Key Files
- `src/cli/setup.ts` — setup entry point, hook patching
- `src/core/migrations.ts` — schema DDL, v2 migration, upgrade-in-place
- `src/assembly/assembler.ts` — injection orchestrator (full, regular, topic pivot)
- `src/assembly/sections.ts` — section formatters
- `src/checkpoint/inject.ts` — checkpoint-to-markdown renderer
- `src/adapters/cc-hooks/user-prompt-submit.ts` — regular prompt hook
- `src/adapters/cc-hooks/session-start.ts` — session start hook
- `~/.claudex/db/claudex.db` — the shared v2/v3 database
- `~/.claude/settings.json` — hook registration (v3 only now)
