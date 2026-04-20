# Phase 2: P1 — Artifact Table Unification — Context

**Gathered:** 2026-04-20
**Status:** Ready for planning
**Source:** `.planning/ROADMAP.md` §Phase 2; `.planning/REQUIREMENTS.md` STOR-01..05,07,08; `context/specs/CLAUDEX_V4_SCOPE.md`

<domain>
## Phase Boundary

**Goal:** Collapse 7 legacy knowledge tables (`learnings`, `decisions`, `experience_patterns`, `angel_opinions`, `critical_rules`, `project_curated_context`, and the `entity_summary` subset of `artifacts`) into a single unified `artifact(kind, ...)` table via V17 migration, with preserving SQL views + INSTEAD OF triggers so every v3 caller keeps working unchanged. Zero behavior change. Transactional, backup-gated, benchmark-gated.

**Commander's intent:** Memory must stop acting like rules. P1's role in that is pure storage consolidation — one substrate, no caller-visible change. Framing, retrieval, and injection changes land in later phases.

**Locked success criteria (from ROADMAP.md §Phase 2):**
1. V17 migration creates `artifact` table with free-form `kind` column and `kind_registry`
2. All rows from 7 legacy tables migrated inside a single transaction
3. Legacy table names preserved as views with unchanged shape; identical `SELECT` data
4. Stale `project_curated_context` rows flagged `status='stale'` via keyword scan (`Gemma 4 31B`, `llama-server:8081`, `local llama-server`)
5. DB backup at `~/.claudex/backups/pre-v4-P1-{ts}.db` verified restorable before migration runs
6. All 2020 Vitest tests pass; LongMemEval Oracle ≥90%; LoCoMo within 2pp of baseline

</domain>

<decisions>
## Implementation Decisions

### 1. Artifact Schema Shape

**Column strategy: shared kernel + JSON sidecar.**

Kernel columns (14):

```sql
CREATE TABLE artifact (
  id                TEXT PRIMARY KEY,           -- UUID lower(hex(randomblob(16))); entity_summary rows preserve legacy id
  kind              TEXT NOT NULL,              -- free-form; registry tracks seen values
  title             TEXT,                       -- short human label, FTS5 weighted
  body              TEXT NOT NULL,              -- full text, cross-encoder rerank target
  scope             TEXT,                       -- 'session' | 'project' | 'universal' (P8 actions it)
  status            TEXT NOT NULL,              -- 'active' | 'stale' | 'archived' | 'superseded'
  confidence        REAL,
  created_at_epoch  INTEGER NOT NULL,           -- ms
  updated_at_epoch  INTEGER NOT NULL,
  session_id        TEXT,
  project_id        TEXT,
  embedding_ref     INTEGER,                    -- rowid in artifact_embeddings (vec0)
  supersedes_id     TEXT,                       -- FK artifact.id (P8 fills)
  data              TEXT                        -- JSON kind-specific payload
);
```

Kind registry (3 columns):

```sql
CREATE TABLE kind_registry (
  kind             TEXT PRIMARY KEY,
  first_seen_epoch INTEGER NOT NULL,
  last_seen_epoch  INTEGER NOT NULL
);
```

**Title / body composition per kind:**

| Legacy kind          | `title`                                       | `body`                                                      |
|---|---|---|
| `learning`           | `learnings.pattern`                           | `learnings.solution` (+ `context` if non-empty)             |
| `decision`           | `decisions.decision`                          | `decisions.rationale` (+ stringified `alternatives` in data) |
| `experience_pattern` | `experience_patterns.trigger_signature`       | `correct_approach` + `\n\nWhat went wrong: ` + `wrong_approach` |
| `angel_opinion`      | `entity_id + ' — ' + opinion_type` (synth)    | `angel_opinions.opinion`                                    |
| `critical_rule`      | first ~80 chars of `rule_text`                | full `rule_text`                                            |
| `mental_model`       | `category + ' — ' + first_line(content)`      | `content`                                                   |
| `entity_summary`     | existing `title` (unchanged)                  | existing `summary` (unchanged)                              |

Secondary fields (confidence, reinforcement_count, severity, aliases, triggers, alternatives, category) live in `data` JSON. Example: `data.section = category` for migrated `project_curated_context`; `data.reinforcement_count` for experience_patterns.

**Vectors: single vec0 table.**

```sql
CREATE VIRTUAL TABLE artifact_embeddings USING vec0(embedding float[1024]);
```

`artifact.embedding_ref → artifact_embeddings.rowid`. Legacy vec0 tables stay untouched through P1; they retire with their source tables at P9.

**Kind vocabulary seeded at P1 migration** (via AFTER INSERT trigger — no manual seed):
`learning`, `decision`, `experience_pattern`, `angel_opinion`, `critical_rule`, `mental_model`, `entity_summary`.

Future kinds (NOT seeded by P1 — appear as writers land):
`directive_rule` (P2), `transcript_chunk` (P3), `session_summary`, `correction`, `reframe`, `workspace_fact`, `shipped_component`, `open_question`, `failure_pattern`.

### 2. Embedding Strategy — pre-staged re-embed

Re-embed every migrated row (arctic-embed2, 1024d) using the NEW `title + " " + body` composition. Legacy embeddings cannot be ported 1:1 because body composition changes and vec0 recall would silently rot.

Migration sequence (split across tx boundary):

```
Phase A (outside transaction): Pre-stage embeddings
  - For each legacy row, compute (title, body) via composeBody(kind, legacyRow)
  - Batch-call Ollama arctic-embed2 (batch 32)
  - Write to migration_embeddings_staging(legacy_table, legacy_id, embedding BLOB)
  - If Ollama fails: abort before touching real tables

Phase B (single transaction): Atomic swap
  - CREATE artifact + kind_registry + artifact_embeddings (vec0)
  - Rename artifacts → artifacts_old
  - INSERT artifact rows with embeddings JOINed from staging
  - INSERT vec0 rows linked via embedding_ref
  - CREATE legacy views + INSTEAD OF triggers
  - Flag stale mental_model rows per review file (Area 4)
  - DROP migration_embeddings_staging
  - COMMIT
```

**A single `composeBody(kind, legacyRow) → {title, body}` function MUST be used by both phases** or embeddings go out of sync with search text.

### 3. Legacy View Strategy

**INSTEAD OF triggers on every legacy view — full INSERT+UPDATE+DELETE parity.**

- 7 views × 3 operations = up to 21 triggers
- **Generated from a single source-of-truth mapping table** (not hand-written). Generator lives in `src/core/migration/v17-triggers.ts`.
- Translation rules:
  - INSERT: maps legacy columns → kernel cols + data JSON per per-kind mapping
  - UPDATE: kernel-mapped cols → direct SET; data-mapped cols → `json_set(data, '$.path', NEW.col)`
  - DELETE: `DELETE FROM artifact WHERE id = OLD.id AND kind = K`
  - Computed UPDATEs (e.g. `x = x + 1`): rely on SQLite evaluating NEW.x before firing trigger; if validation shows this fails, fall back to explicit `json_set(data, '$.count', json_extract(data, '$.count') + 1)` in trigger body. **Plan phase MUST validate `UPDATE experience_patterns SET reinforcement_count = reinforcement_count + 1` works** before committing migration.

### 4. View Shape Fidelity

- **Strict column set** — views project exactly the v3 column list, no extra `id`/`kind` leaks. `SELECT *` returns v3 column order unchanged.
- **Aggressive CAST** on every JSON-derived column: `CAST(json_extract(data, '$.severity') AS TEXT) AS severity`, `CAST(json_extract(data, '$.reinforcement_count') AS INTEGER) AS reinforcement_count`, etc. Types preserved for all v3 integer/real/text columns. BOOLEAN (stored as `0/1 INTEGER` in SQLite) needs no cast.
- **No CHECK constraints on `artifact.data`**. Instead, migration validation pass before COMMIT: `SELECT kind, COUNT(*) FROM artifact WHERE data IS NULL OR <per-kind required paths> IS NULL GROUP BY kind` — any malformed row ⇒ ROLLBACK + surface ids.
- **Views include `ORDER BY created_at_epoch`** to preserve v3's rowid-based implicit insertion-order behavior. Indexed column → cheap sort; overridable by outer ORDER BY.
- **Row visibility: surface all statuses** (no `WHERE status = 'active'` filter). Callers that filtered explicitly keep working; callers that didn't see the same rows as before (modulo the 3 spec'd deltas below).

### 5. Kernel Fill Rules (INSTEAD OF INSERT triggers)

| Field             | Source                                          | Fallback                                           |
|---|---|---|
| `id`              | `NEW.id` if caller supplied (migration only)    | `lower(hex(randomblob(16)))`                       |
| `kind`            | Constant per view                               | —                                                  |
| `title`, `body`   | Per-kind composition table (Decision 1)         | —                                                  |
| `scope`           | `NEW.scope` if caller supplied                  | `'project'`                                        |
| `status`          | `COALESCE(NEW.status, 'active')`                | `'active'`                                         |
| `confidence`      | `NEW.confidence`                                | NULL                                               |
| `created_at_epoch`| `NEW.created_at_epoch`                          | `unixepoch() * 1000`                               |
| `updated_at_epoch`| `NEW.updated_at_epoch`                          | `COALESCE(NEW.created_at_epoch, unixepoch()*1000)` |
| `session_id`      | `NEW.session_id` (if legacy col exists — e.g. `project_curated_context`) | NULL; Angel backfills |
| `project_id`      | Trigger-specific extraction (e.g. from `angel_opinions.entity_id`) | NULL; Angel backfills             |
| `embedding_ref`   | NULL on INSERT                                  | Angel's existing backfill pass                     |
| `supersedes_id`   | NULL                                            | P8 fills later                                     |
| `data`            | Per-kind JSON shape from Decision 1             | —                                                  |

**New code writing directly to `artifact` MUST set session_id / project_id explicitly** — this is a rule for post-P1 phases (P2 onwards). P1 does not enforce via CHECK.

### 6. Entity Summary Migration

**Copy-rewrite from `artifacts` with view-name preservation.**

Sequence inside the atomic tx:

```sql
ALTER TABLE artifacts RENAME TO artifacts_old;
-- then CREATE artifact, INSERT rows from artifacts_old preserving id verbatim:
INSERT INTO artifact(id, kind, title, body, data, session_id, project_id,
                     created_at_epoch, updated_at_epoch, embedding_ref,
                     confidence, status, scope)
SELECT id, 'entity_summary', title, summary,
       json_object('aliases', aliases, /* other fields */),
       session_id, project_id, created_at_epoch, updated_at_epoch,
       <new_embedding_ref>, confidence, COALESCE(status,'active'), 'project'
FROM artifacts_old WHERE kind = 'entity_summary';

-- Plus any non-entity_summary kinds currently in artifacts_old (audit Phase A).

CREATE VIEW artifacts AS 
  SELECT id, kind, title, body AS summary, 
         json_extract(data, '$.aliases') AS aliases,
         session_id, project_id, created_at_epoch, updated_at_epoch,
         embedding_ref, confidence, status
  FROM artifact
  WHERE kind IN ('entity_summary' /* + audited kinds */)
  ORDER BY created_at_epoch;
```

`artifacts_old` table survives through P1–P8 as safety backstop; P9 drops it. **Document retention window in STATE.md so no future agent cleans it up prematurely.**

### 7. Kind Registry Mechanics

**Snapshot-only registry — no counts.**

```sql
CREATE TRIGGER artifact_register_kind AFTER INSERT ON artifact
BEGIN
  INSERT INTO kind_registry(kind, first_seen_epoch, last_seen_epoch)
    VALUES (NEW.kind, NEW.created_at_epoch, NEW.created_at_epoch)
  ON CONFLICT(kind) DO UPDATE SET last_seen_epoch = excluded.last_seen_epoch;
END;
```

Counts computed on demand: `SELECT kind, COUNT(*) FROM artifact GROUP BY kind`. No UPDATE/DELETE triggers — zero drift risk.

**Naming convention (enforced by Vitest lint):** `lowercase_snake_case_singular`.

```ts
test('artifact kinds follow naming convention', () => {
  const rows = db.prepare('SELECT DISTINCT kind FROM artifact').all();
  for (const { kind } of rows) {
    expect(kind).toMatch(/^[a-z][a-z0-9_]*$/);
  }
});
```

**Deprecation: passive.** Kinds drift out via `last_seen_epoch` falling behind. No `status` column on registry in P1.

### 8. Stale-Flag Review Flow (STOR-05)

**Two-phase migration — `migrate:dry-run` then `migrate:apply`, with review file as input.**

File: `.planning/phases/02-p1-artifact-table-unification/stale-review.md` — git-tracked markdown with two sections:
- **Heuristic matches** (default `decision: stale`; flip to `keep` to veto)
- **Manual additions** (human adds rows the heuristic missed; `decision: stale` applies them)

`migrate:apply` reads the file; missing or truncated → abort. Review is additive-capable (human can both veto AND extend).

**For this P1 run: review pre-approved per user directive.** Commit `c84dd61` (feat: swap local Gemma 4 31B for Ollama Cloud `glm-5.1:cloud`) is the evidence that the 3 keyword markers map to a definitively-stale reality. Orchestrator commits `stale-review.md` with all heuristic-match defaults accepted, manual-additions empty. Future migrations with stale flows default to user-reviewed; auto-approval requires explicit user steer.

### 9. STOR-07 Path-Scoped Artifacts — Schema Only in P1

P1 **reserves schema** but does not wire the runtime surface:

- Kernel `scope` column exists (Decision 1)
- `data.paths` is a free-form JSON field; writers/readers agree on path-glob shape at consumer layer
- Migrated legacy rows default `scope='project'`
- **No `.claude/rules/` filesystem writer in P1.** Existing 5 hand-authored rule files (`angel-architecture.md`, `assembly-budget.md`, `embeddings-safety.md`, `hooks-safety.md`, `schema-migration.md`) stay untouched and are out-of-scope for migration.
- No session-start rule-loader query, no runtime glob-match-to-artifact lookup, no writers for `directive_rule`/`workspace_fact` (those ship in P2+).

Runtime wiring deferred to the first phase that produces path-scoped artifacts — P2 (directive_rule) at earliest, likely P3 (which introduces the sentinel-comment file-writer pattern via CUR-03 that this will reuse).

When Angel eventually starts generating `.claude/rules/*.md` files, they must use a distinguishable filename convention (e.g. `.claude/rules/auto/*.md` or `auto-*.md` prefix) + sentinel comment, so they never collide with hand-authored files.

### 10. Backup Verification Gate (STOR-08)

**Backup: full `claudex.db` file via `sqlite3 .backup` API (NOT `.dump`, NOT `cp`).**

Path: `~/.claudex/backups/pre-v4-P1-{ts}.db` (real) and `~/.claudex/backups/pre-v4-P1-dry-{ts}.db` (dry-run).

**6-check verification — any FAIL aborts P1 migration before real tables touched:**

1. Run `sqlite3 source.db ".backup pre-v4-P1-{ts}.db"`
2. Open backup as separate connection with sqlite-vec extension loaded — **fail-fast on extension load** (primary failure mode specific to claudex: vec0 shadow tables corrupted)
3. `PRAGMA integrity_check` → must return `'ok'`
4. `PRAGMA quick_check` → must return `'ok'`
5. Row-count parity: `SELECT COUNT(*) FROM <each legacy table>` in backup vs. source — must match
6. vec0 smoke: `SELECT COUNT(*) FROM <any_existing_vec0_table> LIMIT 1` — proves virtual table queryable
7. Close backup connection; emit manifest row

**Retention: 5 newest per phase per kind (real/dry-run).** Rotation at backup-create time, never at verify-fail time.

**Audit trail: disk-only .db + git-tracked manifest.**

Manifest file: `.planning/phases/02-p1-artifact-table-unification/backup-manifest.md` — appended row per backup with timestamp, path, size, SHA-256, pass/fail per check, total verify time. Committed with the P1 summary. `.db` binaries stay gitignored.

</decisions>

<specifics>
## Specific References & Examples

- **`composeBody` function MUST be shared** between pre-embed staging and atomic-migration INSERT — drift = silent vec0 recall rot.
- **Trigger code-generator lives in** `src/core/migration/v17-triggers.ts` — emits all 21 triggers from one mapping table.
- **Stale-keyword heuristic**: `Gemma 4 31B`, `llama-server:8081`, `local llama-server` (exact from STOR-05). Migration is pre-approved for this P1 run per commit `c84dd61`.
- **Benchmark gate phrasing — spec'd deltas ARE the intended behavior change**, not failures. The 3 known deltas:
  1. Migrated `project_curated_context` rows matching stale keywords flip `status='active' → 'stale'`
  2. Migrated non-`entity_summary` legacy rows get new UUID `id`s; legacy integer ids don't survive
  3. Non-session_id-bearing legacy rows get `session_id=NULL`; Angel backfills best-effort
  
  Plan phase pauses and confirms with user if audit reveals a 4th delta.

- **Kernel schema snippet** (Decision 1) is authoritative for plan phase code — do not re-derive.
- **v3.5 P2.1 injection bug (session 50 handoff) is unrelated** to P1 — P1 is storage only; P2.1 injection fix belongs in P4.

</specifics>

<deferred>
## Deferred Ideas

Captured during discussion, belong in later phases or are explicitly out-of-scope:

- **`.claude/rules/` auto-generation from path-scoped artifacts** — deferred to P3 (first phase that introduces the sentinel-comment file-writer pattern via CUR-03) or whichever phase first needs it.
- **Hot-writer switch from view-triggers to direct `artifact` INSERT** — post-P1 hardening. INSTEAD OF triggers pay a ~3× write amplification (view → trigger → artifact → AFTER INSERT trigger → vec0 async). Acceptable for P1 as transition cost.
- **`kind_registry.description` column** — dropped from schema as YAGNI. Add if/when someone needs it; lives in `.planning/` docs or code comments for now.
- **`kind_registry.status` for deprecation** — dropped as YAGNI. Passive deprecation via `last_seen_epoch` is enough until a kind actually gets renamed.
- **Legacy integer id preservation via mapping table** — contingent. Plan-phase audit greps for external storage of legacy integer ids (`REFERENCES learnings(id)`, callers using `lastInsertRowid` as stable FK). If audit returns nothing (expected), Option 1 (UUID-only) holds. If audit finds dependencies, upgrade to `legacy_id_map(legacy_table, legacy_id, new_uuid)` and flag as scope amendment.
- **Drop `artifacts_old` table** — deferred to P9 per ROADMAP.md §Phase 11. Retained through P1–P8 as safety backstop.

</deferred>

<caveats>
## Audit Items for Plan Phase

Surface as explicit tasks in PLAN.md — do NOT let plan phase miss these:

1. **FK audit on `artifacts.id`** — grep codebase for `REFERENCES artifacts(id)`, string-joins on `artifacts.id`, external storage of `artifacts.id` in other tables. `id` preservation for entity_summary rows is MANDATORY if any hit; drives Decision 6.

2. **Legacy integer id external-storage audit** — grep for `REFERENCES (learnings|decisions|experience_patterns|angel_opinions|critical_rules|project_curated_context)(id)`. If zero hits (expected), Decision 5.a Option 1 holds. If any hits, upgrade to legacy_id_map + user confirmation.

3. **Write-path audit** — grep all callers doing `INSERT INTO (learnings|decisions|...|artifacts) VALUES (...)`. Every one becomes an INSTEAD OF trigger exercise. Ensure the mapping table covers every column they write. Enumerate any caller that depends on `lastInsertRowid` as stable FK — they become the motivation for the legacy_id_map.

4. **Computed-UPDATE behavior test** — before committing migration, validate via isolated test: `UPDATE experience_patterns SET reinforcement_count = reinforcement_count + 1 WHERE id = ?` increments `data.reinforcement_count` correctly through INSTEAD OF UPDATE. If SQLite's NEW.reinforcement_count doesn't carry the evaluated result, fall back to explicit `json_set` in trigger body.

5. **Column-level index audit** — for each legacy table index, determine if it carries real query load (grep `hybrid-retrieval.ts`, `src/intelligence/*` for WHERE-clauses on indexed legacy columns). Port each as an expression index on `json_extract(data, '$.field')`. Don't silently lose indexed access paths.

6. **Migration validation pass SQL** — plan phase writes the explicit per-kind required-paths validation: e.g. `SELECT kind, COUNT(*) FROM artifact WHERE kind = 'learning' AND (title IS NULL OR body IS NULL OR json_extract(data, '$.confidence') IS NULL) GROUP BY kind`. Must return zero rows before COMMIT.

7. **Vitest suite gate** — before P1 commit, the full 2020-test suite must pass AGAINST THE MIGRATED DB. The test suite touching legacy tables through views is the real parity check.

8. **2 NEW Vitest tests to add in P1:**
   - Naming convention lint (Decision 7)
   - Computed-UPDATE test (Audit #4 above, kept as regression test)

9. **State file retention note** — add entry to STATE.md: "artifacts_old table retained P1→P9 as migration backstop; do not drop."

</caveats>

---

*Phase: 02-p1-artifact-table-unification*
*Context gathered: 2026-04-20*
*6 gray areas discussed; 10 Decisions locked; 9 audit items handed to plan phase; 6 deferred ideas preserved.*
