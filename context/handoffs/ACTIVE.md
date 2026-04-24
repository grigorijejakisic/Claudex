---
schema: claudex/handoff
version: 1
handoff_id: claudex-v3-handoff-phase4-post-v17-hook-regression
status: active
created_at: 2026-04-24T02:00:00Z
updated_at: 2026-04-24T02:00:00Z
origin_session_id: fdbe1dd9-e654-462b-b16d-2eeaae6da698
supersedes: claudex-v3-handoff-phase3-post-relabel-harness-retry
---

# Handoff: Phase 4 (P3) — post-04-06, blocked on 04-07 V17-hook fix

Date: 2026-04-24 (session 54). Phase 4 gate was 80% driven by this session; LongMemEval passed, Angel resilience landed, but a V17 migration regression uncovered mid-soak blocks closure. Next session implements 04-07, retries soak, closes Phase 4.

## Commander's Intent

Land plan 04-07 (V15→V16 migration idempotency fix + version-aware initializeSchema), retry the live soak on scratch project `~/Desktop/Projects/soak-test-p4`, re-kick LoCoMo cleanly (glm-5.1:cloud, no VRAM contention), then write 04-05 SUMMARY.md and flip Phase 4 to `[x]` in ROADMAP + advance STATE.md to Phase 5.

## What's Left To Do

1. **Read `.planning/phases/04-p3-memory-md-curation-auto-dream-guard/04-07-debug-findings.md` first.** 311 lines, has root cause + evidence chain + proposed fix + test gap. Written by debug-04-07 this session. Do not re-investigate — pick scope from the findings and start planning.

2. **Write plan 04-07 and execute.** Minimum scope per findings:
   - Wrap `migrateV15toV16(db)` call in try/catch symmetric to the V16→V17 wrap at `src/core/migrations.ts:172`. That's the critical fix.
   - Guard `db.pragma('user_version = 16')` at line 201 so it doesn't demote a V17 DB back to 16.
   - **Better fix** (pick if time permits): make `initializeSchema` version-aware — read `user_version` first, only invoke the specific VN→VN+1 migrations actually needed. Makes future migrations robust by construction.
   - Test: new fixture "open a post-V17 DB via `openDatabase`" — the 2556-test suite never exercised this because all migration tests use fresh `:memory:`. Cover: no-throw, successful INSERT into `session_events` post-open, `user_version` stays at 17.
   - After fix lands: spot-check that `session_events` now accepts writes. Trigger a real CC hook (e.g., user-prompt-submit) and query `MAX(timestamp_epoch)` — expect a row from today.

3. **Retry the live soak.** Scratch project `~/Desktop/Projects/soak-test-p4` already exists with a 651 KB transcript from this session's attempt. Either do a fresh session there or (cleaner) start a new scratch project `soak-test-p4b`. Run the 8-step protocol from plan 04-05-04. MEMORY.md must materialize at `~/.claude/projects/<slug>/memory/MEMORY.md` within ~60s of closing the CC terminal.

4. **Re-kick LoCoMo.** After 04-07 fix verified. Command pattern (from exec-04-05b's earlier re-kick plan):
   ```
   mv benchmarks/results/p3-postmigration/locomo-run.log benchmarks/results/p3-postmigration/locomo-run-stalled-contention.log
   CLAUDEX_BENCH_ANSWER_MODEL=glm-5.1:cloud CLAUDEX_BENCH_JUDGE_MODEL=glm-5.1:cloud \
     node dist/benchmark/locomo-harness.cjs \
     C:/Users/GRIGOR~1/AppData/Local/Temp/locomo/data/locomo10.json \
     > benchmarks/results/p3-postmigration/locomo-run.log 2>&1 &
   ```
   Runtime estimate ~4-6h (cloud path — no local VRAM contention this time). This is a NEW ANCHOR, not a gate — no within-2pp criterion applies (sonnet/CLIProxy baseline not reproducible, scope-locked earlier).

5. **Write 04-05 SUMMARY.md and close Phase 4.** Plan 04-05 (the phase gate) remains the bookkeeping entry point. After (2)-(4) all pass:
   - Post-process `LONGMEMEVAL_ORACLE_RESULTS.json` (or re-read the run log) into `benchmarks/results/p3-postmigration/longmemeval-oracle.json` with the fields per plan task 04-05-02 (model, total, correct, accuracy, timestamp, commit_sha).
   - Post-process LoCoMo output similarly into `benchmarks/results/p3-postmigration/locomo-summary.json`.
   - Write `soak-report.md` with the 8-step inspection results.
   - Write `04-05-phase-gate-SUMMARY.md` per plan lines 189-198. Include explicit notes: (a) LongMemEval PASS at 89.6%, (b) LoCoMo new-anchor-only (no within-2pp gate this time + why), (c) Phase 4 required inline bugfixes 04-06 and 04-07 to ship a working pipeline, (d) static-verification-vs-runtime-reality learning, (e) next phase (P4) is the LEGACY INJECTION deletion — the REAL benchmark gate where within-2pp must apply.
   - Edit ROADMAP.md Phase 4 row `[x] (completed 2026-04-24 OR tomorrow's date)`, Progress table update, Plans list check off 04-01 through 04-07.
   - Edit STATE.md `current_phase: 5`, `current_phase_name: "P4 — Kill legacy injection"`, updated status + last_activity + last_activity_desc.
   - Atomic commit: `feat(04-05): Phase 4 complete — MEMORY.md curation + auto-dream guard`.

## Context That Won't Be Obvious

- **The Claudex-hooks regression hit every project on this machine, not just claudex-v3.** All observability/telemetry writes have been frozen since 2026-04-20T10:38Z. The 04-07 fix restores this for every project simultaneously — a single-line try/catch fix with machine-wide impact. Flag this in the SUMMARY.
- **Static verification passed; runtime was broken.** Phase 4's 7 ROADMAP success criteria all pass on code inspection, yet MEMORY.md never materializes in production. Method-level lesson: verification methodology needs a "does the chosen side-effect actually land on disk in prod conditions?" check beyond "does the code path exist and return cleanly?" This is a follow-up for the P5+ verification protocol — worth noting in SUMMARY's Learnings section.
- **Angel is cloud-mode only now.** `llama-server` (local Gemma 4 31B on 8081) isn't running and Angel detected this correctly via `isCloudModel(LLAMA_MODEL_ALIAS)`, using Ollama Cloud's `glm-5.1:cloud` via daemon instead. The 9-day-old `context/logs/llama-server.log` is expected, not a bug.
- **CLIProxy is not available.** User explicitly offered Gemma 4 local as alternative; chose to stay on glm-5.1:cloud for the LoCoMo anchor. Do NOT try to restore CLIProxy for Phase 4 — defer that discussion to P5 if it matters for the injection-gate benchmarks.
- **Hearthstone on 32 GB VRAM + deepseek 163840-context (61 GB CPU/GPU split) is a stutter storm.** Don't run LoCoMo and LongMemEval concurrently on this hardware — serialize. Deepseek evicts arctic-embed2 every few seconds when both are active. Phase 5 benchmark-gate planning should account for this or reduce deepseek's context length.
- **Plan 04-07 scope is small (~1-3h).** Do not overscope. The findings doc already has the fix sketched. Focus on idempotency + test fixture + spot-check. Do NOT also try to backfill the 3.5 days of missing session_events — data loss is accepted.
- **Angel is currently alive (PID 15212, spawned 2026-04-24 03:16 local).** Leave it running. 04-07 fix doesn't need Angel restart — it's a DB-open path fix, Angel's own DB connection (opened pre-regression at 03:16) stays valid. But a fresh CC session after 04-07 will re-open the DB and exercise the fix.
- **Exec-04-05b's static verification doc is still useful.** See their earlier message (the "Phase 4 gate readiness report" in this session's transcript) for the 7-SC breakdown — copy that into the SUMMARY with PASS status confirmed, don't re-derive.

## Key commits this session (10 total)

- `3e3af07` docs(04-05): pre-benchmark gate artifacts — test-run.txt + injection-guard.txt both PASS
- `b01b6b6` chore(benchmarks): commit p1-postmigration logs with broken-sonnet run archived
- `65027ed` docs(02): retroactive Phase 2 research + context amendment committed
- `958603d` chore: ignore .planning/agent-history.json (per-machine agent scratch)
- `051564b` feat(04-06-01): Angel stderr capture with size-based rotation
- `a75fcb4` feat(04-06-02): heartbeat queue drain per-op try/catch hardening
- `750c82a` feat(04-06-03): hook-driven Angel liveness check (Option B chosen)
- `d6c8f88` test(04-06-04): live-fire verification report
- `79c8312` docs(04-06): summary for Angel resilience hardening
- `367dda8` docs(04-07): debug findings — session_events writes frozen since V17 migration

## Still uncommitted (for tomorrow's SUMMARY commit)

- `benchmarks/results/p3-postmigration/longmemeval-run.log` — full LongMemEval output incl. 89.6% result
- `benchmarks/results/p3-postmigration/longmemeval-pid.txt` — historical PID trace
- `benchmarks/results/p3-postmigration/locomo-run.log` — stall evidence for SUMMARY's "known issue" note
- `benchmarks/results/p3-postmigration/locomo-pid.txt` — historical PID trace
- `context/checkpoints/latest.yaml` — session checkpoint (managed by hook, don't commit manually)
- `node_modules/.vite/vitest/results.json` — test artifact (gitignore-worthy but not this session's job)
