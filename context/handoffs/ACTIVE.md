---
status: active
phase: "14-07 v7.0.0 SHIPPED — tag + push complete on both remotes"
summary: v7.0.0 shipped 2026-05-17 12:12 +0200. Wave 0 (foundations) + Wave 1 (V17 unified substrate, V37) + Wave 2 (knowledge graph, V38) + Wave 3 (session-start coherence including LSS + CHR, V39) all landed. Binding ship gate (Vesna SC#1) 28/28 100% — exceeds v6.6.0 baseline (27/28). Data integrity gates PASS (artifact_id_map 100%, re-vectorize 99.96%). Cutover read-only flip applied to 10,722 legacy artifact rows. Cutover gate redesigned per `feedback_benchmarks_are_sanity_not_gates.md` — binding on Vesna + data integrity; LongMemEval/LoCoMo/cross-project moved to informational. Tag `v7.0.0` annotated and pushed to origin (Corleanus dev) + public (grigorijejakisic). 12 substrate plans shipped (w0d + 14-07a/b/c + LINKS-SCHEMA + 07d/e/f/g + 07h/i/j/k/l). LSS (14-07k) + CHR (14-07l) added to v7 scope mid-run per operator authorization 2026-05-17 02:47.
topic: 2026-05-17-v7-shipped
created_at_epoch_ms: 1779012720000
---

# 2026-05-17 — v7.0.0 SHIPPED

**What we found:** The autonomous overnight run executed end-to-end per the operator's "deploy V7" mandate. Two cutover-gate iterations: first attempt refused (LongMemEval/LoCoMo timing out as binding gates — architectural mismatch between SOTA benchmarks and schema-correctness gates); operator-confirmed Q2 critique morning of 2026-05-17 ("Why did you even consider mixing any benchmarks into validations for what we are doing?") drove the gate redesign per the durable `feedback_benchmarks_are_sanity_not_gates.md` preference; second cutover attempt with binding-only mode passed cleanly (Vesna 28/28 binding ✓, all data-integrity ✓).

**What we decided:**

1. **v7 qualitative ship gate gets a concrete mechanism, not just a vibe check.** LSS (14-07k) + CHR (14-07l) added to v7 scope mid-run as Wave 3 K + L. Together they close the "remembered not read" gap: LSS synthesizes the prior session's decision arc; CHR keeps the handoff refreshed per decision-boundary event so PC-death-mid-pivot can no longer leave a stale snapshot.

2. **Cutover gate design redesigned.** Binding gates measure schema-migration correctness only: Vesna SC#1 (canonical behavioral), `artifact_id_map` completeness (Phase A.2), re-vectorization success rate (Phase B). LongMemEval, LoCoMo, cross-project hit-rate moved to informational sanity (operator-runnable via `bun run wave1:benchmarks --full`). Reflects `feedback_benchmarks_are_sanity_not_gates.md`.

3. **/team pattern with worktree-isolated workers proven across 3 waves.** 12+ workers spawned across Wave 0 (w0d) + Wave 1 (14-07a + 5×14-07b + 14-07c + cross-project script + vesna-fix) + Wave 2 (LINKS-SCHEMA + 4 parallel) + Wave 3 (5 parallel). All landed on master via worktree merges + auto-commit hooks. No catastrophic conflicts.

4. **Production-quality posture confirmed durable** — `feedback_production_not_versioning_or_mvp.md`. Every worker briefing pinned the production-quality discipline; the gate-redesign moment is exactly when MVP shortcuts would have been tempting (force-bypass via `--skip-benchmarks`). Held; redesigned instead.

**What's next:** Operator-runnable post-ship items (none blocking):

- Enable `CLAUDEX_HARD_LINK_PROPOSER` after reviewing UX simulation in `14-07-WAVE2-STATUS.md`
- Run `migrate-lesson-trigger.ts --apply` to backfill `trigger:` field in existing lesson files
- Backfill LSS for prior sessions via `bun src/scripts/backfill-session-synthesis.ts`
- Enable `CLAUDEX_LINK_DISTANCE_BOOST=1` for link-aware retrieval ranking (opt-in)
- Run full sanity benchmarks: `bun src/scripts/run-wave1-benchmarks.ts` (LongMemEval + LoCoMo + cross-project)
- Cross-family review: `/codex-review v7.0.0` or `/gemini-review v7.0.0`
- AC-12 live smoke for LSS, AC-11 live smoke for CHR (require Ollama + real CC session)

**Where to look:** `.planning/phases/14-substrate-coherence/14-07-SHIP-REPORT.md` (full ship report with gate results + post-ship items); `.planning/phases/14-substrate-coherence/14-07-WAVE1-STATUS.md` (cutover trail); `.planning/phases/14-substrate-coherence/14-07-WAVE2-STATUS.md` (hard-link UX sim output); `.planning/phases/14-substrate-coherence/14-07-WAVE1-GATE-RESULTS.md` (cutover gate run logs). Tag `v7.0.0` at commit `c9e85b9` on both remotes.

## Operator Gates (carry-forward / post-ship)

- **Hard-link proposer flag** (`CLAUDEX_HARD_LINK_PROPOSER`): operator reviews UX simulation in `14-07-WAVE2-STATUS.md` before enabling. Per Good Child hybrid policy, hard-link proposer stays OFF until reviewed.
- **migrate-lesson-trigger.ts live run**: dry-run shipped; live run on real lesson files when operator ready.
- **LSS + CHR live verification**: AC-12 (LSS round-trip) + AC-11 (CHR boundary → ACTIVE.md refresh) require real session smoke; agent can't simulate operator's felt experience.
- **Cross-family v7.0.0 review**: operator runs `/codex-review` or `/gemini-review` against the tag for second-eye review.

## v6.6.0 carry-forward (still pending post-v7-ship)

- **v6.6.0 public push** at tag `a3b3a42`: operator-gated. Now superseded by v7.0.0 on public remote.
- **v6.0.0 public push** from prior cycle (Phase 13's retag): operator-gated. Likewise superseded.

## Schema versions

- V36 (v6.6.0 baseline)
- V37 (Wave 1 — V17 unified artifact)
- V38 (Wave 2 — knowledge graph)
- V39 (Wave 3 — handoff_refresh_state for CHR)
- `TARGET_USER_VERSION = 39`
