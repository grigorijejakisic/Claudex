---
phase: 12-metadata-license-readme-foundation
plan: 04
subsystem: docs
tags: [contributing, dev-setup, commit-convention, hook-safety, distribution]
requires: []
provides:
  - "CONTRIBUTING.md at repo root covering dev setup, test commands, commit convention, PR workflow, hook safety"
affects:
  - "GitHub community-standards surfacing (PR banner, Insights → Community Standards)"
tech-stack:
  added: []
  patterns:
    - "bun run test vs bun test warning as load-bearing onboarding rule"
    - "Conventional Commits + phase(NN-MM): convention documented for contributors"
    - "Hook safety rules (no CLIProxyAPI, always await) explicit"
key-files:
  created:
    - CONTRIBUTING.md
  modified: []
key-decisions:
  - "Separate file (not README section) per CONTEXT.md decision — GitHub auto-surfaces CONTRIBUTING.md as a community standard"
  - "CI section references actual .github/workflows/vesna.yml (verified to exist) — no Phase 17 placeholder needed"
  - "PR workflow gate language uses local-run framing (bun run vesna must pass; CI enforces it) rather than benchmark-gate framing"
  - "Pointer to .claude/rules/ rather than inlining architectural detail — keeps CONTRIBUTING focused on contribution mechanics"
requirements-completed:
  - DOC-06
duration: ~2 min
completed: 2026-04-30
commits:
  - d67efca phase(12-04): DOC-06 — CONTRIBUTING.md with dev setup, bun run test warning, commit convention, hook safety
---

# Phase 12 Plan 04: CONTRIBUTING.md Summary

`CONTRIBUTING.md` shipped at repo root as a separate file (not a README section). Covers development setup (clone / bun install / bun run build, plus Bun ≥1.3 + Ollama + Claude Code prereqs), running tests with the load-bearing `bun run test` vs `bun test` warning, Conventional Commits convention including the `phase(NN-MM):` pattern, PR workflow with the four local gates (build, test, vesna, sc3), hook safety (no CLIProxyAPI from hooks; always await), and a pointer to `.claude/rules/` for the deeper architectural surface.

## Tasks completed (2/2)

- **12-04-01:** Verify `.github/workflows/vesna.yml` exists — confirmed present, CI section uses the "first variant" referencing the workflow file by name
- **12-04-02:** Write CONTRIBUTING.md (commit d67efca)

## Files

- **Created:** `CONTRIBUTING.md` (111 lines)

## Verification

- `head -1 CONTRIBUTING.md` returns `# Contributing to Claudex`
- `bun run test` mentioned 3 times; `bun test` warning mentioned 2 times
- `Conventional Commits` linked once
- `phase(NN-MM)` convention documented (1 match) with concrete example `phase(12-03)`
- `CLIProxyAPI` and `deadlock` both present (2 matches)
- `.claude/rules` referenced 2 times (architectural-context section + intro)
- 0 marketing-fluff matches
- No emoji
- `bun run build` and `bun run test` unaffected (no code change)

## Deviations from Plan

None — plan executed as written. The `.github/workflows/vesna.yml` existence check (task 12-04-01) returned positive, so the CI section uses the first variant referencing the file by name (no Phase 17 deferral language needed).

## Next

Wave 1 complete. Ready for wave 2 plan 12-05 (README rewrite).
