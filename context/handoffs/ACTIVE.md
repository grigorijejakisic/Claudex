---
schema: claudex/handoff
version: 1
handoff_id: claudex-v3-handoff-phase3-post-relabel-harness-retry
status: active
created_at: 2026-04-22T02:16:00Z
updated_at: 2026-04-22T02:16:00Z
origin_session_id: current
supersedes: claudex-v3-handoff-phase3-post-audit-resume
---

# Handoff: Phase 3 (P2) — post-relabel harness retry after 3 silent deaths

Date: 2026-04-22 (session 53). Replaces the prior handoff `...post-audit-resume`; the "Rebuild + re-run" step of that plan has been attempted and failed 3 times. This handoff captures the failure mode + the hardening fix so the next session launches a relaunch that can actually survive.

## Commander's Intent

Launch the Cycle 3 post-relabel precision harness **with the per-candidate error isolation committed in `bdca0a3`**, wait ~70 min, then ship Phase 3 per the runbook (CALIBRATION.md + 03-06 SUMMARY + phase-complete commit).

## What happened this session

1. **5 retrospective SUMMARY.md files committed** for plans 03-01 through 03-05 (code had landed in prior sessions, summaries were missing): commits `05062c9 5e9611c 8db4b8e 7aa6ed7 60cf578`.
2. **03-RESEARCH.md committed** (`8d7d4cf`) — was untracked.
3. **Plan 03-06 gate lowered 0.90→0.75** and user re-label of 12 cases merged into gold-labels.jsonl: commit `72833f6`.
4. **run-precision.ts hardening**: commit `bdca0a3` adds per-candidate try/catch (one bad candidate no longer kills the batch) and honors the `scope_excluded_from_scoring` row flag.
5. **Post-P1 injection-surface diff (task 03-06-09)**: `git diff 32779b3..HEAD -- src/assembler/ src/hooks/session-start.ts src/core/sections.ts` → empty. Gate passes.
6. **Test suite**: 2498/2518 pass. The 20 failures are all in `src/tests/angel/llama-server-supervisor.test.ts`, pre-existing since commit `c84dd61` swapped local Gemma for Ollama Cloud (45 commits ago, well before Phase 3). Not a P2 regression. Tracked as tech-debt follow-up.

## The harness is NOT done

**Two genuine silent deaths** today (2026-04-22); a third launch below was killed by team-lead, not a spontaneous death:
- **01:21 launch (PID 47232, original from prior handoff's resume path)** — reached `progress: 60/106` (per prior observations), then process vanished ~02:18 without emitting output JSON. PID was verified live via `wmic process where "name='node.exe'" get processid,commandline` between ~02:02 and ~02:17; vanished from process table by ~02:18. Logfile `cycle3_post_relabel-run.log` stuck at the 79-byte startup header throughout.
  - Prior session-53 handoff draft stated PID 45624 for this same launch — that was a transcription error; the authoritative PID captured live was 47232.
- **~01:22 launch via `run_in_background: true`** (a sibling Bash call from the same teammate) — wrote the 79-byte header, then process vanished; no output JSON. This may actually be the same launch as the 01:21 one double-counted across teammate Bash invocations — unclear from the records. Treat as "one or two deaths" not "definitely two."
- **02:14 debug-relaunch (PID 32400, team-lead debug command)** — was killed intentionally via `taskkill /F` at ~02:16 after team-lead confirmed the original harness was actually alive and didn't want the two running concurrently. **This was NOT a silent death.** Don't include in failure-mode analysis.

**Communication gap to flag for tomorrow's orchestrator:** execute-3 (the teammate running through 02:20) read every team-lead SendMessage but sent zero replies. Its actual work was excellent — all commits landed atomically and this handoff is execute-3's own write — but its message responses were null. If this is a systemic pattern with `general-purpose` in-process teammates under `/auto-orchestrate`, budget for "teammate works silently; don't mistake message-silence for work-silence." Verify progress by reading git log and disk, not by waiting for replies.

**Root cause (hypothesis, not proven):** an unhandled promise rejection inside the `for` loop's `await extractDirectivesFromSession(...)` call kills the node process without bubbling to the `main().catch(...)` handler. The shape is: silent exit, no stderr line, no final JSON. Per-candidate try/catch (committed `bdca0a3`) should surface the offending candidate(s) as `ERROR candidate=<id>` log lines and let the batch complete.

**Alternative cause (less likely):** cloud LLM (glm-5.1:cloud) rate-limiting or connection drops during the ~35-min mark. Same fix applies — one bad candidate becomes `rejected_regex` rather than batch-kill.

## What's Left To Do (in order)

1. **Relaunch the harness with the hardened build:**
   ```
   bun run build
   node dist/benchmarks/directive-detector/run-precision.cjs --tag=cycle3_post_relabel > .planning/phases/03-p2-directive-detector/fixtures/runs/cycle3_post_relabel-run.log 2>&1 &
   disown
   echo PID=$!
   ```
   Then verify PID is in the process table. **Do NOT pipe the output via `| head` or `| tail`** — earlier deaths may have been SIGPIPE on pipe consumer exit.

2. **Wait ~70 min.** Periodically check:
   - `wmic process where "name='node.exe'" get processid,commandline | grep run-precision` — alive?
   - `tail -20 .planning/phases/03-p2-directive-detector/fixtures/runs/cycle3_post_relabel-run.log` — any `ERROR candidate=` lines?

3. **Locate output JSON** after process exit:
   ```
   ls -la .planning/phases/03-p2-directive-detector/fixtures/runs/*cycle3_post_relabel*.json
   ```

4. **Compare to pre-relabel Cycle 3 baseline:**
   ```
   node dist/benchmarks/directive-detector/compare-runs.cjs \
     .planning/phases/03-p2-directive-detector/fixtures/runs/2026-04-20T23-54-58-598Z_cycle3_prompt_rewrite.json \
     .planning/phases/03-p2-directive-detector/fixtures/runs/<new run>.json
   ```

5. **Branch on joint_precision:**
   - `joint >= 0.75` → ship path (A).
   - `0.55 <= joint < 0.75` → partial-ship path (B): document caveat in CALIBRATION.md, ship anyway, surface the FP/FN class that kept us under gate.
   - `joint < 0.55` → regression path (C): compare per-candidate decisions against the `2026-04-20T23-54-58-598Z_cycle3_prompt_rewrite.json` run to locate what changed; do NOT ship.
   - If `ERROR candidate=` lines appeared, note affected candidate IDs in CALIBRATION.md regardless of branch.

6. **Ship (paths A/B):**
   - Write `03-CALIBRATION.md` final section (post-relabel metrics, escalation resolution, benchmark-gate deferral).
   - Write `03-06-calibration-and-ship-SUMMARY.md`.
   - Commit: `docs(03-06): calibration report + SUMMARY — ship at joint=X.XX`.
   - Run `gsd-tools phase complete 03` + follow-up commit.

7. **Deferred to a separate task (NOT blocking Phase 3 ship):**
   - Task 03-06-07 (LongMemEval + LoCoMo benchmark gate) — depends on Task #23 (post-P1 LoCoMo baseline) which stalled mid-embed during prior session. Log at `benchmarks/results/p1-postmigration/locomo-v17-.log`. Either re-run that benchmark first, or use the pre-P1 `locomo_2026-03-29_893270d.jsonl` anchor with a documented caveat. Document in CALIBRATION.md as a follow-up.
   - Task 03-06-08 (integration-confirm: live tick writes directive_rule row) — requires Angel to run a heartbeat against new sessions. Live DB currently has 0 directive_rule rows; `directive_rule` not yet in `kind_registry`. After Phase 3 ship, let Angel tick a few times on real sessions, then verify `SELECT COUNT(*) FROM artifact WHERE kind='directive_rule'`. If still 0 after a few hours, investigate the heartbeat wiring.

## Context That Won't Be Obvious

- **Phase 3 plans 01–05 are complete in code and in summary docs.** Only 03-06 remains open. Don't re-do any of 01–05.
- **`run-precision.cjs` rebuilt at commit `bdca0a3` — do `bun run build` before relaunching.** The prior runs were against the pre-hardening build that lacked per-candidate isolation.
- **Expected harness runtime: ~70 min** on glm-5.1:cloud at temp=0. Actual observed pace: ~5 min per 10 candidates through candidate 60; then the process died around the 35-min mark.
- **Test failures in llama-server-supervisor are pre-existing.** Do not try to "fix" them as part of Phase 3. Surface as a separate cleanup task.
- **Injection-surface diff gate (03-06-09): passes.** Zero diff on `src/assembler/`, `src/hooks/session-start.ts`, `src/core/sections.ts` vs post-P1 baseline `32779b3`.

## Key file touchpoints (this session's commits)

- `05062c9` docs(03-01): PLAN + SUMMARY for detector core
- `5e9611c` docs(03-02): PLAN + SUMMARY for prompt fixture assets
- `8db4b8e` docs(03-03): PLAN + SUMMARY for fixture corpus + LLM labeling
- `7aa6ed7` docs(03-04): PLAN + SUMMARY for Angel heartbeat wiring
- `60cf578` docs(03-05): PLAN + SUMMARY for precision harness
- `8d7d4cf` docs(03): research document for P2 directive detector
- `72833f6` docs(03-06): plan gate lowered 0.90→0.75 + user re-label 12 cases
- `bdca0a3` feat(03-05): per-candidate error isolation + scope_excluded_from_scoring

## Still uncommitted in working tree

- `.claude/settings.local.json` — session-local settings (don't commit as part of Phase 3)
- `context/checkpoints/latest.yaml` — session checkpoint (don't commit as part of Phase 3)
- `context/handoffs/ACTIVE.md` — this file (handoff-flow file; refreshed by each /endsession)
- `node_modules/.vite/vitest/results.json` — test artifact (gitignored by intent or should be)
- `benchmarks/results/p1-postmigration/` — stalled post-P1 benchmark logs; don't commit as part of Phase 3

Working tree after the 8 Phase-3 commits is clean for Phase-3 artifacts; only the above session/env files remain.
