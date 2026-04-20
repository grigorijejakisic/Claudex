---
plan_id: 02-05
phase: 2
wave: 2
depends_on:
  - 02-01
  - 02-02
  - 02-03
  - 02-04
files_modified:
  - src/core/migration/v17-runner.ts
  - src/core/migration/v17-embed-stage.ts
  - src/cli/migrate.ts
  - src/tests/core/migration/v17-runner.test.ts
autonomous: true
requirements:
  - STOR-01
  - STOR-02
  - STOR-03
  - STOR-04
  - STOR-05
  - STOR-08
---

# Plan 02-05: Migration runner (Phase A pre-embed + Phase B atomic tx)

## Objective

Wire the atomic V16→V17 migration. Two CLI entry points: `migrate:v17:dry-run` (Phase A only, no mutation) and `migrate:v17:apply` (Phase A + Phase B atomic tx). Backup-gated, stale-review-gated, validation-gated.

## Must-haves (goal-backward)

- Phase A: reads legacy rows, composes title/body via `composeBody`, calls Ollama arctic-embed2 batched, stages embeddings.
- Phase B: single BEGIN/COMMIT tx that creates V17 schema, renames legacy tables, inserts into `artifact`, links embeddings via `embedding_ref`, creates views + triggers, flags stale rows, runs validation pass. ROLLBACK on any error.
- Pre-flight: backup verifier MUST pass (Plan 02-02); abort on FAIL.
- Pre-flight: `stale-review.md` MUST exist and parse cleanly (Plan 02-03); abort otherwise.
- Post-migration validation: per-kind required-paths SQL check (CONTEXT caveat #6); ROLLBACK on any malformed row.

## Tasks

<task id="05-01-01">
  <subject>Implement src/core/migration/v17-embed-stage.ts</subject>
  <description>
Export:

```ts
export interface StagedRow {
  legacyTable: string;
  legacyId: number | string;          // int for most; UUID for experience_patterns
  kind: ArtifactKind;
  composed: Composed;                  // from composeBody
  embedding: Buffer;                   // 1024 * 4 = 4096 bytes
}

export async function stageEmbeddings(
  db: Database,
  opts: { batchSize?: number }        // default 32
): Promise<StagedRow[]>;
```

Implementation:
1. For each of 6 legacy tables, `SELECT * FROM {tbl}` — iterate all rows.
2. For each row: `composed = composeBody(kind, row)`.
3. Batch-embed via Ollama `/api/embed` (arctic-embed2, 1024d, batch=32). Reuse existing Ollama client from `src/embeddings/`.
4. Pack float32 embedding into Buffer.
5. Yield `StagedRow`.

**Staging persistence:** keep staged rows in-memory as an array. Rows are small (kernel fields + 4KB embedding each). For 10^4 rows per table × 6 tables = 60k rows × 4KB = 240MB — acceptable for one-shot in-memory staging. If bench shows this is too high, switch to temp staging table `migration_embeddings_staging` (CONTEXT Decision 2 pattern) inside the opening tx.

**Ollama failure:** throw clear error `EmbeddingError: Ollama arctic-embed2 unreachable at {url}. Aborting before DB mutation.` Migration runner catches and exits with non-zero.
  </description>
</task>

<task id="05-01-02">
  <subject>Implement src/core/migration/v17-runner.ts</subject>
  <description>
Export:

```ts
export interface RunnerOpts {
  db: Database;
  backupDir: string;                 // ~/.claudex/backups
  staleReviewPath: string;            // .planning/phases/.../stale-review.md
  ollamaUrl: string;
  dryRun: boolean;
  phaseLabel?: string;                // default 'P1'
}

export interface RunnerResult {
  verdict: 'PASS' | 'FAIL' | 'ABORTED';
  backupResult?: VerifyResult;
  stagedCount?: number;
  insertedCounts?: Record<string, number>;
  errors?: string[];
}

export async function runV17Migration(opts: RunnerOpts): Promise<RunnerResult>;
```

Pipeline:

1. **Backup + verify** (real or dry-run mode). Abort on FAIL.
2. **Load stale-review.md** if apply mode. Abort if missing/malformed. Dry-run mode: regenerate via `scanStaleRows` + `writeStaleReview`, don't require pre-existing file.
3. **Phase A — stage embeddings** (outside tx). Pre-embed all rows via `stageEmbeddings`. Abort on embed error.
4. **If dry-run: stop here.** Print summary: `Staged N rows across 6 tables. Next: commit stale-review.md and run migrate:v17:apply.` Return PASS.
5. **Phase B — atomic tx (apply mode only):**
   ```
   BEGIN IMMEDIATE;
     applyV17DDL(db);                              // create artifact, kind_registry, vec0, legacy_id_map
     -- Rename legacy tables (they get replaced by views)
     ALTER TABLE learnings              RENAME TO learnings_old;
     ALTER TABLE decisions              RENAME TO decisions_old;
     ALTER TABLE experience_patterns    RENAME TO experience_patterns_old;
     ALTER TABLE angel_opinions         RENAME TO angel_opinions_old;
     ALTER TABLE critical_rules         RENAME TO critical_rules_old;
     ALTER TABLE project_curated_context RENAME TO project_curated_context_old;
     -- Retire legacy FTS5 (Amendment 4) — must come AFTER rename since FTS5 bound to content table name
     DROP TRIGGER IF EXISTS learnings_fts_insert;
     DROP TRIGGER IF EXISTS learnings_fts_update;
     DROP TRIGGER IF EXISTS learnings_fts_delete;
     DROP TABLE IF EXISTS learnings_fts;
     DROP TRIGGER IF EXISTS experience_patterns_ai;
     DROP TRIGGER IF EXISTS experience_patterns_au;
     DROP TRIGGER IF EXISTS experience_patterns_ad;
     DROP TABLE IF EXISTS experience_patterns_fts;
     -- Pass 1: insert artifact rows + legacy_id_map
     for each stagedRow:
       uuid = lower(hex(randomblob(16)))  // or legacyId if experience_pattern
       INSERT INTO artifact(id, kind, title, body, ...) VALUES (uuid, ...);
       INSERT INTO legacy_id_map(legacy_table, legacy_id, new_uuid) VALUES (legacy_table, legacyId, uuid);
       INSERT INTO artifact_embeddings(rowid, embedding) VALUES (artifact.rowid, embedding);
       UPDATE artifact SET embedding_ref = artifact_embeddings.rowid WHERE id = uuid;
     // Pass 2: resolve mental_model supersedes_id
     UPDATE artifact SET supersedes_id = (
       SELECT m.new_uuid FROM legacy_id_map m
       WHERE m.legacy_table='project_curated_context'
         AND m.legacy_id = CAST(json_extract(artifact.data, '$._legacy_supersedes_id') AS INTEGER)
     ) WHERE kind='mental_model'
       AND json_extract(data, '$._legacy_supersedes_id') IS NOT NULL;
     UPDATE artifact SET data = json_remove(data, '$._legacy_supersedes_id')
       WHERE kind='mental_model';
     // Pass 3: flag stale rows
     staleIds = getStaleIds(parseStaleReview(path));
     for each staleId:
       UPDATE artifact SET status='stale'
       WHERE id = (SELECT new_uuid FROM legacy_id_map WHERE legacy_table='project_curated_context' AND legacy_id = staleId);
     // Apply views + triggers
     applyGeneratedDDL(db, generateViewsAndTriggers(KIND_MAPPING));
     // Validation pass — per-kind required-paths (CONTEXT caveat #6)
     const malformed = db.prepare(`
       SELECT id, kind FROM artifact WHERE
         (kind='learning'  AND (title IS NULL OR body IS NULL OR json_extract(data, '$.fingerprint') IS NULL))
       OR (kind='decision' AND (body IS NULL OR json_extract(data, '$.fingerprint') IS NULL))
       OR (kind='experience_pattern' AND (title IS NULL OR body IS NULL OR json_extract(data, '$.pattern_type') IS NULL))
       OR (kind='angel_opinion' AND (title IS NULL OR body IS NULL OR json_extract(data, '$.subject') IS NULL))
       OR (kind='critical_rule' AND (title IS NULL OR body IS NULL OR json_extract(data, '$.drift_risk') IS NULL))
       OR (kind='mental_model' AND (body IS NULL OR json_extract(data, '$.type') IS NULL OR json_extract(data, '$.curator') IS NULL))
     `).all();
     if (malformed.length > 0) throw new ValidationError(malformed);
     // Bump schema_version
     PRAGMA user_version = 17;
     INSERT INTO schema_versions(version, applied_at_epoch) VALUES (17, unixepoch());
   COMMIT;
   ```

   On any throw inside BEGIN..COMMIT, `db.exec('ROLLBACK')` and return `verdict: 'FAIL'` with error details.

6. **Post-migration post-condition checks** (outside tx):
   - Row-count parity: `SELECT kind, COUNT(*) FROM artifact GROUP BY kind` must match pre-migration counts of the 6 legacy tables.
   - `kind_registry` has exactly 6 rows.
   - SELECT * FROM each legacy view returns same number of rows as its `_old` counterpart.

7. Return `RunnerResult` with verdict + stats.

**Retention note:** The 6 `{name}_old` tables survive post-P1 as safety backstops per CONTEXT Decision 6. P9 drops them. Add STATE.md entry (Plan 02-07).
  </description>
</task>

<task id="05-01-03">
  <subject>Wire CLI subcommands in src/cli/migrate.ts</subject>
  <description>
Extend the stub from Plan 02-03. Add:

- `migrate:v17:dry-run` — calls `runV17Migration({ dryRun: true })`. Writes stale-review.md. Exits with 0 if all pre-flight (backup + staging) passed, otherwise 1.
- `migrate:v17:apply` — calls `runV17Migration({ dryRun: false })`. Exits with 0 only if verdict === 'PASS'.
- Common flags: `--db <path>` (default `~/.claudex/db/claudex.db`), `--backup-dir <path>` (default `~/.claudex/backups`), `--ollama-url <url>` (default `http://localhost:11434`).

Print progress: `[backup] PASS (1234ms)`, `[stage] N rows embedded in 5.2s`, `[migrate] Phase B committed. kind_registry: learning=12 decision=5 ...`.

Exit codes: 0 = PASS, 1 = FAIL, 2 = ABORTED (user-facing like missing stale-review.md).
  </description>
</task>

<task id="05-01-04">
  <subject>End-to-end test src/tests/core/migration/v17-runner.test.ts</subject>
  <description>
Highest-value test in P1. Cases:

- **Happy path**: Seed temp DB with pre-V17 schema + rows in all 6 legacy tables. Mock Ollama `/api/embed` to return deterministic 1024-d vectors. Run `runV17Migration` in apply mode. Assert:
  - verdict === 'PASS'
  - `artifact` has expected row count
  - `kind_registry` has 6 rows
  - `legacy_id_map` has expected row count
  - Each legacy view SELECT returns pre-migration row counts
  - `SELECT * FROM learnings` returns v3-shape columns
  - `artifact_fts MATCH 'keyword'` returns matches
  - `learnings_fts` no longer exists (sqlite_master query)
  - `artifacts_fts` still exists (sanity — not dropped)

- **Dry-run**: same seed. Run with `dryRun: true`. Assert:
  - verdict === 'PASS'
  - stale-review.md written
  - No V17 tables yet (`artifact`, `kind_registry`, etc. absent)

- **Stale flagging**: seed includes a `project_curated_context` row with content `'Uses Gemma 4 31B'`. Commit stale-review.md accepting the flag. Run apply. Assert `artifact.status = 'stale'` for migrated row.

- **Supersedes resolution**: seed 2 `project_curated_context` rows where row B `supersedes_id = A.id`. Run apply. Assert `artifact.supersedes_id` of migrated B = migrated A's UUID (not integer).

- **Rollback on validation failure**: inject a legacy `critical_rules` row missing `drift_risk`. Run apply. Assert verdict === 'FAIL', schema_version still 16, `artifact` table does not exist post-rollback.

- **Backup verifier FAIL short-circuits**: pass a `backupDir` path that is read-only. Assert verdict === 'FAIL' due to backup creation failing, Phase A never starts.

- **Missing stale-review.md in apply mode**: delete the file before apply. Assert verdict === 'ABORTED' with clear message.

- **Ollama failure**: mock Ollama to throw. Assert verdict === 'ABORTED' before any DB mutation.

- **Full-suite regression**: after successful apply, run (in-process) a subset of existing v3 tests that hit legacy tables (e.g., `learnings.ts` write → read). Assert they still work through the views.
  </description>
</task>

## Verification

- `bun run test -- v17-runner` → all 9 cases green.
- `bun run build` → no TS errors.
- Manual E2E: `bun run cli -- migrate:v17:dry-run --db /tmp/test.db` on a cloned dev DB produces stale-review.md. Commit it. Run `bun run cli -- migrate:v17:apply --db /tmp/test.db`. Assert new schema_version, existing session tests still work against migrated DB.

## Quality gate

- [ ] Migration is transactional (BEGIN IMMEDIATE / COMMIT / ROLLBACK). No partial state possible.
- [ ] Backup verifier gate is non-bypassable.
- [ ] Stale-review.md gate is non-bypassable in apply mode.
- [ ] Validation pass runs before COMMIT (not after).
- [ ] Phase A never mutates the real DB.
- [ ] `_old` tables preserved; documented in STATE.md.
- [ ] Computed-UPDATE test from Plan 02-04 green — migration runner trusts it.
