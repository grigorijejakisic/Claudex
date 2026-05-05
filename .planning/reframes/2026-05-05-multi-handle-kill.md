# Milestone Reframe: Multi-Handle Thesis KILL

**Date:** 2026-05-05
**Trigger:** Phase 2.1 closed with 2 KILL verdicts, joining Phase 2's KILL → 3 consistent KILL bound experiences across labeler-strictness and corpus-size conditions.
**Decision:** Drop the multi-handle/density-fusion thesis as v5's load-bearing claim. Reframe v5 as a **substrate-only milestone** with no replacement thesis.
**Owner:** User-approval gate at end of Phase 2.1.

---

## What was tested

The v5 thesis as locked in PROJECT.md (2026-05-04) had three load-bearing legs:

1. **Bound multi-modal episodes** — store experiences with multiple handles (semantic, error-fingerprint, frame trace, etc.) and provenance tags
2. **Recall by any modality** — fuse N indexes (RRF over semantic + non-semantic) so any handle surfaces the episode
3. **Abstraction emerges from density** — clusters of similar episodes ARE the patterns; no extraction-time pattern creation needed

Phase 2 (2026-05-04) and Phase 2.1 (2026-05-05) tested legs 2 and 3 empirically using a pre-committed decision rule, locked corpus, error-fingerprint as the chosen non-semantic index, and Wilson/Newcombe CI-binding as the noise-rejection discipline. Leg 1 was assumed to work (the test required episodes to exist) and was not itself a measurement target.

## What failed

Three bound experiences logged in `.planning/aggregates/multi-handle.json`:

| Phase | Date | Labeler | n | Δp@5 (Wilson 95% CI) | Δr@10 (Wilson 95% CI) | Latency p99 ratio | Intra-project density | Verdict |
|-------|------|---------|---|----------------------|------------------------|-------------------|------------------------|---------|
| 2 | 2026-05-04 | ad-hoc | 20 | +0.10 [-0.157, ?] | — | 0.89 | 0.234 (< 0.30) | KILL |
| 2.1-strict | 2026-05-05 | ≥3-frame | 20 | +0.10 [-0.157, +0.376] | -0.05 [-0.274, +0.172] | 0.83 | 0.2418 | KILL |
| 2.1-relaxed | 2026-05-05 | ≥2-frame | 19 | +0.21 [-0.033, +0.491] | +0.05 [-0.141, +0.226] | 1.31 | 0.2418 | KILL |

**Both criteria 1 and 2 of the locked decision rule failed in all three measurements:**
- Criterion 1 (CI-bound on improvement): no tier produced a Wilson CI lower-bound ≥ 0 on either Δp@5 or Δr@10. Closest was 2.1-relaxed at -0.033, which is not zero.
- Criterion 2 (intra-project density ≥ 0.30): both 2.1 tiers produced 0.2418, identical-to-3-decimals. That repeatability is itself signal — it's not a sampling fluctuation; it's the corpus's actual density.

Criterion 3 (latency budget) passed in all three. Latency on a thesis with no signal is not a deliverable.

**Conclusion:** Legs 2 and 3 of the v5 thesis are dead at our scale on this corpus. The locked decision rule's KILL branch fired, and the rule was committed to disk before measurements ran (`.planning/phases/02-multi-modal-index-seeds-density-check/02-CONTEXT.md` item 5).

## What survives

**Leg 1 — Episode substrate with provenance** survives because it was not the failure mode and has independent value:

- Provenance tags structurally prevent the Mem0 trap (the 2026-05-04 incident that motivated the v5 milestone in the first place)
- Direct-key recall (by session, by tool, by file path) is useful regardless of fusion or density
- Audit, debugging, and reproducibility benefit from structured event rows
- Phase 1 already shipped this (V25 migration, `episodic_events` table, dualWrite helpers, 60+ EPI-tagged tests passing)

**The methodology survives, sharpened.** The Phase 2/2.1 discipline that produced this honest KILL is what we keep:

1. **Pre-commit the decision rule before measurement** — locked in CONTEXT.md, no goalpost shifts after seeing results
2. **Locked corpus, locked harness** — same code, same data, same pair-set across replications
3. **Multiple bound measurements before milestone-level claims** — one experience is not abstraction (the parable applied to ourselves)
4. **Append-only aggregator** — `.planning/aggregates/{topic}.{md,json}` event-sourced, never mutated, the receipts are durable
5. **Descriptive-not-gating audits** — agent autonomy on the audit work; precision/recall metrics reported, not used as gates
6. **Wilson/Newcombe CI binding** — at small n, point-deltas of +5pp can be inside the CI of zero; require the lower bound to bind

This is now **v5 standard practice** for any empirical phase. Recorded in PROJECT.md.

## What dies

**Phase 3 — Multi-handle retrieval cutover** — DROPPED. The thesis the cutover was meant to ship is dead. No RRF fusion in the production retrieval path. v4's `hybrid-retrieval.ts` stays as-is.

**Phase 5 — Density-based abstraction** — DROPPED. Same dead thesis. No retrieval-time clustering as inferred patterns. `experience_patterns` legacy reads stay live; no density abstraction replaces them.

**Requirements DROPPED:**
- RET-01..05 (multi-handle retrieval requirements)
- ABS-01..04 (density-based abstraction requirements)
- VAL-03 (density-at-scale probe) — transformed into a regression probe that asserts the harness reproduces the KILL verdict, so future accidental restoration of the dead thesis is caught

## What v5 becomes after this reframe

**v5 is a substrate-only milestone.** No replacement thesis is being installed. The discipline that just killed the multi-handle thesis applies to ourselves: one reframe conversation cannot manufacture a fresh load-bearing claim.

Surviving v5 deliverables:

- Episode substrate with provenance (Phase 1, SHIPPED)
- Mem0-trap structurally impossible (provenance discipline, SHIPPED with Phase 1)
- Angel reduction (Phase 4) — strip extraction-time pattern creation; the mechanism *itself* violates the parable by abstracting from N=1 experience
- Crash-resilient episode boundary (Phase 6) — engineering value independent of any retrieval thesis
- v4 coexistence / migration / ship (Phase 7) — narrowed: no multi-handle retrieval to migrate, just substrate coexistence + Vesna update + tag

**v5 does NOT deliver better retrieval.** The retrieval question is deferred. v4's hybrid-retrieval pipeline (semantic + FTS + reranker) stays in production unchanged. Future milestones (v6+) may test new retrieval theses on the substrate this milestone built — under the methodology this milestone proved.

## What the parable says about this reframe

The parable: *"a single experience is not yet an abstraction — density across multiple measurements is what produces real signal."*

Three KILLs across labelers and tiers IS density. Acting on it honors the parable. Running a fourth measurement on the same corpus to fish for a different verdict would betray the parable while invoking it.

The same parable applied to the reframe itself: don't install a new load-bearing thesis from one round of reflection. Drop the dead claim, keep the substrate work whose value is thesis-independent, defer new retrieval theses until they have their own bound measurements.

## Roadmap shape after reframe

```
Phase 1 — Episode substrate                            [x] SHIPPED 2026-05-04
Phase 2 — Multi-modal index seeds + density check      [x] SHIPPED 2026-05-04, KILL
Phase 2.1 — Corpus-expansion rerun                     [x] SHIPPED 2026-05-05, KILL × 2
Phase 3 — Multi-handle retrieval cutover               [-] DROPPED 2026-05-05 (this reframe)
Phase 4 — Angel reduction                              [ ] NEXT
Phase 5 — Density-based abstraction                    [-] DROPPED 2026-05-05 (this reframe)
Phase 6 — Crash-resilient episode boundary             [ ]
Phase 7 — v4 coexistence / migration / ship            [ ] (narrowed)
```

Phases 3 and 5 stay in ROADMAP.md marked DROPPED with a pointer to this document, rather than being removed from numbering. The kill is part of v5's history — making it visible in the roadmap diff is the parable applied.

## References

- Locked decision rule: `.planning/phases/02-multi-modal-index-seeds-density-check/02-CONTEXT.md` item 5
- Phase 2 results: `.planning/phases/02-multi-modal-index-seeds-density-check/02-RESULTS.md`, `02-results.json` (raw per-pair data preserved as primary evidence; aggregator is summary, not replacement)
- Phase 2.1 results: `.planning/phases/02.1-corpus-expansion-rerun/02.1-RESULTS.md`, `02.1-results.json`
- Aggregator: `.planning/aggregates/multi-handle.{md,json}` (3 bound experiences)
- Phase 2.1 plan-checker verdict: `.planning/phases/02.1-corpus-expansion-rerun/02.1-VERIFICATION.md` (PASS WITH NOTES)
- v5 framing: `.planning/research/2026-05-04-v5-bound-episodes-framing.md`
- v5 engineering substrate: `.planning/research/2026-04-30-v5-episodic-memory.md`
