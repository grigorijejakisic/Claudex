# Phase 10 Close Summary — Vesna Probe Suite as Central Validation

**Status:** Closed 2026-04-30
**Plans shipped:** 5 (10-01 through 10-05)
**Requirements satisfied:** VESN-01, VESN-02, VESN-04
**Requirements deferred:** VESN-03 (Phase 11 runs the gate)

## Corpus Distribution

| Category | Count | Probe IDs |
|---|---|---|
| entity-recall | 3 | entity-001/002/003 |
| constraint-recall | 3 | constraint-001/002/003 |
| handoff-pickup | 3 | handoff-001/002/003 |
| cross-project | 3 | cross-project-001/002/003 |
| lesson-application | 3 | lesson-application-001/002/003 |
| self-instrumented | 2 | self-instrumented-001/002 |
| buffer (unallocated) | 3 | buffer-001/002/003 |
| **Total** | **20** |  |

Matches CONTEXT.md lock (lines 76-85): 17 core + 3 buffer = 20.

## First Full-Suite Result (phase-close run)

```
bun run vesna --json
exit 0

aggregate_pass_rate: 100%
gated:               true
flaky_probes:        0
failed_probes:       0

Per-category:
  entity-recall:    3/3 (100%)
  constraint-recall:3/3 (100%)
  handoff-pickup:   3/3 (100%)
  cross-project:    3/3 (100%)
  lesson-application:3/3 (100%)
  self-instrumented:2/2 (100%)
  buffer:           0/0 (excluded — slots, not probes)
```

This is the first end-to-end run after authoring. No probes are tagged
flaky in the v4 corpus; trial determinism holds across 3-trial majority.

## Schema (canonical, src/benchmark/vesna/types.ts)

```ts
export type ProbeCategory =
  | 'entity-recall' | 'constraint-recall' | 'handoff-pickup'
  | 'cross-project' | 'lesson-application' | 'self-instrumented' | 'buffer';

export interface Probe {
  id: string;
  category: ProbeCategory;
  source_session_id: string;
  source_project: string;
  source_turn_idx?: number;
  scenario: string;
  user_prompt: string;
  expected_recall: {
    artifact_id_or_pattern: string;
    must_surface_within_turns: number;
    must_contain_phrase_pattern: string[];
  };
  lexical_exclusions: string[];
  evaluation: 'auto' | 'semi-auto';
  setup_steps?: SetupStep[];
  buffer_placeholder?: boolean;
}
```

## Harness Architecture

- **Loader** (`src/benchmark/vesna/loader.ts`) — schema validation +
  load-time `LexicalLeakageError` pre-flight (Phase 6.5 lock)
- **Setup-step DSL** (`src/benchmark/vesna/setup.ts`) — 4 step kinds
  (artifact / handoff / critical_rule / narration_directive); test DB at
  `~/.claudex/db/claudex-vesna-test.db` (override via `CLAUDEX_VESNA_DB`);
  fixture files under `os.tmpdir()/claudex-vesna-fixtures/`
- **Evaluator** (`src/benchmark/vesna/evaluator.ts`) — pattern-match +
  turn-budget; AND-semantics across regex array (use alternation for OR)
- **Runner** (`src/benchmark/vesna/runner.ts`) — three-trial majority;
  agent_text composed from production retrieval surface (FTS5 sync hybrid
  + critical_rules + handoff render + narration directive); flaky verdict
  for 1/3 or 2/3
- **Index** (`src/benchmark/vesna/index.ts`) — orchestrator; gate =
  aggregate ≥80% AND every non-empty non-buffer category ≥80%; empty
  categories exempt; flaky excluded from denominator
- **CLI** (`src/benchmark/vesna/cli.ts`) — `bun run vesna`; flags
  `--probes-dir`, `--trials`, `--strict`, `--json`; exit 0 iff gated

Production DB untouched: harness opens only the isolated Vesna test DB.
Setup writes are session-tagged so untagged ambient rows survive
`resetTestDb` between probes.

## CI

- **Workflow:** `.github/workflows/vesna.yml`
- **Trigger:** every PR against `master` + push to `master`
- **Gate:** aggregate ≥80% AND every non-empty category ≥80%
- **Reranker:** BGE-reranker port 7439 unavailable in CI — harness uses
  the synchronous retrieval surface (FTS5 + recency channels) which does
  not require the cross-encoder; lexical-exclusion rigor + bi-encoder
  cosine cover perceptual recall for the v4 corpus
- **Timeout:** 30 minutes (with 20 probes × 3 trials, well under that)
- **Concurrency:** superseded PR runs cancel in flight
- **Step summary:** per-category pass-rate table + failed probe list
- **Artifact upload:** `vesna-report.json` retained for 30 days

**Follow-up:** GitHub branch protection rule to make Vesna a required
status check is a manual repo-admin GitHub UI step; not Claude-automatable.
Documented here, owned by user.

## Hand-forward to Downstream Phases

- **Phase 6.5** — 3 cross-project probes already shipped
  (`cross-project-001/002/003`). If 6.5 wants its own canonical probe,
  claim a buffer slot.
- **Phase 8.5** — 2 self-instrumented probes already shipped
  (`self-instrumented-001/002`), migrated to canonical schema in Plan 10-02.
- **Phase 11** — runs the full 20-probe suite as SC#1 final validation.
- **Future phases authoring own probes** — follow `src/benchmark/vesna/README.md`.
  Encouraged, not enforced (CONTEXT.md line 174).

## Behavioral Discipline (the why)

Vesna is BEHAVIORAL, not benchmark. Every probe traces to a real retrieval
moment in real session history (or a documented design moment for probes
mined from phase work itself, e.g., `phase-7.5-design`,
`phase-8.5-design`). The "perceptual not lexical" rigor (lexical_exclusions
enforced at load time) means probes test memory, not keyword search. Per
CONTEXT axiom: "Behavioral validation is a first-class deliverable.
Benchmarks were dropped because green numbers feel like progress while
artifacts regress."

## Atomic Commits

- 10-01: vesna harness core — schema + loader + runner + CLI
- 10-02: migrate 5 probes to canonical schema + 3 buffer slots
- 10-03: 6 new probes — 3 entity-recall + 3 constraint-recall
- 10-04: 6 new probes — 3 cross-project + 3 lesson-application
- 10-05 (this commit): CI workflow + authoring README + phase close

## Known Caveats

- **CI runs in synchronous-retrieval mode** (FTS5 + recency). The
  cross-encoder reranker (BGE-v2-m3 on port 7439) is unavailable in CI.
  v4 acceptable trade-off; revisit if cross-encoder access in CI becomes
  feasible.
- **Branch protection** is a manual follow-up (GitHub UI; user-owned).
- **Probes are static.** Auto-mining from telemetry is deferred per
  CONTEXT.md line 224.
- **Pattern-match evaluator only.** LLM-judge deferred per CONTEXT.md
  line 220.

## File Manifest

```
src/benchmark/vesna/
├── README.md                    (authoring guide)
├── types.ts                     (canonical schema)
├── loader.ts                    (load-time validation + lexical pre-flight)
├── setup.ts                     (setup-step DSL + test DB isolation)
├── evaluator.ts                 (pattern-match + turn-budget)
├── runner.ts                    (3-trial majority, agent_text composer)
├── index.ts                     (suite orchestrator + gate)
├── cli.ts                       (bun run vesna entry)
└── probes/                      (20 probes total)
    ├── entity-001.json ... entity-003.json
    ├── constraint-001.json ... constraint-003.json
    ├── handoff-001.json ... handoff-003.json     (named handoff-pickup-*.json on disk)
    ├── cross-project-001.json ... cross-project-003.json
    ├── lesson-application-001.json ... lesson-application-003.json
    ├── self-instrumented-001/002 (named recall-observability-*.json on disk)
    └── buffer-001.json ... buffer-003.json

src/tests/unit/
├── vesna-loader.test.ts         (7 tests)
├── vesna-evaluator.test.ts      (6 tests)
└── vesna-setup.test.ts          (9 tests, isolation + idempotency + production safety)

.github/workflows/vesna.yml      (PR gate)
package.json                     (scripts.vesna)
build.ts                         (cli.ts in optional entry points)
```
