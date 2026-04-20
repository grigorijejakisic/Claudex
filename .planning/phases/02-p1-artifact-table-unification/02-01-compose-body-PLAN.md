---
plan_id: 02-01
phase: 2
wave: 1
depends_on: []
files_modified:
  - src/core/migration/v17-compose.ts
  - src/core/migration/kind-mapping.ts
  - src/tests/core/migration/v17-compose.test.ts
autonomous: true
requirements:
  - STOR-01
  - STOR-02
---

# Plan 02-01: composeBody + KIND_MAPPING (shared migration substrate)

## Objective

Implement the single `composeBody(kind, legacyRow)` function and its backing `KIND_MAPPING` table. Both the Phase A pre-embed staging and the Phase B atomic INSERT code paths MUST use this function. Drift between them causes silent vec0 recall rot.

## Must-haves (goal-backward)

- `composeBody(kind, legacyRow) → { title, body, data, scope, status, confidence, session_id, project_id }` exists and is deterministic.
- `KIND_MAPPING` exports a structure usable by the trigger generator (Plan 02-04).
- Unit tests cover all 6 kinds (`learning`, `decision`, `experience_pattern`, `angel_opinion`, `critical_rule`, `mental_model`) — one positive case per kind, one null-handling case per kind.
- All unit tests pass.

## Tasks

<task id="01-01-01">
  <subject>Create src/core/migration/kind-mapping.ts</subject>
  <description>
Export `KIND_MAPPING: Record<LegacyTable, KindMapping>` following the per-kind table in 02-RESEARCH.md §2.1. Each mapping declares:
- `kind: string`
- `legacyTable: string`
- `kernelMap: { [kernelCol]: string | ((row) => unknown) }` — how each `artifact` kernel column is filled from the legacy row
- `dataKeys: string[]` — which legacy columns flow into `data` JSON
- `titleExpr: (row) => string | null`
- `bodyExpr: (row) => string`
- `scope: 'session' | 'project' | 'universal'` (all current mappings: `'project'`)
- `confidenceExpr: (row) => number | null`

Use the authoritative body-mapping table in 02-RESEARCH.md §2.1 and 02-CONTEXT-AMENDMENT.md §1 — DO NOT re-derive. Include the `mental_model` entry storing `_legacy_supersedes_id` in `data` for Pass 2 resolution (per Amendment 2).
  </description>
</task>

<task id="01-01-02">
  <subject>Create src/core/migration/v17-compose.ts</subject>
  <description>
Export:

```ts
export type ArtifactKind = 'learning' | 'decision' | 'experience_pattern' | 'angel_opinion' | 'critical_rule' | 'mental_model';

export interface Composed {
  title: string | null;
  body: string;
  data: Record<string, unknown>;
  scope: 'session' | 'project' | 'universal';
  status: 'active' | 'stale' | 'archived' | 'superseded';
  confidence: number | null;
  session_id: string | null;
  project_id: string | null;
}

export function composeBody(kind: ArtifactKind, row: Record<string, unknown>): Composed;
```

Implementation: look up `KIND_MAPPING[kind]`, apply each mapper. For `experience_pattern` body: `row.lesson + (row.anti_pattern ? "\n\nWhat went wrong: " + row.anti_pattern : "")`. For `mental_model` body: `row.content` (unchanged). Title expressions per 02-RESEARCH.md §2.1 table.

Status defaults to `'active'` except where a legacy row carries one (`mental_model` only).

For `mental_model`, store the integer `supersedes_id` in `data._legacy_supersedes_id` so Pass 2 can resolve it via `legacy_id_map`.

Do NOT write embedding — embedding generation is separate (Plan 02-05).
  </description>
</task>

<task id="01-01-03">
  <subject>Create unit tests at src/tests/core/migration/v17-compose.test.ts</subject>
  <description>
Vitest file covering:

- For each of 6 kinds, one positive test with a fully-populated legacy row → assert exact `{title, body, data, scope, status, confidence, session_id, project_id}` output.
- For each of 6 kinds, a null/missing-field test: legacy row with minimum required fields → assert no throw, correct defaults.
- `experience_pattern` with `anti_pattern: null` → body is just `lesson` (no `"\n\nWhat went wrong: "` suffix).
- `mental_model` with `supersedes_id: 42` → `data._legacy_supersedes_id === 42`.
- `mental_model` with `supersedes_id: null` → `data._legacy_supersedes_id` absent (not explicitly null).
- `critical_rule` with `rule_text` length > 80 → `title.length === 80`.
- `angel_opinion` → title matches `subject + ' — opinion'` pattern.

Total ~14 cases. Use fixture rows that look like real legacy schema shape — pull column names from `src/core/schema.ts`.
  </description>
</task>

<task id="01-01-04">
  <subject>Run bun run test -- v17-compose and bun run build</subject>
  <description>
Verify all new tests pass and `bun run build` completes without TS errors. Fix anything the compiler flags (exported types, import paths).
  </description>
</task>

## Verification

- `bun run test -- v17-compose` → all 14+ cases green.
- `bun run build` → no TS errors.
- Export shape from `v17-compose.ts` matches the signature consumed by Plan 02-04 (trigger generator) and Plan 02-05 (migration runner). Verified by dependent plans compiling clean.

## Quality gate

- [ ] `composeBody` is pure (no DB access, no filesystem, no clock reads).
- [ ] `KIND_MAPPING` has an entry for all 6 kinds (no entity_summary, per Amendment 1).
- [ ] Tests assert on exact structural output, not just smoke-level "doesn't throw".
- [ ] No runtime dependency on `better-sqlite3` — this module is usable in a worker thread.
