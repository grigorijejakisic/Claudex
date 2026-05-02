# Changelog

All notable changes to Claudex are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- _Nothing yet._ Track v4.2 milestone planning at `.planning/STATE.md` once it kicks off.

## [4.1.1] — 2026-05-02

Patch release. Fixes a stranger-blocking regression in `bun run setup` where step 8/8 (hook registration) crashed with `ReferenceError: getHookPaths is not defined`. Caught by the post-ship stranger-eyes test the user requested immediately after v4.1.0 went public — the same friction class that the deferred Phase 16 fresh-VM HITL trials would have surfaced.

### Fixed

- **Setup hook-registration regression** — `src/cli/setup.ts` re-exported `getHookPaths`, `HOOK_FILES`, `EXPECTED_HOOK_NAMES`, `getSettingsJsonPath` from `./hook-registry.js` using the combined `export { ... } from` syntax. esbuild's CJS bundle renamed the imported `getHookPaths` for disambiguation, leaving the internal call site at line 244 referencing an unbound name. The combined re-export is now split into separate `import` + `export` statements so the symbols enter the local module scope and call sites resolve. `bun run setup` completes step 8/8 cleanly; `bun run doctor` reports `25 of 25` hooks registered after re-setup.

## [4.1.0] — 2026-05-02

Distribution release. v4.0.0 (2026-04-30) shipped Claudex's internal infrastructure — organic tool use, behavior-gated retrieval, single-store SQLite + sqlite-vec, BGE-v2-m3 reranker. v4.1 makes that infrastructure installable by strangers and ships the repo publicly to `github.com/grigorijejakisic/Claudex`.

### Added

- **Phase 12 — Metadata + License + README foundation:** MIT LICENSE at repo root; `package.json` polished (description, repository, keywords, author, license fields); README §What/§Why/§Documentation/§License sections; CHANGELOG.md (this file) seeded; CONTRIBUTING.md established. The repo is now externally legible and legally redistributable.
- **Phase 13 — Cross-platform code audit:** code-only sweep across path handling, hook semantics, file locking, subprocess spawn, line-ending policy. `.gitattributes` enforces LF for shell scripts; subprocess calls use platform-aware shells; path joins go through `path.join` everywhere; lock files use cross-platform primitives (`src/shared/process-control.ts`). No portability TODOs left in source.
- **Phase 14 — Bootstrap install + configurable paths:** `bun run setup` is the single entry point — detects Bun, detects Ollama, pulls `snowflake-arctic-embed2` if missing, creates the BGE reranker Python venv at `services/.venv`, installs Python deps, spawns the reranker on port 7439, creates `~/.claudex/db/claudex.db`, and registers Claude Code hooks at `~/.claude/settings.json`. Idempotent. `CLAUDEX_PROJECTS_DIR` env var replaces the hardcoded `~/Desktop/Projects/` reference. Two thin entry points wrap setup: `install.sh` (macOS / Linux) and `install.bat` (Windows).
- **Phase 15 — `bun run doctor` diagnostics:** parallel checks — Bun version, DB schema, Ollama daemon + `snowflake-arctic-embed2`, BGE reranker on `:7439`, Claude Code hooks, Angel guardian process, plus an aggregate exit-code rollup. Reranker check warns rather than fails (bi-encoder fallback covers it). Each check prints a one-line remediation when it fails.
- **Phase 16 — Onboarding verification + README polish (structural):** README §Quick Start (clone → `bun run setup` → working session, ≤80 lines, references the install scripts and `bun run doctor` shipped in Phases 14-15 verbatim); README §Troubleshooting (≤120 lines, four canonical failures — Ollama not running, port 7439 dead, Bun version mismatch, hook registration failure — all routed through `bun run doctor` first); three onboarding fixtures at `docs/onboarding/{macos,linux,windows}.md` matching the Phase 11 SC#4 cold-start-trial template. Windows fixture is split-mode (steps 4-7 recorded from current dev machine, steps 1-3 HITL-pending for fresh-VM rigor).
- **Phase 17 — Public ship:** README badges (license MIT, version 4.1.0, Vesna CI); `v4.1.0` annotated git tag; complete master history pushed to `github.com/grigorijejakisic/Claudex` (336 commits, fast-forward from v3-era `712c910`); GitHub release `v4.1.0 — Distribution` published with these notes; repository topics applied (`claude-code`, `mcp`, `agent-memory`, `llm-tools`, `typescript`, `bun`, `claudex`, `persistent-memory`, `claude`); branch protection runbook authored at `docs/onboarding/branch-protection-setup.md` for the operator-driven UI step.

### Pending (HITL — operator-runnable; do not gate v4.1 ship)

- **PLAT-06** — macOS install verified end-to-end on fresh VM
- **PLAT-07** — Ubuntu 24.04 LTS install verified end-to-end on fresh VM
- **PLAT-08** — Windows 11 install verified end-to-end on fresh VM (regression check)
- **VER-04** — every friction surfaced in fixtures resolved as code fix / doctor check / README troubleshooting entry
- **VER-05** — <30-minute install target measured and met on each platform
- **REL-07** — branch protection rule for Vesna CI applied via GitHub UI on `grigorijejakisic/Claudex` (runbook at `docs/onboarding/branch-protection-setup.md`)

The HITL-pending items follow the same pattern Phase 11 SC#4 used to ship v4.0.0 with three live cold-start trials still operator-runnable: structural close documented; operator returns when ready; v4.1 ships without waiting.

### Stats

- **44 v4.1 requirements:** 38 closed autonomously across Phases 12-17; 6 HITL-pending (operator-runnable).
- **Hard gates:** `bun run build` green, `bun run test` 3188 baseline + 20 baseline llama-server-supervisor failures unchanged from v4.0.0, `bun run vesna` 17/17 GATED PASS, `bun run doctor` exit 0.
- **DB schema unchanged from v4.0.0** (V24).
- **Hook semantics unchanged from v4.0.0.**

## [4.0.0] — 2026-04-30

First public-eligible release of Claudex. v4 reframed Claudex from a "memory
system the agent is told to use" to a memory system the agent reaches for the
same way it reaches for `Read` or `Grep` — organic tool use, not injected
imperatives.

The release is gated by **behavior, not benchmarks**: SC#1 (Vesna behavioral
probes), SC#2 (token + cache stability), SC#3 (MEMORY.md content quality),
SC#4 (handoff pickup). LongMemEval and LoCoMo numbers are tracked as archival
vibe-checks, not pass/fail criteria.

### Validation

All four success criteria PASS at v4.0.0:

- **SC#1 (Vesna behavioral):** 17/17 probes, 100% aggregate, 100% every
  non-empty category. Cross-encoder reranker (BGE-v2-m3) on port 7439 healthy
  at run time.
- **SC#2 (token + cache-stable):** `gsd-active-start` at 191/500 tokens
  (matches Phase 8.5 baseline exactly); all four scenarios byte-identical and
  volatile-state-invariant across three layers.
- **SC#3 (MEMORY.md content quality):** every active project ≥80%; aggregate
  90 across six projects.
- **SC#4 (handoff pickup):** Vesna synthetic counterpart 3/3 = 100%; three
  live cold-start trials authored with pre-committed prompts (HITL-pending).

Full rollup: `.planning/phases/11-p9-final-validation/11-V4-VALIDATION.md`.

### Added

- **Phase 2 — Artifact-table unification:** V17 schema consolidates legacy
  observation/decision/learning/relationship/note tables into a single
  `artifact` table with computed views; FTS5 callers ported.
- **Phase 3 — Directive detector:** Regex + LLM-confirm pipeline turns
  in-conversation user directives into `directive_rule` artifacts; ship-quality
  joint precision 0.500, scope precision given correct 0.889.
- **Phase 4 — MEMORY.md curation + auto-dream guard:** Heartbeat-driven
  MEMORY.md writer with project-ID resolution fix; transcript chunker;
  auto-dream guard rate-limits consolidation.
- **Phase 4.1 — MEMORY.md content redesign:** Density-3 promotion gate,
  perceptual-similarity probes, mechanical SC#3 content scorer; CUR-09 through
  CUR-13 closed.
- **Phase 5.5 — Curation feedback loop:** V19 `lesson_pointer` +
  `pointer_recall_log` tables; pointers earn their place by use, correcting
  bias toward generic-noun extraction.
- **Phase 6 — Retrieval simplification:** Single canonical scoring function
  with a flat documented weight vector; reranker visibility surface ships as
  load-bearing.
- **Phase 6.5 — Cross-project task-pattern recall:** V21
  `artifact_task_pattern` sidecar; lessons in one project surface in another
  via perceptual handles + shape vocabulary, not text overlap.
- **Phase 7 — Framing rewrite (advisory voice):** Every assembly formatter
  speaks observation, not command; the agent reasons *from* prior experience,
  not *under* a rule.
- **Phase 7.5 — Handoff format redesign:** Hybrid YAML + ADR handoff schema;
  fail-loud parser, atomic write, runtime probe gate.
- **Phase 8.5 — Recall observability:** V22 `retrieval_log` + `session_flag`
  tables; every `claudex_search` / `claudex_recall` event logs token cost;
  per-session `/silent` toggle; visible cost block at `/endsession`.
- **Phase 10 — Vesna probe suite + central validation:** 17 core + 3 buffer
  probes across entity-recall, constraint-recall, handoff-pickup,
  cross-project, lesson-application, self-instrumented categories; first
  full-suite run at 100% aggregate.
- **Phase 11 — Final validation + v4.0.0 ship:** SC#1-#4 verified; V24 schema
  migration; v4.0.0 tagged.

### Changed

- **Assembly pipeline:** Legacy injection paths removed; assembly composes
  from the unified artifact table via the canonical scorer.
- **MEMORY.md schema:** `## Entities` and `## Recent Threads` dropped (audit
  diagnosis: frequency-extraction noise); `## Lessons` added as task-pattern
  indexed pointers; `## User Notes` promoted.
- **Voice:** Phase 7 advisory-voice rewrite — agent surfaces use observational
  tone; no imperative directives injected at run time.
- **Default cross-project recall:** ON. Methodology and knowledge
  cross-pollinate by default; per-project CLAUDE.md opt-out available.

### Removed

- **Phase 5 — Legacy injection + big benchmark gate:** removed the
  benchmarks-as-gates posture that caused "green numbers feel like progress
  while artifacts regress" (audit diagnosis).
- **Phase 8 — RL stack:** ablated under the locked DELETE_ALLOWED verdict
  (Δ=0pp at the ablation gate); retained env-var feature flag for the duration
  of the ablation, then deleted in Phase 9.8.
- **Phase 9 — Cognitive layer (Angel simplification):** per-module deletion
  across 8 sub-phases — autonomous-investigator, cara-reasoning, consolidator
  dream surface, crystallizePatternToSkill, cross-project-consolidator,
  proactive-curator, data-quality, RL stack. Net −6021 LOC. Vesna 32/32 PASS.
- **STOR-04 / V24 migration:** legacy `*_old` tables dropped after zero-caller
  audit (6 tables, 1052 rows; 378 MB DB backup retained at
  `~/.claudex/backups/pre-v4-phase-11-drop-old-20260430-181007.db`).

### Fixed

- **Phase 4.1 writer regression:** `computeMemoryMdPath` had been silently
  computing the wrong path for every project for 17+ days — Claudex project
  IDs (no path separators) fell through to a heuristic `else` branch and were
  used verbatim as CC slugs. Fixed by chaining `resolveProjectPath` →
  `pathToCcSlug`; live-fire re-soak verified 8/8.
- **Mixed-precision timestamps:** Migration paths normalized to consistent
  millisecond precision; downstream consumers no longer trip on
  unit-mismatched comparisons.

### Pre-v4 history

v3 was internal infrastructure and is not itemized here. See `git log` from
the v4.0.0 tag backwards for the full pre-public history.

---

[Unreleased]: https://github.com/grigorijejakisic/Claudex/compare/v4.1.0...HEAD
[4.1.0]: https://github.com/grigorijejakisic/Claudex/releases/tag/v4.1.0
[4.0.0]: https://github.com/grigorijejakisic/Claudex/releases/tag/v4.0.0
