---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: w0b
type: execute
wave: 0
depends_on: ["w0a"]
status: PARTIAL SHIPPED 2026-05-16 (v0 skill registered; scripted version is forward work)
files_modified:
  - ~/.claude/skills/verify/SKILL.md (NEW, SHIPPED)
  - scripts/verify.cjs (FORWARD — not yet authored)
  - src/tests/scripts/verify.test.ts (FORWARD)
autonomous: true
operator_review_gate: false
requirements: ["w0a auto-commit hooks must be live so /verify has a diff baseline"]
---

# 14-07-w0b — /verify skill (PARTIAL SHIPPED + FORWARD)

**Status:** SHIPPED 2026-05-16 — skill registered at `~/.claude/skills/verify/SKILL.md`, confirmed in CC skill list. Procedural v0 (agent runs the 5-step protocol manually). **Forward work:** scripted version `scripts/verify.cjs` that runs the steps as a CLI invocation.

## Objective

Close the protocol loop: agent claims "done" → CLAUDE.md rule says "run /verify first" → agent invokes /verify → /verify runs 5 steps (diff capture, build+test, spec-doc verification, memory-file verification, structured report) → agent surfaces report → operator sees evidence, not claims.

## What shipped (v0)

`~/.claude/skills/verify/SKILL.md` — procedural skill that the agent reads and follows manually:

1. **Step 1 — Diff capture:** find most recent `claudex/session-start-*` tag, run `git diff --stat`, `git diff --name-only`, capture full diff. Falls back to `HEAD~10` if no tag exists.
2. **Step 2 — Build + test:** for each changed `.ts/.tsx/.js/.cjs/.mjs` file, run `bun run build`; for changed test files, run `npx vitest run`; full suite for regression check.
3. **Step 3 — Spec-doc verification:** for changed `.md` files under `.planning/` or `docs/`, grep the codebase for every cited function name / file path / schema version; classify claims as Verified | Unverified | Mismatched.
4. **Step 4 — Memory-file verification:** if `MEMORY.md` or `memory/*.md` changed, confirm `<!-- USER EDITABLE -->` marker present, lesson pointers reference real files, no wipe regression.
5. **Step 5 — Report:** structured markdown report with diff summary, build/test status, claim counts, mismatched-claim list, recommended next action.

Authoritative anti-pattern documented in SKILL.md: the 2026-05-16 v7.0.0 spec session burn (15 docs, no verification, operator caught the gap).

**Verification done 2026-05-16:** CC's skill list confirmed `/verify` is registered and addressable. Procedural form was exercised on today's spec corrections (lightweight: grep for one function name, count occurrences of one path).

## Forward work

`scripts/verify.cjs` — scripted version that automates Steps 1-2 and produces machine-readable JSON output. Agent invokes via Bash; report is structured per SKILL.md's template.

## Acceptance criteria (v0 met; v1 forward)

- AC-1 ✓: SKILL.md exists at `~/.claude/skills/verify/SKILL.md` with correct frontmatter.
- AC-2 ✓: CC registers the skill (confirmed in skill list).
- AC-3 ✓: Procedural form documented for manual execution.
- AC-4 ⏳: Scripted `scripts/verify.cjs` (forward work).
- AC-5 ⏳: End-to-end test running the full 5-step protocol against today's diff (forward).
- AC-6 ⏳: Operator runs /verify in a new session and confirms it surfaces a useful report.

## Anti-scope

- Did NOT build a hard-gate /verify that blocks "done" claims at the harness level. v0 is advisory — agent self-enforces per CLAUDE.md rule.
- Did NOT replace the agent's judgment; /verify outputs a report, agent decides what to do with it.
- Did NOT integrate with CI (out of scope — pre-CI surface).

## Operator approval

Skill design + behavior confirmed 2026-05-16 16:21.
