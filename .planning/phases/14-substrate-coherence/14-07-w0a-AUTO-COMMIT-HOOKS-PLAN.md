---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: w0a
type: execute
wave: 0
depends_on: []
status: SHIPPED 2026-05-16
files_modified:
  - scripts/auto-commit-hook.cjs (NEW)
  - .claude/settings.json
autonomous: true
operator_review_gate: false
requirements: []
---

# 14-07-w0a — Auto-commit hooks (RETROSPECTIVE SPEC)

**Status:** SHIPPED 2026-05-16. This plan doc is retrospective — capturing the design that already landed.

## Objective

Provide a per-session safety net: every session-start captures pre-session state; every Write/Edit/MultiEdit/NotebookEdit captures the change immediately; every session-end captures post-session state. Future agents can `git diff claudex/session-start-<X> HEAD` to see exactly what changed in any past session.

## What shipped

Three hooks registered in `.claude/settings.json` (project-scoped):

1. **SessionStart** — `node scripts/auto-commit-hook.cjs "session-start" "session-start"`. Runs `git add -A && git commit -m "claudex/auto: session-start" --allow-empty --no-verify` then creates tag `claudex/session-start-<epoch_seconds>`.

2. **PostToolUse on `Write|Edit|MultiEdit|NotebookEdit`** — `node scripts/auto-commit-hook.cjs "edit"`. Same `git add -A` + commit; no tag (would be too noisy).

3. **Stop** — `node scripts/auto-commit-hook.cjs "session-end" "session-end"`. Same as SessionStart but tags `claudex/session-end-<epoch_seconds>`.

**Silent-fail design:** any git error swallowed via try/catch; never blocks the session.

**Verification done 2026-05-16:** manual `node scripts/auto-commit-hook.cjs test-manual-invoke test-baseline` produced commit `a4c9059` + tag `claudex/test-baseline-1778940670`. End-to-end working.

## Acceptance criteria (all met at ship)

- AC-1: `scripts/auto-commit-hook.cjs` exists, takes event_name + optional tag_prefix args.
- AC-2: SessionStart hook commits + tags.
- AC-3: PostToolUse hook fires only on write tools (matcher = `Write|Edit|MultiEdit|NotebookEdit`).
- AC-4: Stop hook commits + tags.
- AC-5: All hook ops wrapped in silent-fail; non-git directories skip cleanly.
- AC-6: Manual smoke test produces visible commit + tag.

## Anti-scope

- Did NOT modify `~/.claude/settings.json` (global hooks remain unchanged — only claudex-v3 project-scope updated for initial rollout).
- Did NOT add auto-commit hooks to other projects (per operator: roll claudex-v3 first; propagate when stable).
- Did NOT add auto-init git for `.git`-less projects in this initial roll (open for follow-up if MoneyMaker / other projects need it).

## Follow-ups (not in this plan)

- Propagate hooks to other projects (operator-gated decision).
- Auto-init git in projects without `.git` (operator-gated).
- Squash auto-commits per task at session-end (optional cleanup; loses per-edit granularity).

## Operator approval

Confirmed 2026-05-16 16:21 ("I agree with your formulation! I lean C as well — Agreed again — Then sort them out please").
