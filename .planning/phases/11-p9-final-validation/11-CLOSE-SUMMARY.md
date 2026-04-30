# Phase 11 Close Summary — v4 Final Validation, v4.0.0 Tagged

**Closed:** 2026-04-30
**Plans:** 7 (11-01 through 11-07)
**Requirements addressed:** SC#1-#4 verified; STOR-04 closed (DROP via V24)

## What shipped

**v4.0.0** — internal-infrastructure release of Claudex.

## Validation summary

See [11-V4-VALIDATION.md](./11-V4-VALIDATION.md) for the full SC roll-up.

- **SC#1 (Vesna behavioral):** PASS at 100% aggregate, 100% every non-empty category. 17/17 probes; cross-encoder reranker on port 7439 (CUDA) healthy at run time.
- **SC#2 (token + cache-stable):** PASS — gsd-active-start 191/500 tokens (matches Phase 8.5 baseline exactly), all 4 scenarios byte-identical and volatile-state-invariant across 3 layers.
- **SC#3 (MEMORY.md quality):** PASS — every active project ≥80%; aggregate 90 across 6 projects (claudex-v3 80, lacuna 100, oracle 100, big-mozzy-v2 80, desktop-01dcc792 100, nexus-e53c6c93 80).
- **SC#4 (handoff pickup):** PASS via Vesna synthetic counterpart 3/3 = 100%; 3 live cold-start trials authored with pre-committed prompts but HITL-pending (no executor fabrication; operator-runnable).

## Vibe-check (archival, non-gating)

- LongMemEval Oracle: 89.6% archival cite (vs 90.6% baseline, -1.0pp — within drift)
- LoCoMo: 55.5% archival cite (no fresh run; no Phase 9-10 pressure on harness path)
- Per CONTEXT.md axiom: benchmarks document, do not gate.

## Ancillary closures

- **STOR-04**: Legacy `*_old` tables dropped via V24 migration after zero-caller audit. 6 tables / 1052 rows removed; live DB stamped at user_version=24; 378MB DB backup at `~/.claudex/backups/pre-v4-phase-11-drop-old-20260430-181007.db`.
- **v4.1 Distribution stub**: `.planning/v4.1-distribution/STUB.md` committed; carries forward open REQUIREMENTS.md items + Phase 11-specific deferrals (live SC#4 trials, per-project Vesna re-runs, Lessons reach for big-mozzy/claudex-v3, ACTIVE.md `phase:` placeholders, full benchmark archival re-run).

## What's next

v4.1 = Distribution. Stub at `.planning/v4.1-distribution/STUB.md`. Run `/gsd:new-milestone` to start the next cycle.

## Behavioral discipline (the why, restated)

The audit's diagnosis was "green numbers feel like progress while artifacts regress." v4 corrected by replacing benchmark gates with behavioral (SC#1) + structural (SC#2) + content-quality (SC#3) + continuity (SC#4) gates. **Phase 11 is the moment that corrective went live.**

In particular, the SC#3 gate caught real drift on the first measurement (1/4 measurable PASS, 2/6 unregistered slugs); the team-lead's "no goalpost shift" directive held; the corrective work closed the drift at the source (legacy ACTIVE.md migration + scorer correctness alignment with Phase 4.1's design intent + slug registry registration); and the gate then legitimately PASSED at 90 aggregate / 6 of 6 projects ≥80. That sequence is the audit's whole point demonstrated end-to-end.

Future milestones should not relapse into benchmark gating.

## Atomic commits

- 79cee63 — phase(11-01): SC#3 mechanical scorer + 5-project run — PASS 90% aggregate
- 60d56e2 — phase(11-02,11-03): SC#2 PASS + SC#4 synthetic PASS / live HITL-pending
- f389521 — phase(11-04): SC#1 Vesna full-suite PASS — 17/17 aggregate, 100% per category
- d49b926 — phase(11-05): STOR-04 closed — V24 drops legacy `_old` tables (zero callers)
- 85c6a81 — phase(11-06): benchmark vibe-check accepted via archival cite (non-gating)
- (this commit) — phase(11): close — v4 SHIPPED + v4.0.0 tag
