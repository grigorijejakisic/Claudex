---
phase: 07-supporting-subsystems
plan: 01
status: complete
duration: 3min
tests_passed: 48
files_created:
  - src/gauge/window-detector.ts
  - src/gauge/token-gauge.ts
  - src/decay/decay-engine.ts
  - src/decay/pressure-decay.ts
  - src/tests/gauge/window-detector.test.ts
  - src/tests/gauge/token-gauge.test.ts
  - src/tests/decay/decay-engine.test.ts
  - src/tests/decay/pressure-decay.test.ts
---

## Summary

Token gauge, window detector, decay engine, and stratified pressure decay implemented per Architecture Sections 7.4, 9, 9.3.

## Key Decisions

- Token gauge reads tail ~8KB of transcript JSONL for efficient CC path
- Window detector returns 1M only for claude-opus-4/claude-sonnet-4 with >195k observed tokens
- EI formula: baseWeight * accessFactor * decayFactor * connectivityBonus (4 factors)
- Pruning immune observations: importance >= 5, or access_count >= 3 within 180 days
- Pressure decay uses stratified half-lives: HOT 7d, COLD 3d, reclassify at 0.851 threshold
- All public functions non-throwing

## Artifacts

| File | Purpose | Exports |
|------|---------|---------|
| src/gauge/window-detector.ts | Auto-detect 200k vs 1M context window | `detectWindowSize` |
| src/gauge/token-gauge.ts | Capability-aware token gauge | `getTokenGauge` |
| src/decay/decay-engine.ts | EI formula, pruning, retention | `computeEI`, `getCoOccurrences`, `pruneObservations`, `applyRetentionPolicy` |
| src/decay/pressure-decay.ts | Stratified pressure decay | `decayPressureStratified` |
