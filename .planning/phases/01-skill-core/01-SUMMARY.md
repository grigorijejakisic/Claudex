---
phase: 1
plan: 1
title: "Unified Review Skill Core"
subsystem: skills
tags: [review, codex, multi-perspective]
requires: []
provides: [unified-review-skill, quality-json-export]
affects: [code-review-workflow]
tech-stack:
  added: [mcp__codex__codex]
  patterns: [parallel-codex-dispatch, severity-tiered-synthesis]
key-files:
  created:
    - ~/.claude/skills/unified-review/SKILL.md
    - ~/.claude/skills/unified-review/prompts.md
key-decisions:
  - "Codex runs git diff itself (read-only sandbox) instead of pasting diff into prompt — avoids token bloat"
  - "3-tier severity (Critical/Recommended/Observations) with perspective source tags for deduplication"
  - "Quality JSON output matches desloppify review --import format exactly (assessments + findings)"
requirements-completed: [REV-01, REV-02, REV-03, REV-04, REV-05, REV-06, REV-07, REV-08, REV-09, REV-10, REV-11]
duration: "2 min"
completed: "2026-02-28"
---

# Phase 1 Plan 1: Unified Review Skill Core Summary

SKILL.md orchestrates 4 parallel Codex MCP reviews (quality, acceptance, security, general) with scope resolution, large-diff gating, graceful degradation, 3-tier severity synthesis, letter grading (A-F), and desloppify-compatible quality JSON export. prompts.md provides 4 structured prompt templates with machine-parseable output formats and `{SCOPE_COMMAND}` placeholders.

## Execution

- **Duration:** ~2 min
- **Tasks:** 2 (T01: SKILL.md, T02: prompts.md)
- **Files created:** 2

## Task Outcomes

| Task | Title | Status | Files |
|------|-------|--------|-------|
| T01 | Create SKILL.md | Done | ~/.claude/skills/unified-review/SKILL.md |
| T02 | Create prompts.md | Done | ~/.claude/skills/unified-review/prompts.md |

## Verification

- [x] SKILL.md exists with valid frontmatter (name, description, allowed-tools including mcp__codex__codex)
- [x] prompts.md exists with 4 distinct prompt templates
- [x] Scope resolution: uncommitted (default), branch diff, specific commit [REV-01]
- [x] Large diff warning >2000 lines [REV-11]
- [x] Quality prompt scores all 7 desloppify dimensions 0-100 [REV-02]
- [x] Quality JSON matches `{"assessments": {...}, "findings": [...]}` [REV-09]
- [x] Acceptance covers correctness, edge cases, logic bugs, contracts [REV-03]
- [x] Security covers injection, auth, crypto, data exposure, blast radius [REV-04]
- [x] General covers clarity, architecture, testing [REV-05]
- [x] All 4 dispatched via mcp__codex__codex with sandbox: read-only, approval-policy: never [REV-06]
- [x] Synthesis deduplicates and classifies Critical/Recommended/Observations [REV-07]
- [x] Report includes grade A-F, severity sections, perspective tags [REV-08]
- [x] Graceful degradation handles partial Codex failures [REV-10]

## Deviations from Plan

None - plan executed exactly as written.

## Next Steps

Phase complete, ready for Phase 2 (Live Validation).
