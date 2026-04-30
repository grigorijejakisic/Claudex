# Plan 10-02 Summary — Migrate 5 existing probes + 3 buffer placeholders

**Closed:** 2026-04-30
**Wave:** 2 (parallel-able with 10-03 / 10-04)
**Requirements satisfied (partial):** VESN-02 (5/17 core slots filled; 3/3 buffer)

## Migrated Probes

| Old name | New id | Category | Source | Behavioral intent preserved |
|---|---|---|---|---|
| handoff-pickup-active | handoff-001 | handoff-pickup | phase-7.5-design / claudex-v3 | Active handoff first-line surfaces topic + phase; no body leak |
| handoff-pickup-paused | handoff-002 | handoff-pickup | phase-7.5-design / claudex-v3 | Paused handoff renders status-aware "paused at phase N"; no auto-resume |
| handoff-pickup-archived | handoff-003 | handoff-pickup | phase-7.5-design / claudex-v3 | Archived/missing handoff renders "no active handoff"; no invention |
| recall-observability-gap-detection | self-instrumented-001 | self-instrumented | phase-8.5-design / claudex-v3 | Gold-result narration: agent says "checking ... applying" |
| recall-observability-empty-surface | self-instrumented-002 | self-instrumented | phase-8.5-design / claudex-v3 | Empty-surface narration: "no prior experience" / "going in cold" |

## Buffer Placeholders

| Id | Category | source_session_id | Status |
|---|---|---|---|
| buffer-001 | buffer | phase-10-design | Unallocated, claimable |
| buffer-002 | buffer | phase-10-design | Unallocated, claimable |
| buffer-003 | buffer | phase-10-design | Unallocated, claimable |

## Lexical-Exclusion Adjustments

- **handoff-001**: removed `"pick up"` from exclusions (it's in the prompt and only the user_prompt is tested by pre-flight; removed because forbidding it provided no perceptual signal). Exclusions: `handoff, active, phase 5, tier-deletion, phase-5, ACTIVE.md` — none in `"Pick up where things were."`.
- **handoff-003**: changed user_prompt from `"Anything in flight?"` to `"Anything I should pick up on?"` (Plan 10-03 PLAN warned `"in flight"` was problematic, but the deeper issue is `"in flight"` is generic — keeping the simpler "pick up on?" prompt aligns with the active-handoff probe's neutral phrasing). Exclusions: `handoff, archived, phase 3, ACTIVE.md` — none in user_prompt.
- **self-instrumented-002**: kept `lexical_exclusions: []` per Plan 10-02's design note. Reason: empty-surface probes test narration of ABSENCE; there is no memory text to lexically diverge from. The `"XZRT-77"` placeholder name in the prompt is the absent topic, not a leak. Schema permits empty exclusions explicitly.
- **self-instrumented-002**: changed `must_contain_phrase_pattern` from `["no prior experience", "going in cold"]` (AND) to `["no prior experience|going in cold"]` (single regex with alternation) per Plan 10-02 task 2 — Plan 01's evaluator uses AND-semantics and either narration form is acceptable.

## Obsolete Fields Dropped

Each migrated probe drops: `name`, `description`, `tags`, `setup` (flat shape), `assert`, `fail_signals`, `runtime`. The new shape replaces them with: `id`, `scenario`, `setup_steps`, `expected_recall.must_contain_phrase_pattern`, and runner-emitted diagnostics (replacing `fail_signals` — the runner emits them dynamically).

## Hand-Verification

`bun run vesna -- --json` against the migrated 5 + 3 buffers:

```
handoff-pickup:    3/3 (100%) flaky=0
self-instrumented: 2/2 (100%) flaky=0
buffer:            0/0  (excluded — buffers don't run)
AGGREGATE: 100% — GATED PASS
exit 0
```

All 5 migrated probes pass through the harness against the canonical schema; lexical pre-flight passes; buffer placeholders are skipped per Plan 01 spec (not run, excluded from totals).

## Total Probe Count After Plan 10-02

8 probes loaded:
- 3 handoff-pickup (handoff-001/002/003)
- 2 self-instrumented (self-instrumented-001/002)
- 3 buffer placeholders (buffer-001/002/003)

Plans 10-03 and 10-04 add the remaining 12 (entity 3 + constraint 3 + cross-project 3 + lesson-application 3). Final corpus target: 20.

## Hand-forward

Plan 10-03 / 10-04 author against the same canonical schema. Buffer slots remain available for future phases (6.5, 8.5+, etc.) to claim during their own probe authoring.
