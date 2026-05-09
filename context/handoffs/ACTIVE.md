---
status: active
phase: "11"
summary: Phase 11 W1 + W2 SHIPPED. W3 (empirical re-bind) is operator-driven — requires LIVE 4-judge ensemble (Gemini-3-Flash + Claude Opus 4.7 + GLM-5.1 + Kimi-K2.6) + 2-4 days of GPU/cloud compute per question, plus checkpoint:human tasks for big-mozzy-v2 probe authoring + v6.0.0 retag operator-approval. v6.0.0 local tag is UNCHANGED — still has the unverified Phase 10 annotation. Operator must run W3 before retag + public push.
topic: 2026-05-09-phase-11-w2-complete-w3-pending-operator
created_at_epoch_ms: 1778361000000
---

# 2026-05-09 — Phase 11 polish W1 + W2 SHIPPED; W3 awaits operator

**Where we are:** Phase 11 (the v6 polish phase, addressing pre-push Gemini consultation defects) has 5 of 8 plans SHIPPED. Wave 1 (engineering — code regressions) and Wave 2 (engineering — methodology fix + skill update) are complete. Wave 3 is **operator-driven empirical measurement** — it is a separate operator commitment, not a continuation of the autonomous engineering thread.

## Morning operator action — three decisions

1. **Decide on Wave 3 timing.** W3 plans need ~3-6 days of GPU/cloud compute per the spec. Costs apply (Gemini-3-Flash + GLM-5.1 + Kimi-K2.6 are paid Ollama cloud; Claude Opus 4.7 is OAuth/MAX so no API charge). Schedule overnight runs or a dedicated multi-day window.
2. **Decide on Angel/GLM-5.1 scheduling.** GLM-5.1 is Angel's default model AND a judge in the W3 ensemble. Mitigation per `.planning/phases/11-polish-land-v6-properly/11-CONTEXT.md` § Operational constraints (line 122): swap Angel to a non-judge cloud model OR run W3 during Angel-idle window.
3. **Author big-mozzy-v2 user-pair probes for Q3** (CONTEXT line 108 — required user-pair authoring). Q3 only runs if Q1 + Q2 both BIND_POSITIVE; if W3 short-circuits earlier, Q3 doesn't happen.

## What's complete (W1 + W2 SHIPPED)

**Wave 1 — Code regressions (POLISH-01..06)** — 13 Gemini findings closed across routing / assembly / ingestion + test-discipline lint + sanitized fixture + WIR integration test:

- 11-01 routing fixes (POLISH-01): null-body coalesce, telemetry-bypass try/catch isolation, time-distance ordering. Commits `af9a5ca`, `b91b3d2`.
- 11-02 assembly fixes (POLISH-02): commitEffects spread, async contract guard, bi-encoder header annotation `## Deliberation Surfaced (low-confidence retrieval)`, token-budget pre-deduct. Commit `ea0590e`.
- 11-03 ingestion + tests + lint + snapshot + WIR (POLISH-03..06): atomic upsert, ghost-row cleanup, vec0 DELETE before empty-skip, missing-file errors=-1 sentinel + telemetry, format-preserving sub-chunker (backtick-fence-aware), force-split with telemetry, test-discipline lint at `scripts/lint-test-discipline.cjs`, sanitized FRESH-V32 fixture at `.planning/fixtures/production-shape-v32.db` (788 KB), WIR integration test at `src/tests/integration/phase-11-ingestion-wire-test.test.ts`. Commits `659c0c4`, `b87dc84`, `0863986`.

**Wave 2 — Methodology fix + skill update (POLISH-07..12):**

- 11-04 methodology fix (POLISH-07..11): `runTranscriptArmViaRouting` calls production routeFromArtifact, A-arm session_id metadata parity, `pairedMcNemar` exact test in verdict.ts (replaces pooled-Wilson), 4-judge ensemble scaffolding at `judge-ensemble.ts` (pluggable JudgeDispatcher / VerdictParser; live cloud plumbing is W3's job), 30-probe parametric-knowledge audit at `.planning/phases/11-polish-land-v6-properly/11-PROBE-AUDIT.md`. Commit `42b1beb`.
- 11-05 external-review-gate skill mod (POLISH-12): `scripts/external-review-gate.cjs` orchestrator + skill modifications at `~/.claude/skills/{auto-execute-phase,auto-orchestrate}/SKILL.md` (user-global). Classification rule pre-committed (critical→BLOCK / high→LOG / else SIGNOFF); operator override `--skip-external-review` with audit log. Commit `afdb924`.

## What's incomplete (W3 — operator-driven)

| Plan | Status | What it needs |
|------|--------|---------------|
| 11-06 Q1 within-corpus paired-McNemar | NOT STARTED | Live 4-judge ensemble + reranker on port 7439 + 2-4 days compute. Plan ready; runner.ts needs `runQ1` function (Task 1) + actual run (Task 2). |
| 11-07 Q2 disjoint-probe rebind | NOT STARTED | Conditional on Q1 BIND_POSITIVE. Authoring 60 fresh probes is ~1-2 days of human-pair work. |
| 11-08 Q3 cross-corpus + 11-RESULTS.md + v6.0.0 retag | NOT STARTED | Conditional on Q1 + Q2 both BIND_POSITIVE for Q3 to run. checkpoint:human tasks for big-mozzy-v2 probe authoring (Task 2) + v6.0.0 retag annotation operator-approval (Task 5). |

**v6.0.0 local tag is UNCHANGED.** It still has the Phase 10 annotation (which the Gemini consultation later flagged as methodology-invalidated). Per CONTEXT decision 4: "v6.0.0 local tag — keep until polish completes, then delete + re-tag." The polish is engineering-complete (W1 + W2) but not empirically-rebound (W3). DO NOT push the existing tag; DO NOT retag prematurely.

## What's local-ahead-of-origin

13 commits ahead of `origin/master` (W1 + W2):

```
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

Plus the unchanged local annotated tag `v6.0.0` from Phase 10 close-out.

## Ship gates as of pause

- `bun run build` exits 0
- `bun run vesna` — 26/26 = 100% PASS preserved across all W1 + W2 work
- `bun run test` (full suite) — 3700 passes / 27 v4-debt failures (matches CLAUDE.md baseline) / 8 skipped — no new regressions
- `bun run lint:test-discipline` — 0 flagged sites
- WIR integration test (Phase 11) — 3 cases pass against the committed fixture
- All 5 W1 + W2 SUMMARY.md files exist on disk
- Phase 11 PROBE-AUDIT.md committed (30 probes classified)

## How to resume W3

1. Re-read 11-CONTEXT.md and 11-{06,07,08}-PLAN.md to refresh the conditional outcomes table.
2. Decide Angel/GLM scheduling (option a swap or option b idle window).
3. Verify reranker on port 7439 is alive; verify Ollama can run all 4 judge models; verify Anthropic OAuth at `~/.claude/.credentials.json`.
4. Either:
   - (i) Spawn `/auto-execute-phase 11` again — the skill will pick up at the first incomplete plan (11-06). The existing W1+W2 SUMMARY files are present; the orchestrator's `init execute-phase` resolver will skip them.
   - (ii) Manually invoke the runner: implement 11-06 Task 1 (`runQ1` function in runner.ts) then run Task 2 against the live ensemble.
5. As Q1/Q2/Q3 complete, the conditional outcomes table in 11-CONTEXT.md determines the v6.0.0 retag annotation.
6. Plan 11-08 Task 5 (checkpoint:human) requires operator approval before the local v6.0.0 retag. Plan 11-08 close-out dogfoods the external-review-gate (Plan 11-05).
7. Public push `git push origin master --tags` is OUT OF SCOPE for the autonomous pipeline — operator-confirmed at retag close-out only (CLAUDE.md rule 1 + CONTEXT § Phase Boundary).

## Risks if W3 is delayed

- **None operationally.** Engineering work shipped is internally consistent; Vesna preserved; full suite intact. The retained v6.0.0 local tag has an annotation that the Gemini consultation flagged as methodology-invalidated — keeping it unchanged is the correct conservative posture per CONTEXT decision 4.
- **Audit-trail completeness:** the 11-PROBE-AUDIT.md captures the parametric-knowledge confound finding from Gemini Harness #5 even if W3 never runs. The "what would invalidate this measurement" pre-commits in 11-CONTEXT.md § Methodology critique are the operator's honest signaling of risks.
