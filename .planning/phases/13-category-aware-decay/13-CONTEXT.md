# Phase 13: Category-Aware Decay — Context

**Spec:** context/specs/PROACTIVE_MEMORY.md Part 2

## Problem
All observation categories use the same decay half-lives. Error traces from 3 months ago are noise; architecture decisions from 6 months ago are gold. The decay engine at `src/decay/decay-engine.ts` treats them identically.

## Solution
Add `stability_class` column to observations. Classify automatically on insert based on category. Modify decay engine to use stability-specific half-lives. Run continuous decay in Angel heartbeat (every tick, not threshold-triggered).

## Stability Classes
- **transient** (error, test): 3d/14d/90d half-lives for importance 1/3/5
- **standard** (config, dependency, performance, code, documentation, security): 7d/30d-60d/180d-365d
- **stable** (architecture, decision): 14d/90d/never
- **permanent**: never auto-decay (manually set)

## Key Files
- `src/decay/decay-engine.ts` — modify half-life computation
- `src/core/observations.ts` — auto-classify stability on insert
- `src/core/migrations.ts` — V11 migration: add column + backfill existing observations
- `src/core/schema.ts` — add stability_class column to DDL

## Schema Change
```sql
ALTER TABLE observations ADD COLUMN stability_class TEXT DEFAULT 'standard'
  CHECK (stability_class IN ('transient', 'standard', 'stable', 'permanent'));
```
