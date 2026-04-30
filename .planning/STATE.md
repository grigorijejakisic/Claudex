# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-30)

**Core value:** v4 makes the agent USE Claudex organically as part of how it works in Claude Code. v4.0.0 SHIPPED 2026-04-30. Current milestone v4.1 = Distribution (make Claudex installable by strangers + ship to `grigorijejakisic/claudex` public).

**Current focus:** **v4.1 Distribution roadmap drafted (2026-04-30).** 6-phase structure (Phases 12-17) covers all 44 v4.1 requirements with 100% coverage. Locked decisions: license MIT, platforms Windows + Mac + Linux, harness Claude Code only, self-host only, public ship target `github.com/grigorijejakisic/claudex`. v4.0 history preserved below in Accumulated Context.

## Current Position

**Current Milestone:** v4.1 — Distribution
**Phase:** Not started — Phase 12 (Metadata + License + README foundation) is next
**Plan:** —
**Status:** Roadmap drafted; awaiting plan-phase on Phase 12
**Last activity:** 2026-04-30 — v4.1 roadmap created (Phases 12-17, 44 reqs mapped, 100% coverage)

### v4.1 Phase Structure

| Phase | Goal | Requirements |
|-------|------|--------------|
| 12 — Metadata + License + README foundation | Establish Claudex as MIT-licensed and externally legible | LIC-01..03, DOC-01, DOC-02, DOC-05, DOC-06 (7 reqs) |
| 13 — Cross-platform code audit | Code-only portability sweep across paths/hooks/locks/subprocess/line endings | PLAT-01..05 (5 reqs) |
| 14 — Bootstrap install + configurable paths | One-command `bun run setup` + `CLAUDEX_PROJECTS_DIR` + first-session UX | INST-01..07 (7 reqs) |
| 15 — `claudex doctor` diagnostics | Self-diagnosis surface (Bun, Ollama, port 7439, DB, hooks, Angel) | DIAG-01..08 (8 reqs) |
| 16 — Onboarding verification + README polish | HITL fresh-VM installs (macOS/Ubuntu/Windows); <30-min target | PLAT-06..08, VER-01..05, DOC-03, DOC-04 (10 reqs) |
| 17 — Public ship to grigorijejakisic/claudex | Tag + push + GitHub release + topics + branch protection | REL-01..07 (7 reqs) |

**Coverage:** 44/44 v4.1 requirements mapped. No orphans. No duplicates.

**HITL constraint flagged:** Phase 16 success criteria (PLAT-06/07/08 + VER-01..05 + <30-min target) require operator-driven fresh-VM testing. Plan-phase will produce per-platform operator runbooks; phase closes once each platform's fixture is filled in. Pattern mirrors Phase 11 SC#4 (synthetic + live trials operator-runnable).

**Prior status (v4.0 SHIPPED 2026-04-30 at v4.0.0):** All SC#1-#4 PASS with evidence: SC#1 Vesna 17/17=100% per category; SC#2 12/12 cache-stable (191/500 budget headroom); SC#3 mechanical scorer aggregate 90 across 6 projects each ≥80; SC#4 synthetic Vesna 3/3 PASS + 3 live HITL-pending. STOR-04 closed (V24 dropped 6 legacy *_old tables, 1052 rows, after zero-caller audit; DB backup at ~/.claudex/backups/pre-v4-phase-11-drop-old-20260430-181007.db). Benchmark vibe-check: LongMemEval Oracle 89.6% archival (within drift vs 90.6% baseline); LoCoMo 55.5% archival (no Phase 9-10 pressure). Non-gating per CONTEXT axiom. v4.1 Distribution stub at .planning/v4.1-distribution/STUB.md was the basis for this milestone's REQUIREMENTS.md.
**Last Activity:** 2026-04-30
**Last Activity Description:** v4.1 Distribution roadmap drafted. 6 phases (12-17) appended to ROADMAP.md after the v4.0.0 SHIPPED divider. 44/44 reqs mapped, 100% coverage, no orphans. Phase 16 flagged as HITL-pending (operator-driven fresh-VM installs on macOS/Ubuntu 24.04/Windows 11). Roadmap structure derived from REQUIREMENTS.md categories (LIC + DOC = Phase 12, PLAT-01..05 = Phase 13, INST = Phase 14, DIAG = Phase 15, PLAT-06..08 + VER + DOC-03/04 = Phase 16, REL = Phase 17). Phase 12 is next.
**Progress:** [░░░░░░░░░░] 0% (v4.1 milestone — 0 of 6 phases started)

Phase: 12 of 17 — Phase 12 not started (Phase 11 closed, v4.0.0 SHIPPED)
Plan: — (awaiting plan-phase on Phase 12)
Status: v4.0 SHIPPED — v4.1 Distribution roadmap drafted, ready for plan-phase

Progress: [░░░░░░░░░░░░░░░░░░░░░░] 0% (v4.1)

## Accumulated Context

### Decisions

Decisions logged in PROJECT.md Key Decisions table. Summary:

**P0 (2026-04-19) — original locks:**
- Q1 transcript chunking — LLM topic-detected boundaries
- Q2 MEMORY.md schema — sectioned markdown (superseded by Q5)
- Q3 directive threshold — regex + LLM-confirm, ≥0.7 starting
- Q4 project_curated_context — migrate to `artifact(kind='mental_model')`, flag stale entries

**Audit rebind (2026-04-27) — supersedes/extends P0:**
- Q5 MEMORY.md schema — drop `## Entities` + `## Recent Threads` (frequency-extraction noise); add `## Lessons` (task-pattern indexed pointers); promote `## User Notes`. Supersedes Q2.
- Q6 Goal — agent USES Claudex organically (verb, not vibe). Memory tools used like `Read`/`Grep`.
- Q7 Success criteria — SC#1 Vesna ≥80% (behavioral), SC#2 ≤500 token cache-stable (structural), SC#3 content-quality ≥80% (mechanical), SC#4 one-turn handoff pickup (continuity). Replace all benchmark-as-gate language.
- Q8 Benchmarks — DROPPED ENTIRELY. Not gates, not floors, not sanity. Harness on disk; runnable on demand; one-shot at v4 ship for archival record only.
- Q9 Phase 3 + Phase 10 merge — directive detector ships with PreToolUse consumer + lifecycle (scope, supersession, decay) as one unit.
- Q10 Cross-project recall default — ON. Methodology and knowledge cross-pollinate by default.
- Q11 Handoff format — hybrid (2-line YAML status header + ADR-style body). Replaces 372-line schema with ~15 lines.
- Q12 Phase ordering — 4.1 first (unblocks behavioral exercise of 5).

**v4.1 milestone kickoff (2026-04-30):**
- License MIT (LIC-01..03 implementation)
- Platforms Windows + Mac + Linux (full cross-platform audit; PLAT-01..08)
- Harness Claude Code only (Cursor/Zed/etc deferred to v4.2+)
- Self-host only (no hosted/SaaS variant — v4.2+ if at all)
- Public ship target `github.com/grigorijejakisic/claudex`
- Phase 16 = HITL-pending (operator-driven VM testing structurally required for PLAT-06/07/08 + VER-01..05; cannot be fully automated)

### Pending Todos

- Plan-phase on Phase 12 (Metadata + License + README foundation) — next concrete unit of work.
- Operator (user) to schedule three fresh-VM testing windows for Phase 16 (macOS, Ubuntu 24.04 LTS, Windows 11). These can be planned in parallel with Phase 12-15 work but the actual runs gate Phase 16 close.

### Blockers/Concerns

(No active blockers for v4.1 Phase 12. v4.0 carry-forward concerns parked in `.planning/v4.1-distribution/STUB.md` — those are v4.2+ and do not gate Distribution work.)

**v4.0 carry-forward items still open at v4 ship** (tracked in REQUIREMENTS.md `## v4.2+ Requirements (Deferred)`, NOT v4.1 scope):
- STOR-09 task-pattern fingerprint column on artifact kinds (write-time auto-classification)
- EXTR-04 (held-out recall measurement, `negation_dont` family tune) + EXTR-06 (transcript chunking)
- LIFE-01..04 (directive lifecycle — scope, supersession, decay, accumulation)
- DIR-CONSUMER-01..02 (PreToolUse hook surface for directives)
- FRAM-05 (week-of-use behavioral A/B subjective verdict, due 2026-05-06)
- HAND-03 (handoff pickup probe live trials operator-runnable; synthetic 3/3 already shipped)

These are NOT Distribution work — they're internal cleanup. Re-roadmapping them is a v4.2 milestone activity.

## v4.0 Phase 9 sub-phases shipped (preserved for reference)

(Closed 2026-04-30 — Phase 9 complete across 8 sub-phase atomic commits + 1 close commit.)

- 9.2 (autonomous-investigator) — shipped 2026-04-30, Vesna 8/8
- 9.1 (cara-reasoning) — shipped 2026-04-30, Vesna 8/8
- 9.3 (consolidator dream) — shipped 2026-04-30, Vesna 8/8
- 9.4 (crystallizePatternToSkill) — shipped 2026-04-30, Vesna 8/8 (skill-writer.ts kept; bridgeCorrectionToSkill is a live consumer)
- 9.5 (cross-project-consolidator) — shipped 2026-04-30, Vesna 8/8 (cross-project canary 4/4 PASS)
- 9.6 (proactive-curator) — shipped 2026-04-30, Vesna 8/8 (also dropped guardian.test.ts Proactive Curator section to keep file collectable)
- 9.7 (data-quality) — shipped 2026-04-30, Vesna 8/8 (also dropped guardian.test.ts Data Quality section)
- 9.8 (RL stack + V23 migration) — shipped 2026-04-30, Vesna 8/8; 7 RL files + 3 RL tests + obsolete phase-8 ablation test deleted; qMultiplier stripped from hybrid-retrieval; heartbeat Phase 8/4d3 RL blocks removed; V23 drops policy_weights table + artifacts.q_value column; 11 migration tests bumped to user_version 23; policy-registry.ts kept (T6 audit error — non-RL singleton with 8+ live consumers); LOC delta ~−2700
- 9.9 (phase close) — shipped 2026-04-30, Vesna aggregate 32/32 (100%) across 5 integration test files (multiplier-ablation + cross-project + handoff-pickup + advisory-voice + self-instrumentation); heartbeat tick comments 38→28 (10 dropped); REQUIREMENTS.md/STATE.md/ROADMAP.md/SUMMARY.md/VESNA-RESULT.md updated; CUR-05/06/07, EXTR-05, RETR-05 closed

## Session Continuity

Last session: 2026-04-30
Stopped at: v4.0.0 SHIPPED → v4.1 milestone kickoff → REQUIREMENTS.md authored (44 reqs across 7 categories) → ROADMAP.md drafted (6 phases, 12-17, 100% coverage). Phase 12 is the next concrete unit.
Resume file: .planning/ROADMAP.md (v4.1 section) + .planning/REQUIREMENTS.md (Traceability table)

### v4.1 roadmap notes — 2026-04-30

Six phases derived from natural delivery boundaries in the 44-req category structure:

- **Phase 12** combines small/independent items: LIC (3 reqs) + DOC subset that doesn't depend on INST or DIAG (DOC-01 what/who, DOC-02 why, DOC-05 changelog, DOC-06 contributing). Makes the repo externally legible before any portability or install work.
- **Phase 13** is code-only cross-platform audit (PLAT-01..05). Splits cleanly from PLAT-06..08 (which require fresh-VM runs).
- **Phase 14** ships INST entirely as one bucket (7 reqs) — bootstrap, Ollama+model+reranker, configurable paths, first-session UX. INST-01..07 are tightly coupled deliverables.
- **Phase 15** ships DIAG entirely (8 reqs). Separated from Phase 14 because doctor checks the prereqs that bootstrap installs — natural sequencing.
- **Phase 16** is the HITL phase: PLAT-06/07/08 (3 fresh-VM regressions) + VER-01..05 (5 onboarding fixtures) + DOC-03 (Quick Start, depends on INST working) + DOC-04 (Troubleshooting, depends on DIAG existing). Operator-runnable runbooks; closes once three fixtures filled.
- **Phase 17** is REL ship-out (7 reqs). Strictly last — tagging and pushing happens after every other phase is green.

DOC-03 + DOC-04 deferred to Phase 16 (not Phase 12) because Quick Start can't honestly walk a stranger through `bun run setup → working session` until INST works, and Troubleshooting can't reference doctor checks until DIAG exists.

LIC-02 spans two phases conceptually (`"private": true` removal + `"license": "MIT"` add) but lands as a single change in Phase 12 alongside LIC-01 and LIC-03.

PLAT category split: PLAT-01..05 (code-only) → Phase 13; PLAT-06..08 (fresh-VM regression checks) → Phase 16. This keeps Phase 13 fully automatable while honoring the HITL constraint on cross-OS verification.

REQUIREMENTS.md traceability table updated with Phase column and Status column for all 44 reqs. Coverage: 44/44, no orphans, no duplicates.
