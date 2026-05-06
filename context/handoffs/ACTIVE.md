---
status: active
phase: "7"
summary: Phase 7 (v4 coexistence/migration/ship) discuss complete. CONTEXT.md committed cleanly. Team pre-cleaned. Spawn plan-7 immediately.
topic: 2026-05-06-phase-7
created_at_epoch_ms: 1778029260000
---
# 2026-05-06 — Phase 7 mid-cycle (v5.0.0 ship phase)

**Where we are:** Phase 7 discuss-phase complete. CONTEXT.md on disk at `.planning/phases/07-v4-coexistence-migration-ship/07-CONTEXT.md` (19KB, 4 locked areas) and committed cleanly at `55f84b3` (recovered from earlier malformed `886595c` via reset --soft + resplit). plan-phase + execute-phase + v5.0.0 tag remain.

**Standing user directive (also in curated context as preference):** "no need to stop between phases, keep going" — autonomous through Phase 7 → v5.0.0 tag. NO AskUserQuestion gates between phases. Only escalate for genuine uncertainty.

## First 5 Minutes — Resume Script

Execute in order. No interpretation needed.

1. **Verify clean state** (read-only, ~10 sec):
   ```bash
   git log --oneline -5     # HEAD should be at session-end commit; 55f84b3 (docs(07)) two back
   git status --short       # only context/checkpoints/latest.yaml + node_modules noise allowed
   ls .planning/phases/07-v4-coexistence-migration-ship/  # 07-CONTEXT.md must exist
   ```
   If anything looks wrong, surface it — don't proceed.

2. **Spawn plan-7 immediately** via `/auto-orchestrate --from-phase 7`. The pipeline detects existing CONTEXT.md, skips discuss, lands on plan-phase. Team `auto-gsd-pipeline` was pre-deleted at session 59 close, so TeamCreate succeeds first try.

3. **Handle plan-7 SendMessage questions** per the orchestrator skill answer_questions step — check 07-CONTEXT.md first (it's exhaustive), then PROJECT.md/ROADMAP.md/REQUIREMENTS.md, then escalate only for genuine UX/scope-naming uncertainty. The locked decisions in CONTEXT.md should answer 90%+ of plan-7's questions.

4. **After plan-7 lands PLAN.md files** → spawn execute-7 → run through to completion → close-out commit (ROADMAP/STATE final updates) → tag v5.0.0 with annotation in 07-CONTEXT.md.

That's the whole script. ~1.5h wall time per Phase 4/6 pacing.

## What's Left To Do (per locked Phase 7 scope)

1. **V30 schema migration** — add `provenance` column to `learnings` with `organic | injected | tool_result | environmental` CHECK constraint; backfill 191 existing rows to `organic`.
2. **Write-path filter** in `src/adapters/shared/lifecycle.ts:755 captureInsightsAsLearnings` — skip lines matching INJECTED_BLOCK_TAGS pre-promotion.
3. **9 reader-site comment downgrades** (mechanical: "TODO Phase 7" → steady-state docs) at the 9 reader sites Phase 4 added uniform comments to.
4. **3 new Vesna probes**: `episodic-recall-001` (parable canonical regression), `episodic-recall-002` (generic episodic-recall), `learnings-injected-guard-001` (mirrors extraction-deleted-001).
5. **3 new vitest integration tests**: `phase-7-learnings-provenance.test.ts`, `phase-2-1-kill-regression.test.ts`, `phase-6-crash-resilience.test.ts`.
6. **CHANGELOG.md v5.0.0 entry** — Keep-a-Changelog format with Added/Removed/Changed/Coverage. Content drafted by plan/execute teammates against final shape of what shipped.
7. **Final ROADMAP/STATE/REQUIREMENTS docs update** — Phase 7 marked SHIPPED, surviving phases all complete, milestone closed.
8. **Tag v5.0.0** on master with annotation in 07-CONTEXT.md (annotation leads with the kill, doesn't bury it).

**7 must-pass ship gates before tag** (full table in CONTEXT.md):
- Vesna 21/21 PASS at 100%
- 3 new vitest integration tests PASS
- `bun run build` clean
- `bun run test` no NEW regressions vs Phase-7-immediate-post-merge baseline (each plan rebases via SUMMARY.md baseline-record discipline; 27 pre-existing failures persist as v4-debt)
- `bun run sc3` ≥80% MEMORY.md content quality
- Handoff-pickup 3/3 (active/paused/archived — already in suite)
- Bundle smoke 7/7 (inherited v4.1.2 gate)
- Plus `bun run doctor` exit 0 (substrate health)

## Context That Won't Be Obvious

- **Team `auto-gsd-pipeline` was pre-deleted at end of session 59.** TeamCreate will succeed first try. If it doesn't (e.g., stale config recreated by another process), `rm -rf ~/.claude/teams/auto-gsd-pipeline ~/.claude/tasks/auto-gsd-pipeline` and retry.

- **`learnings` is the 4th Mem0-trap surface** — discuss-7's code trace surfaced this. NOT a frozen v4 archive: `promoteLearnings` is a live writer called from `lifecycle.ts:1151` (Stop hook) and `:1319` (bridge) via `captureInsightsAsLearnings`. Lacks the provenance discipline Phase 1 installed for `episodic_events`. Closing it via V30 + write-path filter completes the parable's "no extraction-time pattern creation" principle uniformly across all extraction surfaces. Same uniform-application pattern as Phase 4's Sites B+C discovery.

- **`decisions` (126 rows) is preserve-as-legacy WITHOUT provenance work.** Structural defenses (fingerprint dedup + INSERT OR IGNORE + Tier 4 explicit-marker requirement + redaction) make Mem0-trap structurally low-risk. Don't add provenance "for symmetry" — it's schema bloat for diminishing returns.

- **Pass-count baseline rebases per plan.** Phase 7's "no NEW regressions" gate compares against the post-each-plan-merge baseline, NOT against Phase-7-pre-merge baseline. Each plan's SUMMARY.md records the new baseline. Same convention Phase 4 used (04-01-SUMMARY.md:79 explicitly cites the post-fixture-patch baseline).

- **Aggregator non-determinism is a known noise pattern at gate-close.** When committing the Phase 7 close-out, expect `.planning/aggregates/multi-handle.md` to show mutated latency p99 ratios + `02-RESULTS.md`/`02-results.json` to show as deleted in working tree. Revert both as known noise (same as Phase 4 + Phase 6 close-out commits did). The aggregator bug is deferred to v5.1.

- **Phase rename "v4 coexistence / migration / ship" is technically misleading post-locking** (preserve-as-legacy means no schema migration of v4 data). Same call as Phase 4's "Angel reduction" name surviving Site B/C scope expansion: keep the name, CONTEXT carries the explanation. User-approval gate at v5.0.0 tag time can retroactively rename if desired; not blocking.

- **27 pre-existing test failures (llama-server-supervisor, llama-client, phase-5-full-gate per Phase 4 baseline) are release-tolerated.** Phase 7 doesn't fix v4 test debt. Document in CHANGELOG.md as "known pre-existing failures, scheduled for v5.1+ cleanup."

- **The malformed `886595c` commit was cleaned up at session 59 close** via `git reset --soft HEAD~2` + `git restore --staged` of ablation files + clean re-commit as `55f84b3 docs(07): capture phase context`. The 10 Phase-6-multiplier-ablation JSON files are back to untracked stray (unchanged from session start; v4-final/phases/06-p5-... has the canonical runs). Decide their final fate during Phase 7 cleanup or defer indefinitely.

**Where to look:** `.planning/phases/07-v4-coexistence-migration-ship/07-CONTEXT.md`, `.planning/reframes/2026-05-05-multi-handle-kill.md`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `CHANGELOG.md` (existing, Keep-a-Changelog format with `[Unreleased]` placeholder).
