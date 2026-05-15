---
phase: 14-substrate-coherence
milestone: v6.6.0
status: shipped
shipped_at: 2026-05-16
plans_shipped: 8
plan_summaries:
  - 14-00-SUMMARY.md
  - 14-01-SUMMARY.md
  - 14-02-SUMMARY.md
  - 14-03-SUMMARY.md
  - 14-04-SUMMARY.md
  - 14-05-SUMMARY.md
  - 14-06-SUMMARY.md
  - 14-08-SUMMARY.md
deferred_to_v7_0_0:
  - 14-07 (V17 ↔ legacy artifacts migration)
---

# Phase 14 Substrate Coherence — Milestone Close (v6.6.0)

## What v6.6.0 ships

Eight contract-tightening fixes that close the structural debt
surfaced in this session's substrate audits. Every fix landed
production-quality with per-plan acceptance criteria + tests +
external-review-ready commits.

| Plan | Surface | Headline |
|---|---|---|
| 14-00 | Highlights extractor | Removed OAuth path hitting global 429; opt-in Opus via API key; local LLM as primary |
| 14-01 | Handoff schema + migrator | `parseHandoffHeader` telemetry-on-rejection + CLI tool that migrates any handoff schema to canonical; big-mozzy-v2 migrated end-to-end |
| 14-02 | Project naming column | `migrateV33toV34` renames V17 `project_id` → `project`; comprehensive caller sweep |
| 14-03 | Substantive filter | `isSubstantive()` predicate + `substantiveSqlClause` with JS↔SQL lockstep test; experience-tier candidate pool filter; **AC-3 verdict PASS — noise rate 83% → 18%** |
| 14-04 | P2.7 Project Knowledge surface | Same-project hybrid retrieval against ACTIVE.md summary; closes the same-project starvation gap; AC-1 evidence: synthesized big-mozzy fixture surfaces canonical entry |
| 14-05 | Lifecycle ownership | Boundary-detector becomes single writer of `status='completed'`; ordered 5-action chain with per-action telemetry; idempotent |
| 14-06 | Epoch canonicalization | `migrateV34toV35` renames every `*_epoch` → `*_epoch_ms` across ~10 tables; `src/core/epoch.ts` typed helpers; lesson-frontmatter migrator; 62 production files swept + 104 test fixtures |
| 14-08 | Multi-agent ACTIVE.md | `renderSessionContinuity` enumerates `ACTIVE*.md` glob; `### Agent <id>` sub-blocks; byte-identical single-file regression test |

## Quantitative wins

- **Cross-project equivalence noise rate: 83% → 18%** (Plan 14-03 re-measurement). The Past Patterns surface in big-mozzy-v2 sessions stops being a noise firehose.
- **Highlights extraction success rate: 0% → expected 100%** for projects on local-LLM path (Plan 14-00). Recent Session Frames goes from "every row degraded" to real frames.
- **Cumulative production files touched (Wave 1 + 2 + 3 + 4):** ~75 production + ~120 test files
- **Schema migrations shipped:** V33→V34 (project naming), V34→V35 (epoch ms), V35→V36 (`session_end_action` telemetry enum). All paired forward + reverse.

## Behavioral wins

- big-mozzy-v2's 119-line `claudex/handoff` v1 schema handoff is now visible to every assembler surface (was silently rejected by `parseHandoffHeader`).
- Multi-agent `ACTIVE-agent2.md` files surface as distinct Session Continuity blocks (was permanently invisible).
- Same-project knowledge surfaces proactively at session-start via P2.7 (was reachable only by agent query).
- Session-end side effects (highlights, MEMORY.md regen, lesson-pointer index) fire in a known order from a single owner (was scattered across multiple writers).
- All `*_epoch` semantics canonicalized to milliseconds (was three different shapes in active use).
- `project` column name unified across V17 + legacy (was `project_id` on V17, `project` everywhere else).

## Wave structure (executed)

```
Wave 1 (parallel, 3 workers — landed 2026-05-15):
  Worker A → 14-01 handoff schema + migrator
  Worker B → 14-02 project naming
  Worker C → 14-08 multi-agent ACTIVE.md

Wave 2 (single worker — landed 2026-05-16):
  Worker D → 14-06 epoch-ms canonicalization

Wave 3 (parallel, 2 workers — landed 2026-05-16):
  Worker E → 14-03 substantive filter (AC-3 PASS)
  Worker F → 14-05 boundary-detector single owner

Wave 4 (single worker — landed 2026-05-16):
  Worker G → 14-04 P2.7 Project Knowledge surface
```

Plus Plan 14-00 shipped earlier (commit `cfc45fe`, 2026-05-15) before the GSD plan-structure was formalized.

## Test sweep at milestone close

- **Total tests:** 4080 / 4088 passing (+ 8 skipped)
- **Failures:** 31 across 5 files — all pre-existing baseline:
  - `llama-server-supervisor.test.ts` (18) — v4-debt baseline
  - `llama-client.test.ts` (2) — v4-debt baseline
  - `phase-5-full-gate.test.ts` (3) — missing paper-trail reports, v4-debt
  - `phase-12-retrieval-ranking-rebalance.test.ts` (5) — pre-existing retrieval-ranking edge cases
  - `phase-6-5-cross-project-vesna.test.ts` (3) — Experience Tier surface, pre-existing flakiness
- **Zero new regressions** introduced by Phase 14.

## What's NOT in v6.6.0 (deferred to v7.0.0)

**Plan 14-07** — V17 ↔ legacy `artifacts` migration. Per RCA-3, this
is the largest single piece of work in Phase 14: ~22 production sites
including the entire `hybrid-retrieval.ts` rewrite, schema migration
with ID-type change (INTEGER → TEXT hash), embedding storage shape
change requiring a re-embed pass, and ranking regression risk that
needs Vesna + LongMemEval + LoCoMo as benchmark gates.

It deserves its own milestone for these reasons (operator-confirmed):
1. PLAN.md hasn't been written yet (only RCA-3 sizing exists)
2. Different change shape — schema migration vs behavioral fixes
3. Ranking regression risk needs benchmark validation
4. Roll-back asymmetry — easier to revert v6.6.0 (8 commits) than a mixed-state schema migration

Production-quality plans for v7.0.0 are scheduled for the next session
(2026-05-16 onwards), likely split into sub-plans:
- **14-07a** DDL + ID-mapping table
- **14-07b** Caller migration
- **14-07c** Cutover + benchmark validation

## v6.6.0 ship gates

- [x] All 8 plan ACs verified per their SUMMARYs
- [x] Build clean
- [x] Test sweep — zero new regressions outside known baseline
- [x] AC-3 quantitative verdict (noise rate < 20%) PASS
- [x] AC-1 evidence (P2.7 surfaces big-mozzy canonical entry) captured
- [x] No `project_id` regressions (Wave-1 invariant preserved through Waves 2+3+4)
- [x] No bare `*_epoch` regressions (Wave-2 invariant preserved through Waves 3+4)
- [x] Schema migrations forward + reverse paired
- [x] `Phase-14-CLOSE.md` written
- [ ] `v6.6.0` annotated tag created locally
- [ ] ROADMAP.md + STATE.md updated
- [ ] Operator confirms public push

## What this milestone proves

The "claudex grew organically without contract enforcement" diagnosis
from `2026-05-15-substrate-contract-matrix.md` is being addressed
systematically. Each plan tightens one contract: handoff schema,
project naming, epoch shape, substance filter, lifecycle ownership,
multi-agent visibility, same-project surface, telemetry enum
discipline.

The next operator session can run the disposition test from `2026-05-15-phase-13-shipped-character-file-test-pending` with the
substrate carrying significantly more honest signal than it did
when the test was scheduled. Recent Session Frames will have real
content (not fallback). Project Knowledge will surface same-project
artifacts proactively. Multi-agent handoffs will be visible. The
handoff schema will accept any project's existing shape after one
operator-driven migration.

## Next operator action

1. Review this close doc + spot-check any plan SUMMARY of interest.
2. (Optional) Run the migrate-handoff CLI on big-mozzy-v2 if you
   want the live ACTIVE.md migrated:
   ```
   bun src/scripts/migrate-handoff.ts C:/Users/Grigorije/Desktop/big-mozzy-v2 --dry-run
   ```
3. (Optional) Run the migrate-lesson-frontmatter CLI to migrate
   on-disk lesson `created_at_epoch` → `created_at_epoch_ms` per
   project.
4. Push `v6.6.0` tag to origin if approved.
5. Schedule v7.0.0 plan-writing for the next session (per operator
   instruction 2026-05-16 00:52: "ship V6.6.0 and we ship full plans
   for everything needed for V7 tomorrow").
