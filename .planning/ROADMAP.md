# Roadmap: Claudex v5 — Bound Multi-Modal Episodes

## Overview

**Milestone reframed 2026-05-05.** Phases 2 and 2.1 produced 3 consistent KILL bound experiences against the multi-handle/density-fusion thesis. The locked decision rule fired; phases 3 and 5 (which were premised on that thesis) are dropped. v5 becomes a **substrate-only milestone** with no replacement thesis. Full reasoning: `.planning/reframes/2026-05-05-multi-handle-kill.md`.

Surviving shape: Phase 1 substrate (shipped), Phase 4 Angel reduction, Phase 6 crash-resilient episode boundary, Phase 7 narrowed v4 coexistence / migration / ship. The parable as cognitive frame stands; legs 2 and 3 of the v5 thesis (recall-by-any-modality via fusion, abstraction-from-density) do not. Methodology that produced the honest KILL — pre-committed decision rule, locked corpus, multiple bound measurements, append-only aggregator, Wilson/Newcombe CI binding — is promoted to v5 standard practice for any future empirical phase.

The architectural framing (parable) is locked in `.planning/research/2026-05-04-v5-bound-episodes-framing.md` and PROJECT.md. This roadmap is the **execution sketch** — phase boundaries are reasonable hypotheses, not guarantees. The user-approval gate between phases is the iteration loop. Phases marked `type: empirical` are explicitly investigations: their CONTEXT.md frames success as measurable hypotheses, their PLAN.md include measurement protocols, their SUMMARY.md may legitimately report "this didn't work, here's what we learned" as a successful outcome.

**Status legend:**
- `[ ]` Pending
- `[x]` Complete
- `[~]` Partial-with-followups
- `[-]` Dropped (with reasoning)
- `type: engineering` — discuss → plan → execute, ship feature
- `type: empirical` — discuss → plan → measure, ship learning (which may include negative results)

## Phases

- [x] **Phase 1: Episode substrate** _(type: engineering)_ — SHIPPED 2026-05-04

    Schema design + write path. New `episodic_events` table with `{id, ts, session_id, type, source, content, provenance, ...}`. Provenance tags: `organic | injected | tool_result | environmental`. Coexists with `conversation_turns` initially — every UserPromptSubmit, every Stop hook, every tool result writes a parallel event row with structured fields. Migration is forward-only; old conversation_turns remain as legacy. Goal: a clean substrate to build the rest on, with the Mem0 trap structurally impossible because injected spans are tagged at write time.

    **Outcome:** V25 migration with 4 indexes + closed-enum `provenance` CHECK; helpers `dualWriteUserPrompt`/`dualWriteAssistantMessage`/`writeToolResult`/`writeEnvironmentalEvent` in `src/core/episodic-events.ts`; PostToolUse + session-start + session-end + Angel heartbeat instrumented; 60+ EPI-tagged tests including stub-extractor proof of EPI-07 Mem0-trap-impossibility; substrate operator README + environmental audit at `.planning/phases/01-episode-substrate/`. Vesna 17/17 preserved.

- [x] **Phase 2: Multi-modal index seeds + density-at-scale check** _(type: empirical)_ — SHIPPED 2026-05-04, **verdict KILL**

    Investigation phase. Pick **one** non-semantic index and prove it works on a small corpus. Recommended starter: error-fingerprint (token-shingle + edit-distance over stack traces). Build it on Phase 1's substrate, populate with 30–50 episodes from real Claudex sessions, measure: (a) does the index fire on similar errors? (b) when fired alongside semantic recall, does fusion improve precision/recall? (c) at the scale of our episode corpus (~9K observations across projects), is density a meaningful signal or pure noise? Output is a measurement report. **Negative result is a valid output** — if error-fingerprint doesn't justify its complexity, scope it down or pivot before phase 3 builds on it.

    **Outcome:** V26 sidecar `episodic_index_error_fingerprint` + pure fingerprinter + idempotent backfill (135 fingerprints / 19 projects on operator DB; 10,678 sidecar rows) + Wilson/Newcombe measurement harness + verdict runner. Live measurement: criterion 1 FAILED (delta_p5 +10pp but Wilson CI lower -0.157 at n=20 — CI-binding discipline rejected as noise); criterion 2 FAILED (intra_project_share 0.234 < 0.30 threshold); criterion 3 PASSED (latency p99 ratio 0.89). Per CONTEXT item 7: Vesna probes remain in `.disabled/`, `DEFAULT_CONFIG.features.error_fingerprint` flipped true→false, backfill data retained, harness reusable by Phase 5. Phase 3's multi-handle cutover plan is **NOT** ready — escalate to user-approval gate. Full report at `.planning/phases/02-multi-modal-index-seeds-density-check/02-05-SUMMARY.md` + `02-RESULTS.md` + `02-results.json`.

- [x] **Phase 2.1: Corpus-expansion rerun (second bound measurement)** _(type: empirical)_ — SHIPPED 2026-05-05, **verdict KILL × 2**

    Approved 2026-05-05 by user. Phase 2 produced ONE bound measurement at n=20: +10pp on precision@5 with Wilson CI [-0.157, ?]. Following the parable: a single experience is not yet an abstraction. Phase 2.1 produced TWO additional bound measurements under different labeler-strictness conditions (strict ≥3-frame and relaxed ≥2-frame) so density could do its work — multiple consistent results across measurements produce real signal; one measurement does not.

    **What changed vs Phase 2:** corpus shape (three-tier `corpus_origin` partition: v4_backfill, phase1_organic_pre_phase2_close, phase1_organic_post_phase2_close — V26→V27 schema), threshold-tested labeler (strict + relaxed run independently with no combined verdict), descriptive-not-gating audit (20 stratified per tier, full agent autonomy), and append-only aggregator at `.planning/aggregates/multi-handle.{md,json}`. Reused: harness, V26 sidecar, fingerprinter, Wilson/Newcombe verdict module, and CONTEXT.md item 5's locked decision rule **verbatim**.

    **Outcome:** Strict tier (n=20): KILL — Δp@5 +0.10 [-0.157, +0.376], Δr@10 -0.05 [-0.274, +0.172], density 0.2418 (< 0.30). Relaxed tier (n=19): KILL — Δp@5 +0.21 [-0.033, +0.491], Δr@10 +0.05 [-0.141, +0.226], density 0.2418 (< 0.30, identical-to-3-decimals — repeatability of the density floor confirms it's the corpus's actual signal, not sampling noise). Aggregator now contains 3 KILL bound experiences across labelers and tiers. Locked decision rule's KILL branch fires at user-approval gate.

    **What this phase did NOT do:** prejudge the milestone reframe. The KILL was honest output of the pre-committed rule against three measurements. The user-approval gate at phase close is where the milestone-level decision was made — see `.planning/reframes/2026-05-05-multi-handle-kill.md`.

    Full report: `.planning/phases/02.1-corpus-expansion-rerun/02.1-RESULTS.md` + `02.1-results.json`. Plan-checker verdict: PASS WITH NOTES (`02.1-VERIFICATION.md`).

- [-] **Phase 3: Multi-handle retrieval cutover** _(type: engineering)_ — **DROPPED 2026-05-05**

    Premised on the multi-handle/density-fusion thesis killed by Phase 2/2.1's three consistent KILL verdicts. v4's `hybrid-retrieval.ts` (semantic + FTS + reranker) stays in production unchanged. No RRF cutover ships in v5. Existing `experience_warning_triggers` and assembly experience-pattern injection continue firing from `experience_patterns` legacy rows (which Phase 4 Angel reduction will stop *creating new instances of* — but reads remain live). Future milestones (v6+) may revisit retrieval theses on Phase 1's substrate, under the methodology Phase 2/2.1 proved.

    Reasoning: `.planning/reframes/2026-05-05-multi-handle-kill.md`.

- [x] **Phase 4: Angel reduction** _(type: engineering with code-trace prerequisite)_ — SHIPPED 2026-05-05

    **Reframed 2026-05-05** (sharpened, not weakened) and **shipped same day** through `/auto-orchestrate` (discuss-4 → plan-4 → execute-4, 31 atomic commits across 9 plans).

    **Outcome:** Three extraction-time pattern creation sites deleted (Site A `pattern-extractor.ts:554`, Site B `experience-scoring.ts` step 1, Site C `heartbeat.ts` synthesis loop — Site C surfaced during discuss). V28 schema cutoff trigger blocks new INSERTs structurally (TEMP trigger + per-connection `temp.session_pragmas` override sidecar for fixtures/migrations). `classifySessionDomains` extracted to new `src/angel/domain-classifier.ts`; correction-signal infra preserved at `src/intelligence/correction-detection.ts`. `applyExperienceFeedback` step 2 (score feedback) + step 3 (flag rotation) survive — they read existing rows, not extract.

    Three-layer cutoff signal in place:
    - L1: JSDoc tombstones on `experience-patterns.ts` module + `createPattern` function pointing at the reframe artifact.
    - L2: `extraction-deleted.test.ts` regression guard (4 assertions including heartbeat lesson-immutability).
    - L3: V28 BEFORE INSERT trigger via TEMP `session_pragmas` sidecar.

    Reader policy: 9 reader sites (assembler, heartbeat janitor, intelligence/*, embed pipeline, mcp recall, hooks step 2/3) carry uniform legacy-with-TODO comment pointing at the reframe and Phase 7's retirement responsibility. No re-points at episode-based fusion (Phase 3 dropped). 88 existing rows untouched.

    Mem0 fix from `0d0fbca` deleted with Site A — now structurally obsolete. `skill-writer.ts` deleted as orphaned with Site A. `markSessionProcessed` deleted; `sessions_processed`/`patterns_extracted` heartbeat fields soft-no-op'd to preserve observability surfaces.

    **Ship gates verified:**
    - SC#1 Vesna: 17/17 → **18/18 PASS at 100%** (new VAL-02 probe `extraction-deleted-001.json`)
    - `bun run build`: clean
    - `bun run test`: 3380/3415 passing (27 pre-existing failures unchanged from master baseline)

    Net code change: ~1100 lines deleted, ~700 added — pure shrinkage on production path.

    **Phase rename consideration deferred:** The phase name "Angel reduction" originally targeted Site A only; Site B (intelligence/) and Site C (Angel/heartbeat) emerged during discuss. CONTEXT.md flagged this for user-approval-gate review. Decision: name stays — historical accident, the reframe artifact carries the explanation, and renaming retroactively is a 30-second decision the user can take at any future time.

- [-] **Phase 5: Density-based abstraction** _(type: empirical)_ — **DROPPED 2026-05-05**

    Premised on the same multi-handle/density-fusion thesis killed by Phase 2/2.1. Intra-project density measured at 0.2418 on both 2.1 tiers (threshold was 0.30) — and the value's repeatability across labelers confirms it's the corpus's actual density floor, not noise. There is no density signal at our scale to abstract from. `experience_patterns` legacy reads stay live; no retrieval-time clustering replaces them in v5. Future milestones may revisit if substrate growth changes the density profile.

    Reasoning: `.planning/reframes/2026-05-05-multi-handle-kill.md`.

- [ ] **Phase 6: Crash-resilient episode boundary** _(type: engineering)_

    Implement engineering-doc Recommendation #1: Angel-as-source-of-truth for session-end. fsnotify on the JSONL directory + heartbeat row from session + idle-timeout sweep + PID-liveness with stale detection. **Episode = session (sub-session segmentation deferred to v6+ per CONTEXT 2026-05-05).** Detection-only — close emits a single `episode_closed` environmental event row via Phase 1's `writeEnvironmentalEvent`; no synthesis fires (Phase 5 dropped). Once this lands, agent lifetime is decoupled from memory persistence: PC crash, OOM, hung agent — the close marker fires when the episode goes quiet.

    **Plans:** 5 plans in 5 waves
    - [ ] 06-01-PLAN.md — V29 schema (episode_boundary_cursor table + sessions.last_heartbeat_ts/last_jsonl_write_ts columns)
    - [ ] 06-02-PLAN.md — chokidar runtime dep + jsonl-watcher / pid-liveness / thresholds modules
    - [ ] 06-03-PLAN.md — heartbeat column writes in 5 hooks (UserPromptSubmit / PreToolUse / PostToolUse / Stop / SessionEnd) + clean_endsession close emission
    - [ ] 06-04-PLAN.md — composition rule + cursor + boundary detector with heartbeat-compare-before-cleanup guard and re-open handling
    - [ ] 06-05-PLAN.md — Angel integration (heartbeat tick + watcher boot/shutdown) + Vesna VAL-04 crash-resilience probe

- [ ] **Phase 7: v4 coexistence / migration / ship** _(type: engineering)_

    **Narrowed 2026-05-05** — no multi-handle retrieval to migrate. Decide per-category what happens to v4 storage:
    - `experience_patterns` (88 rows, inflated): retire — Phase 4 stops new instances; reads stay live during deprecation. NOT replaced by density abstraction (Phase 5 dropped); v4's `experience_warning_triggers` continues reading these rows in legacy mode until a future milestone replaces the surface.
    - `learning` (191 rows): re-derive as projections from raw episodes? Or preserve as legacy "synthesized fact" surface?
    - `decision` (126 rows): same question
    - `mental_model` (659 rows): probably keep — these are user-/agent-confirmed long-term, not extraction artifacts
    - `directive_rule`, `critical_rule`: likely keep — explicit rules that earned their status
    - `transcript_chunk`: superseded by Phase 1 substrate

    Then: Vesna probe suite update (existing 17 + new VAL-01/02/04 + KILL-regression VAL-03'), ship gate validation, **v5.0.0 tag**.

## Phase typing rationale

Post-reframe: surviving v5 is mostly engineering (1, 4, 6, 7). The empirical phases (2, 2.1) shipped their bound experiences and produced the KILL verdict that drove the reframe. No further empirical phases are scheduled in v5. Auto-orchestrate runs surviving phases with discuss → plan → execute → user-approval flow.

The methodology proven by Phase 2/2.1 (pre-committed decision rule, locked corpus, multiple bound measurements, append-only aggregator at `.planning/aggregates/`, descriptive-not-gating audits, Wilson/Newcombe CI binding) is recorded as **v5 standard practice** for any future empirical phase. See PROJECT.md and `.planning/reframes/2026-05-05-multi-handle-kill.md`.

## Validation criteria (refined during phase planning)

The v4 ship gates were SC#1 (Vesna 100%), SC#2 (≤500 token cache-stable), SC#3 (MEMORY.md content quality), SC#4 (handoff pickup). v5's ship gates after reframe:

- **SC-V5-1: Episodic recall.** Probes that establish "the keyword X fires the episode where it was discussed last session" — directly addresses today's failure mode where the parable couldn't be recalled. Driven by Phase 1's substrate (already shipped) and validated by Vesna probes added in Phase 7.
- **SC-V5-2: No re-extraction inflation.** Provenance-tagged write path makes the Mem0 feedback loop structurally impossible. Probe asserts injected-span content does not contribute to extracted artifacts. Validated against the post-Phase-4 codepath (extraction-time pattern creation deleted).
- **SC-V5-3': KILL-regression probe** (transformed from original "density at scale"). Probe replays the Phase 2.1 harness against the locked corpus + decision rule and asserts the KILL verdict reproduces. Future accidental restoration of the dead multi-handle thesis fails this probe.
- **SC-V5-4: Crash-resilient.** Kill -9 mid-session; verify Angel still synthesizes on idle timeout. Engineering-doc Recommendation #1 validation. Driven by Phase 6.
