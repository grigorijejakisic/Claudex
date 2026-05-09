# Deliberation-surfacing aggregator

**Question:** does verbatim transcript context surface deliberation-conditional engagement that summary-only context does not, at our scale?

**Bound experiences:** 3 (rebuilt from `.planning/aggregates/deliberation-surfacing.json` event log)

**Verdict mapping (P9 BindVerdict → aggregator):** POSITIVE → GREEN_LIGHT · NEGATIVE → KILL · INCONCLUSIVE → INCONCLUSIVE.

---

## Chronological table

| Phase | Date | Labeler | n | Δ pass rate | Δ CI lower | Δ CI upper | Verdict | Retrieval baseline |
|-------|------|---------|---|-------------|------------|------------|---------|---------------------|
| 9-r1 | 2026-05-09 | three_prong_rubric_deepseek_coder_v2_16b | 30 | 0.1333 | -0.0920 | 0.3799 | INCONCLUSIVE | bi_encoder_fallback |
| 9-r2 | 2026-05-09 | three_prong_rubric_deepseek_coder_v2_16b | 30 | 0.2000 | -0.0149 | 0.4456 | INCONCLUSIVE | bi_encoder_fallback |
| 9-pooled-r1+r2 | 2026-05-09 | three_prong_rubric_pooled | 60 | 0.1667 | 0.0038 | 0.3434 | GREEN_LIGHT | — |

(rows added at the bottom by future empirical phases; never modified.)

---

## Verdict-grouping summary

- GREEN_LIGHT: 1
- SCOPE_DOWN: 0
- KILL: 0
- BLOCKED: 0
- INCONCLUSIVE: 2

Total bound experiences: 3.

---

## Interpretive History

(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT additional_locks.)

(no interpretive history yet — this section is populated when phases close)
