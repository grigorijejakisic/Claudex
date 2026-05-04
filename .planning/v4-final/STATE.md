# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-30)

**Core value:** v4 makes the agent USE Claudex organically as part of how it works in Claude Code. v4.0.0 SHIPPED 2026-04-30. **v4.1 — Distribution SHIPPED 2026-05-02 at v4.1.0** — public on `github.com/grigorijejakisic/Claudex`. Next milestone: v4.2 (TBD).

**Current focus:** **v4.1 SHIPPED at v4.1.0 — 2026-05-02.** Phase 17 closed: REL-01/02/03/06 [x] (autonomous — public remote verified, fast-forward push 712c910..d18c934 of 337 commits, v4.1.0 annotated tag at content-complete commit, README badges live); REL-04/05 [~] HITL-pending (gh CLI authenticated as Corleanus lacked write permission on grigorijejakisic/Claudex; operator runs `gh auth login --user grigorijejakisic` then re-runs `gh release create` + `gh repo edit --add-topic` per docs/onboarding/branch-protection-setup.md operator-fallback section); REL-07 [~] HITL-pending (branch protection runbook at `docs/onboarding/branch-protection-setup.md` — operator runs the GitHub UI click). 36/44 v4.1 reqs done autonomously; 8/44 HITL-pending (PLAT-06..08 + VER-04/05 from Phase 16; REL-04/05/07 from Phase 17 — all operator-runnable). Next milestone: v4.2 (TBD).

## Current Position

**Current Milestone:** v4.1 — Distribution **SHIPPED at v4.1.0**
**Phase:** 17 — closed 2026-05-02
**Plan:** —
**Status:** v4.1 SHIPPED publicly on `github.com/grigorijejakisic/Claudex`. 4 plans / 3 atomic implementation commits + this close commit pushed to BOTH remotes. v4.0.0 + v4.1.0 tags both visible on the public repo. README badges live. REL-04/05 HITL-pending (gh CLI permission fallback documented); REL-07 HITL-pending (branch protection UI).
**Last activity:** 2026-05-02 — Phase 17 closed; v4.1 milestone shipped publicly

### v4.1 Phase Structure

| Phase | Goal | Requirements |
|-------|------|--------------|
| 12 — Metadata + License + README foundation | Establish Claudex as MIT-licensed and externally legible | LIC-01..03, DOC-01, DOC-02, DOC-05, DOC-06 (7 reqs) |
| 13 — Cross-platform code audit | Code-only portability sweep across paths/hooks/locks/subprocess/line endings | PLAT-01..05 (5 reqs) |
| 14 — Bootstrap install + configurable paths | One-command `bun run setup` + `CLAUDEX_PROJECTS_DIR` + first-session UX | INST-01..07 (7 reqs) |
| 15 — `claudex doctor` diagnostics | Self-diagnosis surface (Bun, Ollama, port 7439, DB, hooks, Angel) | DIAG-01..08 (8 reqs) |
| 16 — Onboarding verification + README polish | HITL fresh-VM installs (macOS/Ubuntu/Windows); <30-min target | PLAT-06..08, VER-01..05, DOC-03, DOC-04 (10 reqs) |
| 17 — Public ship to grigorijejakisic/Claudex | Tag + push + GitHub release + topics + branch protection | REL-01..07 (7 reqs) — **SHIPPED 2026-05-02 (REL-01/02/03/06 [x]; REL-04/05/07 [~] HITL)** |

**Coverage:** 44/44 v4.1 requirements closed structurally (36 autonomous [x] + 8 HITL [~]). v4.1 milestone is SHIPPED — HITL items are deferred to operator follow-up, not blockers.

**HITL constraint flagged:** Phase 16 success criteria (PLAT-06/07/08 + VER-01..05 + <30-min target) require operator-driven fresh-VM testing. Plan-phase will produce per-platform operator runbooks; phase closes once each platform's fixture is filled in. Pattern mirrors Phase 11 SC#4 (synthetic + live trials operator-runnable).

**Prior status (v4.0 SHIPPED 2026-04-30 at v4.0.0):** All SC#1-#4 PASS with evidence: SC#1 Vesna 17/17=100% per category; SC#2 12/12 cache-stable (191/500 budget headroom); SC#3 mechanical scorer aggregate 90 across 6 projects each ≥80; SC#4 synthetic Vesna 3/3 PASS + 3 live HITL-pending. STOR-04 closed (V24 dropped 6 legacy *_old tables, 1052 rows, after zero-caller audit; DB backup at ~/.claudex/backups/pre-v4-phase-11-drop-old-20260430-181007.db). Benchmark vibe-check: LongMemEval Oracle 89.6% archival (within drift vs 90.6% baseline); LoCoMo 55.5% archival (no Phase 9-10 pressure). Non-gating per CONTEXT axiom. v4.1 Distribution stub at .planning/v4.1-distribution/STUB.md was the basis for this milestone's REQUIREMENTS.md.
**Last Activity:** 2026-05-02
**Last Activity Description:** Phase 17 CLOSE. v4.1 SHIPPED publicly to `github.com/grigorijejakisic/Claudex`. 4 plans landed: **17-01:** CHANGELOG promote [Unreleased] → [4.1.0] — 2026-05-02 (Phase 12-17 narrative under ### Added; Pending HITL block listing PLAT-06..08 + VER-04/05 + REL-07; ### Stats with 38 autonomous-closed + 6 HITL-pending across 44 reqs); README badges (license MIT + version 4.1.0 + Vesna CI) at top of README between title and tagline; commit d18c934. **17-02:** v4.1.0 annotated tag created at d18c934 with locked Phase 12-17 message body; `git push public master` succeeded as fast-forward (337 commits, 712c910..d18c934); `git push public --tags` sent v4.0.0 + v4.1.0 (both new tags on public). v4.1 visible publicly. **17-03:** GitHub release + topics autonomous run via Corleanus FAILED with permission errors (gh release create: "workflow scope may be required" misleading text, root cause is lack of write permission; gh repo edit: HTTP 404 on /topics endpoint, same root cause) — exactly the operational risk CONTEXT.md flagged in `<open_questions>`. Branch-protection runbook authored at `docs/onboarding/branch-protection-setup.md` (113 lines) WITH ## Operator fallback section appended documenting both errors verbatim and the `gh auth login --user grigorijejakisic` remediation. Release notes file preserved at `/tmp/phase17-fallback/release-notes.md` for operator re-run; commit 3561ac8. **17-04 (this commit):** STATE/ROADMAP/REQUIREMENTS updated for final v4.1 close — REL-01/02/03/06 marked [x] / Done; REL-04/05 marked [~] HITL with gh-fallback note; REL-07 marked [~] HITL with runbook reference; v4.1 milestone status flipped to SHIPPED. 17-SUMMARY.md authored. Hard gates final witness: `bun run build` ~70ms green; `bun run test` 3188 passed + 20 baseline llama-server-supervisor failures unchanged from v4.0.0; `bun run vesna` **17/17 GATED PASS**; `bun run doctor` exits 0 (5 pass + 1 warn for Angel heartbeat staleness per Phase 15 baseline). DB schema (V24) unchanged. Hook semantics unchanged. v4.0.0 + v4.1.0 tags both visible on `grigorijejakisic/Claudex/tags`. Phase-close commit pushed to BOTH origin (Corleanus/CLAUDEXv3) and public (grigorijejakisic/Claudex). v4.1 milestone closed. Next: v4.2 milestone definition (TBD).

**Prior activity (2026-05-02 — Phase 16 structural close, preserved as historical record):** Phase 16 STRUCTURAL CLOSE. 4 plans shipped: **16-01:** README §Quick Start (47 lines, walks prereqs → clone → install → verify → first session, references `./install.sh` + `install.bat` + `bun run setup` + `CLAUDEX_PROJECTS_DIR` from Phase 14 and `bun run doctor` + the 6 checks from Phase 15 verbatim) + §Troubleshooting (61 lines, four canonical install failures Ollama/7439/Bun/hooks, every entry routes through `bun run doctor` first); status banner updated to reflect v4.1 Quick Start shipped + HITL fresh-VM verification pending; `## Installation` placeholder "Coming in v4.1." removed. **16-02:** `docs/onboarding/macos.md` + `docs/onboarding/linux.md` matching the Phase 11 SC#4 cold-start-trial template (status header HITL-PENDING, 7 numbered steps each with Command/Expected/Friction/Elapsed, Friction summary + Resolutions + Verdict sections at end, all `[OPERATOR FILL-IN]` slots preserved); Linux fixture explicitly scoped to Ubuntu 24.04 LTS only (other distros out of scope per CONTEXT.md). **16-03:** `docs/onboarding/windows.md` split-mode — steps 1-3 (fresh Bun/Ollama/Python install) HITL-pending, steps 4-7 (clone / install.bat / `bun run doctor` / first session) recorded from current dev machine state; verbatim doctor table pasted into Step 6 (5 pass + 1 warn for Angel heartbeat staleness per 15-SUMMARY.md baseline); recorded current-state values include `bun --version` = 1.3.6, `ollama --version` = 0.22.1, `python --version` = 3.12.7, recording commit fc33edb29fc4f20f4cc1ec06d3626a26a97fbfff; dual-Verdict at bottom (autonomous half PASS, HITL half HITL-PENDING) — does NOT close PLAT-08; only an operator-driven fresh-Win11-VM run does that. **16-04:** Phase 16 close commit — REQUIREMENTS.md/ROADMAP.md/STATE.md updated to mark DOC-03/04 + VER-01/02/03 [x] / Done and PLAT-06..08 + VER-04/05 [~] / Pending (HITL); CHANGELOG.md [Unreleased] populated; 16-SUMMARY.md authored. Hard gates: `bun run build` ~70ms green; `bun run test` 3188+ baseline (matches Phase 15 close, +0 from this phase since edits are docs-only); 20 baseline llama-supervisor failures unchanged from v4.0.0; `bun run vesna` **17/17 GATED PASS**; `bun run doctor` exits 0; DB schema unchanged; hook semantics unchanged.

**Prior activity (2026-05-02 — Phase 15 close, preserved as historical record):** Phase 15 SHIPPED. DIAG-01..08 closed in 5 plans. **15-01:** primitives (`src/diagnostics/types.ts` + `runner.ts`) — `runChecks()` parallel via `Promise.all`, per-check try/catch coerces thrown errors to fail with synthetic remediation, durationMs from wall-clock. 4 unit tests. **15-02:** Bun + DB checks — `TARGET_USER_VERSION` exported from `migrations.ts`; `check-bun.ts` dual detection (process.versions.bun first, spawnSync('bun --version') fallback so `node dist/cli/doctor.cjs` works); `check-db.ts` opens DB readonly with fileMustExist:true, reads PRAGMA user_version. 9 unit tests. **15-03:** Ollama + Reranker — `check-ollama.ts` short-circuits on binary→daemon→model (snowflake-arctic-embed2:latest match) with platform-aware install link; `check-reranker.ts` warns (not fails) on 7439 unreachable/timeout/non-2xx. 9 unit tests; no live network. **15-04:** Hooks + Angel — `src/cli/hook-registry.ts` extracted from setup.ts (canonical HOOK_FILES + EXPECTED_HOOK_NAMES + getSettingsJsonPath + getHookPaths) so doctor can import without bundling setup.ts's main(); `src/angel/pid-file.ts` shared PID-path module avoids index↔heartbeat circular import; `heartbeatTick` touches PID-file mtime via fs.utimesSync at end of every successful tick (DIAG-07 freshness signal — no schema migration); `check-hooks.ts` walks EXPECTED_HOOK_NAMES, marks each found if any registered command contains 'claudex' (matches setup.ts patchSettingsJson detection); `check-angel.ts` PID-file→process.kill(pid,0)→mtime<60s, stale heartbeat is `warn` per CONTEXT.md. 10 unit tests. **15-05:** CLI orchestrator — `src/cli/doctor.ts` registers 6 checks in fixed order, exposes runDoctor({json,checks}) for testability; `src/diagnostics/format.ts` pure formatHuman/formatJson with ✓/⚠/✗ symbols; `package.json` "doctor" script; `README.md` Diagnostics section. 9 unit tests. Hard gates: `bun run build` ~75ms green; `bun run test` 41 new + 20 baseline llama-supervisor failures unchanged from v4.0.0; `bun run vesna` **17/17 GATED PASS**; DB schema unchanged (no migration); hook semantics unchanged. **Live verification on this Windows machine:** `bun run doctor` exits 0 (5 pass + 1 warn for Angel heartbeat staleness because running Angel pre-dates the mtime-touch landing); `bun run doctor --json` emits `{"status":"pass","checks":[...],"startedAt":"...","durationMs":...}`. Phase 16 (Onboarding verification + README polish, HITL) is next. **14-01:** new `src/shared/projects-dir.ts` with `getProjectsDir()` honoring `CLAUDEX_PROJECTS_DIR` env var (default `path.join(os.homedir(), 'Projects')` cross-platform), idempotent best-effort mkdir, never-throws contract; 5 unit tests covering env-set absolute / env-set relative / env-unset / empty-string / mkdir-failure; classified callsite audit found 17 hits across 4 grep passes (2 code-fix, 3 string-text-fix, 5 comment-update, 3 test-fixture, 4 keep-with-reason in llama-server-supervisor). **14-02:** applied every fix — scope-detector.ts:133 + content-router.ts:100 → getProjectsDir(); MCP recall-server.ts CLAUDEX_INSTRUCTIONS refactored to buildClaudexInstructions() that interpolates getProjectsDir() at construction (INST-06); assembly/sections.ts generic phrasing; session-events.ts simplify-path regex extended via alternation to match BOTH legacy `~/Desktop/Projects/<name>/` AND new `~/Projects/<name>/` layouts on Windows + POSIX; memory-md-writer.ts JSDoc + curated-context-extractor.ts illustrative example updated; test fixtures retargeted (memory-md-writer.test.ts, memory-md-verify.test.ts). No automatic `~/.claudex/projects.json` migration (per CONTEXT.md decision — destructive). **14-03:** `bun run setup` extended (not rewritten) with 4 new prerequisite steps before existing dirs/DB/hooks logic: bun-version (semver vs 1.3.0), ollama-detect (binary + daemon health), model-pull (snowflake-arctic-embed2, idempotent via ollama list short-circuit), reranker-bootstrap (Python 3.11+ detect → services/.venv create → pip install -r services/requirements.txt → detached spawn → /health 60s budget, all best-effort returning ok:true with warning per INST-04 fallback). Modular under `src/cli/bootstrap-steps/` with DI for testability; 19 unit tests using mocked exec/spawn/fetch (no real bun/ollama/python spawned in tests). `services/requirements.txt` pinned: torch >=2.2 <3.0, sentence-transformers >=3.0 <4.0, transformers >=4.40 <5.0, fastapi >=0.110 <0.120, uvicorn[standard] >=0.27 <0.40, pydantic >=2.0 <3.0. Reranker delegation via approach A — setup spawns one-shot detached; Angel's RerankerSupervisor detects on first heartbeat and reuses. `shell: true` added to bun/ollama/python execFileSync calls (Windows shim PATH resolution; POSIX unaffected) — discovered live during smoke. Live smoke on this Windows machine: `bun run setup` exits 0, second run also exits 0 (idempotent), all 8 numbered steps fire correctly. **14-04:** install.sh + install.bat at repo root. install.sh mode 100755 via `git update-index --chmod=+x` (LF endings, propagates to Mac/Linux clones); install.bat CRLF endings with explicit `if errorlevel 1 exit /b 1` after each step AND `call bun ...` prefix (without `call`, control transfers to bun.cmd Windows shim and never returns to install.bat — gotcha caught live). .gitattributes extended with explicit (redundant-with-PLAT-05-but-clear) install.sh/install.bat rules. Live smoke `cmd /C install.bat` runs end-to-end exit 0 twice in a row. **14-05:** all hard gates green — `bun run build` ~70ms, `bun run test` 3147 passed (3123 baseline + 5 from 14-01 + 19 from 14-03; 20 baseline llama failures unchanged), `bun run vesna` **17/17 PASS GATED PASS**, DB schema unchanged, hook semantics unchanged, src/ Desktop/Projects grep clean (only documented kept-with-reason in llama-server-supervisor.ts + intentional doc/regex references). INST-07 verified live: angel.pid present + node.exe alive (PID 73568), session_events table shows fresh activity from current session, claudex_search MCP call returned ranked RRF-fused results. Phase 15 (claudex doctor diagnostics, DIAG-01..08) is next.
**Progress:** [██████████] 100%

Phase: 17 of 17 — Phase 17 CLOSED (4/4 plans). v4.1 milestone SHIPPED at v4.1.0.
Plan: —
Status: v4.1 SHIPPED publicly to `github.com/grigorijejakisic/Claudex` (36/44 v4.1 reqs done autonomously — LIC-01..03 + DOC-01..06 + PLAT-01..05 + INST-01..07 + DIAG-01..08 + VER-01..03 + REL-01/02/03/06; 8/44 HITL-pending — PLAT-06..08, VER-04/05, REL-04/05/07).

Progress: [██████████████████████] 100% (v4.1 — 6 of 6 phases shipped; v4.1 milestone closed)

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

- Plan-phase on Phase 14 (Bootstrap install + configurable paths, INST-01..07) — next concrete unit of work.
- Operator (user) to schedule three fresh-VM testing windows for Phase 16 (macOS, Ubuntu 24.04 LTS, Windows 11). These can be planned in parallel with Phase 14-15 work but the actual runs gate Phase 16 close.

### Blockers/Concerns

(No active blockers for v4.1 Phase 13. v4.0 carry-forward concerns parked in `.planning/v4.1-distribution/STUB.md` — those are v4.2+ and do not gate Distribution work.)

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

Last session: 2026-05-02
Stopped at: **Phase 17 CLOSE — v4.1 SHIPPED publicly at v4.1.0.** 4 plans / 3 atomic commits + this close commit pushed to BOTH origin (Corleanus/CLAUDEXv3) and public (grigorijejakisic/Claudex). REL-01/02/03/06 [x]. REL-04/05 [~] HITL (gh CLI Corleanus auth lacked write to public repo; operator-fallback runbook documented at `docs/onboarding/branch-protection-setup.md`). REL-07 [~] HITL (operator runs branch protection UI step). v4.0.0 + v4.1.0 tags both visible on `github.com/grigorijejakisic/Claudex/tags`. v4.1 milestone closed.
Resume file: — (next session: define v4.2 milestone or run operator HITL fallbacks)

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
