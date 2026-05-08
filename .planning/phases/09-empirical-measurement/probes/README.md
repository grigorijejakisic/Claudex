# P9 Drift-Detection Probes — Directory Contract

This directory holds the locked probe-set for P9's empirical binding measurement of deliberation-surfacing.

## Naming Convention

`drift-{kind}-{NN}.json` with `kind ∈ {a, b, c, d, e}` and `NN ∈ {01, 02, 03, 04, 05, 06}`.

Total: exactly 5 kinds × 6 fixtures = **30 probes**. Tests at `src/tests/benchmark/deliberation-surfacing/probe-schema.test.ts` enforce this distribution at runtime.

## Drift Taxonomy (CONTEXT decision 1)

| Kind | What shifts |
|------|-------------|
| a | Sample-size shift (past at n=N; current corpus 10× larger) |
| b | Threshold-source drift (threshold T picked under specific reasoning; reasoning still valid?) |
| c | Scope-change drift (past decision applied within narrow scope; scope expanded) |
| d | Dependency-change drift (lib X v2 → v3; reasoning holds?) |
| e | Assumption drift (assumed Y; current shows Y no longer true) |

## Real / Synthetic Ratio

- **≥70% real per kind** (≥4 of 6) — fixtures drawn from claudex-v3 deliberation history.
- **≤30% synthetic per kind** (≤2 of 6) — for kinds where real fixture density is thin (typically c and d).

Per-kind realized counts in this fixture set:

| Kind | Real | Synthetic |
|------|------|-----------|
| a | 6 | 0 |
| b | 5 | 1 |
| c | 4 | 2 |
| d | 4 | 2 |
| e | 6 | 0 |

## Schema

Every probe JSON validates against `src/benchmark/deliberation-surfacing/probe-schema.ts` via Zod. Required fields:

- `id` — `drift-{kind}-{NN}` (regex-bound).
- `kind` — `a` | `b` | `c` | `d` | `e`.
- `source` — `real` | `synthetic`.
- `prompt` — agent-facing query that triggers retrieval of the past decision.
- `past_artifact_ref` — array of artifact IDs the summary-only baseline retrieves.
- `transcript_anchor` — `{ session_id, turn_index_range: [lo, hi], description }`.
- `condition_shift` — `{ past_state, current_state, delta }`.
- `pass_criterion` — explicit rubric trigger for prong 1 (surfaces-divergence) of the LLM-as-judge.

Malformed fixtures throw at load time; the harness uses `loadAllProbes()` which calls `ProbeSchema.parse` on every file.

## Synthetic-Transcripts Subdirectory

`synthetic-transcripts/*.jsonl` holds author-committed deliberation transcripts for the synthetic fixtures (kinds c-05, c-06, d-05, d-06 — 4 files total). Each JSONL uses the conversation format `{type, message: {role, content}}`. Plan 09-04 ingests these into `transcript_chunk_v6` with deterministic synthetic `session_id` values (`synthetic-drift-{kind}-{NN}`) so B-arm retrieval can locate the synthetic fixtures' anchors.

## Immutability Discipline

Once committed, fixtures are byte-frozen for P9 binding replications. CONTEXT additional_locks: "the fixture set is immutable for P9. Replication 3 corpus-expansion (if INCONCLUSIVE) commits NEW fixtures under the same directory; original 30 remain bytewise unchanged."

Naming convention for P9.1 corpus-expansion: `drift-{kind}-{07+}.json` to avoid renumbering.

## Pre-Commitment Audit Anchor

This directory's first commit timestamp + the 09-CONTEXT.md commit (00ab2bb) jointly form the methodology-gate audit anchor. Every row appended to `.planning/aggregates/deliberation-surfacing.json` must have `started_at_iso` strictly greater than these anchor commits. The runner emits ISO timestamps from `new Date().toISOString()` at run time so the strict-greater-than relation is enforceable post-hoc.
