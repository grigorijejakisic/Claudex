---
schema: claudex/handoff
version: 1
handoff_id: claudex-v3-handoff-phase4-post-soak-deferred
status: active
created_at: 2026-04-25T00:50:00Z
updated_at: 2026-04-25T00:50:00Z
origin_session_id: 9e93e1ee-2ea8-4c64-aa80-46aab7737796
supersedes: claudex-v3-handoff-phase4-post-v17-hook-regression
---

# Handoff: Phase 4 close — soak + 04-05 SUMMARY (last gate items)

Date: 2026-04-25 (session 55 → next). Phase 4 ~95% complete. 04-07 V17 migration fix landed, both benchmark anchors set (LongMemEval 89.6% PASS, LoCoMo 62.3% +6.8pp anchor), session_events writes restored machine-wide. Only soak (04-05-04) and 04-05 SUMMARY bookkeeping remain.

## Commander's Intent

Run the live soak on a fresh scratch project, verify MEMORY.md materializes correctly with sentinel + sections + caps, write 04-05-phase-gate-SUMMARY.md, flip Phase 4 to `[x]` in ROADMAP, bump STATE.md to Phase 5. Atomic commit. Phase 5 (P4 — Kill legacy injection, the BIG benchmark gate) becomes ready to plan.

## What's Left To Do

1. **Live soak on `~/Desktop/Projects/soak-test-p4b/`.** Scratch project + README seeded by session 55. Run the 8-step protocol from `.planning/phases/04-p3-memory-md-curation-auto-dream-guard/04-05-phase-gate-PLAN.md` task `04-05-04`:
   - Open a fresh CC terminal in soak-test-p4b
   - Do ≥6 meaningful turns
   - `/endsession`, then close terminal
   - Wait ≤60s for Angel heartbeat
   - Inspect `~/.claude/projects/C--Users-Grigorije-Desktop-Projects-soak-test-p4b/memory/MEMORY.md`:
     - First line `^<!-- CLAUDEX-MANAGED: .* hash=[0-9a-f]{64} -->$`
     - 5 sections in order: `## Entities`, `## Active Projects`, `## Recent Threads`, `## Handoff`, `## How to Query`
     - `<!-- USER EDITABLE -->` marker present, `## User Notes` below
     - `wc -l` ≤ 200, `wc -c` ≤ 25000
   - Start a NEW CC session there → query `session_events` for `event_type='memory_md_invalid'` → expect zero
   - Run `claudex_search "entity"` against soak-test-p4b project DB → confirm entity_summary rows exist
   - Re-tick Angel without new session → verify file bytes unchanged (idempotency)

2. **Write `benchmarks/results/p3-postmigration/soak-report.md`** — one paragraph per numbered step with pass/fail.

3. **Write `04-05-phase-gate-SUMMARY.md`** per plan lines 189-198. Use the pre-staged JSONs:
   - `benchmarks/results/p3-postmigration/longmemeval-oracle.json` (89.6% deepseek)
   - `benchmarks/results/p3-postmigration/locomo-summary.json` (62.3% glm-5.1:cloud)
   Required notes in summary:
   - LongMemEval **PASS** at 89.6%, LoCoMo new-anchor-only (no within-2pp gate this phase, that's Phase 5)
   - Phase 4 required inline bugfixes 04-06 (Angel resilience) and 04-07 (V17 migration idempotency) to ship a working pipeline
   - Mid-phase harness fix: `think: false` added to ollamaGenerate (commit 9cd667a) — gotcha for any future cloud-judge benchmarks
   - Static-verification-vs-runtime-reality methodology learning
   - Phase 5 (P4 injection deletion) is the FIRST real benchmark within-2pp gate

4. **Flip ROADMAP Phase 4 row**: `- [x] **Phase 4: P3 — MEMORY.md curation + auto-dream guard** (completed 2026-04-25)`. Update Progress table. Check off plans 04-01 through 04-07 in Plans list.

5. **Update STATE.md**: `current_phase: 5`, `current_phase_name: "P4 — Kill legacy injection"`, `status:` describing Phase 4 complete + LongMemEval 89.6% / LoCoMo 62.3%, `last_activity_desc:` Phase 4 close summary.

6. **Atomic commit**: `feat(04-05): Phase 4 complete — MEMORY.md curation + auto-dream guard`

## Context That Won't Be Obvious

- **Soak protocol is the ONLY gate item.** All 7 ROADMAP success criteria already PASS on static inspection. Plan 04-05's autonomous tasks (test-run, injection-guard, benchmarks) are all done. The soak is the "does the side-effect actually land in prod conditions?" check that static verification missed in session 54.
- **soak-test-p4b CC project dir does NOT exist yet.** It will be created automatically when you open a CC terminal in `~/Desktop/Projects/soak-test-p4b/` and the SessionStart hook fires.
- **Don't reuse soak-test-p4 (no `b`).** That dir has a 651KB transcript from session 53/54's failed attempt — soak-test-p4b is the clean scratch project from session 55.
- **Angel was alive at session 55 close** (PID 15212 spawned 2026-04-24 03:16). It survives across CC sessions via the heartbeat. After 04-07 fix, fresh CC sessions exercise the version-aware initializeSchema correctly.
- **Both benchmark JSONs are committed and ready** at `benchmarks/results/p3-postmigration/`. `soak-report.md` is the only file 04-05 SUMMARY still needs.
- **LongMemEval root-level JSON is unreliable.** Use `longmemeval-oracle.json` (already committed) — sourced from authoritative run.log, not the stale March 28 root file.
- **Don't re-run benchmarks.** Both anchors set this milestone. The next benchmark gate is Phase 5's hard within-2pp check on injection deletion — fresh runs there.
- **Phase 4 plans list in ROADMAP shows "TBD" for `02-01` and others.** That's prior-phase artifact, not a Phase 4 issue. Don't get confused — only Phase 4's plans (04-01..04-07) need check-off.

## Key commits this session (5 total)

- `b6056f6` fix(04-07-01): version-aware initializeSchema — skip V16-era DDL on V17 DBs
- `c670379` test(04-07-02): post-V17 re-open idempotency fixture
- `0dd13a9` docs(04-07): plan + summary for V17 migration idempotency fix
- `9cd667a` fix(bench): add think:false to Ollama generate — restore judge with thinking-capable models
- `7afc289` chore(benchmarks): p3-postmigration LoCoMo 62.3% + LongMemEval 89.6% summaries

After session 55's /endsession session-log commit lands, master HEAD will be at the session-log commit. Phase 4 close commit will be #6.

## Quick verify before starting

```bash
# Confirm hooks alive (post-04-07)
node -e "const db=require('better-sqlite3')(require('os').homedir()+'/.claudex/db/claudex.db',{readonly:true}); const r=db.prepare('SELECT MAX(timestamp_epoch) as max_ts FROM session_events').get(); console.log('latest:',new Date(r.max_ts*1000).toISOString())"
# expect: timestamp from today, not 2026-04-20

# Confirm benchmark JSONs ready
ls benchmarks/results/p3-postmigration/*.json
# expect: locomo-summary.json + longmemeval-oracle.json
```
