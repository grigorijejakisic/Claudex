# Phase 16 — Onboarding Verification + README Polish — STRUCTURAL CLOSE

**Shipped:** 2026-05-02 (structural — autonomous deliverables on disk)
**HITL-pending close:** PLAT-06..08 + VER-04/05 awaiting operator-driven fresh-VM runs
**Generative axiom:** Strangers picking up `git clone` on Mac, Linux, or Windows can install Claudex in <30 minutes following `README.md` alone, with `bun run doctor` confirming health when something's off. The README half is shipped; the fresh-VM half awaits operator.

---

## What shipped (autonomous half)

| # | Deliverable | Location | Length |
|---|-------------|----------|--------|
| 1 | README §Quick Start (DOC-03) | `README.md` between §Why Claudex and §Diagnostics | 47 lines (≤80 budget) |
| 2 | README §Troubleshooting (DOC-04) | `README.md` after §Diagnostics | 61 lines (≤120 budget) |
| 3 | macOS onboarding fixture (VER-01) | `docs/onboarding/macos.md` | ~145 lines |
| 4 | Linux (Ubuntu 24.04 LTS) onboarding fixture (VER-02) | `docs/onboarding/linux.md` | ~155 lines |
| 5 | Windows 11 onboarding fixture (VER-03, split-mode) | `docs/onboarding/windows.md` | ~180 lines |

## Requirements closed (autonomous)

- [x] **DOC-03** — README §Quick Start exists; references Phase 14 commands (`./install.sh`, `install.bat`, `bun install --frozen-lockfile`, `bun run build`, `bun run setup`, `CLAUDEX_PROJECTS_DIR`) and Phase 15 commands (`bun run doctor`, the 6 diagnostic checks) verbatim
- [x] **DOC-04** — README §Troubleshooting covers Ollama not running / port 7439 dead / Bun version mismatch / hook registration failure; every entry routes through `bun run doctor` before listing manual fixes; reranker entry uses `⚠` (warn) not `✗` (fail), matching doctor's actual output
- [x] **VER-01** — `docs/onboarding/macos.md` exists with the agreed fixture template (status header HITL-PENDING, 7 numbered steps with Command/Expected/Friction/Elapsed each, Friction summary / Resolutions / Verdict sections, cross-links to README sections and to linux.md / windows.md)
- [x] **VER-02** — `docs/onboarding/linux.md` exists with same template, Ubuntu 24.04 LTS specifics (`apt install python3.11 python3.11-venv`, `curl -fsSL https://ollama.com/install.sh | sh`, `systemctl --user start ollama` or `ollama serve &` for headless), distro scope explicitly Ubuntu 24.04 only
- [x] **VER-03** — `docs/onboarding/windows.md` exists in split-mode: steps 1-3 (fresh Bun/Ollama/Python install) HITL-pending, steps 4-7 (clone / install.bat / `bun run doctor` / first session) recorded from current dev machine state with verbatim doctor table pasted in Step 6

## Requirements deferred (HITL — Phase 16 close conditional)

- [~] **PLAT-06** — macOS install verified end-to-end on fresh VM (operator runs `docs/onboarding/macos.md`)
- [~] **PLAT-07** — Ubuntu 24.04 LTS install verified end-to-end on fresh VM (operator runs `docs/onboarding/linux.md`)
- [~] **PLAT-08** — Windows 11 install verified end-to-end on fresh VM (operator runs steps 1-3 of `docs/onboarding/windows.md` from a clean Win11 VM; steps 4-7 already pre-recorded from dev machine, autonomous half PASS)
- [~] **VER-04** — friction-resolution audit (operator-driven; depends on PLAT-06/07/08 runs surfacing real friction first)
- [~] **VER-05** — <30-minute install target measured per platform (operator-driven; baseline is total elapsed time recorded in each fixture's Status header)

These deferrals follow the Phase 11 SC#4 pattern: structural autonomous + HITL operator-runnable. Phase 17 (public ship) is NOT blocked.

## Files added

- `docs/onboarding/macos.md` — VER-01 fixture
- `docs/onboarding/linux.md` — VER-02 fixture
- `docs/onboarding/windows.md` — VER-03 fixture (split-mode: autonomous half recorded, HITL half pending)
- `.planning/phases/16-onboarding-verification-readme-polish/16-SUMMARY.md` — this file

## Files modified

- `README.md` — §Quick Start added, §Troubleshooting added, status banner updated, `## Installation` placeholder removed
- `CHANGELOG.md` — `[Unreleased]` section populated with Phase 16 entry
- `.planning/STATE.md` — Phase 16 structural close status; Phase 17 unblocked
- `.planning/ROADMAP.md` — Phase 16 row updated to `[~]` Structural complete (HITL-pending); Phase 17 row marked unblocked; HITL-pending pattern footnote added
- `.planning/REQUIREMENTS.md` — DOC-03/04 + VER-01/02/03 marked `[x]` / Done; PLAT-06..08 + VER-04/05 marked `[~]` / Pending (HITL); coverage count updated

## Hard gates (autonomous half)

- `bun run build` — green (esbuild ~70-150ms; docs-only edits unaffected; hook smoke 24/24 pass)
- `bun run test` — ≥3188 passing + 20 baseline llama-supervisor failures unchanged from v4.0.0 (no test changes; matches Phase 15 close exactly)
- `bun run vesna` — **17/17 GATED PASS** (entity-recall 3/3 · constraint-recall 3/3 · handoff-pickup 3/3 · cross-project 3/3 · lesson-application 3/3 · self-instrumented 2/2)
- `bun run doctor` — exit 0 (5 pass + 1 warn for Angel heartbeat staleness per 15-SUMMARY.md baseline; warn self-clears on next session-start)
- DB schema — unchanged
- Hook semantics — unchanged
- README final length — within ≤2000 line budget set by `16-CONTEXT.md`

## Cross-link audit

All links resolve at phase close:

- `README.md#quick-start` → §Quick Start in README ✓
- `README.md#troubleshooting` → §Troubleshooting in README ✓
- `docs/onboarding/macos.md` → from README status banner + Troubleshooting footer + Linux/Windows fixture cross-references ✓
- `docs/onboarding/linux.md` → from same set ✓
- `docs/onboarding/windows.md` → from same set + cross-references in macos.md / linux.md ✓
- `../../.planning/phases/14-bootstrap-install-configurable-paths/14-SUMMARY.md` → from Windows fixture ✓
- `../../.planning/phases/15-claudex-doctor-diagnostics/15-SUMMARY.md` → from Windows fixture ✓
- `../../.planning/phases/11-p9-final-validation/11-03-cold-start-trial-1.md` (and -2, -3) → from macOS / Linux fixtures ✓

## Notable decisions made during execution

Three minor on-the-ground adjustments to honest-reality accommodations (no decisions diverged from `16-CONTEXT.md`):

1. **README Troubleshooting reranker.log path:** the canonical Phase 14 path `services/.venv/` is not present on this dev machine (the live BGE reranker on `:7439` is supervised by Angel's `RerankerSupervisor` and runs from a separate environment). The README §Troubleshooting Reranker entry was authored to say "check the reranker process logs (location depends on how `bun run setup` started it — typically captured by Angel's `RerankerSupervisor`)" rather than naming a non-existent log path. This honors the plan's "verify before authoring" rule.
2. **Windows fixture Step 5 dev-machine note:** because `services/.venv/` is absent locally yet the reranker is healthy on `:7439`, Step 5's "Recorded on this machine" callout explicitly notes "on this dev machine the reranker process is supervised by Angel's `RerankerSupervisor` rather than a `services/.venv/` symlink directly, so the venv directory may not be present at the canonical Phase 14 path while the service is still healthy." Honest reflection of state, not fabrication.
3. **Doctor Angel-heartbeat warn cleared between Plan 16-03 recording and Plan 16-04 close gate.** At fixture-recording time `bun run doctor` reported `⚠ Angel ... last heartbeat 989s ago (>=60s)` (matching Phase 15's documented self-clearing behavior). At phase-close gate, `bun run doctor` reports `✓ Angel ... heartbeat fresh (29s)` — exit still 0. The Windows fixture (`docs/onboarding/windows.md` Step 6) preserves the recorded warn shape since the fixture is a snapshot in time, not a contract; the Step 6 note already explains the warn is self-clearing on next session-start, which is exactly what happened. No fixture re-record needed; this divergence is the documented expected behavior.

No other divergences. All other content followed the locked decisions in `16-CONTEXT.md` exactly.

## What's next

Phase 17 — Public ship to `grigorijejakisic/Claudex`. REL-01..07 (remote configuration + history push + tag + GitHub release + topics + badges + branch protection). Unblocked per Phase 11 SC#4 precedent — HITL-pending Phase 16 items do not gate public ship.

When the operator runs the three fixtures and reports back, PLAT-06..08 + VER-04/05 flip to `[x]` in REQUIREMENTS.md and ROADMAP.md, closing Phase 16 fully. That update can land any time, doesn't block v4.1.0 release.
