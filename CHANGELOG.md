# Changelog

All notable changes to Claudex are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- _Nothing yet._ Track v6.x milestone planning at `.planning/STATE.md` once it kicks off.

## [6.0.0] — 2026-05-09

**Deliberation Surfacing milestone — bound POSITIVE.** Pooled n=60 across 2 replications: Δ pass-rate +0.1667, Wilson Δ CI **[+0.0038, +0.3434]** — lower bound binds zero by 38 thousandths, modest but honest. Per-replication: r1 (s=14, t=18) and r2 (s=15, t=21) both INCONCLUSIVE individually (small n); pooling cleared zero per pre-committed CONTEXT decision 4. Retrieval baseline: **bi-encoder fallback** (cross-encoder fitness 56.0% < 60% threshold post-backfill — promotion deferred until corpus growth or distribution shift triggers a re-bind). Per-kind concentration in kinds **b/d/e** (threshold-source, dependency-change, assumption-drift) — kinds a/c (sample-size shift, scope-change) flat in P9 and ride along as non-regression baseline.

Aggregator: [`.planning/aggregates/deliberation-surfacing.md`](.planning/aggregates/deliberation-surfacing.md) (3 BoundExperience entries: 9-r1, 9-r2, 9-pooled-r1+r2). Pre-commitment audit anchor: 09-CONTEXT.md commit `00ab2bb`.

### Added

- **Phase 8 — Transcript ingestion substrate (V32, shipped 2026-05-08; re-stated here for milestone-level traceability):** `transcript_chunk_v6` metadata table + `vec_transcript_chunks_v6` vec0 virtual table; pure-function `chunkTranscript` + `upsertChunk` + parseWrappers redaction at the new write surface; SessionEnd hook + Angel heartbeat drain; `bun run backfill:transcripts` + `bun run reranker:fitness` CLIs; WIR-01 wire-test against V17-collapsed + base-table fresh-DB at ninth-gate severity. `TARGET_USER_VERSION` bumped 31 → 32.
- **Phase 9 — Empirical measurement (BOUND POSITIVE 2026-05-09):** drift-detection probe suite (30 fixtures × 5 kinds × 6 cases each); pre-committed decision rule + locked corpus + Wilson/Newcombe CI binding harness; runner CLI (`bun run benchmark:deliberation-surfacing`); 2 replications run + pooled at n=60 — verdict POSITIVE per CONTEXT decision rule.
- **Phase 10 — Routing + assembly (engineering branch, ROU-01..03 + ASM-01..03):**
  - `src/retrieval/transcript-routing.ts` — `routeFromArtifact` + `routeFromArtifacts` exported. Artifact → transcript-chunk fan-out joined by `session_id` + configurable time window from `artifact.created_at_epoch_ms`. Bi-encoder primary (snowflake-arctic-embed2 via Ollama); cross-encoder (BGE-reranker-v2-m3 port 7439) reachable behind `v6.routing.reranker_mode='cross_encoder_primary'` flag. Artifact-kind-agnostic ranking (no per-kind weighting — zero measurement support per CONTEXT decision 2). Reranker fallback discipline mirrors hybrid-retrieval RETR-08: capture reason, write one telemetry row, fall through to bi-encoder.
  - `src/assembly/deliberation-surface.ts` — pure formatter rendering surfaced spans as labeled citations (`From session X turn 47, where ...: ...`) plus the advisory narration line `## Deliberation Surfaced — N spans from M sessions` consistent with Phase 7's "When You Recall — Narrate" discipline.
  - `src/assembly/sections.ts` adds `formatDeliberationSurfaceSection` wrapper; `src/assembly/assembler.ts` adds opt-in `FullAssemblyParams.deliberationSurfacing` + `appendDeliberationSurfaceToPayload` async helper at L2.5 cascade position. Sites that don't opt in see no behavior change. L2.5 cascade position documented in `.claude/rules/assembly-budget.md`.
  - `v6.routing.*` config block with five locked first-principles defaults: `top_k_per_artifact=3`, `max_k_per_query=12`, `token_pct_cap=15`, `bi_encoder_budget_pct=50`, `reranker_mode='bi_encoder_primary'` (CONTEXT decision 3).
- **Vesna 21 → 26 functional probes:** five new `deliberation-engagement-{a,b,c,d,e}-001` probes at production-shape scale, one per P9 drift kind. Kinds a + c (FLAT in P9) included as non-regression baseline; b/d/e exercise the engagement signal. Vesna setup_step DSL extended with `deliberation_surface` kind that writes via `createArtifact` + `upsertChunk` (production write surfaces). Vesna runner now async; composes the L2.5 deliberation surface for engagement probes. P9 fixtures byte-immutable per pre-commitment lock.
- **WIR-01 wire-test (Phase 10):** `src/tests/integration/phase-10-wire-test.test.ts` — exercises EXPORTED `routeFromArtifacts` + `formatDeliberationSurfaceSection` against V17-collapsed + base-table fresh-DB fixtures. Four assertions: spans retrieved, spans appear in output, zero errors across both shapes, advisory narration line emitted. WIR-02 phase coupling honored — Phase 10 inherits the substrate-ship gate from Phase 8.

### Changed

- `bun run vesna` baseline grows from 21/21 to 26/26 PASS at 100%, gated.
- `loadConfig` deep-merges + `validateConfig` type-guards the new `v6.routing` block.
- Default reranker mode for the v6 transcript-routing surface is `bi_encoder_primary` — cross-encoder is an opt-in via the `v6.routing.reranker_mode` config flag (CONTEXT decision 1; promotion deferred until corpus growth or distribution shift triggers a re-bind).
- **Mem0-trap closure asserted at the v6 write surface (carried through from P8).** Every `KNOWN_WRAPPER_TAGS` variant round-trips through `chunkTranscript` + `upsertChunk` and is structurally absent from the persisted body. Pairs with V28's BEFORE-INSERT trigger on `experience_patterns` (Phase 4) and V31's view-mode learnings.provenance enum (Phase 7) — three structural closures across three write surfaces.

### Deferred (carved out of v6.0.0 — re-examined at v6.x or v7+)

- Per-kind routing weight tuning — production artifacts don't carry drift-kind labels; runtime classification has no measurement support.
- Cross-encoder re-bind on transcript surface — currently fitness 56% < 60% on conversation-distribution chunks; re-check after corpus growth or distribution shift.
- Routing default tuning from production telemetry — first measurement-informed retune scheduled after first 2 weeks of production traffic.
- Kind-a (sample-size) and kind-c (scope-change) null-result investigation — both flat in P9; informs future engagement-metric refinement.
- Retention policy / forgetting-curve layer (RET-NEW) — required at ~10x current scale; v7+.
- Cross-harness transcript sources (XHN) — Codex / Aider / Gemini-CLI ingestion; future milestone.

### Ship gates (9/9 PASS)

- **WIR-01/02 phase coupling honored** — substrate (P8) + routing+assembly (P10) both pass at ninth-gate severity per the v5.0.1 silent-fail lesson promotion.
- `bun run vesna` 26/26 GATED PASS at 100% (entity-recall 5/5, constraint-recall 3/3, handoff-pickup 3/3, cross-project 3/3, lesson-application 3/3, self-instrumented 4/4, deliberation-engagement 5/5).
- Phase 10 vitest tests 27/27 PASS (routing 9, assembly 10, wire-test 8).
- `bun run build` clean.
- `bun run test` 3656/3691 passing; 27 pre-existing v4-debt failures (llama-server-supervisor 18 + llama-client 2 + phase-5-full-gate 7) carry forward unchanged from P8/P9 baseline.
- `bun run sc3` 88.3% aggregate (5/6 projects ≥80%; **big-mozzy-v2 remains at 70% pre-existing project-content gap** — same carry-forward acknowledged at P8 close, not a P10 regression).
- handoff-pickup 3/3 (within Vesna).
- `bun run vitest run src/tests/integration/cli-bundle-smoke.test.ts` 7/7 PASS.
- `bun run doctor` exit 0; user_version=32, Ollama up, Reranker port 7439 healthy, CC hooks 25/25, Angel heartbeat fresh.
- WIR-01 wire-test PASS on V17-collapsed + base-table fresh-DB fixtures (4 assertions × 2 fixture shapes = 8 sub-assertions).

### Coverage

- v6 milestone shipped tests: P8 76 + P9 30-fixture × 2-replication binding measurement + P10 35 (routing 9, assembly 10, wire-test 8, vesna-setup 2, config 4, deliberation-engagement probes 5).
- No retrieval-side surface change in P8 — substrate was reusable regardless of P9 verdict (P10 routing + assembly is the engineering branch unlocked by the bound-POSITIVE verdict).

## [5.0.1] — 2026-05-08

**Hot-fix.** Closes a wiring fault discovered in post-ship live audit: Phase 7's headline `learnings.provenance` discipline silently failed on V17-collapsed DBs (the only DB shape in production). The substantive Mem0-trap closure shipped in v5.0.0 is now actually load-bearing on production installs.

### Fixed

- **`learnings` write path on V17-collapsed DBs (V31 schema bump).** Phase 7's V30 migration legitimately skipped `ALTER TABLE learnings ADD COLUMN provenance` when `learnings` is a view over the `artifact` kernel (V17 collapse), but no equivalent path was landed. Two compounding faults followed: (1) the production `upsertLearning` SQL referenced a non-existent column on the view and threw `table learnings has no column named provenance`; (2) even with the column, SQLite forbids `INSERT ... ON CONFLICT ... DO UPDATE` (UPSERT) on a view, so duplicate-promotion conflicts errored too. Both errors were swallowed by `captureInsightsAsLearnings`'s try/catch, silently dropping every learning the Stop hook attempted to promote. V31 lands the V17-view-mode equivalent of V30 (rebuilt view + INSTEAD OF triggers that accept `NEW.provenance`, persist into `artifact.data` JSON, validate against the closed enum) and rewrites `upsertLearning` as a shape-agnostic SELECT-then-INSERT-or-UPDATE pattern that works against both base tables and views. Backfills 191 existing learning artifacts to `provenance='organic'` to match V30's base-table backfill.
- **Test gap that allowed v5.0.0 to ship with this bug.** Phase 7's integration test `phase-7-learnings-provenance.test.ts` exercised a fresh `:memory:` DB that took the base-table path (V25→V30 clean), never the V17 view-mode path that production runs on. New regression test `src/tests/integration/learnings-write-path-v17.test.ts` runs the actual `upsertLearning` function against a V17-collapsed fixture, including the pre-V31 baseline assertion that the prior path threw. New unit tests at `src/tests/core/migrations-v31.test.ts` (13 cases) cover both DB shapes plus idempotency, closed-enum guard, UPDATE-preserves-provenance-on-omission, and runMigrations advancement.

### Changed

- **`upsertLearning` (`src/core/learnings.ts`)** — replaced the single-statement INSERT-with-ON-CONFLICT pattern with an explicit SELECT-then-INSERT-or-UPDATE pattern. Two prepared statements both go through `cachedPrepare`; perf delta vs. the prior path is negligible vs. the loss-of-data the prior path was costing. Behavior contract unchanged (provenance no-overwrite on existing rows; `last_promoted_epoch` + `updated_at_epoch` bump on conflict; default `provenance='organic'`).
- **DB schema V30 → V31** — V31 (v5.0.1 hot-fix) rebuilds `learnings` view + 3 INSTEAD OF triggers on V17-collapsed DBs to expose `provenance` and persist it into `artifact.data` JSON, with closed-enum validation matching V25's `episodic_events.provenance` CHECK. No-op on base-table DBs (V30 already added the column there).

### Coverage

- Vesna 21/21 PASS unchanged.
- New integration + unit tests: 19 cases (13 in `migrations-v31.test.ts` + 6 in `learnings-write-path-v17.test.ts`), all green.
- Full suite: 3490 passing, 27 pre-existing failures unchanged from v5.0.0 baseline. No new regressions.
- Live-DB verification: production `INSERT INTO learnings (..., provenance) VALUES (..., 'organic')` succeeds on the migrated production DB; 191 existing rows backfilled to `provenance='organic'`.

## [5.0.0] — 2026-05-08

**Substrate-only milestone.** Three load-bearing legs proposed at v5 start; legs 2 and 3 (recall-by-any-modality via fusion, abstraction-from-density) killed empirically by Phase 2/2.1 (3 KILL bound measurements at `.planning/aggregates/multi-handle.json`). Leg 1 (provenance-tagged episode substrate) shipped + extended to learnings. Reframe artifact: [`.planning/reframes/2026-05-05-multi-handle-kill.md`](.planning/reframes/2026-05-05-multi-handle-kill.md).

Methodology promoted to v5 standard practice: pre-committed decision rule, locked corpus, multiple bound measurements, append-only aggregator, Wilson/Newcombe CI binding.

Not delivered: improved retrieval. v4 `hybrid-retrieval.ts` is unchanged in production; future milestones may revisit on the substrate this milestone built.

### Added

- **Phase 1 — Episode substrate (V25):** new `episodic_events` table with structured row schema and provenance enum (`organic | injected | tool_result | environmental`), dual-write helpers from CC hooks, V25 forward-only migration, 60+ EPI-tagged tests including a stub-extractor proof of EPI-07 Mem0-trap-impossibility. Operator README + environmental audit at `.planning/phases/01-episode-substrate/`.
- **Phase 4 — Angel reduction (V28):** three extraction-time-pattern-creation sites deleted (`pattern-extractor.ts`, `experience-scoring.ts` step 1, `heartbeat.ts` synthesis loop). V28 BEFORE INSERT trigger blocks new `experience_patterns` rows structurally via TEMP `session_pragmas` sidecar. Three-layer cutoff: JSDoc tombstones + `extraction-deleted.test.ts` regression guard + V28 trigger. `classifySessionDomains` relocated to `domain-classifier.ts`. ~1100 lines deleted, ~700 added — pure shrinkage on production path.
- **Phase 6 — Crash-resilient episode boundary (V29):** `episode_boundary_cursor` table + `sessions.last_heartbeat_ts` + `sessions.last_jsonl_write_ts`. New `src/angel/boundary/` module surface (thresholds, pid-liveness, jsonl-watcher, composition-rule, cursor, boundary-detector). chokidar 5.0.0 runtime dep. 5 CC hooks bump heartbeat ts; SessionEnd emits `clean_endsession` close marker atomically with cursor advance. Angel.heartbeatTick runs `runBoundaryTick` on every cadence; Angel boot starts JSONL watcher with degraded-mode fallback. 55 boundary tests + 7 V29 migration tests + 6 hook regression tests.
- **Phase 7 — v4 coexistence + Vesna update + ship (V30):** `learnings.provenance` column with closed-enum CHECK matching `episodic_events`; `captureInsightsAsLearnings` filters wrapper-tagged content via Phase 1's `parseWrappers` (KNOWN_WRAPPER_TAGS source-of-truth at `src/extraction/wrapper-parser.ts`). 10 reader-site comments downgraded from forward-looking TODOs to steady-state legacy documentation. Vesna grows 18 → 21 functional probes (`episodic-recall-001`, `episodic-recall-002`, `learnings-injected-guard-001`). Three new vitest integration tests (`phase-7-learnings-provenance`, `phase-2-1-kill-regression`, `phase-6-crash-resilience`) cover the four v5 SC gates at substrate level.

### Removed

- **Phase 3 — Multi-handle retrieval cutover** — DROPPED 2026-05-05. Premised on the multi-handle/density-fusion thesis killed by Phase 2/2.1. v4's `hybrid-retrieval.ts` (semantic + FTS + reranker) stays in production unchanged.
- **Phase 5 — Density-based abstraction** — DROPPED 2026-05-05. Same dead thesis. Intra-project density measured at 0.2418 across both Phase 2.1 tiers (threshold 0.30).
- **Requirements RET-01..05 + ABS-01..04** — closed with the dropped phases.
- **Mem0 fix from commit `0d0fbca`** — deleted as structurally obsolete (Phase 4 deletes the upstream extraction sites that fed it).

### Changed

- **Multi-handle thesis status** — empirically rejected at our scale. The thesis is dead; the methodology that killed it is alive and standard.
- **Phase 4 reader-site comments** — 10 occurrences (across 9 files) downgraded from "Phase 7 owns retirement direction — drop / project / keep" to steady-state legacy documentation: "Rows persist for as long as their content is useful." Forever-legacy reads with no fade.
- **DB schema V24 → V30** — V25 (Phase 1 episodic_events), V26 (Phase 2 error-fingerprint sidecar), V27 (Phase 2.1 corpus_origin enum widen), V28 (Phase 4 trigger marker), V29 (Phase 6 boundary cursor + sessions liveness columns), V30 (Phase 7 learnings provenance).

### Coverage

- `bun run vesna` 21/21 GATED PASS at 100% (entity-recall 5/5, constraint-recall 3/3, handoff-pickup 3/3, cross-project 3/3, lesson-application 3/3, self-instrumented 4/4)
- `bun run test` 3471 passing, +260 over v4.1.2's 3211 baseline; 27 pre-existing failures unchanged (`llama-client`, `llama-server-supervisor`, `phase-5-full-gate`)
- `bun run sc3` aggregate 91.7%, GATED PASS — all 6 active projects ≥80% MEMORY.md content quality
- `bun run doctor` exit 0 (Bun, DB schema V30, Ollama, reranker:7439, hooks 25/25, Angel)

## [4.1.2] — 2026-05-02

Test-coverage release. Closes the regression class that v4.1.1 fixed by adding subprocess-based bundle smoke tests, static bundle integrity checks, and install-script structural tests. The new tests would have caught the v4.1.1 `getHookPaths is not defined` regression at `bun run test` time, before public ship. Same friction class the deferred Phase 16 fresh-VM HITL trials were designed for; this is the unit-level complement.

### Added

- **`CLAUDEX_DRY_RUN=1` env flag** in `src/cli/setup.ts` — walks all 8 setup steps without side effects (no reranker venv creation, no `~/.claudex/*` mkdir, no DB init, no `~/.claude/settings.json` patch). Read-only probes (Bun, Ollama, model presence, projects dir, `getHookPaths()` call site) still execute. Used by tests to exercise the bundled CLI without mutating the user's machine.
- **`src/tests/integration/cli-bundle-smoke.test.ts`** (7 tests) — spawns `node dist/cli/setup.cjs` with `CLAUDEX_DRY_RUN=1`, `node dist/cli/doctor.cjs`, `node dist/cli/doctor.cjs --json`, and `node dist/benchmark/vesna/cli.cjs` as subprocesses. Asserts no bundle-time failure patterns (`ReferenceError`, `SyntaxError`, `TypeError`, `Cannot find module`) appear in stdout/stderr, exit codes are sane, and expected output markers (e.g., `Would register N hooks`, `AGGREGATE`) are present. Catches the v4.1.1 regression class.
- **`src/tests/cli/bundle-integrity.test.ts`** (5 tests) — `require()`s every guarded `.cjs` under `dist/cli/` (setup, doctor, why, session-token-cost) and asserts no top-level errors at module load. Cheap static guard for module-load-time bundle bugs.
- **`src/tests/integration/install-script-smoke.test.ts`** (11 tests) — static-parses `install.sh` and `install.bat`, asserts portable shebang / `@echo off`, Bun pre-flight with install link, ordered invocation of `bun install --frozen-lockfile` → `bun run build` → `bun run setup`, `set -e` (POSIX) / `errorlevel` checks (Windows), and the Windows-specific `call bun ...` requirement (without `call`, control transfers to `bun.cmd` and never returns).

### Coverage

3211 passing tests (+23 over v4.1.1's 3188 baseline) + 20 pre-existing llama-server-supervisor failures unchanged. `bun run vesna` 17/17 GATED PASS, `bun run doctor` exit 0.

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
