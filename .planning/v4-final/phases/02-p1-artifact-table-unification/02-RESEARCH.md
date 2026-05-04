# Phase 2: P1 — Artifact Table Unification — Research

**Researched:** 2026-04-20
**Driven by:** `02-CONTEXT.md` + `02-CONTEXT-AMENDMENT.md`
**Scope:** 6 legacy knowledge tables → unified `artifact(kind, ...)` via V17 migration.

## RESEARCH COMPLETE

---

## 1. Audit Results (CONTEXT §caveats items 1–5)

### 1.1 FK audit on `artifacts.id` (caveat #1)

**Result:** 1 semantic FK — `artifact_links(source_id, target_id)` at `src/core/schema.ts:451-461` stores INTEGER ids that correspond to `artifacts.id`. **No action required** — per Amendment 1, `artifacts` is untouched, FKs remain valid.

### 1.2 Legacy integer-id external-storage audit (caveat #2)

**Grep:** `REFERENCES\s+(learnings|decisions|experience_patterns|angel_opinions|critical_rules|project_curated_context)\s*\(`

**Result — one hit:**
- `src/core/migration-steps.ts:1398`: `supersedes_id INTEGER REFERENCES project_curated_context(id)` (self-reference on `project_curated_context`).

**Also found but not an external REFERENCES clause:**
- `experience_patterns.id` is TEXT (UUID), not integer. No FK concern.
- `critical_rules.id` INTEGER PRIMARY KEY, no external REFERENCES.
- `decisions.id`, `learnings.id`, `angel_opinions.id` all INTEGER PRIMARY KEY AUTOINCREMENT, no external REFERENCES.

**Resolution:** Activated `legacy_id_map` per Amendment 2.

### 1.3 Write-path audit (caveat #3)

All callers grouped by legacy table:

**`learnings`** — 2 production INSERT paths, 2 test INSERT paths:
- `src/core/learnings.ts:35` — `INSERT INTO learnings (project, agent_id, fingerprint, content)`
- `src/angel/cross-project-consolidator.ts:102` — `INSERT INTO learnings ...`
- `src/cli/health.ts:389` — seed-row (CLI health check)
- `src/angel/consolidator.ts:626` — `UPDATE learnings SET promotion_count = 0 WHERE id = ?`
- Tests: `src/tests/intelligence/learnings-promoter.test.ts:207`, `src/tests/angel/guardian.test.ts:180`

**`decisions`** — 2 production paths, 3 test paths:
- `src/core/decisions.ts:80` — `UPDATE decisions SET content = ?, session_id = ?, source = ?, ...`
- `src/core/decisions.ts:88` — `INSERT INTO decisions (session_id, project, content, source, fingerprint)`
- `src/cli/health.ts:391` — seed-row
- Tests: `src/tests/angel/guardian.test.ts:214,1111,1142`, `src/tests/cli/projects-touched.test.ts:61`

**`experience_patterns`** — many paths (the most active table):
- `src/angel/cross-project-consolidator.ts:311` — INSERT
- `src/intelligence/experience-patterns.ts:393` — INSERT
- `src/intelligence/experience-patterns.ts:689` — UPDATE root_cause (string concat!)
- `src/intelligence/experience-patterns.ts:727` — UPDATE escalation_level
- `src/intelligence/experience-patterns.ts:1251` — UPDATE confidence
- `src/intelligence/experience-patterns.ts:1265` — UPDATE maturity
- `src/intelligence/experience-patterns.ts:1288` — UPDATE lesson, pattern_type
- `src/angel/heartbeat.ts:840,864,915,927` — UPDATE retrieval_mode / score / lesson
- `src/angel/proactive-curator.ts:578,587,693` — UPDATE generalized_rule
- `src/angel/pattern-extractor.ts:361,631` — UPDATE score/times_triggered, retrieval_mode/trigger_intents
- `src/intelligence/correction-detection.ts:402` — UPDATE root_cause
- `src/embeddings/embed-pipeline.ts:208` — UPDATE embedding
- `src/core/migration-steps.ts:920,925` — UPDATE maturity (inside migration, kind-internal)
- `src/assembly/assembler.ts:219,228` — UPDATE confidence, needs_reembed
- Tests: 3 test files

**`angel_opinions`** — 1 production path:
- `src/angel/cara-reasoning.ts:71` — `INSERT INTO angel_opinions (project, subject, opinion, source_type)`
- No production UPDATEs found.

**`critical_rules`** — 2 production INSERT paths, no UPDATEs:
- `src/intelligence/critical-reminders.ts:231,288` — INSERT

**`project_curated_context`** — 1 production INSERT path:
- `src/core/curated-context.ts:108` — `INSERT INTO project_curated_context ...`

**Computed UPDATE cases requiring special trigger handling (caveat #4):**
- `experience_patterns`: `score = score + 2, times_triggered = times_triggered + 1` (pattern-extractor.ts:361) — tests NEW.x-carries-evaluated-result path.
- `experience_patterns`: `root_cause = COALESCE(root_cause, '') || ' ' || ?` (experience-patterns.ts:689) — string concat via NEW.
- `artifacts`: `activation_score = MAX(?, activation_score - ?)` and `activation_score * 0.5` — **NOT affected** (artifacts untouched).
- `learnings`: `promotion_count = 0` (consolidator.ts:626) — trivial SET, no computation on RHS.

**All computed UPDATEs on migrated tables are on `experience_patterns` and use the `NEW.x = RHS_expr(...)` form.** SQLite evaluates NEW.column as the resolved post-expression value when firing INSTEAD OF UPDATE — we verify this empirically in Plan Audit #4 (see Plan #06).

### 1.4 Column-level index audit (caveat #5)

Indexes on the 6 migrated tables (from `schema.ts` / `migration-steps.ts`):

| Index | Columns | Port strategy |
|---|---|---|
| `idx_learnings_promo` | `(project, agent_id, promotion_count DESC)` | Express index on `artifact` — `(scope, session_id, json_extract(data, '$.agent_id'), json_extract(data, '$.promotion_count') DESC) WHERE kind='learning'` |
| `idx_decisions_session` | `(session_id, timestamp_epoch DESC)` | Kernel `session_id` already available; `created_at_epoch DESC` proxies `timestamp_epoch DESC`. Add `WHERE kind='decision'` partial index. |
| `idx_decisions_project` | `(project, timestamp_epoch DESC)` | Use `project_id` kernel col; partial index `WHERE kind='decision'`. |
| `idx_expat_project_score` | `(source_project, score DESC)` | Port to `(project_id, json_extract(data, '$.score') DESC) WHERE kind='experience_pattern'`. |
| `idx_expat_score` | `(score DESC, times_triggered DESC)` | Port to `(json_extract(data, '$.score') DESC, json_extract(data, '$.times_triggered') DESC) WHERE kind='experience_pattern'`. |
| `idx_opinions_project` | `(project, confidence DESC)` | Port to `(project_id, confidence DESC) WHERE kind='angel_opinion'` — confidence already in kernel. |
| `idx_critical_rules_project_source` | `(project, source)` | Port to partial expression index. |
| `idx_critical_rules_dedup` UNIQUE | `(project, rule_text)` | Port to UNIQUE partial expression index on `(project_id, body) WHERE kind='critical_rule'`. |
| `idx_pcc_project_status` | `(project, status)` | Kernel `project_id` + kernel `status`; partial `WHERE kind='mental_model'`. |
| `idx_pcc_project_type` | `(project, type, status)` | Port to `(project_id, json_extract(data, '$.type'), status) WHERE kind='mental_model'`. |

**UNIQUE constraints becoming UNIQUE partial indexes:**
- `learnings UNIQUE(project, agent_id, fingerprint)` — port to `CREATE UNIQUE INDEX uq_artifact_learning ON artifact(project_id, json_extract(data, '$.agent_id'), json_extract(data, '$.fingerprint')) WHERE kind='learning'`
- `decisions UNIQUE(session_id, fingerprint)` — port to `UNIQUE INDEX ... WHERE kind='decision'`
- `angel_opinions UNIQUE(project, subject)` — port to `UNIQUE INDEX ... WHERE kind='angel_opinion'`
- `critical_rules.idx_critical_rules_dedup UNIQUE` — already listed above.

**`experience_patterns.id` is TEXT PRIMARY KEY UUID** — preserved verbatim since `artifact.id TEXT PRIMARY KEY UUID` has matching semantics. This is the one legacy table where we keep the original id (TEXT UUID passes the `NEW.id if caller supplied` fill rule in Decision 5). Recorded in body-mapping as exception.

### 1.5 FTS5 caller audit (Amendment 4 addendum — new caveat #10)

**Grep:** `MATCH` against `learnings_fts`, `experience_patterns_fts`.

Call sites (needs porting to `artifact_fts`):
- `src/core/hybrid-retrieval.ts` — MATCH on both FTS5 tables (lines vary; investigation points to the pattern-channel lookup).
- `src/intelligence/experience-patterns.ts` — MATCH on `experience_patterns_fts` for trigger-signature match.
- `src/mcp/recall-server.ts` — MATCH on `learnings_fts` (session recall path).

**All call sites must migrate to `artifact_fts` filtered by `kind`:**
```sql
-- Old:
SELECT rowid FROM learnings_fts WHERE learnings_fts MATCH ?
-- New:
SELECT a.id FROM artifact_fts f JOIN artifact a ON a.rowid = f.rowid
WHERE artifact_fts MATCH ? AND a.kind = 'learning'
```

Exact grep in P1 (Plan #06) will enumerate; estimate 4–8 call sites.

---

## 2. Migration Mechanics — Implementation Detail

### 2.1 The single `composeBody(kind, legacyRow) → {title, body, data}` function

Lives at `src/core/migration/v17-compose.ts` (new file). Used by both Phase A (pre-embed staging) and Phase B (atomic INSERT). If drift, embeddings don't match search text and vec0 recall silently rots.

Signature:
```ts
export interface LegacyRow { [k: string]: unknown }
export interface Composed {
  title: string | null;
  body: string;
  data: Record<string, unknown>; // kind-specific JSON sidecar fields
  scope: 'session' | 'project' | 'universal';
  status: 'active' | 'stale' | 'archived' | 'superseded';
  confidence: number | null;
  session_id: string | null;
  project_id: string | null;
}

export function composeBody(kind: ArtifactKind, row: LegacyRow): Composed;
```

Per-kind behavior table (authoritative):

| kind | title | body | data keys | scope | project_id source | session_id source |
|---|---|---|---|---|---|---|
| `learning` | `row.content.slice(0, 80)` (pattern proxy) | `row.content` (full) | `{agent_id, fingerprint, promotion_count, first_seen_epoch, last_promoted_epoch}` | `project` | `row.project` | null |
| `decision` | first sentence of `row.content` | `row.content` | `{source, fingerprint, timestamp_epoch, alternatives: null}` | `project` | `row.project` | `row.session_id` |
| `experience_pattern` | `row.trigger_context` | `row.lesson + (row.anti_pattern ? "\n\nWhat went wrong: " + row.anti_pattern : "")` | `{pattern_type, severity, score, times_triggered, times_useful, last_triggered_epoch, trigger_glob, trigger_command, assumption, reality, root_cause, generalized_rule, abstraction_level, verified, verification_count, helpful_count, harmful_count, escalation_level, maturity, retrieval_mode, trigger_intents, needs_reembed}` | `project` | `row.source_project` | `row.source_session` |
| `angel_opinion` | `row.subject + ' — opinion'` | `row.opinion` | `{evidence_count, reinforced_count, weakened_count, contradicted_count, source_type}` | `project` | `row.project` | null |
| `critical_rule` | `row.rule_text.slice(0, 80)` | `row.rule_text` | `{variants, source, drift_risk, domain_tags, base_ttl, current_ttl, last_injected_turn, injection_count, violation_count, compliance_count}` | `project` | `row.project` | null |
| `mental_model` | `row.type + ' — ' + firstLine(row.content)` | `row.content` | `{type, tags, curator, trust_tier, _legacy_supersedes_id: row.supersedes_id}` | `project` | `row.project` | `row.source_session_id` |

**`confidence` kernel col:**
- `learning`: null
- `decision`: null
- `experience_pattern`: `row.confidence` (already REAL, default 0.5)
- `angel_opinion`: `row.confidence`
- `critical_rule`: null (not a confidence-bearing concept)
- `mental_model`: `row.trust_tier / 3.0` (normalize 1..3 → 0.33..1.0)

**`status` kernel col:**
- `learning`, `decision`, `experience_pattern`, `angel_opinion`, `critical_rule`: `'active'` (no legacy status)
- `mental_model`: `row.status` passed through (already 'active' | 'superseded' | 'proposed' | 'archived'; 'stale' gets set by stale-flag pass)

### 2.2 Trigger code generator (`src/core/migration/v17-triggers.ts`)

**Single source of truth:** One mapping table `KIND_MAPPING: Record<LegacyTable, KindMapping>` where each `KindMapping` declares:
- `kind: string` — artifact kind.
- `legacyCols: LegacyColSpec[]` — each with `name, type, storage ('kernel' | 'data.PATH'), direction ('read' | 'read-write')`.
- `computedFields: {name, extractExpr}[]` — cols defined as expressions (e.g., `title = row.rule_text.slice(0, 80)`).
- `viewSelect: string` — SELECT shape for the view (generated per column list).

**Generator emits per view:**
1. `CREATE VIEW {legacy_name} AS SELECT ... FROM artifact WHERE kind='{K}' ORDER BY created_at_epoch` — column projection preserves v3 order and types via aggressive CAST on JSON-extracted values.
2. `CREATE TRIGGER {legacy}_instead_insert INSTEAD OF INSERT ON {legacy_name} BEGIN ... END;` — inserts into `artifact` with composed kernel cols + JSON data.
3. `CREATE TRIGGER {legacy}_instead_update INSTEAD OF UPDATE ON {legacy_name} BEGIN ... END;` — per column: if kernel-mapped, `SET kernel_col = NEW.legacy_col`; if data-mapped, `SET data = json_set(data, '$.path', NEW.legacy_col)`; `updated_at_epoch = unixepoch()*1000`; `WHERE id = OLD.id` (or legacy id translated via `legacy_id_map`).
4. `CREATE TRIGGER {legacy}_instead_delete INSTEAD OF DELETE ON {legacy_name} BEGIN DELETE FROM artifact WHERE id = OLD.id AND kind='{K}'; END;`

Output: 6 views, 18 triggers (6 × 3). Total lines ~400 generated; generator itself is ~150 lines.

**Computed-UPDATE handling (caveat #4 / Plan Audit #4):**
For experience_patterns computed UPDATEs (e.g., `score = score + 2`), SQLite evaluates NEW.score as `OLD.score + 2` BEFORE firing the trigger. Plan Vitest verifies:
```sql
INSERT INTO experience_patterns(id, ..., score) VALUES ('x', ..., 5);
UPDATE experience_patterns SET score = score + 2 WHERE id = 'x';
-- Assert: SELECT json_extract(data, '$.score') FROM artifact WHERE id = 'x' → 7
```
If the assertion fails, fall back to explicit generator emission:
```sql
UPDATE artifact SET data = json_set(
  data, '$.score',
  CAST(json_extract(data, '$.score') AS INTEGER) + 2
) WHERE id = OLD.id;
```
— but this requires parsing the RHS expression in the planner, which is complex. **Primary plan:** trust NEW.x, write the test, fix if it fails.

### 2.3 Backup verifier — 6-check gate (Decision 10)

Module: `src/core/migration/v17-backup.ts`, CLI wrapper in `src/cli/migrate.ts`.

Pipeline (already spec'd in Decision 10):
```ts
async function createAndVerifyBackup(
  sourcePath: string,
  backupPath: string,
  opts: { loadVec: boolean }
): Promise<VerifyResult>
```
Steps:
1. `sqlite3 source.db ".backup 'backupPath'"` via `better-sqlite3.Database.backup()` (native API, not shell).
2. Open backup as separate connection, load sqlite-vec ext — **catch error, fail fast**.
3. `PRAGMA integrity_check` must return `'ok'`.
4. `PRAGMA quick_check` must return `'ok'`.
5. Row-count parity: for each of 6 legacy tables + `artifacts` + `artifact_links`, `SELECT COUNT(*)` in source vs backup must match.
6. vec0 smoke: `SELECT COUNT(*) FROM vec_artifacts LIMIT 1` (catch orphan shadow-table failure).
7. Close backup; compute SHA-256; append manifest row.

Manifest row format (in `.planning/phases/02-p1-artifact-table-unification/backup-manifest.md`):
```md
| timestamp | path | size_bytes | sha256 | integrity | quick | parity | vec0 | total_ms | verdict |
|---|---|---|---|---|---|---|---|---|---|
| 2026-04-20T12:34:56Z | ~/.claudex/backups/pre-v4-P1-1745145296000.db | 123456789 | abcd... | ok | ok | ok | ok | 1234 | PASS |
```

**Retention: 5 newest per phase per kind** — rotation logic in `rotateBackups(phase, kind)` uses `fs.readdir()` + sort by mtime, `fs.unlink()` the 6th+.

### 2.4 Stale-review flow (Decision 8)

**File:** `.planning/phases/02-p1-artifact-table-unification/stale-review.md` (git-tracked)

Format:
```md
## Heuristic matches (decision: stale unless flipped)
- id=42  | status=stale  | content="...Gemma 4 31B..."
- id=47  | status=stale  | content="...llama-server:8081..."

## Manual additions (decision: stale)
<!-- empty for this P1 run -->
```

**Parser:** Reads lines matching `^- id=(\d+) \| status=(stale|keep) \| content="..."$`, builds `Set<id>` of ids to flag. Migration Phase B issues `UPDATE artifact SET status='stale' WHERE id IN (resolved_uuids_via_legacy_id_map)` after rows migrated.

**Pre-approved per commit `c84dd61`** — orchestrator commits `stale-review.md` with all heuristic matches flagged stale, manual-additions empty. `migrate:dry-run` populates the heuristic section; `migrate:apply` reads it.

**Two-phase CLI:**
- `bun run migrate:v17:dry-run` — Phase A only (compose + embed + stage + write stale-review.md), no DB mutation.
- `bun run migrate:v17:apply` — reads stale-review.md (abort if missing or truncated), runs Phase B atomic tx.

---

## 3. Wave partitioning for PLAN.md files

Identified 7 plans, 3 waves. Dependency DAG:

```
Wave 1 (parallel):
  - P01: composeBody + KIND_MAPPING + unit tests
  - P02: backup verifier + manifest + CLI entry
  - P03: stale-review parser + file writer + schema

Wave 2 (depends on Wave 1):
  - P04: V17 DDL (artifact + registry + vec0 + fts5 + legacy_id_map) + generator
  - P05: migration runner (Phase A pre-embed + Phase B atomic tx) wiring P01+P02+P03+P04
  - P06: FTS5 caller port (grep + rewrite MATCH queries against learnings_fts/experience_patterns_fts)

Wave 3 (depends on Wave 2):
  - P07: Vitest additions (2 new tests — naming convention, computed UPDATE) + full-suite gate + bench gate + STATE.md entry
```

---

## 4. Known Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Ollama arctic-embed2 unavailable during Phase A | Phase A is outside tx. On failure: abort cleanly, no DB mutation. Retry allowed. |
| SQLite NEW.x doesn't carry evaluated RHS in INSTEAD OF UPDATE | Vitest #2 catches it at dry-run; generator fallback path exists (Plan #06 sub-task). |
| vec0 extension fails to load on backup connection | Check #2 of backup verifier fails → migration aborts before touching real tables. |
| Stale-review file hand-edited then committed with keep/stale flipped | Generator reads it literally; user's flips win. This is the intended affordance. |
| Migrated `project_curated_context.supersedes_id` dangles (target not in legacy_id_map) | Pass 2 update nulls it; INSTEAD OF trigger stores in `data._pending_supersedes` and resolves on next read. |
| Vitest suite fails after migration | Migration tx rolls back; backup still restorable; no permanent damage. |
| LoCoMo drops >2pp due to embedding recomposition | Known risk per scope doc. Mitigation: `composeBody` preserves full legacy content in `body`; title+body should carry same retrieval signal. If benchmark fails, re-embed path allows second attempt with alternate composition. |

---

## 5. Assumptions

1. `NEW.x` in SQLite INSTEAD OF UPDATE triggers carries post-expression value for computed RHS. **Verified by Vitest #2 before migration commit.**
2. `better-sqlite3.Database.backup()` produces a file that survives vec0 shadow-table load. Pattern from V14→V15 migration (`migrateV14toV15()`) is the reference.
3. FTS5 call sites on `learnings_fts` / `experience_patterns_fts` are ≤ 10. If >10, Plan #06 splits into 06a/06b.
4. Ollama arctic-embed2 is operational at migration time (batch=32, 1024d). If down, migration blocks with clear error.
5. The 6-table row count at migration time is O(10^4) per table — Phase A pre-embed completes in < 5 min.

---

## 6. Out of Scope for P1

- Hot-writer switch from view→trigger to direct `artifact` INSERT (deferred to post-P1 hardening per CONTEXT §deferred).
- `kind_registry.description` and `kind_registry.status` columns — YAGNI per CONTEXT.
- `.claude/rules/` auto-generation from path-scoped artifacts — deferred to P3/CUR-03.
- `entity_summary` migration (Amendment 1) — deferred to P5 or P9.
- `artifacts` / `artifacts_fts` / `vec_artifacts` changes (Amendment 1) — deferred to P5 or P9.
- `artifact_links` changes (auto-resolved by Amendment 1) — no action.
- P2.1 injection bug (unrelated — P4 scope per CONTEXT).
- Drop `artifacts_old` (no RENAME happens now; this deferral folds into P9 cleanup).

---

*Research locked: 2026-04-20. Ready for plan phase.*
