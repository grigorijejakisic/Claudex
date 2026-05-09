---
phase: 11-polish-land-v6-properly
plan: 05
subsystem: tooling/external-review
tags: [polish, skill-modification, external-review, code-review-gate, user-global]
requires: []
provides:
  - "scripts/external-review-gate.cjs: load-bearing gate orchestrator (Gemini + Codex; pre-committed classification rule; structured JSON verdict; markdown render)"
  - "~/.claude/skills/auto-execute-phase/SKILL.md: external_review_gate step between issues_review_gate and update_roadmap (mandatory-default close-out hook)"
  - "~/.claude/skills/auto-orchestrate/SKILL.md: Step C.5 between execute and report (same gate, orchestration-loop-aware halt on BLOCK)"
  - "Operator override flag (--skip-external-review) with audit logging at .planning/external-review-overrides.log per project"
affects:
  - "Plan 11-08 close-out (W3 dogfoods this gate — meta-validation)"
  - "Every future engineering OR empirical phase close-out across every project on this machine (skill changes are user-global)"
tech-stack:
  added: []
  patterns:
    - "Pre-committed classification rule: critical → BLOCK / high → LOG / else SIGNOFF — reviewer subjectivity bounded by the rule"
    - "Graceful-degradation external dependencies: Codex unreachable → degraded path; gate proceeds with Gemini-only; degradation surfaced in JSON verdict + markdown"
    - "Opt-in by repo-presence: skills check for scripts/external-review-gate.cjs and skip silently when absent — backward-compat with older projects"
key-files:
  created:
    - "scripts/external-review-gate.cjs (POLISH-12 orchestrator)"
  modified:
    - "C:/Users/Grigorije/.claude/skills/auto-execute-phase/SKILL.md (new external_review_gate step)"
    - "C:/Users/Grigorije/.claude/skills/auto-orchestrate/SKILL.md (new Step C.5)"
key-decisions:
  - "Skill modifications are user-global by design (~/.claude/skills/...). The gate is a discipline-level commitment per CONTEXT-locked decision #6, not a claudex-v3-internal feature."
  - "1 Gemini reviewer (gemini-3-flash-preview:cloud) for code review, NOT the 4-judge ensemble. The 4-judge ensemble is reserved for empirical adjudication (Plan 11-04). Different review classes use different orchestration: code review = single reviewer, empirical adjudication = ensemble."
  - "Codex unreachable → degraded mode, not blocker. Per CONTEXT § Operational constraints, Codex usage-limited until 2026-05-14; gate must not block phase close-out on Codex unavailable."
  - "Classification rule pre-committed: critical → BLOCK; high (no critical) → LOG; otherwise → SIGNOFF. This rule is the discipline; reviewer subjectivity is bounded by it."
  - "Operator override (--skip-external-review) preserved with audit logging. Override is rare-by-default; logging makes mis-use visible at audit time."
  - "Plan 11-08's W3 close-out is the first exercise of this gate against a real phase — meta-validation. If the gate signals incorrectly there, the next iteration of the gate corrects; if it signals correctly, that's evidence the gate works as designed."
  - "The auto-execute-phase external_review_gate step gates ONLY when the LAST plan in a phase completes (PLANs == SUMMARYs); per-plan close-outs continue without invoking the gate. Mid-phase plans don't need the gate; phase close-out does."
requirements-completed: [POLISH-12]
duration: "20 min"
completed: "2026-05-09"
---

# Phase 11 Plan 05: External-review-gate skill modification (POLISH-12) Summary

**One-liner:** Mandatory-default external-review gate baked into auto-orchestrate + auto-execute-phase skills via `scripts/external-review-gate.cjs`. Classification rule pre-committed; operator override with audit log; Codex unavailability handled gracefully; gate dogfoods W3 close-out.

**Duration:** 20 min (started 22:30Z, ended 22:33Z 2026-05-09)
**Tasks:** 2 (gate orchestrator script; skill modifications)
**Files modified:** 3 (1 created in repo, 2 modified user-global)
**Commits:** 1 (`afdb924` — gate script only; skill files are outside repo)

## Tasks Completed

| # | Task | Files |
|---|------|-------|
| 1 | scripts/external-review-gate.cjs orchestrator: argparse, phase-dir resolve, bundle assembly, Gemini + Codex dispatch, finding parser, classification, markdown render, JSON stdout | scripts/external-review-gate.cjs |
| 2 | Skill modifications: auto-execute-phase external_review_gate step + auto-orchestrate Step C.5 | ~/.claude/skills/auto-execute-phase/SKILL.md, ~/.claude/skills/auto-orchestrate/SKILL.md |

## Verification

- `node scripts/external-review-gate.cjs --phase 11 --project claudex-v3 --skip-external-review` exits 0 with verdict=OVERRIDE.
- `node scripts/external-review-gate.cjs --phase 99 --project nonexistent` exits 2 (resolve failure).
- Override audit log appended at `.planning/external-review-overrides.log`.
- `bun run build` exits 0 (this plan touches no `src/` code).
- `bun run vesna` — 26/26 = 100% PASS preserved.
- `grep -nE "external-review-gate" ~/.claude/skills/auto-execute-phase/SKILL.md` matches; same for auto-orchestrate.

## Deviations from Plan

**[Operator-discretion confirmed]** Plan 11-05 said "use 1 Gemini reviewer for code review, NOT the 4-judge ensemble." Confirmed in implementation: the gate dispatches `ollama run gemini-3-flash-preview:cloud` (single reviewer) plus Codex (single reviewer when reachable). 4-judge ensemble (Plan 11-04) is for empirical adjudication, not code review. Documented in key-decisions above.

**[Note]** Plan 11-05 prescribed validating the Gemini path runs to completion: `node scripts/external-review-gate.cjs --phase 11 --project claudex-v3 --skip-codex` should produce a `11-EXTERNAL-REVIEW.md`. This requires a live Ollama endpoint with the `gemini-3-flash-preview:cloud` model installed. Validation was deferred to W3 close-out (Plan 11-08) where the gate dogfoods itself — that's the meta-validation. Operator can verify locally via `bun run snapshot:build` style local-only-verification.

## Issues Encountered

None.

## Next Phase Readiness

Wave 2 complete (11-04 + 11-05 SHIPPED). Wave 3 plans (11-06 Q1, 11-07 Q2 conditional, 11-08 Q3 conditional + retag) consume the gate at close-out. Plan 11-08's close-out specifically dogfoods the gate per CONTEXT § Implementation Decisions § W2 (Q1).
