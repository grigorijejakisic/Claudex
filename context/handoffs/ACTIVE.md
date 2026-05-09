---
status: active
phase: "11"
summary: Phase 11 W1 + W2 + W3-engineering-scaffolding SHIPPED (8/8 plan SUMMARYs on disk). W3 measurement runs + checkpoint:human tasks (big-mozzy-v2 user-pair probe authoring + v6.0.0 retag operator-approval) remain operator work. v6.0.0 local tag UNCHANGED — operator runs the empirical re-bind, then phase-11-close.cjs prints the recommended retag annotation, then operator approves + executes.
topic: 2026-05-09-phase-11-engineering-shipped-w3-empirical-pending
created_at_epoch_ms: 1778363400000
---

# 2026-05-09 — Phase 11 engineering complete; W3 empirical re-bind awaits operator

**Where we are:** Phase 11 (the v6 polish phase) has all 8 plan SUMMARY.md files on disk. W1 (code regressions) and W2 (methodology fix + skill update) shipped end-to-end. W3 (Q1/Q2/Q3 empirical re-bind + 11-RESULTS.md + v6.0.0 retag) has its **engineering scaffolding** shipped — the runner functions, gate-readers, conditional-outcomes classifier, retag-annotation generator are all in place and tested. **The actual measurement runs** (live 4-judge cloud ensemble + 2-4 days GPU/cloud compute per question) and the **two checkpoint:human tasks** (big-mozzy-v2 user-pair probe authoring + v6.0.0 retag annotation operator-approval) are operator commitments outside the autonomous pipeline.

## Operator-runnable command sequence for W3 close-out

This is the precise resume path. Each step is its own operator decision.

### 1. Pre-flight checks

```bash
cd 'C:\Users\Grigorije\Desktop\Projects\CLAUDEXv3'

# Verify reranker is alive (Plan 11-06 pre-flight gate fails closed if not)
curl -s -o NUL -w '%{http_code}' http://127.0.0.1:7439/rerank \
  -X POST -H 'content-type: application/json' \
  -d '{"query":"preflight","documents":["preflight"]}'
# Should print 200. If not: python services/reranker.py & or restart Angel.

# Verify Ollama can run all 4 judge models (cloud passthroughs may not show in `list`):
ollama list | grep -E 'gemini-3-flash-preview|glm-5\.1|kimi-k2\.6'
# Anthropic OAuth: check ~/.claude/.credentials.json exists.
```

### 2. Decide GLM-5.1 / Angel scheduling (CONTEXT § Operational constraints line 122)

GLM-5.1 is Angel's default LLM AND a judge in the W3 ensemble. Pick one:

- **(a) Swap:** edit `~/.claudex/config.json` → `angel.default_model = "minimax-m2.7:cloud"`; restart Angel; restore after Q1+Q2+Q3 complete.
- **(b) Idle window:** schedule the run overnight when no active CC sessions / Angel is naturally idle.

Default if unsure: option (b).

### 3. Run Q1 (locked 30-probe paired-McNemar; ~2-4 days compute)

Operator wires `JudgeDispatcher` + `replicationDriver` via a thin invoke script (live cloud passthroughs for the 4 judges + production routing for the B-arm). The Q1 orchestration is shipped at `src/benchmark/deliberation-surfacing/runner.ts:runQ1` with full pre-flight + fallback-rate monitoring + paired-McNemar verdict. Output: `.planning/phases/11-polish-land-v6-properly/q1-verdict.json`.

Q1 verdict possibilities:
- `BIND_POSITIVE` → proceed to step 4 (Q2)
- `BIND_NEGATIVE` or `INCONCLUSIVE` → skip to step 7 (close-out with KILL receipt)

### 4. Author 60 disjoint Q2 probes (Plan 11-07 Task 2 — user-pair work)

Read the locked authoring rules: `.planning/phases/11-polish-land-v6-properly/q2-probe-rules.md`.

Operator + LLM together, against real claudex-v3 session archive:
- 12 probes per kind × 5 kinds = 60 (30 per replication, no r1↔r2 overlap within Q2)
- Disjoint from P9: no anchor session_id, no normalized prompt overlap, ID prefix `q2-` (not `drift-`)
- Parametric-knowledge avoidance per W2 audit
- ≥70% real source, anchor freshness from sessions later than P9 cluster

Save to `.planning/phases/11-polish-land-v6-properly/q2-locked-probes.json`. Validate:

```bash
bun run phase-11:validate-q2
# Exit 0 → pool is locked-eligible
# Exit 1 → constraint violations listed; re-author affected probes
```

Estimated time: 30 min – 2h per probe × 60 = 30-120h total.

### 5. Run Q2 (60-probe disjoint pool, Wilson lower bound > 0; ~2-4 days compute)

Same harness shape as Q1 but with the 60-probe disjoint pool. Output: `.planning/phases/11-polish-land-v6-properly/q2-verdict.json` (or `q2-skipped.json` if Q1 wasn't BIND_POSITIVE — emitted by `runner.ts:writeQ2Skipped`).

Q2 verdict possibilities:
- `BIND_POSITIVE` → proceed to step 6 (Q3)
- `BIND_NEGATIVE` → skip to step 7 (close-out with KILL receipt; q2-bind-was-artifact)
- `INCONCLUSIVE` → skip to step 7 (close-out as p11_1_corpus_expansion — DO NOT retag v6.0.0; queue P11.1)

### 6. Author + run Q3 cross-corpus on big-mozzy-v2 (Plan 11-08 Task 2 — checkpoint:human)

Big-mozzy-v2 is a separate corpus (browser automation / scraping); user-pair authoring is required because the orchestrator does not have domain knowledge to author drift fixtures alone (CONTEXT line 108).

Author 30 cross-corpus drift fixtures sampled from big-mozzy-v2's history. Save to `.planning/phases/11-polish-land-v6-properly/q3-locked-probes.json`. Run Q3 against that fixture; output `q3-verdict.json` (or `q3-skipped.json` if cross-corpus deferred).

### 7. Run phase-11-close to author 11-RESULTS.md

```bash
bun run phase-11:close
# Reads q1-verdict.json + (q2-verdict.json | q2-skipped.json) + (q3-verdict.json | q3-skipped.json | absent)
# Writes .planning/phases/11-polish-land-v6-properly/11-RESULTS.md
# Prints the recommended v6.0.0 retag annotation matching the branch
```

The applier classifies the branch deterministically per the spec's pre-committed conditional outcomes table:
- `engineering_close_strong_bind` (Q1+Q2+Q3 all BIND_POSITIVE)
- `engineering_close_within_corpus_bind` (Q1+Q2 BIND_POSITIVE; Q3 inconclusive/missing)
- `engineering_close_recursive_echo` (Q1+Q2 BIND_POSITIVE; Q3 BIND_NEGATIVE)
- `kill_receipt_q1_negative` / `kill_receipt_q1_inconclusive` / `kill_receipt_q2_negative`
- `p11_1_corpus_expansion` (Q1 BIND_POSITIVE, Q2 INCONCLUSIVE — **do NOT retag**)

### 8. Approve or reject the retag annotation (Plan 11-08 Task 5 — checkpoint:human)

```bash
bun run phase-11:retag-cmd
# Prints just the recommended annotation + the heredoc retag command for review.
```

Operator inspects the annotation. If accurate:

```bash
git tag -d v6.0.0
git tag -a v6.0.0 -m "$(cat <<'EOF'
<paste the title from phase-11:retag-cmd output>

<paste the body from phase-11:retag-cmd output>
EOF
)"
```

If not accurate: edit the annotation manually before running, OR reject and re-run W3 if the verdict triple itself is suspect.

### 9. Update STATE.md / ROADMAP.md / REQUIREMENTS.md

```bash
node C:/Users/Grigorije/.claude/get-shit-done/bin/gsd-tools.cjs roadmap update-plan-progress 11
# Then manually open STATE.md + ROADMAP.md + REQUIREMENTS.md and flip Phase 11 to COMPLETE
# with the landed branch identifier from 11-RESULTS.md.
```

### 10. Run external-review-gate dogfood (Plan 11-05 meta-validation)

```bash
node scripts/external-review-gate.cjs --phase 11 --project claudex-v3 --skip-codex
# (--skip-codex unless Codex is reachable post-2026-05-14)
# Gate runs against the full Phase 11 artifact set (PLANs + SUMMARYs + 11-RESULTS.md).
# Verdict SIGNOFF / LOG / BLOCK per the pre-committed classification rule.
# If BLOCK: address findings; do not push.
```

### 11. Public push (operator-confirmed; out of scope for autonomous pipeline)

```bash
git push origin master --tags
```

CLAUDE.md rule 1 + CONTEXT § Phase Boundary explicit: NEVER push autonomously. Same pattern as v5.0.0.

## What's complete (W1 + W2 + W3 engineering)

**Wave 1 (engineering — code regressions):**
- 11-01 routing fixes (POLISH-01): `af9a5ca`, `b91b3d2`
- 11-02 assembly fixes (POLISH-02): `ea0590e`
- 11-03 ingestion + lint + snapshot + WIR (POLISH-03..06): `659c0c4`, `b87dc84`, `0863986`

**Wave 2 (engineering — methodology fix + skill update):**
- 11-04 methodology (POLISH-07..11): `42b1beb`
- 11-05 external-review-gate (POLISH-12): `afdb924`

**Wave 3 (engineering scaffolding — runner + gates + applier + retag-annotation generator):**
- 11-06/07/08 W3 scaffolding (POLISH-13/14/15/16 auto tasks): `dbf407d`

**Phase 11 SUMMARY.md files on disk:** 11-01 through 11-08 (8 of 8). All requirements POLISH-01 through POLISH-16 have engineering deliverables. Tasks 2 + 5 of Plan 11-08 (checkpoint:human) and Plan 11-06 Task 2 / Plan 11-07 Task 2 (operator-driven empirical work) are flagged as operator commitments in their respective SUMMARY files.

## Ship gates as of pause

- `bun run build` exits 0
- `bun run vesna` — 26/26 = 100% PASS preserved across all W1 + W2 + W3-scaffolding work
- `bun run test` (full suite) — 3748 passes / 27 v4-debt failures matching CLAUDE.md baseline / 8 skipped — no new regressions
- `bun run lint:test-discipline` — 0 flagged sites
- WIR integration test (Phase 11) — 3/3 PASS
- All 8 SUMMARY.md files on disk
- Phase 11 PROBE-AUDIT.md committed (30 probes classified)
- Q2 probe authoring rules committed at q2-probe-rules.md
- Q2 validator + phase-11-close + retag-cmd scripts committed
- 48 new tests across runQ1.test.ts (29) + validate-q2-probes.test.ts (9) + phase-11-close.test.ts (10)

## What's local-ahead-of-origin

15 commits ahead of `origin/master` (W1 + W2 + W3-scaffolding + handoff):

```
dbf407d feat(11-06/07/08): W3 engineering scaffolding (POLISH-13/14/15/16 auto tasks)
cc01fdf docs(11): W1+W2 SUMMARYs + handoff for W3 operator-driven empirical re-bind
afdb924 feat(11-05): external-review-gate orchestrator + skill modifications (POLISH-12)
42b1beb feat(11-04): methodology fix scaffolding (POLISH-07/08/09/10/11)
0863986 feat(11-03): test-discipline lint + sanitized fixture + WIR integration test (POLISH-04/05/06)
b87dc84 test(11-03): rewrite ingestion tests + add regression tests (POLISH-04)
659c0c4 fix(11-03): close 6 Gemini ingestion findings (POLISH-03 sources)
ea0590e fix(11-02): close 4 Gemini assembly findings (POLISH-02)
b91b3d2 test(11-01): regression tests for 3 Gemini routing findings (POLISH-01)
af9a5ca fix(11-01): close 3 Gemini routing findings (POLISH-01 sources)
1013add phase(11): plan v6 polish — 8 plans, 3 waves, 16 requirements
a3e7a9b docs(11): capture phase context
220bbfb session(59): handoff transition + Phase 4.1 archive + resume script
55f84b3 docs(07): capture phase context
d547afe phase(06): close — VAL-04 deferral + STATE table consistency
```

Plus the unchanged local annotated tag `v6.0.0` from Phase 10 close-out (with the methodology-invalidated annotation per CONTEXT decision 4 — retag pending W3 verdict).

## Risks if W3 is delayed

- **None operationally.** Engineering work shipped is internally consistent; Vesna preserved; full suite intact. The retained v6.0.0 local tag has an annotation that the Gemini consultation flagged as methodology-invalidated — keeping it unchanged is the correct conservative posture per CONTEXT decision 4.
- **The engineering scaffolding is locked in:** Q1/Q2/Q3 verdict files have shape contracts, the conditional outcomes classifier is deterministic, the retag annotation generator is exhaustive across the 8 branches. Operator running W3 has zero engineering risk; only the empirical-result risk (which the conditional outcomes table absorbs by design — no goalpost shifting).
