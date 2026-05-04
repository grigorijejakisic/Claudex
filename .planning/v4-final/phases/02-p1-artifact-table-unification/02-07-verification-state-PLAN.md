---
plan_id: 02-07
phase: 2
wave: 3
depends_on:
  - 02-04
  - 02-05
  - 02-06
files_modified:
  - src/tests/core/migration/v17-naming-convention.test.ts
  - src/tests/core/migration/v17-computed-update.test.ts
  - .planning/STATE.md
  - .planning/phases/02-p1-artifact-table-unification/backup-manifest.md
autonomous: true
requirements:
  - STOR-01
  - STOR-04
  - STOR-08
---

# Plan 02-07: Verification (2 new Vitests + benchmark gate + state/manifest docs)

## Objective

Close out P1 with the CONTEXT caveat #8 + #9 deliverables: 2 new Vitests (naming lint + computed UPDATE regression), the benchmark gate run, and the `STATE.md` entry + manifest file.

## Must-haves (goal-backward)

- `artifact_kinds_naming.test.ts` exists and passes — asserts all `SELECT DISTINCT kind FROM artifact` match `/^[a-z][a-z0-9_]*$/`.
- `experience_pattern_computed_update.test.ts` exists and passes — regression test for the score-increment case.
- Full Vitest suite passes: **2020 pre-existing + new tests**, 100% green.
- LongMemEval Oracle ≥ 90% post-migration (regression must not drop below baseline).
- LoCoMo within 2pp of pre-P1 baseline.
- `.planning/STATE.md` entry added: "artifacts_old retained P1→P9 as migration backstop; do not drop."
- `backup-manifest.md` initialized with header; at least one real migration row appended.

## Tasks

<task id="07-01-01">
  <subject>Create src/tests/core/migration/v17-naming-convention.test.ts</subject>
  <description>
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { openTestDb } from '...'; // existing helper pointing at a migrated DB fixture

describe('V17 artifact kind naming convention', () => {
  it('every kind matches lowercase_snake_case_singular', () => {
    const db = openTestDb();
    const rows = db.prepare('SELECT DISTINCT kind FROM artifact').all() as { kind: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const { kind } of rows) {
      expect(kind).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('kind_registry is in sync with artifact kinds', () => {
    const db = openTestDb();
    const registered = db.prepare('SELECT kind FROM kind_registry').all().map(r => r.kind);
    const actual = db.prepare('SELECT DISTINCT kind FROM artifact').all().map(r => r.kind);
    expect(new Set(registered)).toEqual(new Set(actual));
  });
});
```

Fixture: uses an in-memory DB where Plan 02-04's `applyV17DDL` has been run and a representative row of each kind is inserted. Helper `openTestDb()` already exists in the test utilities (check `src/tests/helpers/` — if not, create minimal one).
  </description>
</task>

<task id="07-01-02">
  <subject>Create src/tests/core/migration/v17-computed-update.test.ts</subject>
  <description>
Regression test locking in the computed UPDATE behavior that generator relies on:

```ts
describe('V17 INSTEAD OF UPDATE — computed RHS via NEW.x', () => {
  it('propagates score + 2 correctly through view trigger', () => {
    const db = seedMigratedDb();
    db.prepare(`INSERT INTO experience_patterns(
      id, pattern_type, trigger_context, lesson, source_project, created_at_epoch, score
    ) VALUES ('p1', 'correction', 'ctx', 'lesson', 'proj', 0, 5)`).run();

    db.prepare("UPDATE experience_patterns SET score = score + 2 WHERE id = 'p1'").run();

    const { score } = db.prepare(
      "SELECT json_extract(data, '$.score') AS score FROM artifact WHERE id = 'p1'"
    ).get() as { score: number };
    expect(score).toBe(7);
  });

  it('propagates string concat on root_cause correctly', () => {
    const db = seedMigratedDb();
    db.prepare(`INSERT INTO experience_patterns(...) VALUES (...)`).run();
    db.prepare("UPDATE experience_patterns SET root_cause = COALESCE(root_cause, '') || ' new' WHERE id = 'p2'").run();
    const { rc } = db.prepare("SELECT json_extract(data, '$.root_cause') AS rc FROM artifact WHERE id = 'p2'").get();
    expect(rc.trim()).toBe('new');
  });
});
```

If either test FAILS post-Plan 02-04, that's the signal to use the fallback trigger emission strategy from Plan 02-04 task 04-01-02 (hand-written trigger variants for the 4 computed columns). Escalate to orchestrator if reached.
  </description>
</task>

<task id="07-01-03">
  <subject>Run full test suite and benchmark gates</subject>
  <description>
Sequence:

1. `bun run build` — must succeed.
2. `bun run test` — all 2020 existing + new tests green. Allowed failures: zero.
3. Benchmark: `bun run bench:longmemeval` (or whatever the harness CLI is in `src/benchmark/longmemeval-harness.ts`) — record Oracle score. Must be ≥ 90% (baseline 90.6% per CLAUDE.md).
4. Benchmark: `bun run bench:locomo` — record score. Must be within 2pp of the current baseline (55.5% per CLAUDE.md, so ≥ 53.5%).

Record results in this task's completion note and in `backup-manifest.md`.

**Benchmark gate treatment of 3 spec'd deltas (CONTEXT §specifics) + 4th (Amendment 4):**
- The 3 original deltas (stale flag flip, legacy integer ids → UUID, session_id=NULL for some rows) and the 4th (FTS5 retirement) are SPEC'D CHANGES, not failures. If Oracle or LoCoMo drop due to exactly these, they are still within gate. Investigate only if drop magnitude suggests a different cause (e.g., vec0 recall rot from composeBody drift).
- Benchmark harnesses go through `hybrid-retrieval.ts` → `artifact_fts` + `artifacts_fts`. Spec'd deltas should be retrieval-neutral on `artifact_fts` side since title+body preserve content.

If LoCoMo drops >2pp:
- First check: do embeddings in `artifact_embeddings` match the `composed(title + " " + body)` text? (If composeBody changed between Phase A staging and the actual artifact row insert, embeddings are wrong.)
- Second check: is `artifact_fts` backfilled? (Sync triggers only fire on new INSERTs — post-migration backfill required via `INSERT INTO artifact_fts(rowid, title, body) SELECT rowid, title, body FROM artifact;` — verify Plan 02-04 task 04-01-01 includes this backfill).
  </description>
</task>

<task id="07-01-04">
  <subject>Append STATE.md entry</subject>
  <description>
Add to `.planning/STATE.md` (append under the latest phase section, or create a "Phase 2 completion notes" section if structure demands):

```md
### Phase 2 (P1) completion notes — 2026-04-20

- **6 legacy tables renamed to `{name}_old` and retained as migration backstop.** Specifically: `learnings_old`, `decisions_old`, `experience_patterns_old`, `angel_opinions_old`, `critical_rules_old`, `project_curated_context_old`. Do NOT drop before P9.
- `legacy_id_map(legacy_table, legacy_id, new_uuid)` retained through P1→P9 for view ↔ caller id translation. Do NOT drop before P9.
- `artifacts` table, `artifacts_fts`, `vec_artifacts`, `artifact_links` all untouched by P1 (Amendment 1). Entity_summary migration deferred to P5/P9.
- Retired in P1: `learnings_fts`, `experience_patterns_fts`. Replaced by `artifact_fts` (content='artifact', indexing title+body).
- Schema version: 17 (bumped from 16).
- Benchmark post-migration: LongMemEval Oracle = {N}%; LoCoMo = {N}%. (Recorded 2026-04-20.)
```

(Executor fills in the {N}% values from actual benchmark output.)
  </description>
</task>

<task id="07-01-05">
  <subject>Initialize backup-manifest.md + append first production row</subject>
  <description>
Create `.planning/phases/02-p1-artifact-table-unification/backup-manifest.md` if not yet created by Plan 02-02's `appendManifestRow`. Header:

```md
# P1 Backup Manifest

Audit trail for `~/.claudex/backups/pre-v4-P1-*.db` files. `.db` binaries are gitignored; this file is git-tracked.

| timestamp | path | size_bytes | sha256 | integrity | quick | parity | vec0 | total_ms | verdict |
|---|---|---|---|---|---|---|---|---|---|
```

After the actual P1 apply run in Plan 02-05, a row is appended automatically. This task verifies the append happened and the file is git-committable.
  </description>
</task>

<task id="07-01-06">
  <subject>Final verification — CONTEXT success criteria checklist</subject>
  <description>
Check each of the 6 ROADMAP §Phase 2 success criteria against the actual migrated DB:

1. **V17 migration creates `artifact` table with free-form `kind` column and `kind_registry`.** Verify: `sqlite_master` has both tables; `artifact.kind` has no CHECK.
2. **All rows from 6 legacy tables migrated inside a single transaction.** Verify via `SELECT COUNT(*) FROM learnings_old` vs `SELECT COUNT(*) FROM artifact WHERE kind='learning'` for each table. Must match.
3. **Legacy table names preserved as SQL views with unchanged shape; identical SELECT data.** Verify shape: `pragma_table_info(learnings)` returns v3 column list. Verify data: `SELECT * FROM learnings ORDER BY id` vs `SELECT ... FROM learnings_old ORDER BY id` — row-by-row equality (modulo the 4 spec'd deltas).
4. **Stale `project_curated_context` rows flagged `status='stale'` via keyword scan.** Verify: any artifact with kind='mental_model' whose body contains one of the 3 keywords has status='stale'.
5. **DB backup at `~/.claudex/backups/pre-v4-P1-{ts}.db` verified restorable before migration runs.** Verify: `backup-manifest.md` has at least one PASS row for the real P1 apply run.
6. **All 2020 Vitest tests pass; LongMemEval Oracle ≥90%; LoCoMo within 2pp of baseline.** Verify via test output + benchmark output.

If any criterion fails, escalate to orchestrator. Do NOT claim P1 done until all 6 are PASS.

Write the checklist results into a section at the bottom of this plan file (as task completion evidence).
  </description>
</task>

## Verification

- All new Vitests green.
- Full suite green (2020+).
- Both benchmarks within gate.
- STATE.md updated.
- Manifest file has PASS row.
- All 6 ROADMAP success criteria checked.

## Quality gate

- [ ] No test is skipped with `.skip` or `todo`.
- [ ] Benchmark gates run against the MIGRATED DB, not pre-migration fixture.
- [ ] Success criteria #6 actually runs the benchmarks and records numbers (no estimation).
- [ ] STATE.md entry is specific enough that a future agent reading it does NOT drop `{name}_old` or `legacy_id_map` prematurely.
- [ ] CONTEXT-AMENDMENT.md is left in place (git-tracked) as decision-audit record.
