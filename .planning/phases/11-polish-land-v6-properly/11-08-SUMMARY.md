---
phase: 11-polish-land-v6-properly
plan: 08
subsystem: tooling/phase-close
tags: [polish, w3-scaffolding, conditional-outcomes, retag-script, results-template]
requires: [11-06, 11-07]
provides:
  - "applyConditionalOutcomes(triple) + loadAndClassifyPhase11(outDir) — operationalizes the spec's pre-committed conditional outcomes table; 8 branches"
  - "scripts/phase-11-close.cjs — reads q1+q2+q3 verdict files, classifies branch, writes 11-RESULTS.md with verdict triple + recommended v6.0.0 retag annotation"
  - "BRANCH_ANNOTATIONS dictionary: title + body for every conditional outcome; p11_1_corpus_expansion explicitly says do-not-retag"
  - "10 regression tests covering all 8 branches + dry-run + print-retag-only modes"
affects:
  - "Operator-driven Phase 11 close-out (Tasks 2 + 5 — checkpoint:human — remain operator work)"
  - "External-review-gate dogfood at W3 close-out runs against 11-RESULTS.md output"
tech-stack:
  added: []
  patterns:
    - "Pre-committed conditional outcomes table operationalized as a deterministic classifier — no goalpost shifting, function applies the locked rule"
    - "Retag script prints command but does NOT execute — operator-approval gate (checkpoint:human) preserved"
    - "Skip-record handling: q2-skipped.json + q3-skipped.json treated as INCONCLUSIVE+skipped in classification"
key-files:
  created:
    - "scripts/phase-11-close.cjs"
    - "src/tests/benchmark/deliberation-surfacing/phase-11-close.test.ts (10 tests)"
  modified:
    - "src/benchmark/deliberation-surfacing/runner.ts (applyConditionalOutcomes + loadAndClassifyPhase11)"
    - "package.json (phase-11:close + phase-11:retag-cmd scripts)"
key-decisions:
  - "Engineering-only scope — Tasks 1, 3, 4, 6 (auto) shipped. Tasks 2 + 5 (checkpoint:human) remain operator work: big-mozzy-v2 user-pair probe authoring (Task 2) + v6.0.0 retag annotation operator-approval (Task 5)."
  - "Retag command prints — does not execute — even on engineering_close_strong_bind. Operator must explicitly run `git tag -d v6.0.0 && git tag -a v6.0.0 -m \"...\"` after Task 5 approval."
  - "Public push (`git push origin master --tags`) is OUT OF SCOPE per CONTEXT § Phase Boundary `Not in scope`. Even after retag, operator runs the push separately."
  - "p11_1_corpus_expansion branch explicitly says NOT TAGGED — the script's annotation refuses to recommend a v6.0.0 retag in this branch (do-not-retag instruction in the body)."
  - "8 branches cover every cell of the (Q1, Q2, Q3) verdict table including missing/skipped Q2 + Q3 cases. Defense-in-depth: incomplete branch is the fallback when partial state is on disk."
  - "External-review-gate dogfood (per Plan 11-05) runs against the 11-RESULTS.md the operator publishes; documented in the resume sequence in ACTIVE.md."
requirements-completed: [POLISH-15, POLISH-16]
duration: "engineering scaffolding only — Tasks 1/3/4/6 of plan; Tasks 2/5 (checkpoint:human) remain operator work"
completed: "2026-05-09"
---

# Phase 11 Plan 08: conditional-outcomes applier + 11-RESULTS template + retag script (engineering scaffolding) Summary

**One-liner:** Pre-committed conditional outcomes table operationalized as a deterministic classifier; phase-11-close.cjs writes 11-RESULTS.md + recommends the v6.0.0 retag annotation matching the branch the verdict triple produced. Operator-approval (Task 5) and big-mozzy-v2 probe authoring (Task 2) remain checkpoint:human.

**Engineering shipped:**
- `applyConditionalOutcomes` + `loadAndClassifyPhase11` exports in runner.ts.
- 8-branch classifier (engineering_close_strong_bind / within_corpus_bind / recursive_echo, kill_receipt_q1_negative / q1_inconclusive / q2_negative, p11_1_corpus_expansion, incomplete).
- scripts/phase-11-close.cjs:
  - reads q1-verdict.json + (q2-verdict.json | q2-skipped.json) + (q3-verdict.json | q3-skipped.json | absent)
  - classifies branch
  - writes 11-RESULTS.md with verdict triple, Q1 paired-McNemar detail, per-judge error rates, recommended retag annotation
  - supports `--dry-run` (print MD without writing) and `--print-retag-cmd-only` (just the retag command)
- 10 regression tests covering all 8 branches + the print modes.

**Verification:**
- `bun run build` exits 0
- `bunx vitest run src/tests/benchmark/deliberation-surfacing/phase-11-close.test.ts` — 10/10 pass
- `bun run phase-11:close` exits 2 when q1-verdict.json missing (correct — Q1 must run first)
- `bun run vesna` — 26/26 = 100% PASS preserved

**Operator workflow for Phase 11 close-out:**
1. Run Q1 (operator-driven; live ensemble) → q1-verdict.json
2. If BIND_POSITIVE: author 60 disjoint probes (user-pair) → run Q2 → q2-verdict.json
3. If Q2 BIND_POSITIVE: author big-mozzy-v2 30 probes (user-pair, Plan 11-08 Task 2 checkpoint:human) → run Q3 → q3-verdict.json
4. `bun run phase-11:close` — writes 11-RESULTS.md and emits the recommended retag annotation
5. Operator reviews 11-RESULTS.md and approves/rejects the retag annotation (Plan 11-08 Task 5 checkpoint:human)
6. Operator runs `git tag -d v6.0.0 && git tag -a v6.0.0 -m "..."` (the script prints the exact heredoc form)
7. Operator updates STATE.md / ROADMAP.md / REQUIREMENTS.md to mark Phase 11 COMPLETE with the landed branch
8. Operator runs external-review-gate against the published Phase 11 artifacts: `node scripts/external-review-gate.cjs --phase 11 --project claudex-v3 --skip-codex` (dogfood per Plan 11-05)
9. If gate signs off: operator runs `git push origin master --tags` (out of scope for autonomous pipeline; operator-confirmed)

**Deviation:** Plan 11-08 Tasks 2 + 5 are checkpoint:human by design — autonomous: false on the plan. Tasks 1, 3, 4, 6 shipped as engineering scaffolding.

**Next:** Phase 11 close awaits operator action on Tasks 2 + 5 + the steps above. context/handoffs/ACTIVE.md updated with the precise resume sequence.
