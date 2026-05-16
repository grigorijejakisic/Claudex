---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: w0c
type: execute
wave: 0
depends_on: ["w0b"]
status: SHIPPED 2026-05-16
files_modified:
  - ~/.claude/CLAUDE.md
autonomous: true
operator_review_gate: false
requirements: ["w0b /verify skill must be registered first so the rule references something real"]
---

# 14-07-w0c — CLAUDE.md verify-before-done rule (RETROSPECTIVE SPEC)

**Status:** SHIPPED 2026-05-16. Retrospective spec.

## Objective

Identity-level rule in `~/.claude/CLAUDE.md`: before claiming any work done, run `/verify` and surface its output. Verified is the only kind of done. Per the persona-tuning track (`feedback_persona_tuning_manual_track.md`), behavioral rules stick better when framed as character traits, not procedural rules — the new paragraph is character-shaped.

## What shipped

Added a paragraph in `~/.claude/CLAUDE.md` "How I approach work" section, immediately after the existing *"I don't trust my own 'done'"* paragraph. The new text:

> *"I run `/verify` before I claim done. The discipline above lives in a slash command: it captures git diff against the session-start tag, runs the relevant tests, greps for assumed-but-not-verified names against the actual codebase, and produces a structured 'N claims, M verified, K unverified' report. I surface its output. If `/verify` isn't available in the current environment, I run the equivalent steps manually and surface what I checked. The 2026-05-16 v7.0.0 spec session is the burn behind this rule — I wrote 15 spec docs without verifying any function name or schema mapping against the actual code, and the operator caught the gap before I caught it. **Verified is the only kind of done.**"*

## Acceptance criteria (all met)

- AC-1 ✓: Rule lands in `~/.claude/CLAUDE.md` "How I approach work" section.
- AC-2 ✓: Rule names the 2026-05-16 v7.0.0 spec burn explicitly.
- AC-3 ✓: Rule cites `/verify` skill (which must exist — w0b shipped first).
- AC-4 ✓: Rule has the identity-shape ending: *"Verified is the only kind of done."*
- AC-5 ⏳: Future-session test: agent reads CLAUDE.md at session start, sees the rule, runs /verify before claiming done. (Will be observable empirically over the next N sessions.)

## Anti-scope

- Did NOT add the rule to project-level CLAUDE.md files. The rule is identity-level (operator's user-scope), applies across all projects.
- Did NOT modify the existing surrounding paragraphs (only inserted new content).
- Did NOT add SessionStart reminder hook (deferred — see CONTEXT decision rationale; CLAUDE.md re-injection per session is sufficient).

## Operator approval

Confirmed 2026-05-16 16:21 (alongside the Wave 0 design overall).
