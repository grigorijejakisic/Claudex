# Phase 17: Public Ship to grigorijejakisic/Claudex — Context

**Gathered:** 2026-05-02 (synthesized inline by team-lead orchestrator from PROJECT.md + REQUIREMENTS.md + Phase 14/15/16 outputs + live remote inspection)
**Status:** Ready for planning
**Generative axiom:** v4.1 ships publicly. The 336-commit evolution from v3-era (last public push: session 41 at `712c910`) → v4.0.0 internal infrastructure → v4.1 distribution becomes visible to strangers at `github.com/grigorijejakisic/Claudex` with `v4.0.0` and `v4.1.0` annotated tags. This is the final phase of the v4.1 milestone.

---

<domain>
## Phase Boundary

This phase delivers seven things and ONLY these seven:

1. **REL-01:** Public GitHub remote configured pointing to `git@github.com:grigorijejakisic/Claudex.git` (already done — `public` remote exists, verified)
2. **REL-02:** Initial push includes complete master history + all tags. **CONFIRMED FAST-FORWARD:** local master contains `712c910` (current `public/master` HEAD) as ancestor; 336 new commits append cleanly. NO force-push needed.
3. **REL-03:** `v4.1.0` annotated git tag created and pushed
4. **REL-04:** GitHub release for `v4.1.0` published with notes derived from `CHANGELOG.md`
5. **REL-05:** Repository topics set on GitHub for discoverability
6. **REL-06:** README badges (license, version, build status) display correctly on GitHub
7. **REL-07:** Branch protection rule for Vesna CI applied via GitHub UI (manual step — operator runs this; phase closes structurally with documented runbook for the UI click)

**Out of scope:**
- New features
- Multi-harness adapters → v4.2+
- Hosted/SaaS variant → v4.2+
- HITL fresh-VM trials → Phase 16 deferred (does NOT block this ship)
- v5 episodic memory → separate future milestone

**Hard gates:**
- `bun run build` (esbuild ~70ms) green
- `bun run test` 3188 baseline + 20 baseline llama-server-supervisor failures unchanged from v4.0.0; anything beyond is regression
- `bun run vesna` 17/17 PASS (SC#1 holds)
- `bun run doctor` exits 0 on this Windows machine
- `git push public master` succeeds as fast-forward (no force-push)
- `git push public --tags` succeeds (both v4.0.0 and v4.1.0 land)
- GitHub release v4.1.0 visible at `github.com/grigorijejakisic/Claudex/releases/tag/v4.1.0`
- DB schema unchanged
- Hook semantics unchanged

</domain>

<decisions>
## Implementation Decisions

### Push strategy (REL-01, REL-02)
- **Remote:** `public` → `git@github.com:grigorijejakisic/Claudex.git` (already configured, no setup needed)
- **Method:** standard `git push public master` (fast-forward; merge-base verified as `712c910`)
- **Followed by:** `git push public --tags` to send v4.0.0 + v4.1.0
- **Auth:** SSH key for `grigorijejakisic` GitHub account (or whatever the existing `public` remote uses for auth). If push fails with auth error, surface it and have operator run the push manually.
- **Pre-push verification:** `git status` clean (no uncommitted changes); `git log --oneline public/master..master` shows expected 336 commits

### v4.1.0 tag (REL-03)
- **Tag style:** annotated tag (matches v4.0.0 pattern)
- **Tag command:** `git tag -a v4.1.0 -m "v4.1.0 — Distribution"`
- **Tag message body** (one paragraph):
  ```
  v4.1.0 — Distribution
  
  Phase 12: MIT LICENSE + package.json polish + README + CHANGELOG + CONTRIBUTING
  Phase 13: Cross-platform code audit (path/hooks/locks/subprocess/.gitattributes)
  Phase 14: bun run setup bootstrap + CLAUDEX_PROJECTS_DIR env var + install.sh + install.bat
  Phase 15: bun run doctor diagnostics (7 checks)
  Phase 16: README Quick Start + Troubleshooting + onboarding fixtures (HITL-pending fresh-VM trials)
  Phase 17: Public ship
  
  44 v4.1 requirements: 32 closed autonomously; 12 HITL-pending (fresh-VM trials operator-runnable).
  All hard gates green: build, test (3188 + 20 baseline llama unchanged), vesna 17/17, doctor.
  ```
- **Push:** `git push public v4.1.0` (or use `--tags` to send all)

### GitHub release (REL-04)
- **Tool:** `gh release create v4.1.0 --repo grigorijejakisic/Claudex --notes-file <path>`
- **Notes source:** extract v4.1.0 section from `CHANGELOG.md` (the `[Unreleased]` content from Phase 16 should be promoted to `[4.1.0] — 2026-05-02` as part of phase close before tagging)
- **Title:** `v4.1.0 — Distribution`
- **Auth:** `gh` CLI authenticated as Corleanus (from `gh auth status`); if Corleanus has push access to grigorijejakisic/Claudex (we believe so since SSH remote works), the release create will work

### Repository topics (REL-05)
- **Tool:** `gh repo edit grigorijejakisic/Claudex --add-topic <topic>` (one per topic)
- **Topics to set:**
  - `claude-code`
  - `mcp`
  - `agent-memory`
  - `llm-tools`
  - `typescript`
  - `bun`
  - `claudex`
  - `persistent-memory`
  - `claude`
- **Verification:** `gh repo view grigorijejakisic/Claudex --json repositoryTopics`

### README badges (REL-06)
- **Badges to add** (top of README, after title, before tagline):
  - License: `![License](https://img.shields.io/badge/license-MIT-blue.svg)` linked to LICENSE
  - Version: `![Version](https://img.shields.io/badge/version-4.1.0-brightgreen.svg)`
  - Build: `![Vesna](https://github.com/grigorijejakisic/Claudex/actions/workflows/vesna.yml/badge.svg)` (will render once workflow runs on public repo)
- **Note:** the Vesna badge will show "no status" until the workflow runs at least once on the public repo. Acceptable — it'll go green on first push that triggers CI.

### Branch protection (REL-07) — HITL
- **Step:** operator visits `https://github.com/grigorijejakisic/Claudex/settings/branches` → "Add rule" for `master` → enable "Require status checks before merging" → search for "Vesna" and require it
- **Why HITL:** GitHub branch protection requires UI interaction (gh CLI has API support but for "rulesets" not classic protection rules; the simplest path is the UI)
- **Phase close:** ships a runbook (`docs/onboarding/branch-protection-setup.md` or equivalent) describing the click path; operator runs it post-ship

### CHANGELOG.md update for v4.1.0
- **Pre-tag:** Phase 16 left CHANGELOG `[Unreleased]` section with v4.1 onboarding notes. Phase 17 should:
  1. Move that content into a new `[4.1.0] — 2026-05-02` section
  2. Add Phase 17's deliverables (public ship, tag, release)
  3. Reset `[Unreleased]` to placeholder for v4.2+
- **Sequence matters:** CHANGELOG update → commit → tag → push (so the tag points at a commit with the correct CHANGELOG)

### Phase close (final v4.1 close)
- **Updates:**
  - STATE.md: mark v4.1 SHIPPED at v4.1.0; "next milestone v4.2 (TBD)"; mark Phase 17 [x]
  - ROADMAP.md: mark Phase 17 [x] with completion date
  - REQUIREMENTS.md: mark REL-01..06 [x]; REL-07 marked HITL-pending; PLAT-06..08 + VER-04..05 still HITL-pending from Phase 16
  - 17-SUMMARY.md
- **Final commit:** atomic phase-close commit pushes to BOTH remotes (origin Corleanus/CLAUDEXv3 + public grigorijejakisic/Claudex)

</decisions>

<integration_points>
## Integration Points

- **Existing `public` remote:** `git@github.com:grigorijejakisic/Claudex.git` — verified
- **Existing v4.0.0 tag:** at commit `f8f617c` — also needs to push to public (was only pushed to origin earlier)
- **CHANGELOG.md** (Phase 12 + Phase 16): contains the v4.0.0 release notes already (Phase 12) + `[Unreleased]` v4.1 entries (Phase 16); promote Unreleased to v4.1.0 before tagging
- **README.md** (Phase 12 + Phase 16): has Quick Start, Troubleshooting, What+Why; add badges at top
- **gh CLI auth:** Corleanus account; if push fails with permission error on grigorijejakisic/Claudex, surface to operator
- **Vesna CI workflow** at `.github/workflows/vesna.yml`: will run on first public push; the badge in README will resolve once the workflow runs

</integration_points>

<acceptance>
## Acceptance Criteria

The phase is closed when:

1. `git push public master` succeeded as fast-forward; `public/master` advances from `712c910` to current HEAD
2. `git push public --tags` succeeded; `v4.0.0` and `v4.1.0` both visible on `github.com/grigorijejakisic/Claudex/tags`
3. `v4.1.0` annotated tag created at the phase-close commit with the message body above
4. GitHub release `v4.1.0` visible at `github.com/grigorijejakisic/Claudex/releases` with title "v4.1.0 — Distribution" and CHANGELOG-derived notes
5. Repository topics include at least: `claude-code`, `mcp`, `agent-memory`, `llm-tools`, `typescript`, `bun`, `claudex`, `persistent-memory`, `claude` (verifiable via `gh repo view`)
6. README has 3 badges at top (license, version, Vesna CI); Vesna badge may show "no status" until first public CI run (acceptable)
7. CHANGELOG.md has `[4.1.0] — 2026-05-02` section with v4.1 deliverables; `[Unreleased]` reset for v4.2+
8. `bun run build`, `bun run test` (3188 + 20 baseline llama unchanged), `bun run vesna` 17/17, `bun run doctor` exit 0 — all gates green
9. STATE.md / ROADMAP.md / REQUIREMENTS.md updated; 17-SUMMARY.md exists
10. Atomic commits using `phase(17):` convention; phase-close commit pushed to both remotes
11. Branch protection setup runbook exists (REL-07 HITL marker; operator runs UI step post-ship)

</acceptance>

<plan_authorization>
## Pre-authorized Plan Decisions

The plan-phase agent has authority to:

- Use the locked decisions in `<decisions>` without re-asking the operator
- Decide structure of plans (likely 3-4 plans):
  - Plan 1: CHANGELOG promotion + README badges (pre-tag content)
  - Plan 2: v4.1.0 tag + push to public (REL-02 + REL-03)
  - Plan 3: GitHub release + topics (REL-04 + REL-05) + REL-07 runbook
  - Plan 4: Phase close + final v4.1 milestone close
- Choose between separate `gh release create` step and using existing CHANGELOG content directly
- Skip Vesna CI badge if it requires the workflow to have run at least once (acceptable — badge resolves on first public push)
- Reuse Phase 14 install.sh for example commands in any documentation that needs them

The plan-phase agent does NOT have authority to:

- Force-push to public master (NOT NEEDED — fast-forward verified; if the situation changes and force-push is needed, escalate to operator)
- Use a different remote name than `public`
- Skip CHANGELOG promotion (the v4.1.0 tag must point at a commit with v4.1.0 release notes)
- Add v4 internal deferrals (EXTR-04, LIFE-01..04, etc.) to v4.1.0 scope — they remain v4.2+
- Modify code beyond README badges and CHANGELOG (Phase 17 is publication only)

</plan_authorization>

<open_questions>
## Open Questions

**One operational risk worth surfacing pre-execution:**
- **gh CLI auth scope:** Corleanus is logged into gh CLI; we verified `gh repo view grigorijejakisic/Claudex` works (read access). Whether Corleanus has WRITE access to grigorijejakisic/Claudex is the unknown. The SSH `public` remote uses a different auth path (SSH key, likely registered to grigorijejakisic). So:
  - `git push public master` uses SSH → likely works
  - `gh release create --repo grigorijejakisic/Claudex` uses gh's HTTPS+token → may fail if Corleanus lacks write
  - **Mitigation:** if `gh release create` fails, the operator can run it manually as grigorijejakisic via `gh auth login --hostname github.com --user grigorijejakisic`. Plan 17-03 should document this fallback explicitly.
- This is NOT a CONTEXT-changing question (we proceed with the plan); it's a runtime risk to anticipate.

If the executor surfaces a question that genuinely needs operator input mid-flow (e.g., "git push to public failed with permission denied"), SendMessage team-lead. The bar is "this changes the deliverable shape," not "I want to confirm an obvious choice."

</open_questions>
