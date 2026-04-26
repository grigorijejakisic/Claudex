---
schema: claudex/handoff
version: 1
handoff_id: claudex-v3-handoff-phase5-ready-to-plan
status: active
created_at: 2026-04-26T00:00:00Z
updated_at: 2026-04-26T00:00:00Z
origin_session_id: e37d5c59-c2ec-4042-bb97-16ead5b1f349
supersedes: claudex-v3-handoff-phase4-post-soak-deferred
---

# Handoff: Phase 5 ready to plan — P4 Kill legacy injection

Date: 2026-04-26. Phase 4 (P3 — MEMORY.md curation + auto-dream guard) is **fully closed**. All gates PASS. Phase 5 (P4 — Kill legacy injection) is the next phase and is ready to plan.

## Commander's Intent

Plan Phase 5. This is the highest-risk phase of v4 — it deletes 9 injection sections from `assembler.ts`, collapses session-start to ≤500 tokens, and carries the first hard within-2pp LoCoMo gate. BENCH-09 activates as a behavioral gate. The L1..L4 fallback ladder must be incorporated into the Phase 5 PLAN before any code changes.

**Start with:** `/gsd:plan-phase 5`

## Phase 4 close summary (what just happened)

Phase 4 closed 2026-04-26 with all gates PASS:
- LongMemEval Oracle: 89.6% (floor ≥88%, PASS)
- LoCoMo: 62.3% new anchor (+6.8pp over 55.5% pre-migration; no within-2pp gate in Phase 4)
- Soak: 8/8 PASS (verify-soak.cjs on soak-test-p4b project)
- Test suite: 2577/2597 (20 pre-existing llama-server-supervisor failures, unchanged)
- BENCH-09 baseline: median=1 claudex_search call/non-trivial session (n=122 sessions, 30d)

Three inline bugfixes shipped alongside the planned deliverables:
- **04-06**: Angel resilience — stdio:'ignore' child spawns caused silent heartbeat deaths; no MEMORY.md was ever written
- **04-07**: V17 migration idempotency — initializeSchema threw on view-indexing; 3.5 days of hook data lost
- **04-08**: memory-md-writer project ID resolution — wrong slug on Windows; zero projects had a valid MEMORY.md (CLAUDEXv3 was 17 days stale)

All three passed the static test suite. All three were caught by live-fire/soak protocols. This pattern is now a load-bearing methodology requirement for future plans.

## Phase 5 success criteria (from ROADMAP.md)

Full list at `.planning/ROADMAP.md` Phase 5 section. Key items:
1. Assembler deletes: Proven Principles, Entity Summaries, Angel Opinions, Predicted Context, Curated Context, Experience Warnings auto-surface, Flow, Reference Layer, Materialization (9 sections)
2. Assembler keeps: Identity, Project (CLAUDE.md), Session Continuity, Checkpoint, GSD, MEMORY.md (native load)
3. Session-start tokens ≤500 (tokenizer verified on real session-start output)
4. UPS per-turn payload ≤1KB
5. All surviving injected text cache-stable (no timestamps/turn-counts/session-IDs)
6. `initialUserMessage` auto-prime when ACTIVE.md handoff exists
7. Experience-warnings surface only on explicit `claudex_search` or path/command trigger
8. **BENCH-09 gate**: post-P4 median claudex_search calls ≥ baseline (≥1); target ≥2 (2× baseline)
9. **Benchmark gate with fallback ladder**: LongMemEval ≥88%; LoCoMo within 2pp of 62.3%

## BENCH-09 baseline (Phase 4 deliverable)

File: `benchmarks/results/p3-postmigration/bench09-baseline.json`

- Median: **1** claudex_search call per non-trivial session
- P25: 1, P75: 1, Mean: 2.3, N=122 sessions
- post_v4_floor: 1, post_v4_target: 2

Pre-v4 baseline reflects that the agent rarely searches because most context is injected. After Phase 5 deletes injection, the agent MUST search more — not less. If post-P4 median < 1, amnesia, not pull-based reframe.

## Fallback ladder for Phase 5 benchmark regression

From `.planning/ROADMAP.md` Phase 5 success criteria — MUST be incorporated into the Phase 5 PLAN before any code is committed:

- **L1**: Raise UPS budget 1KB → 2KB; re-run benchmarks. If recovers, ship at 2KB and document.
- **L2**: Keep Entity Summaries injection section (highest signal density per token). Re-run. If recovers, ship with one section and spec the retirement path.
- **L3**: Dual-inject diagnostic — re-enable old sections alongside MEMORY.md for one full LongMemEval run; attribute gap to specific deletions; narrow-revert only responsible section(s).
- **L4**: Full revert. MEMORY.md curation must show measurable improvement before re-attempt.

**Do NOT revert immediately on first benchmark miss.** Exhaust the ladder in order.

## DB backup requirement (STOR-08)

Phase 5 deletes production injection code and schema consumers. Per STOR-08, a DB backup must be taken to `~/.claudex/backups/pre-v4-P5-{ts}.db` and verified restorable BEFORE any commit that modifies `assembler.ts` or drops injection-related table consumers. The existing P1 backup (`~/.claudex/backups/pre-v4-P1-1776681458021.db`) covers schema rollback but not code rollback — a fresh backup is needed.

## Context that won't be obvious

- **MEMORY.md writer is working for all 16 active CC projects** as of 04-08 fix. When Phase 5 adds MEMORY.md as an injection source (INJ-03), the writer is confirmed reliable.
- **All hooks are writing correctly** post-04-07. `MAX(timestamp_epoch) FROM session_events` reflects live activity — confirm before planning session if in doubt.
- **LoCoMo 62.3% is with glm-5.1:cloud as the answer model.** If you need to re-run, use the same model. deepseek-coder-v2:16b is the LongMemEval answer model; they are not interchangeable.
- **The `think: false` flag is required** in `ollamaGenerate` for any Ollama-judge benchmark. Without it, thinking-capable models emit `<think>` blocks that break parsers (commit 9cd667a).
- **Phase 4 plans list in prior ROADMAP had "TBD" entries for other phases' plans.** Those are resolved. Phase 5 plans list currently shows `- [ ] 05-01: TBD` — replace with actual plans during planning.

## Quick verify before starting Phase 5 planning

```bash
# Confirm Phase 4 closed in ROADMAP
grep "Phase 4.*completed" .planning/ROADMAP.md

# Confirm STATE.md is on Phase 5
grep "Current Phase:" .planning/STATE.md

# Confirm BENCH-09 baseline committed
cat benchmarks/results/p3-postmigration/bench09-baseline.json | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('median:',d.claudex_search_calls_per_session.median,'n:',d.n_sessions)"
```
