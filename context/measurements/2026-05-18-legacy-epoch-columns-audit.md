# Legacy `_epoch` Columns Audit — 2026-05-18

> **STATUS: RESOLVED 2026-05-18.** V43 migration (`migrateV42toV43`) shipped the rename + scale, and the `/team` epoch-rename phase updated all callers across Waves 1-4 + W1.5. This document is preserved as the historical record of the scope and pre-fix state. All `*_epoch` columns listed below have been renamed to `*_epoch_ms` and their values scaled by 1000.

**Purpose (at time of writing):** Map of every `*_epoch` column (legacy V14-pre-V35 shape) still present in the live substrate, with row counts and intended unit. Set the scope for the rename phase that closed the V35 epoch-canonicalization scar.

**Trigger:** A fresh agent in a new session (`2a696bb7`, 2026-05-17 21:46) ran the recall test (*"why did the last 2 productions stop?"*) and was tripped by `session_journal.timestamp_epoch` — dividing it by 1000 thinking it was milliseconds, getting "1970-01-21" results. The data wasn't corrupt; the agent misread the column's unit. The substrate has two coexisting conventions (`_epoch` = sec, `_epoch_ms` = ms) and the inconsistency is a real cognitive load on every new caller.

**V35 canonicalized 7 tables** (handled by V40 DEFAULT-fix). **24 more legacy `_epoch` columns remain** across 16 tables. None are data-corrupt — every column is internally consistent with its `_epoch` (seconds) name. The work is renaming + scaling + caller-reference audit, not data repair.

## Survivors (24 columns × 16 tables)

Snapshot from live DB at 2026-05-18 00:10 +02:00. All max values ≈ 1.78×10⁹ (= ~2026 in unix seconds), confirming consistent sec storage.

| Table | Column | Rows | NOT NULL | DEFAULT | Notes |
|---|---|---:|---|---|---|
| `thread_state` | `updated_at_epoch` | 875 | yes | `unixepoch()` | |
| `checkpoint_tracking` | `last_checkpoint_epoch` | 3 | no | `null` | |
| `checkpoint_tracking` | `updated_at_epoch` | 28 | yes | `unixepoch()` | |
| `checkpoint_tracking` | `last_tick_epoch` | 28 | yes | `0` | |
| `verified_facts` | `created_at_epoch` | 45 | yes | `unixepoch()` | |
| `file_leases` | `granted_at_epoch` | 0 | yes | `null` | empty — safe to rename + add DEFAULT |
| `artifact_claims` | `claimed_at_epoch` | 0 | yes | `null` | empty |
| `session_events` | `timestamp_epoch` | **117,127** | yes | `unixepoch()` | highest traffic — query-hot |
| `session_journal` | `timestamp_epoch` | 22,762 | yes | `unixepoch()` | the audit trigger |
| `artifact_links` | `created_at_epoch` | 13,492 | yes | `unixepoch()` | |
| `artifact_links` | `valid_at_epoch` | 5,042 | no | `null` | |
| `artifact_links` | `invalid_at_epoch` | 0 | no | `null` | empty |
| `capability_boundaries` | `last_updated_epoch` | 469 | yes | `unixepoch()` | |
| `conversation_turns` | `timestamp_epoch` | 10,683 | yes | `unixepoch()` | query-hot via heartbeat |
| `artifact_access_log` | `timestamp_epoch` | 0 | yes | `unixepoch()` | empty |
| `knowledge_gaps` | `detected_at_epoch` | 0 | yes | `unixepoch()` | empty |
| `knowledge_gaps` | `resolved_at_epoch` | 0 | no | `null` | empty |
| `temporal_profile` | `updated_at_epoch` | 427 | yes | `unixepoch()` | |
| `action_transitions` | `last_epoch` | 5,499 | yes | `unixepoch()` | |
| `solution_outcomes` | `created_at_epoch` | 2,230 | yes | `unixepoch()` | |
| `entity_aliases` | `created_at_epoch` | 47 | yes | `unixepoch()` | |
| `artifacts` | `timestamp_epoch` | 10,722 | yes | `unixepoch()` | legacy artifacts table (read-only post-cutover, but column still referenced) |
| `artifacts` | `last_materialized_epoch` | 2,795 | no | `null` | |
| `code_index` | `last_indexed_epoch` | 1,216 | yes | `unixepoch()` | |

**Total data rows to scale:** ~191,000 (dominated by `session_events.timestamp_epoch`).

## Rename + scale plan per column

For each column, the migration step is:

1. `ALTER TABLE T RENAME COLUMN old_epoch TO old_epoch_ms` (SQLite 3.25+)
2. `UPDATE T SET old_epoch_ms = old_epoch_ms * 1000` (whole-row scan, but each table is small except session_events)
3. Rewrite DDL DEFAULT via `PRAGMA writable_schema = 1` (V40 pattern): `unixepoch()` → `unixepoch() * 1000`

Per-table cost: ~50ms for small tables, ~2-5s for `session_events` (117K rows). Whole migration: under 30 seconds end-to-end.

## Caller-reference scope

Every code site that reads any of these columns BY NAME needs to be updated. Examples of likely-affected paths (from the source tree):

- `src/assembly/sections.ts` — reads `session_events.timestamp_epoch` for activity surfaces
- `src/angel/heartbeat.ts` — reads `conversation_turns.timestamp_epoch` for transcript ordering
- `src/intelligence/recall-flow.ts` — likely reads `session_journal.timestamp_epoch` for journal surfaces
- `src/intelligence/capability-tracker.ts` — reads `capability_boundaries.last_updated_epoch`
- `src/core/observations.ts` — may read `artifacts.timestamp_epoch`
- `src/cli/dashboard.ts` — display surfaces
- 30-50 tests — each fixture that writes one of these columns needs the new name + ms value

**The audit cannot be eyeballed.** A `grep -r "<column_name>" src/` per column is required to surface every reference, then each gets renamed + units adjusted (no `/1000` if the caller used it as sec; no `* 1000` if the caller multiplied to ms).

## Wave structure for `/team` dispatch

Recommended split for parallel execution:

- **Wave 1 — high-traffic / query-hot** (4 workers, parallel):
  - W1a: `session_events.timestamp_epoch` (117K rows, dozens of callers — biggest)
  - W1b: `session_journal.timestamp_epoch` (22K rows)
  - W1c: `conversation_turns.timestamp_epoch` (10K rows)
  - W1d: `artifacts.timestamp_epoch` + `artifacts.last_materialized_epoch` (legacy artifacts table cluster)

- **Wave 2 — knowledge graph cluster** (1 worker):
  - W2: `artifact_links.created_at_epoch` + `valid_at_epoch` + `invalid_at_epoch` (linked semantics, treat together)

- **Wave 3 — behavioral substrate** (2 workers, parallel):
  - W3a: `capability_boundaries.last_updated_epoch` + `action_transitions.last_epoch` + `temporal_profile.updated_at_epoch`
  - W3b: `solution_outcomes.created_at_epoch` + `verified_facts.created_at_epoch` + `entity_aliases.created_at_epoch`

- **Wave 4 — low-traffic / mostly-empty** (1 worker):
  - W4: `thread_state.updated_at_epoch`, `checkpoint_tracking` (3 cols), `code_index.last_indexed_epoch`, `file_leases.granted_at_epoch`, `artifact_claims.claimed_at_epoch`, `artifact_access_log.timestamp_epoch`, `knowledge_gaps` (2 cols) — most are empty, this is cleanup

**Per-worker brief:**
- Read this audit doc
- For your assigned column(s): grep ALL caller references in `src/` and `src/tests/`
- Migration step in `migration-steps.ts` (V43): rename + scale + DDL DEFAULT fix
- Edit every caller: rename `_epoch` → `_epoch_ms`, audit unit math (`* 1000` becomes no-op, `/ 1000` becomes `* 1000` only if converting back to sec for a sec-expecting API)
- Update test fixtures (column name + values now in ms)
- Run `bun run build` + targeted vitest on changed test files
- Report: # callers updated, # rows scaled, build status, test pass/fail count

**Per-PM verification:**
- Run `bun run vesna` (binding ship gate)
- Run `npx vitest run` on all affected test files
- Confirm no `_epoch` (no `_ms`) column survives the worker's scope via the audit grep
- Cross-family review via `/codex-review` or `/gemini-review` on the V43 diff

## Why this isn't a one-session push

8 workers × per-worker ~50 caller references × per-reference grep + edit + verify = real work. Aggregate scope is days of focused effort, not hours. Hence dispatching `/team` rather than inline.

## What's NOT in scope

- The 7 columns V40 already fixed (`session_signals.created_at_epoch_ms`, etc.) — those are already `_ms`-named with correct units.
- The `artifact` (V17) table — uses `created_at_epoch_ms` / `updated_at_epoch_ms` correctly.
- The `kind_registry` legacy columns — V40 dropped them already.
- The `session_termination` table (V42) — already `_epoch_ms` from the start.
- The `chr_pending_classifications` table (V41) — already `_epoch_ms` from the start.

## Convention going forward

Codified in `CLAUDE.md`:
> `_epoch` (no suffix) = SECONDS. `_epoch_ms` = MILLISECONDS. New tables MUST use `_epoch_ms` only — never add an `_epoch` column. Respect names; don't infer units from context.
