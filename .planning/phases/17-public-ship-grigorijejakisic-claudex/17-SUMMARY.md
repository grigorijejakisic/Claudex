# Phase 17 Summary — Public Ship to grigorijejakisic/Claudex

**Closed:** 2026-05-02
**Status:** SHIPPED — v4.1 publicly on `github.com/grigorijejakisic/Claudex`
**Requirements:** REL-01..07 (7 total) — 4 [x] autonomous + 3 [~] HITL

## What shipped

### REL-01: Public GitHub remote configured

`public` remote points to `git@github.com:grigorijejakisic/Claudex.git` (verified pre-phase; no setup needed). Used SSH auth (key registered for grigorijejakisic).

### REL-02: Complete master history pushed (337 commits)

`git push public master` succeeded as fast-forward from `712c910` (the v3-era last public push, session 41) to `d18c934` (Plan 17-01's commit). 336 commits from v4.0.0 milestone work + 1 commit from Plan 17-01 = 337 total. NO force-push needed.

`git push public --tags` sent both `v4.0.0` (created Phase 11 close at `19e9fa0`, never previously pushed to public) and `v4.1.0` (created Plan 17-02 at `4f29efe`).

Verified via `git ls-remote public`:
- `refs/heads/master` → `d18c9343776e87483fca1eb9cb37cbabef7d2113`
- `refs/tags/v4.0.0` → `19e9fa093c0e715846a1e54c5a63623d3cc29da4`
- `refs/tags/v4.1.0` → `4f29efe0ab556df249d213eb928147aeac383ca1`

### REL-03: v4.1.0 annotated tag

Annotated tag at the CHANGELOG/badges commit (Plan 17-01, `d18c934`) — content-complete state, not phase-admin state. Tag message body:

```
v4.1.0 — Distribution

Phase 12: MIT LICENSE + package.json polish + README + CHANGELOG + CONTRIBUTING
Phase 13: Cross-platform code audit (path/hooks/locks/subprocess/.gitattributes)
Phase 14: bun run setup bootstrap + CLAUDEX_PROJECTS_DIR env var + install.sh + install.bat
Phase 15: bun run doctor diagnostics (7 checks)
Phase 16: README Quick Start + Troubleshooting + onboarding fixtures (HITL-pending fresh-VM trials)
Phase 17: Public ship

44 v4.1 requirements: 38 closed autonomously; 6 HITL-pending (fresh-VM trials operator-runnable).
All hard gates green: build, test (3188 + 20 baseline llama unchanged), vesna 17/17, doctor.
```

(The tag body's 38/6 numbers were the projected post-Phase-17 counts at tag-write time. The actual final count after the gh-permission HITL fallback is 36 [x] + 8 [~] — REL-04 + REL-05 dropped from autonomous to HITL post-tag — but the tag body is immutable; CHANGELOG and STATE/ROADMAP carry the corrected counts.)

Verified via `git cat-file -p v4.1.0`.

### REL-04 (HITL): GitHub release v4.1.0 — Distribution

**Autonomous attempt failed.** `gh release create v4.1.0 --repo grigorijejakisic/Claudex --title "v4.1.0 — Distribution" --notes-file <extracted-changelog-section> --verify-tag` returned: `Failed to create release, "workflow" scope may be required.` Corleanus's gh CLI token already has `workflow` scope (verified via `gh auth status`); the misleading error masks the actual root cause — Corleanus lacks write permission on the public repo `grigorijejakisic/Claudex`. This is exactly the operational risk CONTEXT.md `<open_questions>` flagged.

**Operator fallback documented** at `docs/onboarding/branch-protection-setup.md` (## Operator fallback section). Release notes file preserved at `/tmp/phase17-fallback/release-notes.md` so the operator can re-run `gh release create` directly without re-extracting from CHANGELOG. After operator runs the fallback, REL-04 flips from `[~]` to `[x]`.

### REL-05 (HITL): Repository topics

**Autonomous attempt failed.** `gh repo edit grigorijejakisic/Claudex --add-topic ...` returned `HTTP 404: Not Found (https://api.github.com/repos/grigorijejakisic/Claudex/topics)`. Same permission root cause as REL-04 (404 from this endpoint with read-only auth is GitHub's permission-mask behaviour).

The 9 topics intended for application:

- `claude-code`
- `mcp`
- `agent-memory`
- `llm-tools`
- `typescript`
- `bun`
- `claudex`
- `persistent-memory`
- `claude`

**Operator fallback documented** in the same runbook section as REL-04. After operator runs the fallback, REL-05 flips from `[~]` to `[x]`.

### REL-06: README badges

3 badges added at top of README (between title and tagline) in Plan 17-01:

- `[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)` — links to LICENSE
- `[![Version](https://img.shields.io/badge/version-4.1.0-brightgreen.svg)](#)` — informational, no link
- `[![Vesna CI](https://github.com/grigorijejakisic/Claudex/actions/workflows/vesna.yml/badge.svg)](https://github.com/grigorijejakisic/Claudex/actions/workflows/vesna.yml)` — links to workflow page

The Vesna badge will show "no status" until the Vesna workflow runs at least once on the public repo. The first push from Plan 17-02 should trigger that run; the badge resolves on its own.

### REL-07 (HITL): Branch protection runbook

Authored at `docs/onboarding/branch-protection-setup.md` (113 lines including the operator-fallback section for REL-04 + REL-05) describing the GitHub UI click path for the operator to apply the branch protection rule (Vesna CI required on `master`). Phase closes structurally with this requirement marked `[~]` HITL — operator runs the UI step post-ship. Pattern matches Phase 11 SC#4 cold-start trials and Phase 16 PLAT-06..08 HITL deferrals.

## What's HITL-pending after Phase 17

| Req | Source phase | Description | Runbook |
|-----|--------------|-------------|---------|
| PLAT-06 | Phase 16 | macOS install verified end-to-end on fresh VM | docs/onboarding/macos.md |
| PLAT-07 | Phase 16 | Ubuntu 24.04 LTS install verified on fresh VM | docs/onboarding/linux.md |
| PLAT-08 | Phase 16 | Windows 11 install verified on fresh VM (regression) | docs/onboarding/windows.md (split-mode autonomous half PASS) |
| VER-04 | Phase 16 | Friction resolution as code/doctor/README entry | (depends on PLAT-06..08) |
| VER-05 | Phase 16 | <30-min install target measured per platform | (depends on PLAT-06..08) |
| REL-04 | Phase 17 | GitHub release v4.1.0 created via `gh release create` | docs/onboarding/branch-protection-setup.md (Operator fallback) |
| REL-05 | Phase 17 | 9 repo topics applied via `gh repo edit` | docs/onboarding/branch-protection-setup.md (Operator fallback) |
| REL-07 | Phase 17 | Branch protection UI step | docs/onboarding/branch-protection-setup.md (Click path) |

These eight items follow the same flexibility pattern v4.0.0 used at Phase 11 SC#4 — structural close ships; operator-driven verification deferred. v4.1 milestone is closed despite these deferrals. REL-04 + REL-05 are the only ones that crossed the autonomous/HITL boundary mid-phase due to the Corleanus permission gap on the public repo (anticipated risk; runbook covered it).

## Hard-gate evidence

Run on Plan 17-01's commit (`d18c934`) before tag creation; re-witnessed at phase-close commit:

```
$ bun run build
[esbuild green, ~70ms]

$ bun run test
3188 passed | 20 failed (215 test files; 2 failed)
[20 failed all in src/tests/angel/llama-server-supervisor.test.ts — baseline failures unchanged from v4.0.0]

$ bun run vesna
17/17 GATED PASS
  entity-recall: 3/3 (100%) flaky=0
  constraint-recall: 3/3 (100%) flaky=0
  handoff-pickup: 3/3 (100%) flaky=0
  cross-project: 3/3 (100%) flaky=0
  lesson-application: 3/3 (100%) flaky=0
  self-instrumented: 2/2 (100%) flaky=0
AGGREGATE: 100%

$ bun run doctor
✓ Bun version        Bun 1.3.6                    (225ms)
✓ DB schema          user_version=24              (186ms)
✓ Ollama             daemon up, snowflake-arctic-embed2 pulled (190ms)
✓ Reranker           port 7439 healthy            (7ms)
✓ CC hooks           25 of 25 registered          (1ms)
✓ Angel              PID 73568, heartbeat fresh (19s) (0ms)
exit: 0
```

DB schema (V24) unchanged from v4.0.0. Hook semantics unchanged.

## Plans

- **17-01** — CHANGELOG promote `[Unreleased]` → `[4.1.0] — 2026-05-02` + README badges. Atomic commit `d18c934`. REL-06 closed; CHANGELOG content staged for REL-04.
- **17-02** — v4.1.0 annotated tag at `d18c934` (`4f29efe`) + `git push public master` (fast-forward 712c910..d18c934) + `git push public --tags`. No commit (tag is metadata). REL-02, REL-03 closed.
- **17-03** — `gh release create` and `gh repo edit` both failed with permission error (Corleanus lacks write on public repo); branch-protection runbook authored at `docs/onboarding/branch-protection-setup.md` WITH the conditional `## Operator fallback` section per Plan 17-03 task 06. Release notes file preserved at `/tmp/phase17-fallback/release-notes.md`. Atomic commit `3561ac8`. REL-07 runbook half closed; REL-04 + REL-05 documented as HITL-pending awaiting operator gh-as-grigorijejakisic re-run.
- **17-04 (this plan)** — STATE/ROADMAP/REQUIREMENTS updated for final v4.1 close + 17-SUMMARY.md (this file) + phase-close commit pushed to BOTH remotes. REL-01 (already verified pre-phase) marked [x]; REL-02/03/06 confirmed [x]; REL-04/05/07 marked [~] HITL with runbook references.

## Public-ship verification (visual on GitHub)

After Plan 17-02's push:

- `https://github.com/grigorijejakisic/Claudex` → master at `d18c934`; README renders with 3 badges at top
- `https://github.com/grigorijejakisic/Claudex/tags` → v4.0.0 and v4.1.0 listed
- `https://github.com/grigorijejakisic/Claudex/releases/tag/v4.1.0` → 404 currently (release object pending operator fallback for REL-04)
- `https://github.com/grigorijejakisic/Claudex` (sidebar) → no topics currently (pending operator fallback for REL-05)
- `https://github.com/grigorijejakisic/Claudex/settings/branches` → empty (operator runs REL-07 click path to populate)

## Notes

- **The v4.1.0 tag is at Plan 17-01's commit (`d18c934`), not at this close commit.** This is intentional: the tag points at content-complete v4.1.0 state (CHANGELOG narrative + badges), not at planning admin (STATE updates). Matches v4.0.0 precedent (tag at `19e9fa0`, the v4.0.0 release-content commit).
- **Phase 17 is the FINAL phase of v4.1.** v4.2 milestone is TBD; will be defined in a future planning session.
- **Phase commits use the `phase(17):` convention** — matches Phase 11/12/13/14/15/16 close commit format. The atomic chain is: 17-01 CHANGELOG/badges (`d18c934`) → 17-02 (no commit, tag + push) → 17-03 runbook + fallback (`3561ac8`) → 17-04 close (this commit).
- **The push to BOTH remotes happens only in this plan.** Plan 17-02's push to `public` only sent commits 1..N (where N is 17-01's commit); Plan 17-03's commit is local-only; this plan pushes commits 17-03 + 17-04 to `public` and the entire `phase(17):` chain to `origin` (Corleanus/CLAUDEXv3).
- **gh CLI permission gap was anticipated but materialized.** CONTEXT.md `<open_questions>` explicitly named this risk and pre-authorized the runbook fallback as the response. The runbook is now in place; v4.1 ships structurally with REL-04/05 awaiting one operator command.
- **Stats reconciliation:** the v4.1.0 tag body and CHANGELOG `### Stats` block say "38 closed autonomously / 6 HITL-pending" because that was the projected count at tag-write time (with REL-01/02/03/04/05/06 all expected to close autonomously). After REL-04 + REL-05 dropped to HITL, the actual final count is **36 closed autonomously / 8 HITL-pending**. STATE.md and REQUIREMENTS.md carry the corrected 36/8 counts. The tag is immutable — recreating it would require a destructive force-push of a tag, which the phase explicitly forbids.
