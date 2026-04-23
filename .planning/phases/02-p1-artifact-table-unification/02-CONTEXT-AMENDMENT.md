# Phase 2: P1 — Artifact Table Unification — CONTEXT AMENDMENT

**Amended:** 2026-04-20
**Supersedes parts of:** `02-CONTEXT.md`
**Trigger:** Plan-phase audit (required by original CONTEXT.md §specifics) surfaced 4 conflicts with locked decisions. Team-lead resolved all four authoritatively. This file captures the resolutions.

**Original `02-CONTEXT.md` is preserved unchanged for audit trail.** Where this amendment conflicts with the original, this amendment wins.

---

## Amendment 1 — Revoke Decision 6. Exclude `entity_summary` from P1 scope.

**Original (revoked):** Decision 6 instructed `ALTER TABLE artifacts RENAME TO artifacts_old`, migrate `entity_summary` rows into `artifact`, and expose legacy name as a view filtering for `kind IN ('entity_summary', ...)`.

**Replacement:** `artifacts` table, `artifacts_fts` virtual table, `vec_artifacts` vec0 binding, and `artifact_links` FK dependency are **all untouched in P1**. No RENAME, no view shadow, no entity_summary copy.

**Why:**
- Codebase audit (`src/core/schema.ts:285-317`) shows `artifacts` is the v3 hot retrieval substrate, not a knowledge-store. It has 10 `artifact_type` values, ~20 columns including hot-path fields (`activation_score`, `q_value`, `retrieval_count`, `success_count`, `confidence`, `novelty_score`, `embedding`), an FTS5 `artifacts_fts` binding, a `vec_artifacts` vec0 binding, 3 indexes, and is updated from 12+ write paths (hybrid-retrieval, memrl-scorer, retrieval-feedback, benchmark harnesses, etc.).
- Collapsing it risks silent duplication if we COPY entity_summary rows (writers keep writing to `artifacts`, the copy in `artifact` goes stale) and risks catastrophic retrieval degradation if we RENAME (vec_artifacts orphaned, FTS5 sync broken, activation_score path dead).
- Scope-lock "sqlite-vec + 5 vec0 tables are out of scope" (v3.5 baseline) makes `vec_artifacts` retirement explicitly off-limits for P1.
- Entity_summary migration is deferred to whichever later phase addresses the `artifacts` table holistically — P5 (retrieval simplification) or P9 (cleanup). Not this phase.

**Revised P1 scope — 6 tables, not 7:**

| # | Table | Status |
|---|---|---|
| 1 | `learnings` | IN scope |
| 2 | `decisions` | IN scope |
| 3 | `experience_patterns` | IN scope |
| 4 | `angel_opinions` | IN scope |
| 5 | `critical_rules` | IN scope |
| 6 | `project_curated_context` | IN scope |
| 7 | ~~`entity_summary` subset of `artifacts`~~ | **OUT of P1 — deferred to P5/P9** |

**Body-mapping table (Decision 1 Q2) — strike the last row:**

| Legacy kind | `title` | `body` |
|---|---|---|
| `learning` | `learnings.pattern` | `learnings.solution` (+ `context` if non-empty) |
| `decision` | `decisions.decision` | `decisions.rationale` (+ stringified `alternatives` in data) |
| `experience_pattern` | `experience_patterns.trigger_signature` | `correct_approach` + `\n\nWhat went wrong: ` + `wrong_approach` |
| `angel_opinion` | `entity_id + ' — ' + opinion_type` (synth) | `angel_opinions.opinion` |
| `critical_rule` | first ~80 chars of `rule_text` | full `rule_text` |
| `mental_model` | `category + ' — ' + first_line(content)` | `content` |
| ~~`entity_summary`~~ | ~~existing `title` (unchanged)~~ | ~~existing `summary` (unchanged)~~ |

**Kind vocabulary seeded at P1 — 6 kinds, not 7:**
`learning`, `decision`, `experience_pattern`, `angel_opinion`, `critical_rule`, `mental_model`.

**Revised success criterion #2:** "All rows from **6** legacy tables migrated inside a single transaction."

---

## Amendment 2 — Activate `legacy_id_map` contingent path.

**Original (contingent):** Decision 5 / Deferred #5 specified that UUID-only IDs hold *if* the legacy-integer-id-external-storage audit returned zero hits, and required a fallback to `legacy_id_map` + user confirmation if any hits were found.

**Audit result:** Hit at `src/core/migration-steps.ts:1398`:
```sql
supersedes_id INTEGER REFERENCES project_curated_context(id)
```

**Resolution — `legacy_id_map` table included in P1 scope:**

```sql
CREATE TABLE legacy_id_map (
  legacy_table TEXT NOT NULL,
  legacy_id    INTEGER NOT NULL,
  new_uuid     TEXT NOT NULL REFERENCES artifact(id),
  PRIMARY KEY (legacy_table, legacy_id)
);
CREATE INDEX idx_legacy_id_map_uuid ON legacy_id_map(new_uuid);
```

**Usage during migration (single transaction):**
1. **Pass 1 — row migration.** For every migrated row, insert into `legacy_id_map(legacy_table, legacy_id, new_uuid)`. Table-universal (all 6 kinds), not just `project_curated_context`. Costs one row per legacy row; enables future callers that stored legacy integer ids to resolve them.
2. **Pass 2 — supersedes resolution.** Within same tx, after all rows are in `artifact`:
   ```sql
   UPDATE artifact
   SET supersedes_id = (
     SELECT m.new_uuid FROM legacy_id_map m
     WHERE m.legacy_table = 'project_curated_context'
       AND m.legacy_id = CAST(json_extract(artifact.data, '$._legacy_supersedes_id') AS INTEGER)
   )
   WHERE kind = 'mental_model'
     AND json_extract(data, '$._legacy_supersedes_id') IS NOT NULL;
   ```
   (Staging passes the legacy integer `supersedes_id` through `data.$._legacy_supersedes_id`; resolution strips it.)
3. **Strip staging field:**
   ```sql
   UPDATE artifact SET data = json_remove(data, '$._legacy_supersedes_id')
     WHERE kind = 'mental_model' AND json_extract(data, '$._legacy_supersedes_id') IS NOT NULL;
   ```

**Usage post-migration (view INSTEAD OF triggers):**
- INSTEAD OF INSERT on `project_curated_context`: if caller supplies `supersedes_id`, resolve through `legacy_id_map` at write time. If caller passes an integer that doesn't resolve (new row not yet migrated), either (a) store the integer in `data.$._pending_supersedes` and resolve on read, or (b) reject with clear error. **Plan-phase picks (a) for safety**, re-resolves lazily on trigger path.
- INSTEAD OF UPDATE on `project_curated_context.supersedes_id`: same translation path.

**Retention:** `legacy_id_map` lives from P1 through P9 (drops with `artifacts_old` and legacy views). Documented in STATE.md.

**No caller API change** — callers still pass integer `supersedes_id` to the view; translation is opaque.

---

## Amendment 3 — Auto-resolved by Amendment 1.

`artifact_links(source_id, target_id)` at `src/core/schema.ts:451-461` references `artifacts.id` as INTEGER. Since `artifacts` is untouched per Amendment 1, these FKs remain valid. No action.

---

## Amendment 4 — Add 4th spec'd delta. Retire 2 legacy FTS5 tables, create `artifact_fts`.

**Original CONTEXT.md §specifics listed 3 spec'd deltas.** Audit found a 4th: FTS5 virtual tables bound to legacy tables.

**Affected legacy FTS5 tables:**
- `learnings_fts` (bound to `learnings` — `src/core/schema.ts:153-159`)
- `experience_patterns_fts` (bound to `experience_patterns` — `src/core/schema.ts:425-431`)

**NOT affected (stays untouched per Amendment 1):**
- `artifacts_fts` (bound to `artifacts` — `src/core/schema.ts:320-341`)

**Resolution:**
1. At migration tx, `DROP TABLE learnings_fts; DROP TABLE experience_patterns_fts;` (and drop their 6 sync triggers: `learnings_fts_insert/update/delete`, `experience_patterns_ai/au/ad`).
2. Create new `artifact_fts`:
   ```sql
   CREATE VIRTUAL TABLE artifact_fts USING fts5(
     title, body,
     content='artifact',
     content_rowid='rowid',
     tokenize='porter unicode61'
   );
   ```
3. Create 3 sync triggers (`artifact_fts_ai`, `artifact_fts_au`, `artifact_fts_ad`) mirroring the pattern used by `observations_fts` / `artifacts_fts` in schema.ts.
4. Backfill: `INSERT INTO artifact_fts(rowid, title, body) SELECT rowid, title, body FROM artifact;` inside the migration tx.

**Why this is safe:** The INSTEAD OF triggers on `learnings` and `experience_patterns` views cannot rebuild FTS5 auto-sync for FTS5 `content='view_name'` mode in a way that stays clean — FTS5 wants a physical content table. Retiring the two legacy FTS5 tables and routing FTS search through `artifact_fts` is the only clean path.

**4th spec'd delta (add to CONTEXT.md §specifics):**
> 4. Legacy FTS5 tables `learnings_fts` and `experience_patterns_fts` are retired at P1 commit. Callers performing direct `MATCH` queries against those tables must migrate to `artifact_fts` (then WHERE kind IN ('learning', 'experience_pattern') as needed). `artifacts_fts` is untouched.

**Plan-phase audit item added:** Grep for `MATCH` against `learnings_fts` or `experience_patterns_fts`. If hits found, add a PLAN task to port call sites. Expected hits limited — claudex hybrid-retrieval pipeline routes through `artifacts_fts` for its main FTS channel.

---

## Updated P1 Scope Summary

**In P1 (new):**
- `CREATE TABLE artifact(id, kind, title, body, scope, status, confidence, created_at_epoch, updated_at_epoch, session_id, project_id, embedding_ref, supersedes_id, data)`
- `CREATE TABLE kind_registry(kind, first_seen_epoch, last_seen_epoch)`
- `CREATE VIRTUAL TABLE artifact_embeddings USING vec0(embedding float[1024])`
- `CREATE VIRTUAL TABLE artifact_fts USING fts5(title, body, content='artifact', ...)`
- `CREATE TABLE legacy_id_map(legacy_table, legacy_id, new_uuid, PRIMARY KEY(legacy_table, legacy_id))`
- 6 AFTER INSERT/UPDATE/DELETE triggers on `artifact` (kind_registry sync + FTS5 sync)
- 6 legacy views: `learnings`, `decisions`, `experience_patterns`, `angel_opinions`, `critical_rules`, `project_curated_context`
- 18 INSTEAD OF triggers (6 views × 3 ops) generated from mapping table

**In P1 (retired):**
- `learnings_fts` virtual table + 3 sync triggers
- `experience_patterns_fts` virtual table + 3 sync triggers

**Untouched by P1:**
- `artifacts` table (rows + columns + indexes + ALTER history)
- `artifacts_fts` virtual table
- `vec_artifacts`, `vec_patterns`, `vec_threads`, `vec_journal`, `vec_conversations` (all 5 vec0 tables stay)
- `artifact_links` table
- All other tables not in the 6-table migration set

**Deferred to later phases:**
- Entity_summary migration → P5 or P9 (whichever addresses `artifacts` holistically)
- `artifacts_old` retention and drop → P9 *(no rename happens in P1 anymore, so this deferral becomes "drop `vec_patterns` and the 2 retired FTS5 bindings' orphaned data" — de-minimis)*

---

*Amendment locked: 2026-04-20*
*4 conflicts resolved; 1 scope reduction; 1 new table (`legacy_id_map`); 1 new FTS5 table (`artifact_fts`); 2 FTS5 tables retired.*
