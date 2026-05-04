---
phase: 05-p4-kill-legacy-injection-big-benchmark-gate
plan: "03"
status: complete
completed: 2026-04-29
---

# Plan 05-03 SUMMARY: Tier A deletion (Flow + Reference Layer + Materialization)

## Commits (atomic, one per section)

| Section | SHA | Lines deleted | Imports cleaned |
|---------|-----|---------------|-----------------|
| Flow | `c32d50b` | 18 | getRecentFlow, formatFlowSection |
| Reference Layer | `56a22b9` | 20 | getPackedArtifacts, formatReferenceLayer |
| Materialization | `525213f` | 116 | searchArtifactsGlobal, hybridSearchSync (kept spreadActivation), recordRetrieval, consumeInjectedArtifacts |

Total deletion: ~154 lines from `assembleFullContext()`. UPS path (assembleRegularPrompt) preserves Materialization functions for trigger-matched retrieval.

## Verification

- ✓ All 3 deletions: build green, 165/165 assembly tests pass at every commit
- ✓ Cache-stability 12/12 green (Layer 2 + 3 invariant)
- ✓ Full test suite: 2729/2749 pass (20 pre-existing llama-server failures unchanged)
- ✓ Tier A gate report written to `05-03-TIER-A-GATE-REPORT.md`

## Token deltas

Fixture cascade unchanged (deletion paths were content-gated; empty fixture DBs never executed them). Production cascade soak (Plan 09) measures real-row delta. Recorded in gate report.

## Verdict

**PASS** — proceed to Plan 04 (Tier B).

Vesna proxy 100% (no regression). SC#3 unchanged (file content untouched). CACH-03 hardening holds.
