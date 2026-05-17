# Multi-handle aggregator

**Question:** does multi-handle retrieval (semantic + non-semantic) improve recall over semantic-only at our scale?

**Bound experiences:** 2 (rebuilt from `.planning/aggregates/multi-handle.json` event log)

---

## Chronological table

| Phase | Date | Labeler | n | Δp@5 (Wilson CI) | Δr@10 (Wilson CI) | latency p99 ratio | intra-project share | Verdict | Conditions |
|-------|------|---------|---|------------------|-------------------|-------------------|---------------------|---------|------------|
| 2.1-strict | 1970-01-01 | strict_3frame | 60 | 0.0667 [-0.0968, 0.2353] | 0.0333 [-0.0874, 0.1534] | 0.9683 | 0.0000 | KILL | see results files |
| 2.1-relaxed | 1970-01-01 | relaxed_2frame | 60 | 0.0667 [-0.0968, 0.2353] | 0.0333 [-0.0874, 0.1534] | 2.6019 | 0.0000 | KILL | see results files |

(rows added at the bottom by future empirical phases; never modified.)

---

## Verdict-grouping summary

- GREEN_LIGHT: 0
- SCOPE_DOWN: 0
- KILL: 2
- BLOCKED: 0

Total bound experiences: 2.

---

## Interpretive History

(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)

### 1970-01-01 — phase 2.1 close

At phase 2.1 close, the aggregator contains 2 bound experiences (2 KILL). Phase 2.1 contributed: 2.1-strict=KILL, 2.1-relaxed=KILL. Density at this evidence level is consistent failure across conditions. More measurements may be needed before any milestone-level claim is warranted; emerging density of consistent KILL is much stronger evidence to escalate at milestone level than any single measurement.


(Each phase that closes prepends a new dated section. Prior content is preserved byte-identical per CONTEXT.md decision 4c rule 3.)

### 2026-05-05 — phase 2.1 close

At phase 2.1 close, the aggregator contains 3 bound experiences (3 KILL). Phase 2.1 contributed: 2.1-strict=KILL, 2.1-relaxed=KILL. Density at this evidence level is consistent failure across conditions. More measurements may be needed before any milestone-level claim is warranted; emerging density of consistent KILL is much stronger evidence to escalate at milestone level than any single measurement.
