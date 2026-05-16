---
phase: 14-substrate-coherence
sub_phase: 14-07
plan: 07a
type: execute
wave: 1
depends_on: []
files_modified:
  - src/core/migration-steps.ts
  - src/core/migration/v17-runner.ts
  - src/core/migration/v17-triggers.ts
  - src/core/artifact-id-map.ts (NEW)
  - src/core/re-vectorize.ts (NEW)
  - src/tests/core/migration/v17-unified.test.ts (NEW)
  - src/tests/core/artifact-id-map.test.ts (NEW)
  - src/tests/core/re-vectorize.test.ts (NEW)
autonomous: true
requirements: []

must_haves:
  truths:
    - "**Schema reality (per RCA-3, 2026-05-15):** Legacy `artifacts` table (INTEGER PK, schema.ts:338) and V17 `artifact` table (TEXT hash PK, V17 kernel) are SEPARATE TABLES that coexist. V17 unification shipped 2026-04-20 (migrateV16toV17 — collapsed 6 knowledge tables into V17 kernel + JSON sidecar + INSTEAD OF triggers on legacy views) but did NOT migrate the legacy `artifacts` table — that's THIS plan's job. RCA-3 names 22 production read/write sites against legacy `artifacts` and 7 against V17 `artifact`."
    - "**Field mapping (loss-map per RCA-3 — NOT identity rename):** summary→title; content→body; importance(1-5)→confidence(0-1) **scale conversion** (confidence = importance/5); state('fresh','packed','materialized')→status('active','stale','superseded') **enum shift**; superseded_by(forward: replaced-by-X)→supersedes_id(backward: replaces-X) **direction flip**; artifact_type→kind with new V17 kinds registered: observation (high-volume — 9270 rows in claudex-v3), flow, session_log, memory_file, handoff, entity_summary, hot_file, milestone; artifact_ref→drop or move to data JSON depending on site; ttl, last_materialized_epoch, retrieval_score, activation_score, valid_until, novelty_score, retrieval_count, success_count → all move to V17 `artifact.data` JSON sidecar. **Each renamed/scaled field is a load-bearing API change for every caller; 14-07b workers translate at the call site.**"
    - "**Embedding storage shape change (per RCA-3):** Legacy `embedding` BLOB on `artifacts` row → V17 sidecar table `artifact_embeddings` (RCA-3 says possibly chunked storage — VERIFY exact shape in `src/core/migration/v17-triggers.ts` and `src/core/migration/v17-ddl.ts` BEFORE authoring the migration). Re-embedding from scratch via arctic-embed2 (1024-d) is the chosen path — lower risk than blob-convert, deterministic, same model. If V17 uses chunked storage, `re-vectorize.ts` writes one row per chunk; if single-row, one row per artifact. **Helper signature depends on which; not safe to lock in spec until v17-triggers.ts is read.**"
    - "**`artifact_task_pattern` sidecar migration (per RCA-3 — load-bearing for experience tier):** Currently joins to `artifacts.id` INTEGER. Experience tier (`src/intelligence/experience-tier.ts` `fetchCandidatePool`) reads this sidecar. After cutover, the sidecar must join to V17 `artifact.id` TEXT. Position-unless-flagged: create new sidecar `artifact_task_pattern_v17` with TEXT FK; backfill rows from the legacy join; cut over experience-tier's query at cutover step (14-07c). Alternative (operator may flag): try ALTER TABLE on the existing sidecar (SQLite limited support; may need table-rewrite anyway). If the migration is incomplete at cutover, **experience tier surface breaks**."
    - "**`artifact_links` is V17-only (per RCA-3):** Pre-existing V17 table (verify DDL in schema.ts). Wave 2 / LINKS-SCHEMA adds NEW `soft_link` + `hard_link` tables ALONGSIDE it, not replacing. Position-unless-flagged: coexist (`artifact_links` for legacy V17 link semantics; new tables for the typed-link tiers). Operator may flag — alternative is to deprecate `artifact_links` and migrate rows into the new tier-aware shape during Wave 2."
    - "ID type is V17 TEXT hash. Legacy INTEGER IDs remain valid keys in the legacy `artifacts` table and in `artifact_id_map` (the mapping table) but are NOT used for new writes. All writes after 14-07a's migration step go to V17 with TEXT IDs."
    - "`artifact_id_map` is single-writer. 14-07a's migration step populates every existing legacy row's mapping during migration; subsequent callers (14-07b workers) READ from it but do not modify schema or rows. 14-07c flips legacy table to read-only at cutover."
    - "`artifact_id_map` schema: `legacy_id INTEGER PRIMARY KEY, v17_id TEXT NOT NULL UNIQUE, mapped_at_epoch_ms INTEGER NOT NULL, project TEXT NOT NULL`. Indexed on v17_id for reverse lookup. Foreign key on v17_id references `artifact(id)`."
    - "V17 ID derivation from legacy: `v17_id = sha256(legacy_id::TEXT || ':' || project || ':' || created_at_epoch_ms::TEXT || ':' || content_hash).slice(0, 32)`. Deterministic; same legacy row → same V17 ID across runs. The `content_hash` is `sha256(summary || body)` on the legacy row."
    - "Re-vectorization is deterministic: re-vectorizing the same artifact content twice via arctic-embed2 (1024-d) produces byte-identical vectors. This is the test that gates `re-vectorize.ts` correctness."
    - "Re-vectorization helper lives at `src/core/re-vectorize.ts` but its invocation for production data is the responsibility of 14-07c (cutover script). 14-07a ships the helper + its determinism tests; 14-07a does NOT trigger production-scale re-vectorization."
    - "**FTS5 + vec0 sidecar names (verify in code before authoring):** V17 already uses `artifact_fts` (FTS5, per RCA-3 sidecar consolidation table) and a V17 vec sidecar. Legacy `artifacts_fts` (FTS5, schema.ts:373) and `vec_artifacts` are the legacy sidecars. RCA-3 says V17 FTS is `artifact_fts` (singular) and V17 vec storage is `artifact_embeddings` (different shape — chunked). **The spec-time names `artifact_fts_v17` / `vec_artifact_v17` I used earlier are wrong — V17 uses `artifact_fts` + `artifact_embeddings`. Update during plan execution after reading `v17-triggers.ts` for canonical names.**"
    - "Migration step is `migrateV36toV37`. v6.6.0 shipped at V36 (confirmed via `migrations.ts:122 TARGET_USER_VERSION = 36`). 14-07a increments `PRAGMA user_version` by 1 and adds a row to `schema_versions`. Reverse migration `migrateV37toV36` is present (drops `artifact_id_map`, restores legacy as primary; rollback path only)."
    - "Migration is non-destructive on the legacy table. legacy `artifacts` is not dropped, not truncated, not altered structurally. Only the `read_only` flag column is added; flag is FALSE during 14-07a (writes still go to legacy if any caller is unmigrated); 14-07c flips it to TRUE at cutover."
    - "`bun run setup` is updated to reference V37. Hook registration count stays at 25 (no new hooks; the V37 schema does not require new hook types)."
    - "**Verification gate before plan authoring (Wave 0 sections-split timing):** Read `src/core/migration/v17-ddl.ts` + `src/core/migration/v17-triggers.ts` to confirm: (a) actual V17 FTS5 sidecar name; (b) V17 embedding sidecar table name + shape (chunked vs single-row); (c) V17 `artifact` column list to lock the loss-map; (d) artifact_links DDL. **Spec re-pass after this read.** Without it, the migration helper signatures and field-mapping table are guesses."
  artifacts:
    - path: "src/core/migration-steps.ts"
      provides: "migrateV36toV37 forward migration step; migrateV37toV36 reverse migration step"
      contains: "migrateV36toV37|migrateV37toV36|artifact_id_map|read_only_legacy"
    - path: "src/core/migration/v17-runner.ts"
      provides: "Extended V17 schema runner — adds unified-shape DDL extensions"
      contains: "artifact_id_map|unified|v37"
    - path: "src/core/migration/v17-triggers.ts"
      provides: "Updated FTS5 + vec0 triggers for the unified shape"
      contains: "artifact_fts_v17|vec_artifact_v17"
    - path: "src/core/artifact-id-map.ts"
      provides: "Single-source-of-truth helpers for legacy↔V17 ID lookup, mapping population, and reverse resolution"
      contains: "generateV17IdFromLegacy|lookupV17ByLegacy|lookupLegacyByV17|populateAllMappings|verifyMappingComplete"
    - path: "src/core/re-vectorize.ts"
      provides: "arctic-embed2-based re-vectorization helper; deterministic same-input-same-vector"
      contains: "reVectorizeArtifact|reVectorizeAll|verifyDeterminism|callOllamaEmbed"
    - path: "src/tests/core/migration/v17-unified.test.ts"
      provides: "Tests for forward + reverse migration, idempotency, FTS5/vec0 trigger correctness, schema-version row insertion"
      contains: "migrateV36toV37|migrateV37toV36|idempotent|reverse|fts5_trigger|vec0_trigger"
    - path: "src/tests/core/artifact-id-map.test.ts"
      provides: "Tests for ID derivation determinism, round-trip lookup, populateAllMappings, foreign-key constraint"
      contains: "deterministic|round_trip|populate|foreign_key"
    - path: "src/tests/core/re-vectorize.test.ts"
      provides: "Tests for re-vectorization determinism, arctic-embed2 dimension (1024d), Ollama callable mocking"
      contains: "deterministic|1024|ollama|byte_identical"
  key_links:
    - from: "src/core/migration-steps.ts (migrateV36toV37)"
      to: "src/core/artifact-id-map.ts (populateAllMappings)"
      via: "Migration step invokes populateAllMappings after schema DDL completes"
      pattern: "populateAllMappings"
    - from: "src/core/migration-steps.ts (migrateV36toV37)"
      to: "src/core/migration/v17-triggers.ts"
      via: "Migration step recreates FTS5 + vec0 triggers via v17-triggers helpers"
      pattern: "createUnifiedTriggers"
    - from: "src/core/re-vectorize.ts"
      to: "Ollama HTTP /api/embed endpoint"
      via: "POST with model=snowflake-arctic-embed2; returns 1024d vector; same input → byte-identical output"
      pattern: "arctic-embed2"
---

<objective>
Three deliverables in one plan, all schema/infrastructure:

1. **`migrateV36toV37`** — additive migration step that (a) extends the V17 `artifact` table where needed for unified shape, (b) creates `artifact_id_map` mapping table, (c) populates the map for every existing legacy `artifacts` row, (d) updates FTS5 + vec0 sidecar triggers to write to `artifact_fts_v17` + `vec_artifact_v17`, (e) adds a `read_only` flag column to legacy `artifacts` (flag false during 14-07a; 14-07c flips at cutover). Reverse `migrateV37toV36` drops the map and unwinds for rollback only.

2. **`src/core/artifact-id-map.ts`** — single-source-of-truth helpers for the legacy ↔ V17 ID transition. Deterministic ID derivation (`generateV17IdFromLegacy`), round-trip lookup (`lookupV17ByLegacy`, `lookupLegacyByV17`), bulk population (`populateAllMappings`), completeness verification (`verifyMappingComplete`).

3. **`src/core/re-vectorize.ts`** — arctic-embed2-based re-vectorization helper. 14-07a ships the helper + determinism tests; 14-07c invokes it on production data at cutover. The helper is deterministic: same input content → byte-identical 1024-d vector across runs.

Together: by the end of 14-07a, the unified schema exists, every legacy row has a V17 ID mapping, and the re-vectorization helper is proven deterministic against test fixtures. **14-07b workers can now begin caller migration** — they read from the unified API and translate via `artifact-id-map.ts` where transitional bridging is needed.

| What this plan provides | Why |
|---|---|
| Unified V17 artifact schema | One table, one ID type, eliminates Conflict K |
| artifact_id_map mapping table | Legacy callers can resolve via the map during transition |
| Deterministic V17 ID derivation from legacy | Same legacy row → same V17 ID across runs; no migration drift |
| arctic-embed2 re-vectorization helper | Cutover re-vectorizes from unified content; same-input-same-vector guaranteed |
| Read-only flag on legacy artifacts | 14-07c flips at cutover; rollback restores by clearing the flag |
| FTS5 + vec0 triggers updated | artifact_fts_v17 + vec_artifact_v17 are the canonical search/vector stores |
</objective>

<execution_context>
@C:/Users/Grigorije/.claude/get-shit-done/workflows/execute-plan.md
@C:/Users/Grigorije/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/14-substrate-coherence/14-07-CONTEXT.md
@.planning/phases/14-substrate-coherence/14-07-WAVE1-COORDINATION.md
@context/measurements/2026-05-15-substrate-rcas.md
@context/measurements/2026-05-15-substrate-contract-matrix.md
@src/core/migration-steps.ts
@src/core/migration/v17-runner.ts
@src/core/migration/v17-triggers.ts
</context>

<anti_scope>
- Do NOT migrate any caller site to V17. Caller migration is 14-07b territory; this plan only ships the schema + helpers + tests.
- Do NOT add new artifact types or new `kind` enum values. The unified shape uses V17's existing kind enum unchanged.
- Do NOT touch link tables. Soft/hard link tables don't exist until Wave 2 / `14-07-LINKS-SCHEMA-PLAN.md`. If 14-07a is tempted to add link-shaped columns "for forward compatibility," STOP — those belong to Wave 2.
- Do NOT change arctic-embed2 model name, dimension (1024d), or Ollama endpoint shape. The helper calls the existing endpoint per `services/reranker.py` conventions; no model swap.
- Do NOT touch BGE-v2-m3 reranker — Wave 1 does not change reranker config.
- Do NOT modify hybrid-retrieval ranking math, query expansion logic, or candidate sourcing. Per CONTEXT out-of-scope.
- Do NOT touch session-start surfaces (assembler sections, codebase-context, lessons formatter). Wave 3 territory.
- Do NOT touch experience-tier project-scope filter. Wave 3 / 14-07h territory.
- Do NOT auto-trigger production re-vectorization. The helper ships in 14-07a; 14-07c invokes it at cutover, gated on operator.
- Do NOT drop, truncate, or structurally alter the legacy `artifacts` table. Only additive change: a `read_only` flag column.
- Do NOT touch `~/.claudex/db/claudex.db` file path or DB instance topology.
- Do NOT add new hooks to `bun run setup`. Hook count stays at 25; only the schema version reference updates to V37.
</anti_scope>

<tasks>

<task type="auto">
  <name>Task 1: Forward migration step migrateV36toV37</name>
  <files>src/core/migration-steps.ts, src/core/migration/v17-runner.ts, src/core/migration/v17-triggers.ts</files>
  <action>
Add `migrateV36toV37` to `src/core/migration-steps.ts`. The step is additive and idempotent on already-V37 databases.

Schema DDL (within a single transaction):

1. **Add `read_only` flag column to legacy `artifacts`:**
   ```sql
   ALTER TABLE artifacts ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
   ```
   Note: SQLite does not enforce CHECK on ALTER TABLE in older versions; the flag is enforced at the application layer (14-07c flips it; reads continue to work either way).

2. **Create `artifact_id_map` table:**
   ```sql
   CREATE TABLE IF NOT EXISTS artifact_id_map (
     legacy_id INTEGER PRIMARY KEY,
     v17_id TEXT NOT NULL UNIQUE,
     mapped_at_epoch_ms INTEGER NOT NULL,
     project TEXT NOT NULL,
     FOREIGN KEY (v17_id) REFERENCES artifact(id) ON DELETE RESTRICT
   );
   CREATE INDEX IF NOT EXISTS idx_artifact_id_map_v17 ON artifact_id_map(v17_id);
   CREATE INDEX IF NOT EXISTS idx_artifact_id_map_project ON artifact_id_map(project);
   ```

3. **Re-create FTS5 + vec0 triggers via `v17-triggers.ts` helpers.** The helpers are extended to ensure the unified shape's INSERT/UPDATE/DELETE triggers write to `artifact_fts_v17` + `vec_artifact_v17`. The existing legacy triggers (writing to `artifact_fts` + `vec_artifacts`) are left in place during 14-07a — they continue mirroring writes to legacy sidecars until 14-07c demotes them.

4. **Populate `artifact_id_map`** for every existing legacy `artifacts` row by calling `populateAllMappings(db)` from `src/core/artifact-id-map.ts` (Task 2). The migration step is the SINGLE call site for populateAllMappings during initial migration; subsequent runs are no-ops (rows already mapped).

5. **Update `PRAGMA user_version`** to V37 and INSERT a row into `schema_versions` with the migration metadata.

Add reverse `migrateV37toV36` in the same file:
- DROP TABLE `artifact_id_map`
- ALTER TABLE legacy `artifacts` to DROP COLUMN `read_only` (or, if SQLite version too old for DROP COLUMN, mark in app layer)
- Reverse triggers
- Decrement PRAGMA user_version + log reverse in schema_versions

Update `v17-runner.ts` to invoke migrateV36toV37 as part of standard runner flow (when current version is V36).

Update `v17-triggers.ts` with the new `createUnifiedTriggers(db)` helper that creates the unified-shape triggers.

Update `bun run setup`'s schema version reference from V36 → V37 (one constant change; hook registration count stays 25).
  </action>
  <verification>
- migrateV36toV37 applied to a fresh V36 DB lands cleanly.
- migrateV36toV37 applied to an already-V37 DB is a no-op (idempotent).
- artifact_id_map table exists post-migration.
- read_only column exists on legacy artifacts post-migration.
- FTS5 + vec0 unified triggers in place.
- PRAGMA user_version reads 37 post-migration.
- schema_versions row inserted with correct metadata.
- migrateV37toV36 cleanly reverses (DB returns to V36 shape).
- `bun run setup` references V37; hook count == 25.
  </verification>
</task>

<task type="auto">
  <name>Task 2: artifact-id-map.ts helpers</name>
  <files>src/core/artifact-id-map.ts</files>
  <action>
Create new file `src/core/artifact-id-map.ts` with the following exports:

```typescript
/**
 * Phase 14-07a — legacy↔V17 ID mapping helpers.
 *
 * Single source of truth for ID translation during the V17 unification
 * transition window. Populated once at migrateV36toV37; read-only
 * thereafter until 14-07c cutover. Drops one milestone post-cutover.
 */

import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';

/**
 * Derive a V17 TEXT hash ID from a legacy artifact row.
 *
 * Deterministic — same legacy row inputs → same V17 ID across runs.
 *
 * Formula: sha256(legacy_id || ':' || project || ':' || created_at_epoch_ms || ':' || content_hash).slice(0, 32)
 * where content_hash = sha256(summary || body).
 *
 * 32-char prefix matches V17's existing TEXT ID convention.
 */
export function generateV17IdFromLegacy(input: {
  legacy_id: number;
  project: string;
  created_at_epoch_ms: number;
  summary: string;
  body: string;
}): string;

/**
 * Look up V17 ID for a given legacy INTEGER ID.
 * Returns null if no mapping exists (caller should error rather than guess).
 */
export function lookupV17ByLegacy(db: Database, legacy_id: number): string | null;

/**
 * Reverse lookup: legacy ID for a given V17 TEXT ID.
 * Used by 14-07c rollback path and by diagnostic tools.
 */
export function lookupLegacyByV17(db: Database, v17_id: string): number | null;

/**
 * Populate artifact_id_map for every row currently in legacy `artifacts`.
 * Single call site: migrateV36toV37. Idempotent: if a mapping already
 * exists for a legacy_id, skipped silently.
 *
 * Returns count of new rows inserted.
 */
export function populateAllMappings(db: Database): { inserted: number; skipped: number };

/**
 * Verify mapping completeness: every legacy artifacts row has a V17
 * mapping. Returns the count of unmapped legacy rows (0 = healthy).
 * 14-07c's gate refuses cutover if this returns non-zero.
 */
export function verifyMappingComplete(db: Database): { total_legacy: number; mapped: number; unmapped: number };
```

Implementation notes:

- `generateV17IdFromLegacy` is a pure function. No DB access. The deterministic-ID test calls it twice on the same input and asserts byte equality.
- `populateAllMappings` reads from legacy `artifacts` and writes to `artifact_id_map`. Per row: INSERT OR IGNORE on the unique constraint. The V17 ID must also exist in `artifact` (foreign key) — the migration step inserts/upserts into V17 `artifact` before populating the map.
- The V17 artifact insert during populateAllMappings copies legacy columns into V17 shape: `id = v17_id`, `kind = (legacy.kind or 'observation')`, `project = legacy.project`, `summary = legacy.summary`, `body = legacy.body`, `created_at_epoch_ms = legacy.created_at_epoch_ms`, `data = JSON.stringify({migrated_from_legacy_id: legacy.id})`.
- Embeddings are NOT populated here — that's 14-07c's re-vectorize step.
  </action>
  <verification>
- generateV17IdFromLegacy returns the same 32-char hex string for identical inputs across 10 calls.
- generateV17IdFromLegacy returns different strings when ANY input field differs by one byte.
- populateAllMappings on an empty mapping table populates N rows where N = legacy row count.
- populateAllMappings on a partially-populated map is idempotent (no duplicate insertions; skipped count > 0).
- verifyMappingComplete returns unmapped=0 after a clean populateAllMappings run.
- verifyMappingComplete returns unmapped>0 if a legacy row was inserted after the map was populated (regression test for partial migrations).
- Round-trip: legacyId → lookupV17ByLegacy → lookupLegacyByV17 returns original legacy id.
- Foreign-key violation: attempting to INSERT into artifact_id_map without a matching artifact row raises a constraint error (DB-level enforcement).
  </verification>
</task>

<task type="auto">
  <name>Task 3: re-vectorize.ts helper</name>
  <files>src/core/re-vectorize.ts</files>
  <action>
Create new file `src/core/re-vectorize.ts` with the following exports:

```typescript
/**
 * Phase 14-07a — arctic-embed2 re-vectorization helper.
 *
 * Invoked by 14-07c at cutover to re-vectorize all unified artifact
 * rows from scratch into vec_artifact_v17. Deterministic: same
 * artifact content → byte-identical 1024-d vector across runs.
 *
 * NOT invoked at production scale by 14-07a. This file ships the
 * helper + determinism test only.
 */

import type { Database } from 'better-sqlite3';

export type EmbeddingVector = Float32Array;  // 1024-d arctic-embed2

export interface ReVectorizeParams {
  ollama_base_url?: string;   // default: 'http://localhost:11434'
  model?: string;             // default: 'snowflake-arctic-embed2'
  timeout_ms?: number;        // default: 10000
}

/**
 * Re-vectorize a single artifact by id.
 * Reads `summary` + `body` from the V17 artifact table, calls
 * Ollama /api/embed, writes the resulting vector to vec_artifact_v17.
 *
 * Returns the vector for inspection in tests.
 * Throws on Ollama HTTP error or non-1024 dimension response.
 */
export async function reVectorizeArtifact(
  db: Database,
  artifact_id: string,
  params?: ReVectorizeParams
): Promise<EmbeddingVector>;

/**
 * Bulk re-vectorize. Invoked at cutover (14-07c).
 * Iterates V17 artifact table; per row, calls reVectorizeArtifact.
 *
 * Progress callback fires every batch_size rows (default 100).
 *
 * Returns counts: { total, succeeded, failed }.
 * Failed rows are logged to `telemetry` with event_kind='re_vectorize_failed'.
 */
export async function reVectorizeAll(
  db: Database,
  params?: ReVectorizeParams & {
    batch_size?: number;
    on_progress?: (done: number, total: number) => void;
  }
): Promise<{ total: number; succeeded: number; failed: number }>;

/**
 * Determinism check: re-vectorize the same content twice via separate
 * Ollama calls and assert byte-identical output. Used by tests + by
 * 14-07c's pre-cutover sanity gate.
 */
export async function verifyDeterminism(
  sample_text: string,
  params?: ReVectorizeParams
): Promise<{ deterministic: boolean; first_bytes: Uint8Array; second_bytes: Uint8Array }>;

/**
 * Test-only: inject a callable for the Ollama /api/embed endpoint.
 * Production code uses the real fetch path; tests use this to mock.
 */
export function _setOllamaEmbedCallableForTest(fn: ((text: string) => Promise<number[]>) | null): void;
```

Implementation:

- Real Ollama call uses `fetch(ollama_base_url + '/api/embed', { method: 'POST', body: JSON.stringify({ model, input: text }) })`. Returns `{ embeddings: [[...1024 floats]] }`.
- Vector serialization to `vec_artifact_v17` uses sqlite-vec's BLOB encoding (existing helper in `v17-triggers.ts`).
- Determinism: arctic-embed2 produces deterministic output for identical input. The `verifyDeterminism` helper calls Ollama twice, compares byte-for-byte. If non-deterministic (network jitter / model rebuild), surfaces the discrepancy explicitly.
- Failed re-vectorizations: logged to `telemetry` with event_kind='re_vectorize_failed', detail.artifact_id + detail.error. Do NOT block bulk re-vectorize on individual failures; failures are surfaced as a count.
  </action>
  <verification>
- reVectorizeArtifact on a known artifact returns a 1024-element Float32Array.
- verifyDeterminism returns deterministic=true for identical inputs.
- verifyDeterminism returns deterministic=false (surfaced, not thrown) for hand-crafted non-deterministic mock.
- reVectorizeAll iterates correctly over a fixture DB with 10 artifacts.
- Bulk failure handling: 2-of-10 artifacts with injected errors → succeeded=8, failed=2, telemetry rows present.
- _setOllamaEmbedCallableForTest allows mocking; tests do not require real Ollama.
  </verification>
</task>

<task type="auto">
  <name>Task 4: Tests for migration step</name>
  <files>src/tests/core/migration/v17-unified.test.ts</files>
  <action>
New test file. Use `:memory:` DBs per test. Tests:

1. `forward: migrateV36toV37 applies on fresh V36 DB`
   - Setup: DB at V36 with seeded legacy artifacts (5 rows across 2 projects).
   - Run migrateV36toV37.
   - Expected: PRAGMA user_version == 37; artifact_id_map exists; read_only column exists; legacy rows mapped (count == 5).

2. `forward: migrateV36toV37 is idempotent on already-V37 DB`
   - Setup: DB at V37 (one migration already run).
   - Run migrateV36toV37 again.
   - Expected: no error; user_version unchanged; map row count unchanged; no duplicate schema_versions row.

3. `reverse: migrateV37toV36 unwinds cleanly`
   - Setup: DB at V37.
   - Run migrateV37toV36.
   - Expected: user_version == 36; artifact_id_map dropped; read_only column dropped (or marked stale per SQLite version); schema_versions reverse-row inserted.

4. `forward: legacy table is non-destructive`
   - Setup: DB at V36 with 5 legacy rows.
   - Run migrateV36toV37.
   - Expected: legacy artifacts table still has 5 rows; columns unchanged except `read_only` added; data byte-identical.

5. `forward: FTS5 + vec0 unified triggers created`
   - Inspect sqlite_master for `artifact_fts_v17_*` trigger names.
   - Inspect sqlite_master for `vec_artifact_v17_*` trigger names.
   - Expected: trigger count matches v17-triggers.ts's createUnifiedTriggers spec.

6. `forward: schema_versions row inserted`
   - Row with version=37, applied_at_epoch_ms recent, direction='forward'.

7. `forward: populateAllMappings called during migration`
   - Verify the V17 artifact table has 5 corresponding rows (one per legacy row).

8. `forward + cross-table: V17 artifact row references match legacy via map`
   - For each legacy_id, lookupV17ByLegacy returns a V17 ID that exists in artifact table with matching summary + body.

9. `reverse: artifact table V17 rows NOT dropped on rollback`
   - migrateV37toV36 drops the map but does NOT delete artifact rows (V17 table is canonical post-cutover; only the *mapping* is transient).
  </action>
  <verification>
- All 9 tests pass.
- No regressions in `src/tests/core/migration/*.test.ts` baseline.
  </verification>
</task>

<task type="auto">
  <name>Task 5: Tests for artifact-id-map helpers</name>
  <files>src/tests/core/artifact-id-map.test.ts</files>
  <action>
New test file. Tests:

1. `generateV17IdFromLegacy: same inputs → same output (10 calls)`
2. `generateV17IdFromLegacy: different legacy_id → different output`
3. `generateV17IdFromLegacy: different project → different output`
4. `generateV17IdFromLegacy: different created_at_epoch_ms → different output`
5. `generateV17IdFromLegacy: different summary → different output`
6. `generateV17IdFromLegacy: different body → different output`
7. `generateV17IdFromLegacy: output is 32 hex chars (matches V17 convention)`
8. `populateAllMappings: empty map → N rows after`
9. `populateAllMappings: partial map → idempotent, no duplicates`
10. `populateAllMappings: V17 artifact rows also created`
11. `populateAllMappings: legacy_id and v17_id round-trip via lookup`
12. `lookupV17ByLegacy: missing legacy_id returns null`
13. `lookupLegacyByV17: missing v17_id returns null`
14. `verifyMappingComplete: clean populate → unmapped=0`
15. `verifyMappingComplete: legacy row inserted after populate → unmapped=1`
16. `foreign-key constraint: artifact_id_map insert without matching artifact row throws`
  </action>
  <verification>
- All 16 tests pass.
  </verification>
</task>

<task type="auto">
  <name>Task 6: Tests for re-vectorize helper</name>
  <files>src/tests/core/re-vectorize.test.ts</files>
  <action>
New test file. Uses `_setOllamaEmbedCallableForTest` to mock Ollama (no real Ollama dependency in CI).

Tests:

1. `reVectorizeArtifact: returns 1024-element Float32Array`
2. `reVectorizeArtifact: writes vector to vec_artifact_v17`
3. `reVectorizeArtifact: throws on dimension mismatch (e.g., mocked 768d response)`
4. `reVectorizeArtifact: throws on Ollama HTTP error (mocked 500)`
5. `reVectorizeAll: 10 artifacts → succeeded=10, failed=0`
6. `reVectorizeAll: 2-of-10 with mock errors → succeeded=8, failed=2, telemetry rows present`
7. `reVectorizeAll: progress callback fires every batch_size`
8. `verifyDeterminism: identical mock outputs → deterministic=true`
9. `verifyDeterminism: divergent mock outputs → deterministic=false, surfaces both byte arrays`
10. `_setOllamaEmbedCallableForTest(null) restores production fetch path` (without invoking — verifies the setter accepts null)
  </action>
  <verification>
- All 10 tests pass.
- No real Ollama dependency required.
  </verification>
</task>

<task type="auto">
  <name>Task 7: Build + run plan-touched tests + sweep</name>
  <files></files>
  <action>
- `bun run build` — must succeed.
- `npx vitest run src/tests/core/migration/v17-unified.test.ts` — 9 tests pass.
- `npx vitest run src/tests/core/artifact-id-map.test.ts` — 16 tests pass.
- `npx vitest run src/tests/core/re-vectorize.test.ts` — 10 tests pass.
- `npx vitest run src/tests/core/` — no new regressions in core/.
- `npx vitest run src/tests/angel/ src/tests/assembly/ src/tests/intelligence/` — no new regressions outside known llama-* baseline.
- `bun run setup` — exits 0; reports 25 hooks; schema version reference is V37.
- `bun run build && node dist/angel/index.cjs --version` — Angel still starts cleanly (smoke).
  </action>
  <verification>
- Build green.
- 9 + 16 + 10 = 35 new tests pass.
- No new regressions outside known llama-* baseline.
- `bun run setup` reports V37.
  </verification>
</task>

</tasks>

<acceptance_criteria>
- AC-1: `migrateV36toV37` exists in `src/core/migration-steps.ts`, is idempotent on already-V37 DB, and reverses cleanly via `migrateV37toV36`.
- AC-2: `artifact_id_map` table exists post-migration with the spec-defined schema (legacy_id PK, v17_id UNIQUE, mapped_at_epoch_ms, project, FK to artifact).
- AC-3: `read_only` flag column added to legacy `artifacts` (default 0; 14-07c flips at cutover).
- AC-4: `populateAllMappings` populates V17 artifact rows AND mapping rows for every legacy artifact at migration time.
- AC-5: `generateV17IdFromLegacy` is deterministic (10 calls → identical output) and content-sensitive (any byte change → different output).
- AC-6: `reVectorizeArtifact` produces a 1024-d Float32Array via arctic-embed2 (or mocked equivalent in tests).
- AC-7: `verifyDeterminism` correctly surfaces deterministic vs non-deterministic Ollama responses.
- AC-8: FTS5 + vec0 unified triggers (`artifact_fts_v17`, `vec_artifact_v17`) created at migration; legacy triggers (`artifact_fts`, `vec_artifacts`) preserved untouched.
- AC-9: `bun run setup` references V37; hook registration count stays at 25.
- AC-10: All 35 new tests (9 migration + 16 id-map + 10 re-vectorize) pass.
- AC-11: No new regressions outside known llama-* baseline (`bun run build && npx vitest run`).
- AC-12: `schema_versions` row inserted for V37 migration with `direction='forward'`.
</acceptance_criteria>

<risks>
- **Risk 1: SQLite version doesn't support ALTER TABLE DROP COLUMN.** The reverse migration may fail to drop `read_only`. Mitigation: detect SQLite version; if DROP COLUMN unsupported, mark the column as stale in `schema_versions` metadata and document the limitation. Reverse migration is rollback-only; production never expects it under normal flow.
- **Risk 2: populateAllMappings is slow on production-size legacy artifacts.** RCA-3 reports legacy `artifacts` has ~thousands of rows. Per-row sha256 + V17 artifact INSERT + mapping INSERT could be slow under a single transaction. Mitigation: batch in groups of 500 with intermediate commits; emit progress via console. Mitigation already in 14-07c (cutover invokes re-vectorize at scale; the schema migration's row-copy is fast enough to land in seconds).
- **Risk 3: Ollama snowflake-arctic-embed2 model unavailable at migration time.** The migration step itself does NOT call Ollama (re-vectorization is 14-07c's job). But the determinism test in Task 6 mocks Ollama; production verification at cutover is operator-gated. Mitigation: 14-07a does not depend on Ollama for the migration to succeed.
- **Risk 4: V17 ID derivation collision on different content.** Birthday-paradox at 32 hex chars (~128 bits) is negligibly small but non-zero. Mitigation: UNIQUE constraint on `v17_id` in the map; collision → constraint failure → migration aborts with explicit error. Test 9 in Task 5 covers the foreign-key/UNIQUE path.
- **Risk 5: Legacy table mutation during migration.** If another process writes to legacy `artifacts` during migrateV36toV37, the snapshot is inconsistent. Mitigation: 14-07a runs in a single transaction; SQLite's BEGIN IMMEDIATE blocks other writers. Documented; 14-07c's cutover script also acquires the same lock.
- **Risk 6: arctic-embed2 produces non-deterministic vectors across model rebuilds.** If Ollama updates the model and dimension/precision shifts, determinism breaks. Mitigation: `verifyDeterminism` runs as a gate at 14-07c pre-cutover; if non-deterministic, hold cutover and surface to operator.
</risks>

<external_review_gate>
Codex + Gemini cross-family review focuses on:
- (a) Is the V17 ID derivation collision-resistant for production-scale data?
- (b) Does the migration step's transaction boundary correctly isolate from concurrent writers?
- (c) Is the FTS5 + vec0 trigger update non-breaking for existing legacy reads?
- (d) Is the re-vectorize helper's failure handling production-grade (telemetry on per-row failure; non-blocking bulk)?
- (e) Does the read_only flag plus 14-07c cutover plan correctly leave a rollback path open?

NO-SIGNOFF triggers PM escalation per WAVE1-COORDINATION's PM → PO escalation rules.
</external_review_gate>

<methodology_gates>
1. Pre-committed AC matrix above before any code (this plan satisfies).
2. Tests written alongside code (Tasks 4, 5, 6 are paired with Tasks 1, 2, 3).
3. Live-wiring smoke: AC-9 verifies `bun run setup` against the migrated schema; AC-11 verifies build + test suite end-to-end.
4. No "MVP" shortcuts — deterministic ID derivation is a production-quality safeguard against migration drift; non-destructive legacy preservation is the rollback safety.
5. Negative results valid: if `verifyDeterminism` reveals arctic-embed2 non-determinism (Risk 6), document and revise — do not loosen the cutover gate.
6. Cross-family external review per the gate above.
7. No time estimates anywhere (per `memory/feedback_no_time_estimates.md`). Sizing language is relative or scope-based.
</methodology_gates>
