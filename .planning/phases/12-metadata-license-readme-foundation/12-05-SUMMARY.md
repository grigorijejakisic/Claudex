---
phase: 12-metadata-license-readme-foundation
plan: 05
subsystem: docs
tags: [readme, doc-01, doc-02, distribution, voice]
requires:
  - phase: 12-01
    provides: LICENSE for footer link
  - phase: 12-03
    provides: CHANGELOG.md for documentation links
  - phase: 12-04
    provides: CONTRIBUTING.md for documentation links
provides:
  - "README.md at repo root rewritten with What+Why under 500-word cap, verbatim shadowban example, footer links to LICENSE/CHANGELOG/CONTRIBUTING/.claude/rules/"
affects:
  - "github.com/grigorijejakisic/Claudex landing-page first impression for strangers"
  - "60-second axiom: stranger reads → understands what Claudex is, who it's for, why it matters, that it's MIT-licensed"
tech-stack:
  added: []
  patterns:
    - "What is Claudex? + Why Claudex? combined under 500 words (mechanical wc -w verification)"
    - "Verbatim shadowban canonical example (PROJECT.md core value) preserved including (1)/(2)/(3) enumeration and 'all without being told to query memory' closer"
key-files:
  created: []
  modified:
    - README.md
key-decisions:
  - "Full rewrite (not patch) — old v3-era 'Persistent memory that makes LLM agents actually remember' framing replaced end-to-end"
  - "What section: 134 words; Why section: 193 words; combined 327 (well under 500-word hard cap)"
  - "Quick Start and Troubleshooting deferred to Phase 16 with 'Coming in v4.1' placeholder pointing to CHANGELOG"
  - "No insider jargon above the fold (no Vesna / SC#1-#4 / V15 / FTS5 / sqlite-vec / RRF / BGE / advisory voice / hybrid retrieval)"
  - "No status badges yet (per CONTEXT.md authorization line 140 — populate in Phase 17 once public CI is green)"
requirements-completed:
  - DOC-01
  - DOC-02
duration: ~2 min
completed: 2026-04-30
commits:
  - fbb1acd phase(12-05): DOC-01,DOC-02 — README rewrite (What+Why under 500 words, verbatim shadowban example)
---

# Phase 12 Plan 05: README Rewrite Summary

`README.md` fully rewritten end-to-end (24 insertions, 194 deletions). Replaces v3-era "Persistent memory that makes LLM agents actually remember" framing with v4.1-aligned content: tagline "Persistent memory for LLM coding agents — they reach for it the way they reach for Grep"; status banner pointing to CHANGELOG; What is Claudex? section (134 words, plain English, no insider jargon); Why Claudex? section (193 words) with the verbatim canonical shadowban example from PROJECT.md core value preserved including the (1)/(2)/(3) enumeration and "all without being told to query memory" closer; Installation placeholder deferring to v4.1 / Phase 16; Documentation links section pointing to CHANGELOG.md / CONTRIBUTING.md / `.claude/rules/` / `.planning/PROJECT.md`; License footer linking to LICENSE.

## Tasks completed (2/2)

- **12-05-01:** Read PROJECT.md to absorb voice and confirm shadowban quote — read-only, no commit
- **12-05-02:** Write README.md replacing v3-era content (commit fbb1acd)

## Files

- **Modified:** `README.md` (+24 / -194 — full rewrite)

## Verification (every plan check passed)

- `head -1 README.md` → `# Claudex`
- `What is Claudex?` and `Why Claudex?` headers each present once
- Verbatim shadowban triplet present: `60 HTTP polls to backend X` (1 match), `15-min IP shadowban` (1 match), `all without being told to query memory` (1 match)
- **Word-count check:** `awk` extraction → What 134w + Why 193w = **327w combined**, under the 500-word hard cap
- 0 v3 stale claims (`550+ sessions`, `30,000+ observations`, `incremental checkpointing`, `context-aware intelligence`)
- 0 insider-jargon matches above the Installation section (Vesna / SC#1-#4 / V15 / FTS5 / sqlite-vec / RRF / BGE / advisory voice / hybrid retrieval)
- 0 marketing-fluff matches (revolutionary / blazing / cutting-edge / state-of-the-art / game-chang / next-gen)
- 0 benchmarks-as-gates language; 0 LongMemEval / LoCoMo mentions
- No emoji
- All footer links resolve to existing files: LICENSE, CHANGELOG.md, CONTRIBUTING.md, `.claude/rules/`, `.planning/PROJECT.md`
- `bun run build` and `bun run test` unaffected (no code change)

## Deviations from Plan

None — plan executed exactly as written. The What section came in at 134 words (slightly under the ~150 target); the Why section at 193 words (under the ~250 target); the combined total at 327 words leaves comfortable headroom under the 500-word hard cap.

## Next

Phase 12 plans complete (5/5). Ready for phase-close commit (STATE.md / ROADMAP.md / REQUIREMENTS.md updates marking Phase 12 [x] and LIC-01..03 + DOC-01/02/05/06 [x]).
