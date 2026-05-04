---
phase: 03-p2-directive-detector
plan: 06
subsystem: calibration-and-ship
tags: [calibration, precision-harness, runbook, escalation, label-audit, partial-ship, noise-bound]

requires:
  - phase: 03-p2-directive-detector
    provides: run-precision.ts harness + compare-runs.ts (Plan 03-05); fixture + gold labels (Plan 03-03); prompt assets + rubric (Plan 03-02); detector pipeline (Plan 03-01); Angel heartbeat integration (Plan 03-04)
provides:
  - `.planning/phases/03-p2-directive-detector/03-CALIBRATION.md` — full iteration log from baseline through Cycle 4, post-relabel run, ship verdict
  - `.planning/phases/03-p2-directive-detector/03-PER-CANDIDATE-DIFF.md` — evidence note for the ship/tune branch call, per-candidate flip analysis
  - `.planning/phases/03-p2-directive-detector/03-LABEL-AUDIT.md` — 20-case blind audit showing labeler noise (already-committed at audit time)
  - Ship-quality metric: **joint_precision = 0.500, scope_precision_given_correct = 0.889** on post-relabel fixture
affects: [P4 directive_rule consumption, P8 supersession/contradiction logic]

tech-stack:
  added: []
  patterns:
    - 3-cycle tune budget + escalation-template message when the budget runs out
    - Label-audit (blind rubric reapplication) as evidence before gate adjustment
    - Per-candidate diff doc as the deliverable input to a human ship/tune branch call
    - Hardened harness observability (harness_pid + heartbeat + success-signal doc) to kill the observer-error class

key-files:
  created:
    - .planning/phases/03-p2-directive-detector/03-PER-CANDIDATE-DIFF.md
    - .planning/phases/03-p2-directive-detector/03-06-calibration-and-ship-SUMMARY.md
  modified:
    - .planning/phases/03-p2-directive-detector/03-CALIBRATION.md (appended post-relabel + Cycle 4 + ship decision)
    - src/benchmarks/directive-detector/run-precision.ts (observability commit 3ddd183)
  reverted:
    - src/intelligence/directive-detector-prompts/confirmation-few-shot.json (Cycle 4 tune attempt, net-zero trade)

key-decisions:
  - "Escalation resolution: path A (gate 0.90→0.75) + 12-case hand re-label, NOT corpus expansion or scope-taxonomy redesign — cheaper signal vs effort"
  - "Cycle 4 tune reverted: polarity +8.3pp and is_directive -8.3pp cancelled; adjacent-family collateral on always_emphasis (-13.3pp) made the trade net-negative"
  - "Ship path B (partial-ship) over path C (regression) because joint=0.500 is noise-bound on n=12 confirmations; scope precision 0.889 is the primary P8 consumer contract and ships strong"
  - "Benchmark gate (03-06-07) + live-tick confirm (03-06-08) deferred to post-ship follow-ups, NOT blockers — the injection-surface diff (03-06-09) is empty so LoCoMo/LongMemEval regressions from additive rows would be investigation-worthy, not rollback-worthy"
  - "harness_pid first-line + heartbeat + success=JSON-landed documentation killed the 3-silent-death observer-error class permanently (commit 3ddd183)"

patterns-established:
  - "Label audit before gate adjustment: when measured precision is far from gate, measure labeler noise before tuning the detector — the yardstick may be broken"
  - "Per-candidate diff as the evidence input to a ship/tune/regression branch call: aggregate metrics hide which candidates moved and why"
  - "Keep tune edits uncommitted until a rerun confirms non-regression; revert rather than bundle marginal wins with collateral damage"
  - "Observability hardening (process pid + heartbeat + success-signal docs) is a one-time commit that prevents a recurring observer-error class"

requirements-completed:
  - EXTR-04

duration: ~3 sessions (sessions 52-54), including multi-session handoff loop + silent-death investigation
completed: 2026-04-22
---

# Plan 03-06: Calibration + Ship Summary

**Phase 3 detector shipped at joint_precision = 0.500 on post-relabel fixture (path B partial-ship). Scope precision 0.889 is ship-quality for the primary P8 consumer contract; remaining polarity/is_directive gaps are concentrated on the `negation_dont` regex family and deferred to P8 as a tunable follow-up with a larger confirmation denominator.**

## Performance

- **Completed:** 2026-04-22
- **Tasks:** 9 (01 first-run, 02 threshold sweep, 03 few-shot, 04 prompt rewrite, 05 escalation, 06 CALIBRATION write, 07 benchmark gate DEFERRED, 08 live-tick confirm DEFERRED, 09 injection-surface diff PASSES)
- **Files created:** 2 (PER-CANDIDATE-DIFF, SUMMARY)
- **Files modified:** 1 (CALIBRATION appended), 1 (run-precision observability, separate commit)
- **Files reverted:** 1 (confirmation-few-shot.json, Cycle 4 attempt)

## Accomplishments

- **Full 4-cycle iteration log** in `03-CALIBRATION.md` — baseline → threshold sweep → scope few-shot → prompt rewrite → label audit + gate resolution → post-relabel cycle3_diag → negation_dont tune → ship.
- **Escalation resolved** per RESEARCH §1.6 template: 3-cycle budget exhausted at joint=0.455, surfaced three options, user chose path A (gate 0.90→0.75) + 12-case hand re-label.
- **Post-relabel run** lifted joint to 0.500 with no detector changes (+4.5pp purely from label-quality). Scope precision jumped from 0.667 → 0.889 (+22.2pp) because the re-label fixed over-universalization in the gold.
- **Cycle 4 tune attempted and reverted** — 3 synthetic `negation_dont` few-shot examples. Polarity +8.3pp, is_directive -8.3pp, joint flat, `always_emphasis` regressed -13.3pp. Reverted rather than committed.
- **`03-PER-CANDIDATE-DIFF.md` evidence doc** drove the human ship/tune branch call. Identified that 3 polarity misses + 3 is_directive FPs all cluster on one tunable regex family, giving user the scope picture needed to pick path B.
- **Harness observability hardening** (separate commit `3ddd183`): `harness_pid=<pid>` first log line, `--heartbeat-ms=<ms>` flag, `--limit=<N>` flag, doc comment clarifying success = output JSON landing not process-table presence. Killed the 3-silent-death observer-error class that cost sessions 52-54 significant iteration cycles.
- **Injection-surface diff check PASSES** — zero diff from post-P1 baseline `32779b3` on `src/assembler/`, `src/hooks/session-start.ts`, `src/core/sections.ts`.

## Task Commits

1. **Pre-relabel Cycle 3 measurement + escalation** — commits `6187ac6` (`p2(03-06): cycle3 measurement + option-D escalation (audit labels)`) and `de6b42b` (`p2(03-06): label audit (option D) — gold noise confirmed`).
2. **Gate lowering + 12-case re-label** — commit `72833f6` (`docs(03-06): plan gate lowered 0.90→0.75 + user re-label 12 cases`).
3. **Per-candidate error isolation + scope_excluded flag** (harness hardening) — commit `bdca0a3` (`feat(03-05): per-candidate error isolation + scope_excluded_from_scoring`).
4. **Harness observability** — commit `3ddd183` (`feat(03-05): harness observability — heartbeat + harness_pid line`).
5. **Calibration report + SUMMARY** — this commit.

## Files Created/Modified

- `.planning/phases/03-p2-directive-detector/03-CALIBRATION.md` — appended escalation resolution, post-relabel cycle3_diag run, Cycle 4 tune + revert, ship decision, final per-scope + per-family + P8 follow-ups + deferred-gate notes.
- `.planning/phases/03-p2-directive-detector/03-PER-CANDIDATE-DIFF.md` — written; full 12-candidate breakdown + failure-mode analysis, drove the branch call.
- `.planning/phases/03-p2-directive-detector/03-06-calibration-and-ship-SUMMARY.md` — this file.
- `.planning/phases/03-p2-directive-detector/fixtures/runs/2026-04-22T15-48-01-273Z_cycle3_diag.json` — ship run.
- `.planning/phases/03-p2-directive-detector/fixtures/runs/2026-04-22T21-42-16-292Z_cycle4_negation_fewshot.json` — cycle 4 attempt, retained as evidence for the revert decision.

## Decisions Made

- **Chose path B (partial-ship) over path C (regression) at joint=0.500.** Below the 0.75 ship gate but the aggregate metric is noise-bound on n=12 confirmations — a single candidate represents ~8pp. Scope precision 0.889 is ship-quality for P8's consumer contract, and the remaining gaps are concentrated on a single tunable regex family.
- **Declined to retry Cycle 4 with a narrower few-shot edit.** The single-iteration convergence signal was weak and blind; P8 should approach this with a held-out test set rather than iterating full-fixture.
- **Deferred 03-06-07 (benchmark gate) and 03-06-08 (live-tick confirm) to post-ship follow-ups.** Not blockers: the injection-surface diff is empty (03-06-09 passes), so LoCoMo/LongMemEval regressions from additive `directive_rule` rows would be investigation-worthy rather than rollback-worthy.
- **Harness observability committed as a separate hardening commit** rather than bundled with CALIBRATION — the change removes a recurring observer-error class and is valuable independent of Phase 3 ship.

## Deviations from Plan

- **Plan 03-06 gate was lowered 0.90 → 0.75 mid-execution** (commit `72833f6`) in response to the label audit showing gold-side noise. This is plan-evolution not plan-deviation — the audit produced new information that changed what "ship-quality" meant on this fixture.
- **Cycle 4 tune was attempted after escalation resolution** — not in the original 3-cycle budget. It was greenlit by team-lead as a post-relabel bonus attempt, produced net-zero results, and was reverted without being committed.
- **Plan tasks 03-06-07 and 03-06-08 not completed at ship time** — explicitly deferred to follow-ups, documented in CALIBRATION. Task 03-06-09 PASSES.

## Issues Encountered

- **Silent harness death "bug" turned out not to exist.** Three consecutive "silent deaths" across sessions 52-54 were observer errors (wrong PID tracked, death declared before first progress tick, one intentional taskkill mis-classified). Direct reproduction on 2026-04-22 ran the full 106-candidate harness to completion in ~24 min. Hardening committed at `3ddd183` to prevent recurrence.
- **deepseek-v3.2:cloud labeler noise** was material on this fixture. The 03-LABEL-AUDIT found rubric-defensible disagreement with gold on ~half of the 20-case audit pool. Feeding this back into path-A resolution (12-case hand re-label) was the unblocker; future phases consuming gold from an LLM labeler should budget for a similar audit step.
- **Cycle 4 negation few-shot tune produced collateral damage** on the adjacent `always_emphasis` family (-13.3pp). Single-iteration prompt tuning at n=12 confirmations is too noisy to converge cleanly.

## Next Phase Readiness

- **P4 (directive consumption)** — `directive_rule` artifact shape is stable; the detector writes `body`, `scope ∈ {session, project, universal}`, `polarity ∈ {prescriptive, prohibitive}`, and passive annotations (`data.possible_contradicts`, `data.related_to`, `data.related_cosine`) for the dedup-shortlist-hit cases. P4 can consume these fields directly.
- **P8 (supersession / contradiction / decay)** — the passive annotations above are the input. Supersession logic should consume `possible_contradicts` rather than re-running cosine. Decay logic should consume `reinforcements[]` on the `updated` decision path.
- **P8 tune-queue starter set** is in CALIBRATION `## Follow-ups for P8`: negation_dont retune with held-out test set, fixture expansion to 30 sessions, universal-scope second-pass via stubbed scope-rubric prompt, reinforcement_count distribution telemetry.

---
*Phase: 03-p2-directive-detector*
*Completed: 2026-04-22*
