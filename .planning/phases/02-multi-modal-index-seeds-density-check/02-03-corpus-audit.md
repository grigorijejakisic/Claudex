# Phase 2 Corpus Audit

**Generated:** 2026-05-04 (epoch 1777938869)
**Backfill module:** `src/benchmark/episodic-density/backfill.ts`
**DB inspected:** `~/.claudex/db/claudex.db`
**Run mode:** `--dry-run`
**Reproduce:** `bun run build && node dist/benchmark/episodic-density/cli.cjs backfill --dry-run`

## Source 1: Phase 1 organic tool_result

- **Filter:** `episodic_events WHERE provenance='tool_result' AND ts_epoch >= 1777929975` (PHASE1_SHIP_TS_EPOCH = `git show -s --format=%ct 9434ab9`, the Phase 1 ship commit, 2026-05-04 epoch).
- **Rows scanned:** 349
- **Rows fingerprinted (looksLikeStackTrace + computeErrorFingerprint non-null):** 5
- **Fingerprint hit rate (5 / 349):** 1.4%
- **Sidecar writes (shingles per fingerprint, summed):** 6454
- **Projects covered:** `desktop-01dcc792`
- **Sample row IDs (first 5 fingerprinted):** discoverable via `SELECT id FROM episodic_events WHERE provenance='tool_result' AND ts_epoch >= 1777929975 ORDER BY id LIMIT 5` (specific IDs project-scoped to the operator's machine; not committed for portability).

The hit rate on Phase 1 organic data is low because the substrate has only been live for hours at audit time (commit 9434ab9 landed earlier on 2026-05-04). Production tool_result rows skew toward Read/Glob/Grep tool output rather than error stack traces — most don't match the heuristic. This is expected; v4 backfill is the larger source for measurement.

## Source 2: v4 artifact observations

- **Filter:** `artifacts WHERE artifact_type = 'observation' AND content IS NOT NULL` followed by per-row `looksLikeStackTrace(content)`. The artifact_type heuristic was confirmed against the live DB shape — `kind` (the column name in CONTEXT.md item 2) maps to `artifact_type` in this codebase's schema; observation rows are the dominant kind (8391 of 9420 total artifacts at audit time).
- **Rows scanned:** 8393
- **Rows fingerprinted:** 130
- **Fingerprint hit rate (130 / 8393):** 1.5%
- **Sidecar writes:** 4166
- **Projects covered (19):** claudex, claudex-v3, openclaw-main, nexus-e53c6c93, nexus-app-f0158b12, nexus-app-56a23c73, nexus-v2-7e3c3a02, oracle-3951898e, daemon-9f9827ee, desktop-01dcc792, claude-code-buildable-6deec3e5, vesna-6abb357b, lacuna-betting-9f1d552c, kompas-98604047, projects-3892a6d8, claudex-v2, big-mozzy-v2, big-mozzart-clean, big-balkan
- **Sample row IDs:** discoverable via `SELECT id FROM artifacts WHERE artifact_type='observation' ORDER BY id LIMIT N` and inspecting which match the heuristic; not committed for portability.

The v4 backfill is the workhorse — 19 projects' worth of long-tail observation history covering ~3.5 months of Claudex use across multiple Nexus iterations, Vesna, Oracle, Lacuna-Betting, BigMozzy/Balkan, etc.

## Cumulative

- **Total fingerprinted episodes:** 135
- **Total distinct projects:** 19
- **Floor met (≥50 fingerprinted AND ≥3 projects)?** **YES**
  - 135 ≥ 50 (2.7× floor)
  - 19 ≥ 3 (6.3× floor)

The 50-event floor is comfortably cleared even with the conservative heuristic for "looks like a stack trace." Plan 02-04's harness has enough corpus to score Wilson CI deltas at the held-out test-set level the decision rule requires.

## Manual 20-pair spot-check (CONTEXT discretion)

Per CONTEXT item 2, the auto-pair-labeler MUST be audited on 20 random pairs BEFORE measurement runs. This audit is operator-driven: the harness in Plan 02-04 emits the labeled-pair list, the operator samples 20 at random, and verifies the labels are not garbage.

**Pair selection rule** (auto-labeler):
- Same outer_exception
- ≥3 frames overlap (frame = `<file>:<line>:<func>`)
- Different session_id

**Operator workflow:**
1. After Plan 02-04 lands, run `bun run build && node dist/benchmark/episodic-density/cli.cjs spot-check` (or invoke `labelPairs(events)` from a one-off node script if the spot-check subcommand is not yet wired).
2. Sample 20 pairs uniformly at random from the labeled list (use `seed=4242` for reproducibility).
3. For each pair, manually compare the two `raw_content` strings and tick "valid?" Y/N.
4. If <20/20, list the invalid pairs and the auto-labeler rule that misfired.

| # | event_a id | event_b id | outer_exception | overlap_frames | sessions | projects | valid? (Y/N) | notes |
|---|------------|------------|-----------------|----------------|----------|----------|--------------|-------|
| 1  | [OPERATOR-FILL] | | | | | | | |
| 2  | [OPERATOR-FILL] | | | | | | | |
| 3  | [OPERATOR-FILL] | | | | | | | |
| 4  | [OPERATOR-FILL] | | | | | | | |
| 5  | [OPERATOR-FILL] | | | | | | | |
| 6  | [OPERATOR-FILL] | | | | | | | |
| 7  | [OPERATOR-FILL] | | | | | | | |
| 8  | [OPERATOR-FILL] | | | | | | | |
| 9  | [OPERATOR-FILL] | | | | | | | |
| 10 | [OPERATOR-FILL] | | | | | | | |
| 11 | [OPERATOR-FILL] | | | | | | | |
| 12 | [OPERATOR-FILL] | | | | | | | |
| 13 | [OPERATOR-FILL] | | | | | | | |
| 14 | [OPERATOR-FILL] | | | | | | | |
| 15 | [OPERATOR-FILL] | | | | | | | |
| 16 | [OPERATOR-FILL] | | | | | | | |
| 17 | [OPERATOR-FILL] | | | | | | | |
| 18 | [OPERATOR-FILL] | | | | | | | |
| 19 | [OPERATOR-FILL] | | | | | | | |
| 20 | [OPERATOR-FILL] | | | | | | | |

**Verdict:** [OPERATOR-FILL] — `N/20 valid`.

If <20/20, the auto-labeler's frame-overlap or outer_exception rule needs tightening, and Plan 02-04's harness should be re-run after the fix. Auto-labeler quality is a precondition for the decision rule (CONTEXT item 5) to be honest.

## Known limitations (CONTEXT item 2)

- v4 backfill rows lack Phase 1 provenance tags. Sidecar `corpus_origin='v4_backfill'` keeps post-hoc analysis honest. Plan 02-04 reports metrics BOTH pooled AND split by `corpus_origin` so the operator can see whether the index works on clean data, dirty data, or both.
- Heuristic regex for "looks like stack trace" may miss real errors (false negatives) and over-include some non-errors (false positives). Missed fingerprints fall out of the corpus, not corrupt it. Over-inclusions add noise to retrieval but don't affect ground-truth labeling, which uses `outer_exception` AND ≥3 frame overlap (a stricter test).
- Corpus is heavily skewed toward `desktop-01dcc792` for Phase 1 organic (5 of 5 rows). v4 backfill is the diversified source.
- Heuristic-driven shingle counts (6454 + 4166 = 10620 sidecar rows) are large per-event because tokens repeat across runs; Plan 02-04's Jaccard-on-shingles similarity correctly handles this via set semantics.

## Notes for the operator

The audit's machine-readable counts above are derived from a clean dry-run; re-running `bun run build && node dist/benchmark/episodic-density/cli.cjs backfill --dry-run` reproduces them deterministically as long as the underlying DB has not been modified. The 20-pair spot-check is the only section requiring human judgment.

To run the full backfill (writes to `episodic_events.metadata_json` and the sidecar) drop the `--dry-run` flag. The backfill is idempotent — re-runs converge.

## Next step

Plan 02-04 lands the A/B/C measurement harness that consumes this corpus. The verdict-runner in 02-05 then writes 02-RESULTS.md and 02-results.json.
