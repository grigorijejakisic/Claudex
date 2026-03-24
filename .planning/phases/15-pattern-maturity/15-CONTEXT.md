# Phase 15: Pattern Maturity + Harmful Multiplier — Context

**Spec:** context/specs/PROACTIVE_MEMORY.md Part 7

## Problem
Experience patterns have no maturity lifecycle. A pattern from a single session is treated the same as one validated across 10 sessions. Negative outcomes aren't weighted heavily enough — CASS research shows 4× harmful multiplier is optimal.

## Solution
Add maturity progression (candidate → established → proven), confidence scoring with Laplace smoothing, 4× harmful multiplier, and anti-pattern inversion.

## Key Research
- CASS: 4× harmful multiplier, 90-day confidence half-life, maturity progression
- Wikipedia model: evidence-based quality gating
- Collective intelligence: reputation per writer

## Key Files
- `src/intelligence/experience-patterns.ts` (960 lines) — maturity lifecycle + confidence
- `src/adapters/cc-hooks/stop.ts` (406 lines) — promotion logic + harmful scoring
- `src/core/schema.ts` — add maturity + confidence columns

## Schema Change
```sql
ALTER TABLE experience_patterns ADD COLUMN maturity TEXT DEFAULT 'candidate'
  CHECK (maturity IN ('candidate', 'established', 'proven'));
ALTER TABLE experience_patterns ADD COLUMN confidence REAL DEFAULT 0.5;
```
