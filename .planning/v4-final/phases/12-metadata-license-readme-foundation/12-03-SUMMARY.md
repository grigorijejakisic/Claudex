---
phase: 12-metadata-license-readme-foundation
plan: 03
subsystem: docs
tags: [changelog, release-notes, keep-a-changelog, distribution]
requires: []
provides:
  - "CHANGELOG.md at repo root in Keep-a-Changelog format with [4.0.0] — 2026-04-30 release notes"
affects:
  - "Release-history surface for github.com/grigorijejakisic/Claudex"
  - "[Unreleased] section ready for v4.1 phases to populate"
tech-stack:
  added: []
  patterns:
    - "Keep a Changelog 1.1.0 conventions (Added/Changed/Removed/Fixed)"
    - "Validation block with all four SC#1-#4 evidence numbers cited verbatim from 11-CLOSE-SUMMARY.md"
key-files:
  created:
    - CHANGELOG.md
  modified: []
key-decisions:
  - "16-phase summary distilled — one observational line per phase, sourced from each phase's *-SUMMARY.md / *-CLOSE-SUMMARY.md, not commit-by-commit re-narration"
  - "SC#1-#4 evidence paragraph quotes 11-CLOSE-SUMMARY.md verbatim (17/17 100%, 191/500 token + 4 byte-identical scenarios, aggregate 90 / 6 projects, 3/3 synthetic + 3 HITL-pending)"
  - "Phase 5 / 8 / 9 deletions land in Removed section with their own bullets (benchmark-gate posture, RL stack, cognitive layer); STOR-04 V24 migration also under Removed"
  - "Pre-v4 era acknowledged as internal infrastructure with one-line pointer to git log; v3 phases NOT itemized"
  - "[Unreleased] placeholder at top per Keep a Changelog convention"
requirements-completed:
  - DOC-05
duration: ~2 min
completed: 2026-04-30
commits:
  - 04c1a79 phase(12-03): DOC-05 — CHANGELOG.md with v4.0.0 release notes (16-phase summary + SC#1-#4 evidence)
---

# Phase 12 Plan 03: CHANGELOG.md v4.0.0 Release Notes Summary

Keep-a-Changelog format `CHANGELOG.md` shipped at repo root with `## [4.0.0] — 2026-04-30` release section: validation block with SC#1-#4 evidence quartet; Added section listing 11 v4 phase accomplishments distilled to one line each; Changed section covering assembly pipeline / MEMORY.md schema / advisory voice / cross-project default; Removed section covering Phase 5 benchmark gate, Phase 8 RL stack, Phase 9 cognitive layer (−6021 LOC), and STOR-04 V24 migration (6 tables / 1052 rows); Fixed section covering the Phase 4.1 writer regression and mixed-precision timestamps. Pre-v4 history acknowledged with one-line git-log pointer. `[Unreleased]` placeholder ready for v4.1.

## Tasks completed (2/2)

- **12-03-01:** Read source material (11-CLOSE-SUMMARY.md + per-phase summaries) — read-only step, no commit
- **12-03-02:** Write CHANGELOG.md (commit 04c1a79)

## Files

- **Created:** `CHANGELOG.md` (126 lines)

## Verification

- `head -1 CHANGELOG.md` returns `# Changelog`
- `## [4.0.0] — 2026-04-30` present (1 match)
- 6 `### ` sub-headers (Added/Changed/Removed/Fixed + Validation + Pre-v4 history) — exceeds the 4-minimum
- `SC#1` cited 3 times in Validation block
- `[Unreleased]` placeholder present (2 matches — header + footer link)
- 0 marketing-fluff matches (revolutionary / blazing / powerful / cutting-edge / state-of-the-art)
- 0 reintroduction of benchmarks-as-gates posture (the only matches are in the Removed section describing the v3 posture being deleted, which is the historical record — not a reintroduction)
- LongMemEval / LoCoMo mentioned exactly once, framed as "tracked as archival vibe-checks, not pass/fail criteria"

## Deviations from Plan

None — plan executed as written. The 16-phase framing in CONTEXT.md is honored by listing 11 v4 phases under Added (the deletion phases 5 / 8 / 9 are listed under Removed instead of Added — Keep a Changelog convention puts deletions there, not in the new-capabilities section).

## Next

Ready for plan 12-04 (CONTRIBUTING.md) — already executed in this Wave 1 batch.
