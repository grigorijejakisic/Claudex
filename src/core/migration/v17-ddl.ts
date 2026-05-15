/**
 * V17 DDL — unified artifact schema.
 *
 * Creates:
 *   - `artifact`            — kernel table (14 cols + JSON data sidecar)
 *   - `kind_registry`       — passive kind tracking (first_seen / last_seen)
 *   - `legacy_id_map`       — legacy INTEGER ↔ new UUID translation (Amendment 2)
 *   - `artifact_embeddings` — vec0 virtual table (float[1024], arctic-embed2 native)
 *   - `artifact_fts`        — FTS5 virtual table bound to `artifact` (title + body)
 *   - expression + partial indexes for every legacy access path (RESEARCH §1.4)
 *   - AFTER INSERT trigger for kind_registry sync
 *   - 3 AFTER triggers for artifact_fts sync (insert / update / delete)
 *
 * Idempotent (all IF NOT EXISTS). The migration RUNNER (Plan 02-05) decides
 * WHEN to call this — this module does not bump `user_version` by itself.
 */

import type { Database } from 'better-sqlite3';
import { loadSqliteVec } from '../sqlite-vec-loader.js';

/**
 * Apply all V17 DDL to `db`. Caller must ensure sqlite-vec is loadable
 * on this connection — `loadSqliteVec` is called internally and throws
 * if it fails (vec0 creation would fail silently otherwise).
 */
export function applyV17DDL(db: Database): void {
  // ── Kernel + registry + map ───────────────────────────────────────
  db.exec(ARTIFACT_KERNEL_DDL);
  db.exec(KIND_REGISTRY_DDL);
  db.exec(LEGACY_ID_MAP_DDL);
  db.exec(KERNEL_TRIGGERS_DDL);
  db.exec(EXPRESSION_INDEXES_DDL);

  // ── vec0 virtual table for embeddings ─────────────────────────────
  const loaded = loadSqliteVec(db);
  if (!loaded) {
    throw new Error(
      'applyV17DDL: sqlite-vec extension failed to load — cannot create artifact_embeddings',
    );
  }
  db.exec(ARTIFACT_EMBEDDINGS_DDL);

  // ── FTS5 virtual table + sync triggers ────────────────────────────
  db.exec(ARTIFACT_FTS_DDL);
}

export const ARTIFACT_KERNEL_DDL = `
CREATE TABLE IF NOT EXISTS artifact (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  title             TEXT,
  body              TEXT NOT NULL,
  scope             TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  confidence        REAL,
  created_at_epoch_ms  INTEGER NOT NULL,
  updated_at_epoch_ms  INTEGER NOT NULL,
  session_id        TEXT,
  project           TEXT,
  embedding_ref     INTEGER,
  supersedes_id     TEXT REFERENCES artifact(id),
  data              TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data))
);

CREATE INDEX IF NOT EXISTS idx_artifact_kind
  ON artifact(kind, created_at_epoch_ms DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_project
  ON artifact(project, kind, created_at_epoch_ms DESC);
CREATE INDEX IF NOT EXISTS idx_artifact_status
  ON artifact(status, kind);
`;

export const KIND_REGISTRY_DDL = `
CREATE TABLE IF NOT EXISTS kind_registry (
  kind             TEXT PRIMARY KEY,
  first_seen_epoch INTEGER NOT NULL,
  last_seen_epoch  INTEGER NOT NULL
);
`;

export const LEGACY_ID_MAP_DDL = `
CREATE TABLE IF NOT EXISTS legacy_id_map (
  legacy_table TEXT NOT NULL,
  legacy_id    INTEGER NOT NULL,
  new_uuid     TEXT NOT NULL REFERENCES artifact(id),
  PRIMARY KEY (legacy_table, legacy_id)
);
CREATE INDEX IF NOT EXISTS idx_legacy_id_map_uuid ON legacy_id_map(new_uuid);
`;

export const KERNEL_TRIGGERS_DDL = `
CREATE TRIGGER IF NOT EXISTS artifact_register_kind
AFTER INSERT ON artifact
BEGIN
  INSERT INTO kind_registry(kind, first_seen_epoch, last_seen_epoch)
    VALUES (NEW.kind, NEW.created_at_epoch_ms, NEW.created_at_epoch_ms)
  ON CONFLICT(kind) DO UPDATE SET last_seen_epoch = excluded.last_seen_epoch;
END;
`;

export const EXPRESSION_INDEXES_DDL = `
-- learnings (2 indexes)
CREATE INDEX IF NOT EXISTS idx_artifact_learning_agent
  ON artifact(project, json_extract(data, '$.agent_id'), json_extract(data, '$.promotion_count') DESC)
  WHERE kind = 'learning';
CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_learning
  ON artifact(project, json_extract(data, '$.agent_id'), json_extract(data, '$.fingerprint'))
  WHERE kind = 'learning';

-- decisions (3 indexes)
CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_decision
  ON artifact(session_id, json_extract(data, '$.fingerprint'))
  WHERE kind = 'decision';
CREATE INDEX IF NOT EXISTS idx_artifact_decision_session
  ON artifact(session_id, created_at_epoch_ms DESC)
  WHERE kind = 'decision';
CREATE INDEX IF NOT EXISTS idx_artifact_decision_project
  ON artifact(project, created_at_epoch_ms DESC)
  WHERE kind = 'decision';

-- experience_patterns (2 indexes)
CREATE INDEX IF NOT EXISTS idx_artifact_expat_score
  ON artifact(json_extract(data, '$.score') DESC, json_extract(data, '$.times_triggered') DESC)
  WHERE kind = 'experience_pattern';
CREATE INDEX IF NOT EXISTS idx_artifact_expat_project_score
  ON artifact(project, json_extract(data, '$.score') DESC)
  WHERE kind = 'experience_pattern';

-- angel_opinions (2 indexes)
CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_opinion
  ON artifact(project, json_extract(data, '$.subject'))
  WHERE kind = 'angel_opinion';
CREATE INDEX IF NOT EXISTS idx_artifact_opinion_confidence
  ON artifact(project, confidence DESC)
  WHERE kind = 'angel_opinion';

-- critical_rules (2 indexes)
CREATE INDEX IF NOT EXISTS idx_artifact_critrule_source
  ON artifact(project, json_extract(data, '$.source'))
  WHERE kind = 'critical_rule';
CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_critrule_dedup
  ON artifact(project, body)
  WHERE kind = 'critical_rule';

-- mental_model / project_curated_context (2 indexes)
CREATE INDEX IF NOT EXISTS idx_artifact_mentalmodel_status
  ON artifact(project, status)
  WHERE kind = 'mental_model';
CREATE INDEX IF NOT EXISTS idx_artifact_mentalmodel_type
  ON artifact(project, json_extract(data, '$.type'), status)
  WHERE kind = 'mental_model';
`;

export const ARTIFACT_EMBEDDINGS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_embeddings
  USING vec0(embedding float[1024]);
`;

export const ARTIFACT_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(
  title, body,
  content='artifact',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS artifact_fts_ai
AFTER INSERT ON artifact
BEGIN
  INSERT INTO artifact_fts(rowid, title, body)
    VALUES (new.rowid, COALESCE(new.title, ''), new.body);
END;

CREATE TRIGGER IF NOT EXISTS artifact_fts_au
AFTER UPDATE OF title, body ON artifact
BEGIN
  INSERT INTO artifact_fts(artifact_fts, rowid, title, body)
    VALUES ('delete', old.rowid, COALESCE(old.title, ''), old.body);
  INSERT INTO artifact_fts(rowid, title, body)
    VALUES (new.rowid, COALESCE(new.title, ''), new.body);
END;

CREATE TRIGGER IF NOT EXISTS artifact_fts_ad
AFTER DELETE ON artifact
BEGIN
  INSERT INTO artifact_fts(artifact_fts, rowid, title, body)
    VALUES ('delete', old.rowid, COALESCE(old.title, ''), old.body);
END;
`;
