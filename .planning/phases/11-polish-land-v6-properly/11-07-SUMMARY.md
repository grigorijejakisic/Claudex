---
phase: 11-polish-land-v6-properly
plan: 07
subsystem: benchmark/deliberation-surfacing
tags: [polish, w3-scaffolding, q2-gate, disjoint-pool-rules, validator]
requires: [11-06]
provides:
  - "readQ1Gate(outDir) — gate-reader returns proceed=true only if q1-verdict.json exists AND verdict === 'BIND_POSITIVE'"
  - "writeQ2Skipped(reason, outDir, q1?) — emits q2-skipped.json with skip reason for Plan 11-08 audit"
  - "q2-probe-rules.md — 9 selection criteria for the 60-probe disjoint pool (kind balance, ID convention, P9 disjointness, parametric-knowledge avoidance, source distribution, anchor freshness)"
  - "scripts/validate-q2-probes.cjs — exit 0 valid / 1 violation / 2 file shape error"
  - "9 regression tests (kind balance, drift- prefix forbidden, P9 disjointness, source distribution, parametric-likely term flagging)"
affects:
  - "11-08 (q2-verdict.json or q2-skipped.json consumed by loadAndClassifyPhase11)"
tech-stack:
  added: []
  patterns:
    - "Validator before commit pattern: probe pool authoring is operator work; the script ensures structural rules are met before the pool is locked-eligible"
    - "Skip-record pattern: q2-skipped.json emitted in early-fail paths preserves audit-trail visibility (vs silent absence)"
key-files:
  created:
    - "scripts/validate-q2-probes.cjs"
    - ".planning/phases/11-polish-land-v6-properly/q2-probe-rules.md"
    - "src/tests/benchmark/deliberation-surfacing/validate-q2-probes.test.ts (9 tests)"
  modified:
    - "src/benchmark/deliberation-surfacing/runner.ts (readQ1Gate + writeQ2Skipped exports)"
    - "package.json (phase-11:validate-q2 script)"
key-decisions:
  - "Engineering-only scope — Plan 11-07 Task 1 lands the gate-reader + rules + validator; Task 2 (60-probe authoring) is user-pair work per CONTEXT line 108."
  - "Validator runs as a CI gate before q2-locked-probes.json can be committed. Probe pool is locked-eligible only when validator exits 0."
  - "ID convention `q2-{kind}-{NN}` (NN 01-12) makes disjointness from P9's `drift-{kind}-{NN}` lexically obvious. Validator forbids `drift-` prefix."
  - "≥70% real source distribution preserves the P9 schema constraint."
  - "Parametric-likely terms must be explicitly flagged (`parametric_risk: 'mentioned'`) — defense against fixture drift toward training-data-overlap probes."
  - "Anchor freshness rule (item 9): Q2 anchors should sample from sessions later than P9's clustering — substrate state the agent could not have memorized at P9 authoring time."
requirements-completed: [POLISH-14]
duration: "engineering scaffolding only — Task 1 of plan; Task 2 (probe authoring) remains user-pair operator work"
completed: "2026-05-09"
---

# Phase 11 Plan 07: Q2 disjoint-probe gate-reader + authoring rules (engineering scaffolding) Summary

**One-liner:** Q2 gate-reader (`readQ1Gate`) + 60-probe disjoint-pool authoring rules + validator script shipped. The 60 probes themselves are user-pair work per CONTEXT line 108.

**Engineering shipped:**
- Gate-reader in runner.ts that consumes q1-verdict.json and returns `proceed=true` only on BIND_POSITIVE.
- Skip-record writer for q2-skipped.json on early-fail paths.
- 9 selection criteria in q2-probe-rules.md (kind balance 12 each / a-e, ID convention `q2-{kind}-{NN}`, P9 anchor disjointness, parametric-knowledge avoidance, ≥70% real source, anchor freshness, etc.).
- Validator at scripts/validate-q2-probes.cjs covering all 9 rules.
- 9 regression tests.

**Verification:**
- `bun run build` exits 0
- `bunx vitest run src/tests/benchmark/deliberation-surfacing/validate-q2-probes.test.ts` — 9/9 pass
- `bun run phase-11:validate-q2` exits 2 when q2-locked-probes.json missing (correct — operator must author first)
- `bun run vesna` — 26/26 = 100% PASS preserved

**Deviation:** Plan 11-07 Task 2 (60-probe authoring) is intentionally not executed. CONTEXT line 108 explicitly: "orchestrator can't write drift fixtures for an unfamiliar domain alone." The fresh-probe-set authoring requires user-pair work (operator + LLM together against the actual session archive). Operator workflow documented in q2-probe-rules.md.

**Next:** Plan 11-08 (close-out + 11-RESULTS.md + retag — auto Tasks 1/3/4/6).
