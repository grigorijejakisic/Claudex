---
status: active
phase: "12+11"
summary: Phase 12 spec ready at .planning/research/2026-05-10-phase-12-real-v6-structural-marks.md — /auto-orchestrate it tomorrow on Track A. Phase 11 W3 empirical re-bind runs in parallel as Track B (operator-driven, days of GPU compute). Both tracks must close before public push. v6.0.0 local tag at 109495c11e UNCHANGED until W3 verdict produces the corrected annotation.
topic: 2026-05-10-phase-12-spec-ready-w3-parallel
created_at_epoch_ms: 1778450400000
---

# 2026-05-10 — Phase 12 spec ready; W3 empirical runs in parallel

**Where we are:** A discussion on 2026-05-10 worked through the residual concerns from the v6→v6-polish round-trip and produced a Phase 12 spec. Phase 12 lands the structural marks the polish burn produced — cross-family critique-before-pre-commitment, cross-family adversarial test/fixture authoring, Vesna probe-suite polishing, lightweight telemetry instrumentation, and mid-flight commit visibility — without which the v6 marks remain decorative rather than load-bearing. Phase 11 W3 empirical re-bind has not started; it remains operator-driven and runs in parallel on a separate compute window. Both tracks converge before public push.

## Tomorrow — first command

```
/auto-orchestrate .planning/research/2026-05-10-phase-12-real-v6-structural-marks.md
```

This kicks off Track A (Phase 12 engineering). Track B (Phase 11 W3) is operator-driven separately; the 11-step sequence is preserved below.

---

## Track A — Phase 12 (autonomous via /auto-orchestrate)

**Spec:** `.planning/research/2026-05-10-phase-12-real-v6-structural-marks.md`

**Six items, three waves, ~6 plans + 12-CLOSE:**

| Wave | Plans | What |
|---|---|---|
| W1 (foundation) | 12-01 | Cross-family invocation pipeline (node-side primitive: Gemini CLI + Codex CLI + Claude-via-SDK with bounded prompts and structured BLOCK/FLAG/SIGNOFF responses). |
| W2 (gates + observation) | 12-02, 12-03, 12-04 | Methodology critique checkpoint (`auto-plan-phase` skill); cross-family adversarial test/fixture authoring (`auto-plan-phase` skill); lightweight telemetry instrumentation (hook-side signal recording, no verdict structure). |
| W3 (standalone polish) | 12-05, 12-06 | Vesna probe-suite polishing (`lesson-application` + `deliberation-engagement` rename + new probes for what original names promised); mid-flight commit visibility (PostToolUse hook + statusline + transcript-tail documentation). |
| Close | 12-CLOSE | External-review-gate dogfood on Phase 12 itself, using the cross-family pipeline Plan 12-01 ships. SIGNOFF or LOG-with-ack required to close. |

**Pre-committed close-out conditions** (full list in spec section "Pre-committed close-out"):

- All 6 plan SUMMARYs on disk (12-01 through 12-06).
- `bun run build` exits 0; `bun run vesna` ≥80% aggregate AND ≥80% per non-empty non-buffer category (against polished probe set); `bun run test` no new regressions vs. Phase 11 baseline.
- Cross-family pipeline integration test passes for each first-class family.
- Telemetry instrumentation emits at least one signal type during a CC session.
- Mid-flight commit visibility scripts operator-runnable; sidecar file updates on `git commit`.
- 12-CLOSE external-review-gate dogfood SIGNOFF or LOG-with-ack.
- STATE.md / ROADMAP.md / REQUIREMENTS.md updated to reflect Phase 12 close.

**Lines that hold during Track A** (re. leaked CC source from 2026-03-31):
- Won't redistribute leaked source.
- Won't modify CC and ship a fork.
- Will reference leaked source for legitimate interop work IF documented APIs fall short. For Phase 12 specifically, documented APIs cover everything — clause is dormant. See `feedback_leaked_cc_source_positional_decline_was_thin.md` for the lines and the conversation that resolved them.

---

## Track B — Phase 11 W3 empirical re-bind (operator-driven, parallel)

This is the existing 11-step sequence. Track B does NOT depend on Track A's output structurally — they're independent. v6.0.0 retag is gated on Track B's verdict, NOT on Track A.

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

### 8. Approve or reject the retag annotation (Plan 11-08 Task 5 — checkpoint:human)

```bash
bun run phase-11:retag-cmd
# Prints just the recommended annotation + the heredoc retag command for review.
```

Operator inspects. If accurate:

```bash
git tag -d v6.0.0
git tag -a v6.0.0 -m "$(cat <<'EOF'
<paste the title from phase-11:retag-cmd output>

<paste the body from phase-11:retag-cmd output>
EOF
)"
```

If not accurate: edit manually before running, OR reject and re-run W3 if the verdict triple itself is suspect.

### 9. Update STATE.md / ROADMAP.md / REQUIREMENTS.md (after Track B close)

```bash
node C:/Users/Grigorije/.claude/get-shit-done/bin/gsd-tools.cjs roadmap update-plan-progress 11
# Then manually open STATE.md + ROADMAP.md + REQUIREMENTS.md and flip Phase 11 to COMPLETE
# with the landed branch identifier from 11-RESULTS.md.
```

### 10. Run external-review-gate dogfood for Phase 11 close-out

```bash
node scripts/external-review-gate.cjs --phase 11 --project claudex-v3 --skip-codex
# (--skip-codex unless Codex is reachable post-2026-05-14)
```

Gate runs against the full Phase 11 artifact set. Verdict SIGNOFF / LOG / BLOCK per the pre-committed classification rule. If BLOCK: address findings.

### 11. (Now part of convergence point — see below)

---

## Convergence point — both tracks must close before public push

After Track A close + Track B close:

1. Phase 12 STATE/ROADMAP/REQUIREMENTS updated to v6 milestone COMPLETE (analogous to Track B step 9).
2. **Public push:**

```bash
git push origin master --tags
```

CLAUDE.md rule 1 + CONTEXT § Phase Boundary explicit: NEVER push autonomously. Same pattern as v5.0.0.

---

## What's complete (carried forward from Phase 11)

**Phase 11 W1 (engineering — code regressions):**
- 11-01 routing fixes (POLISH-01): `af9a5ca`, `b91b3d2`
- 11-02 assembly fixes (POLISH-02): `ea0590e`
- 11-03 ingestion + lint + snapshot + WIR (POLISH-03..06): `659c0c4`, `b87dc84`, `0863986`

**Phase 11 W2 (engineering — methodology fix + skill update):**
- 11-04 methodology (POLISH-07..11): `42b1beb`
- 11-05 external-review-gate (POLISH-12): `afdb924`

**Phase 11 W3 engineering scaffolding (runner + gates + applier + retag-annotation generator):**
- 11-06/07/08 W3 scaffolding (POLISH-13/14/15/16 auto tasks): `dbf407d`

**Phase 11 SUMMARY.md files on disk:** 11-01 through 11-08 (8 of 8). All requirements POLISH-01 through POLISH-16 have engineering deliverables.

**Phase 12 spec on disk:** `.planning/research/2026-05-10-phase-12-real-v6-structural-marks.md` (committed at session-end via /endsession).

## Ship gates as of pause

- `bun run build` exits 0
- `bun run vesna` — 26/26 = 100% PASS preserved across all W1 + W2 + W3-scaffolding work
- `bun run test` (full suite) — 3748 passes / 27 v4-debt failures matching CLAUDE.md baseline / 8 skipped — no new regressions
- `bun run lint:test-discipline` — 0 flagged sites
- WIR integration test (Phase 11) — 3/3 PASS
- All 8 Phase 11 SUMMARY.md files on disk
- Phase 11 PROBE-AUDIT.md committed (30 probes classified)
- Q2 probe authoring rules committed at q2-probe-rules.md
- Q2 validator + phase-11-close + retag-cmd scripts committed
- 48 new tests across runQ1.test.ts (29) + validate-q2-probes.test.ts (9) + phase-11-close.test.ts (10)

## Memories materialized 2026-05-10

The 2026-05-10 discussion produced four memory updates that feed Phase 12 design and future cross-project behavior:

- `feedback_surface_in_weak_areas_under_autonomy.md` (UPDATED) — added "clean-looking analysis is one of the disguises lock takes." Refined by the user catching me locking with a confident solution table mid-conversation.
- `project_quality_variance_across_projects.md` (UPDATED) — training volume promoted from hypothesis to **CONFIRMED FACT** ("This is the fact!"). Angel cross-project pattern promotion elevated to **"million dollar question"** dominating any future v7 design conversation.
- `feedback_leaked_cc_source_positional_decline_was_thin.md` (NEW) — codified the lines (no redistribution, no fork-and-ship; reading-as-reference is fine for legitimate interop). Replaces the broad positional decline that produced friction without insulation.
- `project_v6_polish_residual_concerns.md` (UPDATED) — concern 4 narrowed: Vesna binary rubric is correct for 5/7 categories; only `lesson-application` + `deliberation-engagement` have name-vs-implementation gaps requiring polish, not rework.

## Risks if Phase 12 + W3 collide

- **Cross-family API quotas.** Phase 12's external-review-gate dogfood (12-CLOSE) and W3's 4-judge ensemble both consume Codex / Gemini Flash quotas. Watch rate limits; stagger if necessary. Codex is unavailable until 2026-05-14 per CONTEXT line 116 — Phase 12 dogfood may need `--skip-codex` if 12-CLOSE runs before 2026-05-14.
- **GLM-5.1 / Angel scheduling.** Same constraint as W3 step 2 — GLM-5.1 is Angel's default LLM. If W3 ensemble is running and Phase 12 needs Angel for pattern promotion, the swap or idle-window discipline applies to both tracks.
- **Q2 probe authoring is 30-120h operator commitment.** This is the tightest serial path on Track B. If operator capacity is the bottleneck, Phase 12 (Track A) finishes well before Track B does. That's fine — convergence waits.
- **Phase 12 close depends on the cross-family pipeline Phase 12 itself ships.** 12-CLOSE dogfood uses Plan 12-01's pipeline. If Plan 12-01 fails or produces an unstable pipeline, the gate doesn't run; address the pipeline before declaring close.

## What's local-ahead-of-origin

15 commits ahead of `origin/master` (W1 + W2 + W3-scaffolding + handoff), plus whatever /endsession adds (this handoff update + spec + memory files):

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

Plus the unchanged local annotated tag `v6.0.0` from Phase 10 close-out (with the methodology-invalidated annotation per CONTEXT decision 4 — retag pending W3 verdict, NOT Phase 12 verdict).

## Note on confidence

Phase 12 ships the marks, but confidence in Claudex comes from real-use validation post-push, not from shipping Phase 12. Phase 12 is the *condition* that makes validation possible — telemetry instrumentation lighting up, cross-family gates active, Vesna polished. The actual confidence-generating events are real users (you and others) running v6 + Phase 12 over the 2-week post-push window and either getting burned or not.

There is no "finally" event. Confidence is a moving target. After Phase 12 + 2 weeks of telemetry: less worried about the named gaps. After 6 months of real use: more. After a year: more. The parable answer was load-bearing for Phase 12's design and remains load-bearing for what comes after.
