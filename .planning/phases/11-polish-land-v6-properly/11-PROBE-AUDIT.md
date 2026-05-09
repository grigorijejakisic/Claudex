# P9 Probes — Parametric-Knowledge Confound Audit

**Audit date:** 2026-05-09
**Reference:** Gemini Harness Finding #5; 11-CONTEXT.md § Implementation Decisions § W2 (Q3) — descriptive, no rewrite.
**Probes audited:** 30
**Probes directory:** `.planning/phases/09-empirical-measurement/probes/`

## Heuristic

- **parametric-likely**: probe text mentions ≥ 2 markers from a list of widely-known frontier-LLM-training-data terms (popular frameworks, protocols, OS/cloud providers, canonical algorithms) AND zero project-internal markers.
- **parametric-unlikely**: probe text mentions ≥ 2 project-internal markers (claudex / vesna / V32 schema / Phase X / KILL/BIND verdicts / kind-a..e drift taxonomy) AND zero parametric markers.
- **mixed**: probe blends both, or neither score reaches the threshold.

_The heuristic is visible-not-perfect. False positives / negatives are acceptable — the output is methodology footnote, not measurement input._

## Summary by P9 kind

| Kind | parametric-likely | parametric-unlikely | mixed | total |
|------|-------------------|---------------------|-------|-------|
| a | 0 | 4 | 2 | 6 |
| b | 0 | 5 | 1 | 6 |
| c | 0 | 6 | 0 | 6 |
| d | 0 | 4 | 2 | 6 |
| e | 0 | 6 | 0 | 6 |

## Per-probe classification

| Probe ID | P9 kind | Classification | Param markers | Internal markers |
|----------|---------|----------------|---------------|------------------|
| drift-a-01 | a | mixed | 1 | 5 |
| drift-a-02 | a | mixed | 1 | 5 |
| drift-a-03 | a | parametric-unlikely | 0 | 3 |
| drift-a-04 | a | parametric-unlikely | 0 | 4 |
| drift-a-05 | a | parametric-unlikely | 0 | 5 |
| drift-a-06 | a | parametric-unlikely | 0 | 3 |
| drift-b-01 | b | mixed | 1 | 3 |
| drift-b-02 | b | parametric-unlikely | 0 | 5 |
| drift-b-03 | b | parametric-unlikely | 0 | 3 |
| drift-b-04 | b | parametric-unlikely | 0 | 3 |
| drift-b-05 | b | parametric-unlikely | 0 | 3 |
| drift-b-06 | b | parametric-unlikely | 0 | 3 |
| drift-c-01 | c | parametric-unlikely | 0 | 4 |
| drift-c-02 | c | parametric-unlikely | 0 | 3 |
| drift-c-03 | c | parametric-unlikely | 0 | 3 |
| drift-c-04 | c | parametric-unlikely | 0 | 5 |
| drift-c-05 | c | parametric-unlikely | 0 | 2 |
| drift-c-06 | c | parametric-unlikely | 0 | 2 |
| drift-d-01 | d | parametric-unlikely | 0 | 5 |
| drift-d-02 | d | parametric-unlikely | 0 | 4 |
| drift-d-03 | d | mixed | 1 | 4 |
| drift-d-04 | d | parametric-unlikely | 0 | 3 |
| drift-d-05 | d | parametric-unlikely | 0 | 2 |
| drift-d-06 | d | mixed | 1 | 2 |
| drift-e-01 | e | parametric-unlikely | 0 | 3 |
| drift-e-02 | e | parametric-unlikely | 0 | 2 |
| drift-e-03 | e | parametric-unlikely | 0 | 3 |
| drift-e-04 | e | parametric-unlikely | 0 | 3 |
| drift-e-05 | e | parametric-unlikely | 0 | 3 |
| drift-e-06 | e | parametric-unlikely | 0 | 3 |

## Interpretation

Per 11-CONTEXT.md § Implementation Decisions § W2 (Q3), the original 30 probes remain byte-immutable for Q1 paired-McNemar. This audit is a methodology footnote, not a fixture rewrite:

- **If Q1 + Q2 both bind (W3 outcome A):** the parametric-likely classifications listed above are documented context; the rebind is methodology-clean by Q2 design (the 60-probe disjoint pool authored in Plan 11-07 structurally avoids the parametric-knowledge confound).
- **If Q1 binds but Q2 doesn't (W3 outcome B):** the parametric-likely classifications above may be cited as one possible explanation in the kill receipt — the original-probe-set bind was probe-set-specific artifact rather than substrate value.
- **If Q1 doesn't bind (W3 outcome C):** Q2/Q3 are skipped per the conditional outcomes table. The audit becomes part of the kill receipt narrative.

_Q2 (Plan 11-07) authors a fresh 60-probe disjoint pool with parametric-knowledge confound structurally avoided by design — that's where methodology-clean rebind happens._
