---
plan_id: 04-05
phase: 4
wave: 3
depends_on:
  - 04-01
  - 04-02
  - 04-03
  - 04-04
files_modified:
  - benchmarks/results/p3-postmigration/
  - .planning/STATE.md
  - .planning/ROADMAP.md
autonomous: false
requirements:
  - CUR-01
  - CUR-02
  - CUR-03
  - CUR-04
  - STOR-06
  - EXTR-06
---

# Plan 04-05: Phase 4 Gate — Benchmarks, End-to-End Soak, and Roadmap Check-Off

## Objective

Validate that the four implementation plans (04-01..04-04) together satisfy every Phase 4 acceptance criterion in ROADMAP.md, run the two benchmark gates that guard v4 progress (LongMemEval ≥88%, LoCoMo within 2pp of P2 baseline), and check Phase 4 off the roadmap. `autonomous: false` — this plan produces artifacts that require a human look (benchmark result diffs, session log entries) and ends with the roadmap commit.

## Must-haves (goal-backward)

- All 6 Phase 4 ROADMAP success criteria verified by explicit test or file-on-disk inspection:
  1. MEMORY.md with 5 sections + caps (15/5/5/1/1) produced for a real project.
  2. Entities ranked importance DESC with recency tiebreaker; universal user memories in preamble.
  3. `CLAUDE_CODE_DISABLE_AUTO_DREAM` line present in CLAUDE_ENV_FILE; MEMORY.md sentinel regex valid.
  4. Idempotency: running Angel heartbeat twice on unchanged inputs produces byte-identical MEMORY.md.
  5. File ≤25KB / 200 lines — verified by checksum/line-count on a live session-start.
  6. `artifact(kind='transcript_chunk')` rows with `data.topic_label` + `data.turn_range` produced at /endsession (session-end hook → next heartbeat tick).
  7. Dual-injection confirmed: grep `src/assembly/sections.ts` and `src/assembly/assembler.ts` for any consumer of the new MEMORY.md — must find NONE (Phase 5 / P4 territory). Confirms Phase 4 added no injection read.
- LongMemEval Oracle benchmark: `deepseek-coder-v2:16b` local, result ≥88%. Baseline from CLAUDE.md = 90.6%; phase-4 run may drop up to 2pp but must stay ≥88%.
- LoCoMo benchmark: claude-sonnet-4-6, result within 2pp of the Phase 3 baseline (55.5% per CLAUDE.md pre-this-phase, though planner must use the ACTUAL P3-close number — run `cat benchmarks/results/p2-postmigration/locomo-summary.json` or equivalent to get the real baseline).
- Benchmark artifacts committed under `benchmarks/results/p3-postmigration/` (directory already exists per git status preamble — extend it with the new run results).
- `.planning/STATE.md` updated: `current_phase` advances to 5; `current_phase_name` to "P4 — Kill legacy injection"; `status` captures Phase 4 close.
- `.planning/ROADMAP.md` Phase 4 line gets `[x]` check and completion date; Progress table row updated to `Complete`.
- No code edits in this plan — it is a verification + bookkeeping gate.

## Tasks

<task id="04-05-01">
  <subject>Full-suite pre-gate test run</subject>
  <description>
Run `bun run test` across the entire repo. All tests must pass including:
- The 7 new unit/integration test files added by plans 04-01 through 04-04.
- All 2020 pre-existing tests (may have grown from the P3 phase; if count is different, that's the new denominator — no test should regress).

Record pass count and test duration in a scratch file `benchmarks/results/p3-postmigration/test-run.txt`:
```
bun run test
----
Result: N passed / M total
Duration: Xm Ys
Date: 2026-04-DD
```

If any tests fail: stop. Do NOT advance to benchmarks; report failure and route the issue back to whichever plan introduced the failing code.
  </description>
</task>

<task id="04-05-02">
  <subject>LongMemEval Oracle gate (≥88%)</subject>
  <description>
Run the existing LongMemEval Oracle benchmark harness. Exact command lives in `scripts/` or `benchmarks/` — inspect `package.json` scripts and repo docs; at time of planning, the invocation is typically:

```bash
bun run bench:longmemeval:oracle
```

or via a dedicated TypeScript entrypoint in `src/benchmarks/longmemeval/`. Use whatever command produces `benchmarks/results/p2-postmigration/longmemeval-oracle.json` (reference the Phase 2/P1 result file format).

Save output to `benchmarks/results/p3-postmigration/longmemeval-oracle.json` with at least these fields:
- `model`: model id used
- `total`: total questions
- `correct`: count
- `accuracy`: decimal, e.g. `0.906`
- `timestamp`: ISO-8601
- `commit_sha`: current HEAD sha

Gate:
- `accuracy >= 0.88` → PASS, proceed.
- `accuracy < 0.88` → FAIL. Halt gate. Produce a written root-cause analysis: was injection accidentally removed? Did the writer corrupt the retrieval corpus? Plan 04-05 ends here pending remediation via a fix plan (04-06, if needed).
  </description>
</task>

<task id="04-05-03">
  <subject>LoCoMo gate (within 2pp of P3 baseline)</subject>
  <description>
Read the Phase 3 (P2) LoCoMo baseline. Likely location: `benchmarks/results/p2-postmigration/locomo-summary.json` or similar. If the file exists, read `accuracy` as the baseline. If the file does NOT exist, use the CLAUDE.md-reported 55.5% as the baseline (documenting the fallback in the gate artifact).

Run the existing LoCoMo benchmark with `claude-sonnet-4-6`:

```bash
bun run bench:locomo   # or whatever the package script is
```

Save output to `benchmarks/results/p3-postmigration/locomo-summary.json` with fields analogous to task 04-05-02.

Gate:
- `accuracy >= baseline - 0.02` → PASS.
- `accuracy < baseline - 0.02` → FAIL. Halt. Root-cause: is dual-injection accidentally broken? Did heartbeat Phase 5b starve Phase 6b embedding backfill of resources? Produce a written analysis and a remediation plan before advancing.

Benchmark gate enforcement is a literal halt — do NOT check the roadmap box or advance STATE.md on failure.
  </description>
</task>

<task id="04-05-04">
  <subject>End-to-end soak: real-project /endsession → curate → next-session verify</subject>
  <description>
Manual soak test (no automation — this is why `autonomous: false` on this plan):

1. On a scratch project (use the tempdir helper from plan-04-01 tests OR the actual `claudexv3` project if safe), complete a real session:
   - at least 6 meaningful turns;
   - run `/endsession` (skill, which commits + writes handoff).
2. Let the CC terminal close, triggering the real SessionEnd hook.
3. Wait ≤60s for an Angel heartbeat tick.
4. Inspect `~/.claude/projects/<slug>/memory/MEMORY.md`:
   - First line matches `^<!-- CLAUDEX-MANAGED: .* hash=[0-9a-f]{64} -->$`.
   - Contains the 5 section headers in order.
   - Contains `<!-- USER EDITABLE -->` marker.
   - Below marker: `## User Notes` (empty or pre-existing user content preserved).
   - `wc -l` ≤ 200; `wc -c` ≤ 25000.
5. Start a NEW CC session.
6. Inspect `session_events` for that new session: query for `event_type='memory_md_invalid'` → expect zero rows (file is valid per verifier).
7. Run `claudex_search "entity"` against the project's DB to confirm entity_summary rows ARE present (soak checks live corpus health, not just file shape).
8. Repeat: run Angel tick a second time without starting a new session → verify file bytes unchanged (idempotent_noop).

Record all inspection results in `benchmarks/results/p3-postmigration/soak-report.md` — one short paragraph per numbered step, pass/fail.

Failure modes to surface explicitly:
- Sentinel hash is not 64 hex chars → Plan 04-01 bug.
- `## Recent Threads` section missing → Plan 04-01 bug.
- File exceeds 25KB → trim logic bug in Plan 04-01.
- User Notes section wiped → sentinel-preserve bug in Plan 04-01.
- Second tick rewrites the file → idempotency fast-path bug in Plan 04-01.
- `session_events` has `memory_md_invalid` after tick → Plan 04-03 verifier disagreeing with writer; indicates normalization mismatch.
  </description>
</task>

<task id="04-05-05">
  <subject>Dual-injection guard — Phase 4 adds no injection read</subject>
  <description>
Grep assertion (manual, one-shot):

```bash
grep -rn "memory-md-writer\|memory-md-verify\|MEMORY.md" src/assembly/
```

Expected: zero matches OR only matches that are pre-existing (not added by this phase). The intent is that no assembler formatter READS from MEMORY.md as part of the session-start prompt — that's Phase 5 / P4 work.

Record the grep output in `benchmarks/results/p3-postmigration/injection-guard.txt`. If any unexpected match is found, it means a plan leaked scope — halt and file a fix against the offending plan.

Companion check: `git diff post-P3-baseline -- src/assembly/` must show ZERO changes. Use the commit SHA from the end of Phase 3 as the baseline.
  </description>
</task>

<task id="04-05-06">
  <subject>Roadmap + STATE.md check-off</subject>
  <description>
Only after tasks 04-05-01 through 04-05-05 all PASS:

1. Edit `.planning/ROADMAP.md`:
   - Change `- [ ] **Phase 4: P3 — MEMORY.md curation + auto-dream guard**` to `- [x] **Phase 4: P3 — MEMORY.md curation + auto-dream guard** (completed YYYY-MM-DD)`
   - In the `## Progress` table at the bottom, update row:
     `| 4. P3 — MEMORY.md curation + auto-dream guard | 5/5 | Complete | YYYY-MM-DD |`
   - Update the `Plans:` list under Phase 4 — replace `- [ ] 04-01: TBD` with:
     - [x] 04-01: MEMORY.md writer core (sentinel + idempotency)
     - [x] 04-02: Transcript chunker (LLM topic segmentation)
     - [x] 04-03: Auto-dream env flag + session-start verifier
     - [x] 04-04: Heartbeat wiring (chunker + curator from completed-session queue)
     - [x] 04-05: Phase gate (benchmarks + soak + check-off)

2. Edit `.planning/STATE.md`:
   - `current_phase: 5`
   - `current_phase_name: "P4 — Kill legacy injection"`
   - `status: "Phase 4 (P3) complete — MEMORY.md curation live, auto-dream disabled, transcript chunks producing. LongMemEval X.X%, LoCoMo Y.Y%. Phase 5 (P4 injection deletion, BIG BENCHMARK GATE) ready to plan."`
   - `last_activity: YYYY-MM-DD`
   - `last_activity_desc: "Phase 4 gate passed: all 5 plans complete, benchmarks green, soak clean, MEMORY.md sentinel file shipping."`

3. Commit with message shape (match repo convention — session(N): prefix):
   ```
   feat(04-05): Phase 4 complete — MEMORY.md curation + auto-dream guard

   - MEMORY.md written by Angel at session-completion with sentinel hash
   - Transcript chunks producing at /endsession (kind='transcript_chunk')
   - CLAUDE_CODE_DISABLE_AUTO_DREAM=1 in CLAUDE_ENV_FILE
   - Session-start verifier logs memory_md_invalid on sentinel/size breach
   - LongMemEval X.X% / LoCoMo Y.Y% — both within gate

   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   ```

4. Write session log entry at `context/sessions/YYYY-MM-DD_session-N.md` per the /endsession skill format, noting: Phase 4 close, benchmarks, remaining roadmap ahead.
  </description>
</task>

## Verification

- Every ROADMAP Phase 4 success criterion has a named check in tasks 04-05-01..05 above.
- `benchmarks/results/p3-postmigration/` contains: `test-run.txt`, `longmemeval-oracle.json`, `locomo-summary.json`, `soak-report.md`, `injection-guard.txt`.
- `.planning/ROADMAP.md` Phase 4 row shows `[x]` with date; Progress table updated.
- `.planning/STATE.md` shows Phase 5 as current.
- `git log --oneline -1` shows the Phase 4 complete commit with Co-Authored-By trailer.
- Running a fresh session after commit still produces a valid MEMORY.md — one last live check before the next planning session.
