---
plan_id: 02-04
phase: 2
wave: 2
depends_on:
  - 02-01
files_modified:
  - src/core/migration/v17-ddl.ts
  - src/core/migration/v17-triggers.ts
  - src/core/migration-steps.ts
  - src/core/schema.ts
  - src/tests/core/migration/v17-ddl.test.ts
  - src/tests/core/migration/v17-triggers.test.ts
autonomous: true
requirements:
  - STOR-01
  - STOR-02
  - STOR-03
  - STOR-07
---

# Plan 02-04: V17 DDL + trigger code generator

## Objective

Write all V17 schema DDL:
- Kernel `artifact` table
- `kind_registry` table + AFTER INSERT trigger
- `artifact_embeddings` vec0 virtual table
- `artifact_fts` FTS5 virtual table + sync triggers
- `legacy_id_map` table + index
- 6 legacy views (one per migrated table, with aggressive CAST for type preservation)
- 18 INSTEAD OF triggers (6 × INSERT/UPDATE/DELETE) generated from `KIND_MAPPING` (Plan 02-01)

This plan writes the DDL **code** and generator. It does NOT run the migration against a real DB — Plan 02-05 does that.

## Must-haves (goal-backward)

- `applyV17DDL(db)` idempotently creates all new tables / vec0 / fts5 / views / triggers.
- Generator emits 18 triggers programmatically from `KIND_MAPPING` — no hand-written trigger bodies.
- Views project exact v3 column order + types (CAST-enforced where JSON-derived).
- Views include `ORDER BY created_at_epoch` (preserves v3 implicit rowid order — see CONTEXT Decision 4).
- All unit tests pass.

## Tasks

<task id="04-01-01">
  <subject>Implement src/core/migration/v17-ddl.ts</subject>
  <description>
Export `applyV17DDL(db: Database): void`. Issues:

```sql
CREATE TABLE IF NOT EXISTS artifact (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  title             TEXT,
  body              TEXT NOT NULL,
  scope             TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  confidence        REAL,
  created_at_epoch  INTEGER NOT NULL,
  updated_at_epoch  INTEGER NOT NULL,
  session_id        TEXT,
  project_id        TEXT,
  embedding_ref     INTEGER,
  supersedes_id     TEXT REFERENCES artifact(id),
  data              TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data))
);

CREATE INDEX IF NOT EXISTS idx_artifact_kind ON artifact(kind, created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_project ON artifact(project_id, kind, created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_status ON artifact(status, kind);

-- Expression indexes for ported legacy access paths (per 02-RESEARCH.md §1.4)
CREATE INDEX IF NOT EXISTS idx_artifact_learning_agent
  ON artifact(project_id, json_extract(data, '$.agent_id'), json_extract(data, '$.promotion_count') DESC)
  WHERE kind = 'learning';

CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_learning
  ON artifact(project_id, json_extract(data, '$.agent_id'), json_extract(data, '$.fingerprint'))
  WHERE kind = 'learning';

CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_decision
  ON artifact(session_id, json_extract(data, '$.fingerprint'))
  WHERE kind = 'decision';

CREATE INDEX IF NOT EXISTS idx_artifact_decision_session
  ON artifact(session_id, created_at_epoch DESC)
  WHERE kind = 'decision';

CREATE INDEX IF NOT EXISTS idx_artifact_expat_score
  ON artifact(json_extract(data, '$.score') DESC, json_extract(data, '$.times_triggered') DESC)
  WHERE kind = 'experience_pattern';

CREATE INDEX IF NOT EXISTS idx_artifact_expat_project_score
  ON artifact(project_id, json_extract(data, '$.score') DESC)
  WHERE kind = 'experience_pattern';

CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_opinion
  ON artifact(project_id, json_extract(data, '$.subject'))
  WHERE kind = 'angel_opinion';

CREATE INDEX IF NOT EXISTS idx_artifact_opinion_confidence
  ON artifact(project_id, confidence DESC)
  WHERE kind = 'angel_opinion';

CREATE INDEX IF NOT EXISTS idx_artifact_critrule_source
  ON artifact(project_id, json_extract(data, '$.source'))
  WHERE kind = 'critical_rule';

CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_critrule_dedup
  ON artifact(project_id, body)
  WHERE kind = 'critical_rule';

CREATE INDEX IF NOT EXISTS idx_artifact_mentalmodel_type
  ON artifact(project_id, json_extract(data, '$.type'), status)
  WHERE kind = 'mental_model';

-- kind_registry
CREATE TABLE IF NOT EXISTS kind_registry (
  kind             TEXT PRIMARY KEY,
  first_seen_epoch INTEGER NOT NULL,
  last_seen_epoch  INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS artifact_register_kind AFTER INSERT ON artifact
BEGIN
  INSERT INTO kind_registry(kind, first_seen_epoch, last_seen_epoch)
    VALUES (NEW.kind, NEW.created_at_epoch, NEW.created_at_epoch)
  ON CONFLICT(kind) DO UPDATE SET last_seen_epoch = excluded.last_seen_epoch;
END;

-- legacy_id_map
CREATE TABLE IF NOT EXISTS legacy_id_map (
  legacy_table TEXT NOT NULL,
  legacy_id    INTEGER NOT NULL,
  new_uuid     TEXT NOT NULL REFERENCES artifact(id),
  PRIMARY KEY (legacy_table, legacy_id)
);
CREATE INDEX IF NOT EXISTS idx_legacy_id_map_uuid ON legacy_id_map(new_uuid);
```

Then load sqlite-vec extension (reuse pattern from `migrateV14toV15`) and:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_embeddings USING vec0(embedding float[1024]);
```

Then FTS5:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(
  title, body,
  content='artifact',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS artifact_fts_ai AFTER INSERT ON artifact BEGIN
  INSERT INTO artifact_fts(rowid, title, body)
  VALUES (new.rowid, COALESCE(new.title, ''), new.body);
END;

CREATE TRIGGER IF NOT EXISTS artifact_fts_au AFTER UPDATE OF title, body ON artifact BEGIN
  INSERT INTO artifact_fts(artifact_fts, rowid, title, body)
  VALUES ('delete', old.rowid, COALESCE(old.title, ''), old.body);
  INSERT INTO artifact_fts(rowid, title, body)
  VALUES (new.rowid, COALESCE(new.title, ''), new.body);
END;

CREATE TRIGGER IF NOT EXISTS artifact_fts_ad AFTER DELETE ON artifact BEGIN
  INSERT INTO artifact_fts(artifact_fts, rowid, title, body)
  VALUES ('delete', old.rowid, COALESCE(old.title, ''), old.body);
END;
```
  </description>
</task>

<task id="04-01-02">
  <subject>Implement src/core/migration/v17-triggers.ts (code generator)</subject>
  <description>
Export:

```ts
export interface GeneratedViewDDL {
  legacyTable: string;
  kind: string;
  viewSql: string;                // CREATE VIEW ...
  insertTriggerSql: string;       // CREATE TRIGGER <legacy>_ii INSTEAD OF INSERT ...
  updateTriggerSql: string;
  deleteTriggerSql: string;
}

export function generateViewsAndTriggers(mapping: typeof KIND_MAPPING): GeneratedViewDDL[];

export function applyGeneratedDDL(db: Database, generated: GeneratedViewDDL[]): void;
```

The generator uses `KIND_MAPPING` (from Plan 02-01). For each legacy table entry:

**View (uses the `viewSelect` spec):**
```sql
CREATE VIEW {legacyTable} AS
SELECT
  {for each legacyCol:}
    {if kernel-stored: CAST(kernel_col AS {legacyType}) AS {legacyCol}}
    {if data-stored:   CAST(json_extract(data, '$.{path}') AS {legacyType}) AS {legacyCol}}
FROM artifact
WHERE kind = '{kind}'
ORDER BY created_at_epoch;
```

Special handling:
- `learnings.id`, `decisions.id`, `angel_opinions.id`, `critical_rules.id`, `project_curated_context.id` — legacy INTEGER, translated from `legacy_id_map`: `CAST((SELECT legacy_id FROM legacy_id_map WHERE new_uuid = artifact.id) AS INTEGER) AS id`.
- `experience_patterns.id` — TEXT UUID preserved verbatim: `artifact.id AS id`.

**INSERT trigger:**
```sql
CREATE TRIGGER {legacy}_instead_insert INSTEAD OF INSERT ON {legacyTable}
BEGIN
  INSERT INTO artifact(id, kind, title, body, scope, status, confidence, created_at_epoch, updated_at_epoch, session_id, project_id, data)
  VALUES (
    lower(hex(randomblob(16))),
    '{kind}',
    {titleExpr applied to NEW},
    {bodyExpr applied to NEW},
    'project',
    COALESCE(NEW.status, 'active'),
    {confidenceExpr applied to NEW},
    COALESCE(NEW.created_at_epoch * 1000, unixepoch() * 1000),
    COALESCE(NEW.updated_at_epoch * 1000, unixepoch() * 1000),
    NEW.session_id_col_if_present,
    NEW.project_col,
    json_object(
      {for each dataKey:}
        '{key}', NEW.{legacyCol}
    )
  );
END;
```

For integer-id legacy tables with AUTOINCREMENT, emit an AFTER-INSERT handler that writes the generated synthetic integer id into `legacy_id_map`:
```sql
-- inside the BEGIN ... END block, after the INSERT:
INSERT INTO legacy_id_map(legacy_table, legacy_id, new_uuid)
VALUES (
  '{legacyTable}',
  (SELECT COALESCE(MAX(legacy_id), 0) + 1 FROM legacy_id_map WHERE legacy_table = '{legacyTable}'),
  (SELECT id FROM artifact WHERE rowid = last_insert_rowid())
);
```
(Synthetic legacy id = max + 1 scoped per table. Matches AUTOINCREMENT-like semantics for post-migration writers.)

**UPDATE trigger:**
```sql
CREATE TRIGGER {legacy}_instead_update INSTEAD OF UPDATE ON {legacyTable}
BEGIN
  UPDATE artifact SET
    {for each kernel-mapped col: kernel_col = NEW.legacy_col}
    , data = {json_set chained for each data-mapped col, using NEW.legacy_col}
    , updated_at_epoch = unixepoch() * 1000
  WHERE id = (SELECT new_uuid FROM legacy_id_map WHERE legacy_table = '{legacyTable}' AND legacy_id = OLD.id)
     OR id = OLD.id;  -- fallback for experience_patterns where OLD.id is UUID directly
END;
```

**DELETE trigger:**
```sql
CREATE TRIGGER {legacy}_instead_delete INSTEAD OF DELETE ON {legacyTable}
BEGIN
  DELETE FROM artifact
  WHERE id = (SELECT new_uuid FROM legacy_id_map WHERE legacy_table = '{legacyTable}' AND legacy_id = OLD.id)
     OR id = OLD.id;
END;
```

**`project_curated_context.supersedes_id` handling (Amendment 2):**
INSERT trigger: store `NEW.supersedes_id` in `data._pending_supersedes` if non-null. UPDATE trigger: resolve via `json_set(data, '$.supersedes_id_resolved', (SELECT new_uuid FROM legacy_id_map WHERE legacy_table='project_curated_context' AND legacy_id = NEW.supersedes_id))` — lazy resolve.

View SELECT for `project_curated_context.supersedes_id` column: return the integer id if resolved (reverse-lookup via legacy_id_map) or the stored `_pending_supersedes` value, whichever is set.
  </description>
</task>

<task id="04-01-03">
  <subject>Wire applyV17DDL into V16→V17 migration step in src/core/migration-steps.ts</subject>
  <description>
Add `migrateV16toV17(db: Database): void` following the existing migration pattern. Bump schema_version to 17. Call `applyV17DDL(db)` then `applyGeneratedDDL(db, generateViewsAndTriggers(KIND_MAPPING))`.

Also: drop the 2 retired FTS5 tables + their sync triggers (Amendment 4):
```sql
DROP TRIGGER IF EXISTS learnings_fts_insert;
DROP TRIGGER IF EXISTS learnings_fts_update;
DROP TRIGGER IF EXISTS learnings_fts_delete;
DROP TABLE IF EXISTS learnings_fts;

DROP TRIGGER IF EXISTS experience_patterns_ai;
DROP TRIGGER IF EXISTS experience_patterns_au;
DROP TRIGGER IF EXISTS experience_patterns_ad;
DROP TABLE IF EXISTS experience_patterns_fts;
```

**Important:** these DROPs MUST happen AFTER the legacy tables are renamed (Plan 02-05 handles renaming — legacy → {name}_old). Otherwise the FTS5 content= binding breaks mid-migration. So in migrateV16toV17, the DROPs go between the rename pass and the artifact INSERT pass.

Keep `artifacts_fts` untouched (Amendment 1).

Update `src/core/schema.ts`: add comment `-- V17: see migrateV16toV17 and v17-ddl.ts`. Do NOT duplicate the DDL — schema.ts is reference documentation, migration-steps.ts is the procedural source of truth.
  </description>
</task>

<task id="04-01-04">
  <subject>Vitest: src/tests/core/migration/v17-ddl.test.ts</subject>
  <description>
- Apply DDL to fresh temp DB. Assert `artifact`, `kind_registry`, `legacy_id_map`, `artifact_embeddings`, `artifact_fts` exist. Query `sqlite_master` to verify.
- Insert a row directly into `artifact`, assert `kind_registry` row appears with matching `first_seen_epoch`/`last_seen_epoch`. Insert another row with same kind, assert `last_seen_epoch` updates, `first_seen_epoch` unchanged.
- Insert a row with invalid JSON in `data` → CHECK fails, throws.
- Insert rows of all 6 kinds; assert expression indexes can serve lookups (EXPLAIN QUERY PLAN on sample queries shows index use).
- Naming convention lint test (CONTEXT Decision 7): insert rows with kinds `'learning'`, `'experience_pattern'` → pass; insert row with kind `'Learning'` (capital L) → existing rows remain but naming-convention test asserts `SELECT DISTINCT kind FROM artifact` all match `/^[a-z][a-z0-9_]*$/`.
  </description>
</task>

<task id="04-01-05">
  <subject>Vitest: src/tests/core/migration/v17-triggers.test.ts</subject>
  <description>
Core coverage of the generator. For each of the 6 legacy views:

- `INSERT INTO {legacy_view} (...) VALUES (...)` → assert `artifact` row exists with correct kind, correct title/body composition, correct data JSON.
- `SELECT * FROM {legacy_view}` → round-trip assertion: shape matches v3 column list (exact order + types). `typeof` each column.
- `UPDATE {legacy_view} SET some_col = ? WHERE id = ?` → assert kernel or data JSON field updated correctly.
- `DELETE FROM {legacy_view} WHERE id = ?` → assert `artifact` row gone.

**Computed-UPDATE test (CONTEXT caveat #4):**
```ts
db.prepare("INSERT INTO experience_patterns(id, pattern_type, trigger_context, lesson, source_project, created_at_epoch, score) VALUES ('x', 'correction', 't', 'l', 'p', 0, 5)").run();
db.prepare("UPDATE experience_patterns SET score = score + 2 WHERE id = 'x'").run();
const { score } = db.prepare("SELECT json_extract(data, '$.score') AS score FROM artifact WHERE id = 'x'").get() as { score: number };
expect(score).toBe(7);
```
If this test FAILS (SQLite doesn't carry NEW.score post-expression), the generator has a fallback: emit `json_set(data, '$.score', CAST(json_extract(data, '$.score') AS INTEGER) + <literal>)` — but that requires AST of RHS, infeasible generically. Primary plan trusts SQLite; fallback is hand-written trigger variants for the 4 known computed columns on experience_patterns (`score`, `times_triggered`, `times_useful`).

**Legacy_id_map reverse-lookup test:**
- INSERT into `learnings` view. SELECT id FROM learnings → assert integer id returned.
- SELECT * from legacy_id_map → assert row (learnings, that_int, the_uuid) exists.
- UPDATE learnings WHERE id = that_int → assert `artifact.updated_at_epoch` changed.
- DELETE FROM learnings WHERE id = that_int → assert artifact row gone AND legacy_id_map row gone (cleanup via FK cascade or trigger).

**Cross-kind isolation:** Insert row into `learnings` view, SELECT * FROM `decisions` → assert does not appear. And vice versa.
  </description>
</task>

## Verification

- `bun run test -- v17-ddl v17-triggers` → all cases green.
- `bun run build` → no TS errors.
- Run full test suite: `bun run test` → all 2020 existing tests still green (or explain any regression as a Plan 02-05 task).

## Quality gate

- [ ] All 6 views have INSERT / UPDATE / DELETE triggers generated from mapping table (18 total).
- [ ] No hand-written trigger bodies (except the explicit computed-UPDATE fallback if needed).
- [ ] Views preserve exact v3 column order and types via aggressive CAST.
- [ ] `artifact_fts` has 3 sync triggers; legacy `learnings_fts` / `experience_patterns_fts` dropped.
- [ ] `artifacts_fts`, `vec_artifacts`, `artifact_links` untouched.
- [ ] Naming-convention Vitest lint present and green.
