"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/sqlite-vec/index.cjs
var require_sqlite_vec = __commonJS({
  "node_modules/sqlite-vec/index.cjs"(exports2, module2) {
    var { arch, platform } = require("node:process");
    var BASE_PACKAGE_NAME = "sqlite-vec";
    var ENTRYPOINT_BASE_NAME = "vec0";
    var supportedPlatforms = [["darwin", "x64"], ["linux", "x64"], ["darwin", "arm64"], ["win32", "x64"], ["linux", "arm64"]];
    var invalidPlatformErrorMessage = `Unsupported platform for ${BASE_PACKAGE_NAME}, on a ${platform}-${arch} machine. Supported platforms are (${supportedPlatforms.map(([p, a]) => `${p}-${a}`).join(",")}). Consult the ${BASE_PACKAGE_NAME} NPM package README for details.`;
    function validPlatform(platform2, arch2) {
      return supportedPlatforms.find(([p, a]) => platform2 === p && arch2 === a) !== void 0;
    }
    function extensionSuffix(platform2) {
      if (platform2 === "win32") return "dll";
      if (platform2 === "darwin") return "dylib";
      return "so";
    }
    function platformPackageName(platform2, arch2) {
      const os = platform2 === "win32" ? "windows" : platform2;
      return `${BASE_PACKAGE_NAME}-${os}-${arch2}`;
    }
    function getLoadablePath() {
      if (!validPlatform(platform, arch)) {
        throw new Error(
          invalidPlatformErrorMessage
        );
      }
      const packageName = platformPackageName(platform, arch);
      const loadablePath = require.resolve(packageName + "/" + ENTRYPOINT_BASE_NAME + "." + extensionSuffix(platform));
      return loadablePath;
    }
    function load(db) {
      db.loadExtension(getLoadablePath());
    }
    module2.exports = { getLoadablePath, load };
  }
});

// .tmp-backfill-term-entry.mjs
var tmp_backfill_term_entry_exports = {};
__export(tmp_backfill_term_entry_exports, {
  readLastTurnTexts: () => readLastTurnTexts,
  recordSessionTermination: () => recordSessionTermination,
  runMigrations: () => runMigrations
});
module.exports = __toCommonJS(tmp_backfill_term_entry_exports);

// src/core/stmt-cache.ts
var MAX_CACHE_SIZE = 256;
var stmtCache = /* @__PURE__ */ new WeakMap();
function cachedPrepare(db, sql) {
  let map = stmtCache.get(db);
  if (!map) {
    map = /* @__PURE__ */ new Map();
    stmtCache.set(db, map);
  }
  let stmt = map.get(sql);
  if (stmt) {
    map.delete(sql);
    map.set(sql, stmt);
    return stmt;
  }
  if (map.size >= MAX_CACHE_SIZE) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
  stmt = db.prepare(sql);
  map.set(sql, stmt);
  return stmt;
}

// src/core/session-termination.ts
function deriveOpenBlockers(db, sessionId) {
  try {
    const rows = cachedPrepare(
      db,
      `SELECT signal_type, target, detail
         FROM session_signals
        WHERE session_id = ?
          AND signal_type IN ('wip', 'danger', 'failure')
          AND cleared_at_epoch_ms IS NULL
          AND (expires_at_epoch_ms IS NULL OR expires_at_epoch_ms > ?)
        ORDER BY created_at_epoch_ms ASC`
    ).all(sessionId, Date.now());
    return rows.map((r) => ({
      signal_type: r.signal_type,
      target: r.target,
      detail: r.detail
    }));
  } catch {
    return [];
  }
}
function recordSessionTermination(db, opts) {
  try {
    const endedAt = opts.ended_at_epoch_ms ?? Date.now();
    let obsCount = 0;
    try {
      const row = cachedPrepare(
        db,
        `SELECT observation_count FROM sessions WHERE session_id = ?`
      ).get(opts.session_id);
      obsCount = row?.observation_count ?? 0;
    } catch {
    }
    const truncate = (s, n) => {
      if (s === null || s === void 0) return null;
      return s.length <= n ? s : s.slice(0, n);
    };
    let blockersJson = null;
    if (opts.open_blockers === void 0) {
      const derived = deriveOpenBlockers(db, opts.session_id);
      blockersJson = derived.length > 0 ? JSON.stringify(derived) : null;
    } else if (opts.open_blockers !== null) {
      blockersJson = opts.open_blockers.length > 0 ? JSON.stringify(opts.open_blockers) : null;
    }
    let hasOpenBlockers = false;
    try {
      const cols = db.prepare("PRAGMA table_info(session_termination)").all();
      hasOpenBlockers = cols.some((c) => c.name === "open_blockers");
    } catch {
    }
    if (hasOpenBlockers) {
      cachedPrepare(
        db,
        `INSERT OR REPLACE INTO session_termination
           (session_id, project, ended_at_epoch_ms, end_reason,
            last_user_directive, last_assistant_text, observation_count, recorded_at_epoch_ms,
            open_blockers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        opts.session_id,
        opts.project,
        endedAt,
        opts.end_reason,
        truncate(opts.last_user_directive, 4e3),
        truncate(opts.last_assistant_text, 4e3),
        obsCount,
        Date.now(),
        blockersJson
      );
    } else {
      cachedPrepare(
        db,
        `INSERT OR REPLACE INTO session_termination
           (session_id, project, ended_at_epoch_ms, end_reason,
            last_user_directive, last_assistant_text, observation_count, recorded_at_epoch_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        opts.session_id,
        opts.project,
        endedAt,
        opts.end_reason,
        truncate(opts.last_user_directive, 4e3),
        truncate(opts.last_assistant_text, 4e3),
        obsCount,
        Date.now()
      );
    }
    return true;
  } catch {
    return false;
  }
}
function readLastTurnTexts(db, sessionId) {
  let lastUser = null;
  let lastAssistant = null;
  try {
    const row = cachedPrepare(
      db,
      `SELECT user_text, assistant_text FROM conversation_turns
       WHERE session_id = ?
       ORDER BY turn_number DESC LIMIT 1`
    ).get(sessionId);
    if (row) {
      lastUser = row.user_text ?? null;
      lastAssistant = row.assistant_text ?? null;
    }
  } catch {
  }
  return { last_user_directive: lastUser, last_assistant_text: lastAssistant };
}

// src/core/migrations.ts
var import_better_sqlite3 = __toESM(require("better-sqlite3"), 1);

// src/shared/constants.ts
var DEFAULT_COMPACTION_INSTRUCTIONS = [
  "Preserve all file paths verbatim \u2014 do not abbreviate, shorten, or summarize paths.",
  "Preserve error messages and stack traces verbatim.",
  "Preserve architectural decisions and their rationale.",
  "Do NOT reproduce code blocks verbatim \u2014 reference the file path and function name instead.",
  "Strip old tool outputs (older than 10 turns) \u2014 they are stored in the observation database.",
  "The checkpoint (## Checkpoint section) is the authoritative state source. Preserve its content.",
  "Keep the most recent context gauge line verbatim."
].join("\n");
var DEFAULT_CONFIG = {
  schema: "claudex/config",
  version: 3,
  injection: {
    budget_tokens: 8e3,
    topic_shift_budget: 800
  },
  observations: {
    retention_days: 90,
    prune_threshold: 1e3,
    prune_count: 50
  },
  checkpoint: {
    debounce_seconds: 60,
    compaction_instructions: DEFAULT_COMPACTION_INSTRUCTIONS
  },
  learnings: {
    max_per_project: 50
  },
  enrichment: {
    enabled: true,
    provider: "auto",
    ollama_base_url: "http://localhost:11434",
    ollama_model: "auto",
    timeout_ms: 1e4
  },
  embeddings: {
    enabled: true,
    provider: "ollama",
    model: "snowflake-arctic-embed2",
    ollama_base_url: "http://localhost:11434",
    topic_shift_threshold: 0.35,
    topic_shift_window: 3,
    decision_confidence_threshold: 0.15,
    jaccard_shift_threshold: 0.15
  },
  observability: {
    enabled: true,
    retention_days: 7,
    retain_error_count: 1e3
  },
  context: {
    advisory_threshold: 0.5,
    warning_threshold: 0.65,
    critical_threshold: 0.8,
    checkpoint_cooldown_seconds: 300
  },
  features: {
    fts5_search: true,
    error_fingerprint: false
  },
  // v6 routing surface (Phase 10) — defaults locked from .planning/phases/10-conditional-ship/10-CONTEXT.md decisions 1-3
  v6: {
    routing: {
      top_k_per_artifact: 3,
      max_k_per_query: 12,
      token_pct_cap: 15,
      bi_encoder_budget_pct: 50,
      reranker_mode: "bi_encoder_primary"
    }
  }
};
var PRESSURE_ZONES = {
  normal: { max: DEFAULT_CONFIG.context.advisory_threshold },
  advisory: { min: DEFAULT_CONFIG.context.advisory_threshold, max: DEFAULT_CONFIG.context.warning_threshold },
  warning: { min: DEFAULT_CONFIG.context.warning_threshold, max: DEFAULT_CONFIG.context.critical_threshold },
  critical: { min: DEFAULT_CONFIG.context.critical_threshold }
};

// src/core/schema.ts
var SHAPE_VOCABULARY_SCHEMA = `
CREATE TABLE IF NOT EXISTS shape_vocabulary (
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  promoted_at_epoch INTEGER NOT NULL,
  promoted_session_count INTEGER NOT NULL,
  PRIMARY KEY (field, value)
);

CREATE TABLE IF NOT EXISTS shape_candidates (
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  proposed_at_epoch INTEGER NOT NULL,
  PRIMARY KEY (field, value, session_id)
);

CREATE INDEX IF NOT EXISTS idx_shape_candidates_field_value
  ON shape_candidates(field, value);

CREATE TABLE IF NOT EXISTS critical_rules_multi_project (
  project TEXT NOT NULL,
  normalized_rule_text TEXT NOT NULL,
  multi_project_count INTEGER NOT NULL,
  updated_at_epoch INTEGER NOT NULL,
  PRIMARY KEY (project, normalized_rule_text)
);

CREATE INDEX IF NOT EXISTS idx_crmp_norm_text
  ON critical_rules_multi_project(normalized_rule_text);
`;
var ARTIFACT_TASK_PATTERN_SCHEMA = `
CREATE TABLE IF NOT EXISTS artifact_task_pattern (
  artifact_id INTEGER NOT NULL,
  task_pattern TEXT NOT NULL,
  classified_at_epoch_ms INTEGER NOT NULL,
  classifier_confidence REAL NOT NULL DEFAULT 1.0,
  classifier_source TEXT NOT NULL CHECK (classifier_source IN ('write_time', 'heartbeat_backfill')),
  PRIMARY KEY (artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_artifact_task_pattern_pattern
  ON artifact_task_pattern(task_pattern);
`;
var TELEMETRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'hook_invocation', 'injection', 'observation_capture', 'decision_capture',
    'checkpoint_write', 'enrichment', 'topic_shift', 'dedup', 'decay_prune', 'error',
    'reranker_fallback',
    'cross_project_ambiguous', 'cross_project_query_expansion',
    'episodic_write_failure',
    'signal_reread_after_surface', 'signal_retrieval_fallback',
    'signal_transcript_injection_acceptance', 'signal_retrieved_but_unapplied',
    'handoff_parse_failed',
    'session_end_action',
    're_vectorize_failed',
    'soft_link_skipped', 'soft_link_write_failed',
    'chr_boundary_detected', 'chr_no_boundary', 'chr_classify_failed', 'chr_throttled'
  )),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  latency_ms REAL,
  timestamp_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  adapter TEXT DEFAULT 'unknown'
);

CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry(session_id, timestamp_epoch_ms DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_kind ON telemetry(event_kind, timestamp_epoch_ms DESC);
`;
var POINTER_RECALL_SCHEMA = `
CREATE TABLE IF NOT EXISTS lesson_pointer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  filename TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('lesson','user_note')),
  first_seen_epoch_ms INTEGER NOT NULL,
  UNIQUE(project, filename, source)
);
CREATE INDEX IF NOT EXISTS idx_lesson_pointer_project ON lesson_pointer(project);

CREATE TABLE IF NOT EXISTS pointer_recall_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pointer_id INTEGER NOT NULL REFERENCES lesson_pointer(id),
  session_id TEXT NOT NULL,
  retrieved_at_epoch_ms INTEGER NOT NULL,
  helpful_yn INTEGER NULL,
  query TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_pointer_recall_pointer
  ON pointer_recall_log(pointer_id, retrieved_at_epoch_ms DESC);
CREATE INDEX IF NOT EXISTS idx_pointer_recall_session
  ON pointer_recall_log(session_id);
CREATE INDEX IF NOT EXISTS idx_pointer_recall_helpful
  ON pointer_recall_log(pointer_id, helpful_yn) WHERE helpful_yn = 1;
`;
var SCHEMA_V22 = `
CREATE TABLE IF NOT EXISTS retrieval_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  invoked_at_epoch_ms INTEGER NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN (
    'claudex_search', 'claudex_recall', 'pointer_surface', 'mcp_other'
  )),
  query TEXT,
  top_k_results TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(top_k_results)),
  used_in_output INTEGER NOT NULL DEFAULT 0
    CHECK (used_in_output IN (0, 1)),
  token_cost INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_retrieval_log_session
  ON retrieval_log(session_id, invoked_at_epoch_ms DESC);

CREATE TABLE IF NOT EXISTS session_flag (
  session_id TEXT NOT NULL,
  flag_key TEXT NOT NULL,
  flag_value TEXT NOT NULL DEFAULT '1',
  set_at_epoch_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, flag_key)
);
`;

// src/core/sqlite-vec-loader.ts
var loadAttempted = false;
var loadSucceeded = false;
var loadErrorMessage = null;
function loadSqliteVec(db) {
  try {
    const sqliteVec = require_sqlite_vec();
    sqliteVec.load(db);
    const row = db.prepare("SELECT vec_version() AS v").get();
    if (!row?.v) {
      if (!loadAttempted) {
        loadErrorMessage = "vec_version() returned null after load";
        loadAttempted = true;
      }
      return false;
    }
    loadAttempted = true;
    loadSucceeded = true;
    loadErrorMessage = null;
    return true;
  } catch (err) {
    if (!loadAttempted) {
      loadErrorMessage = err instanceof Error ? err.message : String(err);
      loadAttempted = true;
      loadSucceeded = false;
      process.stderr.write(
        `[sqlite-vec] failed to load: ${loadErrorMessage} \u2014 vec0 tables unavailable, falling back to Qdrant
`
      );
    }
    return false;
  }
}

// src/core/migration/v17-ddl.ts
function applyV17DDL(db) {
  db.exec(ARTIFACT_KERNEL_DDL);
  db.exec(KIND_REGISTRY_DDL);
  db.exec(LEGACY_ID_MAP_DDL);
  db.exec(KERNEL_TRIGGERS_DDL);
  db.exec(EXPRESSION_INDEXES_DDL);
  const loaded = loadSqliteVec(db);
  if (!loaded) {
    throw new Error(
      "applyV17DDL: sqlite-vec extension failed to load \u2014 cannot create artifact_embeddings"
    );
  }
  db.exec(ARTIFACT_EMBEDDINGS_DDL);
  db.exec(ARTIFACT_FTS_DDL);
}
var ARTIFACT_KERNEL_DDL = `
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
var KIND_REGISTRY_DDL = `
CREATE TABLE IF NOT EXISTS kind_registry (
  kind                TEXT PRIMARY KEY,
  first_seen_epoch_ms INTEGER NOT NULL,
  last_seen_epoch_ms  INTEGER NOT NULL
);
`;
var LEGACY_ID_MAP_DDL = `
CREATE TABLE IF NOT EXISTS legacy_id_map (
  legacy_table TEXT NOT NULL,
  legacy_id    INTEGER NOT NULL,
  new_uuid     TEXT NOT NULL REFERENCES artifact(id),
  PRIMARY KEY (legacy_table, legacy_id)
);
CREATE INDEX IF NOT EXISTS idx_legacy_id_map_uuid ON legacy_id_map(new_uuid);
`;
var KERNEL_TRIGGERS_DDL = `
CREATE TRIGGER IF NOT EXISTS artifact_register_kind
AFTER INSERT ON artifact
BEGIN
  INSERT INTO kind_registry(kind, first_seen_epoch_ms, last_seen_epoch_ms)
    VALUES (NEW.kind, NEW.created_at_epoch_ms, NEW.created_at_epoch_ms)
  ON CONFLICT(kind) DO UPDATE SET last_seen_epoch_ms = excluded.last_seen_epoch_ms;
END;
`;
var EXPRESSION_INDEXES_DDL = `
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
var ARTIFACT_EMBEDDINGS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_embeddings
  USING vec0(embedding float[1024]);
`;
var ARTIFACT_FTS_DDL = `
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

// src/core/migration-steps.ts
function hasTable(db, table) {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return row.cnt > 0;
}
function hasColumn(db, table, column) {
  const cols = db.pragma(`table_info(${table})`);
  return cols.some((c) => c.name === column);
}
function ensureAdapterColumns(db) {
  if (hasTable(db, "sessions") && !hasColumn(db, "sessions", "adapter")) {
    db.exec("ALTER TABLE sessions ADD COLUMN adapter TEXT DEFAULT 'unknown'");
  }
  const telemetryCols = db.pragma("table_info(telemetry)");
  if (telemetryCols.length > 0 && !telemetryCols.some((c) => c.name === "adapter")) {
    db.exec("ALTER TABLE telemetry ADD COLUMN adapter TEXT DEFAULT 'unknown'");
  }
}
function migrateV1toV2(db) {
  if (hasTable(db, "pressure_scores") && hasColumn(db, "pressure_scores", "last_accessed_epoch") && !hasColumn(db, "pressure_scores", "last_touched_epoch")) {
    db.exec("ALTER TABLE pressure_scores ADD COLUMN last_touched_epoch INTEGER");
    db.exec("UPDATE pressure_scores SET last_touched_epoch = last_accessed_epoch");
  }
  if (!hasColumn(db, "observations", "consumed")) {
    db.exec("ALTER TABLE observations ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(db, "observations", "obs_type")) {
    db.exec("ALTER TABLE observations ADD COLUMN obs_type TEXT");
  }
  ensureAdapterColumns(db);
  const tsCol = hasColumn(db, "observations", "timestamp_epoch_ms") ? "timestamp_epoch_ms" : "timestamp_epoch";
  db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_consumed ON observations(project, consumed, ${tsCol} DESC)`);
}
function migrateV2toV3(db) {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    if (!tables.includes("artifacts")) return true;
    try {
      db.exec(`SAVEPOINT v3_probe`);
      db.exec(`INSERT INTO artifacts (session_id, project, artifact_type, artifact_ref, summary, state, ttl, importance)
        VALUES ('__v3_probe__', '__v3_probe__', 'memory_file', NULL, '__v3_probe__', 'packed', 0, 1)`);
      db.exec(`ROLLBACK TO v3_probe`);
      db.exec(`RELEASE v3_probe`);
      return true;
    } catch {
      try {
        db.exec("ROLLBACK TO v3_probe");
      } catch {
      }
      try {
        db.exec("RELEASE v3_probe");
      } catch {
      }
    }
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE artifacts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          artifact_type TEXT NOT NULL CHECK (artifact_type IN (
            'observation', 'learning', 'decision', 'hot_file', 'flow', 'milestone',
            'memory_file', 'session_log', 'handoff'
          )),
          artifact_ref TEXT,
          summary TEXT NOT NULL,
          content TEXT,
          state TEXT NOT NULL DEFAULT 'fresh'
            CHECK (state IN ('fresh', 'packed', 'materialized')),
          ttl INTEGER NOT NULL DEFAULT 3,
          importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
          timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
          last_materialized_epoch INTEGER
        );
        INSERT INTO artifacts_new (id, session_id, project, artifact_type, artifact_ref,
        summary, content, state, ttl, importance, timestamp_epoch, last_materialized_epoch)
      SELECT id, session_id, project, artifact_type, artifact_ref,
        summary, content, state, ttl, importance, timestamp_epoch, last_materialized_epoch
      FROM artifacts;
        DROP TABLE artifacts;
        ALTER TABLE artifacts_new RENAME TO artifacts;
        CREATE INDEX IF NOT EXISTS idx_artifacts_project_state ON artifacts(project, state);
        CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(artifact_type);
      `);
      db.exec("COMMIT");
      return true;
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {
      }
      return false;
    }
  } catch {
    return false;
  }
}
function migrateV3toV4(db) {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((t) => t.name);
    if (!tables.includes("artifacts_fts")) {
      db.exec(`
        CREATE VIRTUAL TABLE artifacts_fts USING fts5(
          summary, content, content=artifacts, content_rowid=id,
          tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS artifacts_fts_insert AFTER INSERT ON artifacts BEGIN
          INSERT INTO artifacts_fts(rowid, summary, content)
          VALUES (new.id, new.summary, COALESCE(new.content, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS artifacts_fts_update AFTER UPDATE OF summary, content ON artifacts BEGIN
          INSERT INTO artifacts_fts(artifacts_fts, rowid, summary, content)
          VALUES ('delete', old.id, old.summary, COALESCE(old.content, ''));
          INSERT INTO artifacts_fts(rowid, summary, content)
          VALUES (new.id, new.summary, COALESCE(new.content, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS artifacts_fts_delete AFTER DELETE ON artifacts BEGIN
          INSERT INTO artifacts_fts(artifacts_fts, rowid, summary, content)
          VALUES ('delete', old.id, old.summary, COALESCE(old.content, ''));
        END;
      `);
      db.exec(`INSERT INTO artifacts_fts(rowid, summary, content) SELECT id, summary, COALESCE(content, '') FROM artifacts`);
    }
    if (!tables.includes("context_triggers")) {
      db.exec(`CREATE TABLE context_triggers (id INTEGER PRIMARY KEY AUTOINCREMENT, glob_pattern TEXT, command_pattern TEXT, knowledge_domain TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 5, project TEXT NOT NULL DEFAULT '__global__');`);
    }
    if (!tables.includes("session_events")) {
      db.exec(`CREATE TABLE session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT NOT NULL, event_type TEXT NOT NULL, entity TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()));
        CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(project, timestamp_epoch);`);
    }
    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_file_ref ON artifacts(project, artifact_type, artifact_ref) WHERE artifact_ref IS NOT NULL AND artifact_type IN ('memory_file', 'session_log', 'handoff')`);
    } catch {
    }
    const artCols = db.pragma("table_info(artifacts)").map((c) => c.name);
    if (!artCols.includes("retrieval_score")) {
      db.exec("ALTER TABLE artifacts ADD COLUMN retrieval_score REAL NOT NULL DEFAULT 1.0");
    }
    if (tables.includes("experience_patterns")) {
      const epCols = db.pragma("table_info(experience_patterns)").map((c) => c.name);
      if (!epCols.includes("trigger_glob")) db.exec("ALTER TABLE experience_patterns ADD COLUMN trigger_glob TEXT");
      if (!epCols.includes("trigger_command")) db.exec("ALTER TABLE experience_patterns ADD COLUMN trigger_command TEXT");
    }
    const sessCols = db.pragma("table_info(sessions)").map((c) => c.name);
    if (!sessCols.includes("session_summary")) db.exec("ALTER TABLE sessions ADD COLUMN session_summary TEXT");
  } catch {
  }
}
function migrateV4toV5(db) {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    if (!tables.includes("retrieval_feedback")) {
      db.exec(`CREATE TABLE retrieval_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, artifact_id INTEGER NOT NULL, query_text TEXT NOT NULL, was_useful INTEGER NOT NULL DEFAULT 0, created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()));
        CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_artifact ON retrieval_feedback(artifact_id);
        CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_session ON retrieval_feedback(session_id);`);
    }
    if (tables.includes("reasoning_chains")) {
      try {
        db.exec(`UPDATE reasoning_chains SET timestamp_epoch = timestamp_epoch / 1000 WHERE timestamp_epoch > 10000000000`);
        db.exec(`UPDATE reasoning_chains SET created_at_epoch = created_at_epoch / 1000 WHERE created_at_epoch > 10000000000`);
      } catch {
      }
    }
    try {
      db.exec(`UPDATE observations SET content = '' WHERE content IS NULL`);
      db.exec(`UPDATE observations SET access_count = 0 WHERE access_count IS NULL`);
      db.exec(`UPDATE sessions SET status = 'completed' WHERE status IS NULL`);
      db.exec(`UPDATE sessions SET observation_count = 0 WHERE observation_count IS NULL`);
      db.exec(`UPDATE pressure_scores SET temperature = 'COLD' WHERE temperature IS NULL`);
      db.exec(`UPDATE pressure_scores SET last_touched_epoch = 0 WHERE last_touched_epoch IS NULL`);
      db.exec(`UPDATE pressure_scores SET decay_rate = 0.1 WHERE decay_rate IS NULL`);
      db.exec(`UPDATE session_journal SET timestamp_epoch = 0 WHERE timestamp_epoch IS NULL`);
    } catch {
    }
  } catch {
  }
}
function migrateV5toV6(db) {
  try {
    if (hasTable(db, "session_journal") && !hasColumn(db, "session_journal", "metadata")) {
      db.exec("ALTER TABLE session_journal ADD COLUMN metadata TEXT");
    }
    if (hasTable(db, "session_journal")) {
      try {
        db.exec("SAVEPOINT v6_sj_probe");
        db.exec("INSERT INTO session_journal (session_id, project, entry_type, content, timestamp_epoch) VALUES ('__probe__', '__probe__', 'flow', '__probe__', NULL)");
        db.exec("ROLLBACK TO v6_sj_probe");
        db.exec("RELEASE v6_sj_probe");
        db.exec("BEGIN");
        db.exec(`CREATE TABLE session_journal_new (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT NOT NULL, entry_type TEXT NOT NULL CHECK (entry_type IN ('flow', 'milestone', 'summary')), content TEXT NOT NULL, metadata TEXT, timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()))`);
        db.exec(`INSERT INTO session_journal_new (id, session_id, project, entry_type, content, metadata, timestamp_epoch) SELECT id, session_id, project, entry_type, content, metadata, COALESCE(timestamp_epoch, 0) FROM session_journal`);
        db.exec("DROP TABLE session_journal");
        db.exec("ALTER TABLE session_journal_new RENAME TO session_journal");
        db.exec("COMMIT");
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {
        }
        try {
          db.exec("ROLLBACK TO v6_sj_probe");
        } catch {
        }
        try {
          db.exec("RELEASE v6_sj_probe");
        } catch {
        }
      }
    }
    if (hasTable(db, "sessions")) {
      try {
        db.exec("SAVEPOINT v6_sess_probe");
        db.exec("INSERT INTO sessions (session_id, status) VALUES ('__v6_probe__', NULL)");
        db.exec("ROLLBACK TO v6_sess_probe");
        db.exec("RELEASE v6_sess_probe");
        db.exec("BEGIN");
        db.exec(`CREATE TABLE sessions_new (session_id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'unknown', project TEXT NOT NULL DEFAULT '__global__', cwd TEXT NOT NULL DEFAULT '.', source TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')), observation_count INTEGER NOT NULL DEFAULT 0, created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()), ended_at_epoch INTEGER, adapter TEXT DEFAULT 'unknown', session_summary TEXT)`);
        db.exec(`INSERT INTO sessions_new SELECT session_id, COALESCE(scope, 'unknown'), COALESCE(project, '__global__'), COALESCE(cwd, '.'), source, COALESCE(status, 'completed'), COALESCE(observation_count, 0), created_at_epoch, ended_at_epoch, adapter, session_summary FROM sessions`);
        db.exec("DROP TABLE sessions");
        db.exec("ALTER TABLE sessions_new RENAME TO sessions");
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project, created_at_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, created_at_epoch DESC)");
        db.exec("COMMIT");
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {
        }
        try {
          db.exec("ROLLBACK TO v6_sess_probe");
        } catch {
        }
        try {
          db.exec("RELEASE v6_sess_probe");
        } catch {
        }
      }
    }
    if (hasTable(db, "observations")) {
      try {
        db.exec("SAVEPOINT v6_obs_probe");
        db.exec("INSERT INTO observations (session_id, tool_name, category, title, content, importance) VALUES ('__v6__', 'Test', 'code', 'test', NULL, 1)");
        db.exec("ROLLBACK TO v6_obs_probe");
        db.exec("RELEASE v6_obs_probe");
        db.exec("BEGIN");
        db.exec("DROP TRIGGER IF EXISTS observations_ai");
        db.exec("DROP TRIGGER IF EXISTS observations_ad");
        db.exec("DROP TRIGGER IF EXISTS observations_au");
        db.exec(`CREATE TABLE observations_new (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT, tool_name TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('code', 'architecture', 'decision', 'error', 'test', 'config', 'dependency', 'documentation', 'performance', 'security', 'other')), title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5), files_modified TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_modified)), timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()), access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at_epoch INTEGER, deleted_at_epoch INTEGER DEFAULT NULL, consumed INTEGER NOT NULL DEFAULT 0, obs_type TEXT)`);
        db.exec(`INSERT INTO observations_new SELECT id, session_id, project, tool_name, category, title, COALESCE(content, ''), importance, files_modified, timestamp_epoch, COALESCE(access_count, 0), last_accessed_at_epoch, deleted_at_epoch, consumed, obs_type FROM observations`);
        db.exec("DROP TABLE observations");
        db.exec("ALTER TABLE observations_new RENAME TO observations");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_importance ON observations(importance DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_composite ON observations(tool_name, category, project, session_id, timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project_active ON observations(project, deleted_at_epoch, timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project_importance ON observations(project, deleted_at_epoch, importance)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_consumed ON observations(project, consumed, timestamp_epoch DESC)");
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END`);
        db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
        db.exec("COMMIT");
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {
        }
        try {
          db.exec("ROLLBACK TO v6_obs_probe");
        } catch {
        }
        try {
          db.exec("RELEASE v6_obs_probe");
        } catch {
        }
      }
    }
    if (hasTable(db, "pressure_scores")) {
      try {
        db.exec("SAVEPOINT v6_ps_probe");
        db.exec("INSERT INTO pressure_scores (file_path, project, raw_pressure, temperature) VALUES ('__probe__', '__probe__', 0, NULL)");
        db.exec("ROLLBACK TO v6_ps_probe");
        db.exec("RELEASE v6_ps_probe");
        db.exec("BEGIN");
        db.exec(`CREATE TABLE pressure_scores_new (file_path TEXT NOT NULL, project TEXT NOT NULL, raw_pressure REAL NOT NULL DEFAULT 0, temperature TEXT NOT NULL DEFAULT 'COLD', last_touched_epoch INTEGER NOT NULL DEFAULT 0, decay_rate REAL NOT NULL DEFAULT 0.1, PRIMARY KEY (file_path, project))`);
        db.exec(`INSERT OR IGNORE INTO pressure_scores_new (file_path, project, raw_pressure, temperature, last_touched_epoch, decay_rate) SELECT file_path, project, raw_pressure, COALESCE(temperature, 'COLD'), COALESCE(last_touched_epoch, 0), COALESCE(decay_rate, 0.1) FROM pressure_scores`);
        db.exec("DROP TABLE pressure_scores");
        db.exec("ALTER TABLE pressure_scores_new RENAME TO pressure_scores");
        db.exec("COMMIT");
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {
        }
        try {
          db.exec("ROLLBACK TO v6_ps_probe");
        } catch {
        }
        try {
          db.exec("RELEASE v6_ps_probe");
        } catch {
        }
      }
    }
  } catch {
  }
}
function migrateV6toV7(db) {
  try {
    if (hasTable(db, "sessions")) {
      try {
        db.exec("SAVEPOINT v7_sess_probe");
        db.exec("INSERT INTO sessions (session_id, status) VALUES ('__v7_probe__', NULL)");
        db.exec("ROLLBACK TO v7_sess_probe");
        db.exec("RELEASE v7_sess_probe");
        db.exec("BEGIN");
        db.exec(`CREATE TABLE sessions_new (session_id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'unknown', project TEXT NOT NULL DEFAULT '__global__', cwd TEXT NOT NULL DEFAULT '.', source TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')), observation_count INTEGER NOT NULL DEFAULT 0, created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()), ended_at_epoch INTEGER, adapter TEXT DEFAULT 'unknown', session_summary TEXT)`);
        db.exec(`INSERT INTO sessions_new SELECT session_id, COALESCE(scope, 'unknown'), COALESCE(project, '__global__'), COALESCE(cwd, '.'), source, COALESCE(status, 'completed'), COALESCE(observation_count, 0), created_at_epoch, ended_at_epoch, adapter, session_summary FROM sessions`);
        db.exec("DROP TABLE sessions");
        db.exec("ALTER TABLE sessions_new RENAME TO sessions");
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project, created_at_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, created_at_epoch DESC)");
        db.exec("COMMIT");
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {
        }
        try {
          db.exec("ROLLBACK TO v7_sess_probe");
        } catch {
        }
        try {
          db.exec("RELEASE v7_sess_probe");
        } catch {
        }
      }
    }
    if (hasTable(db, "observations")) {
      try {
        db.exec("SAVEPOINT v7_obs_probe");
        db.exec("INSERT INTO observations (session_id, tool_name, category, title, content, importance) VALUES ('__v7__', 'Test', 'code', 'test', NULL, 1)");
        db.exec("ROLLBACK TO v7_obs_probe");
        db.exec("RELEASE v7_obs_probe");
        try {
          db.exec("UPDATE observations SET category = 'code' WHERE category NOT IN ('code','architecture','decision','error','test','config','dependency','documentation','performance','security','other')");
        } catch {
        }
        db.exec("BEGIN");
        db.exec("DROP TRIGGER IF EXISTS observations_ai");
        db.exec("DROP TRIGGER IF EXISTS observations_ad");
        db.exec("DROP TRIGGER IF EXISTS observations_au");
        db.exec(`CREATE TABLE observations_new (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT, tool_name TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('code', 'architecture', 'decision', 'error', 'test', 'config', 'dependency', 'documentation', 'performance', 'security', 'other')), title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5), files_modified TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_modified)), timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()), access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at_epoch INTEGER, deleted_at_epoch INTEGER DEFAULT NULL, consumed INTEGER NOT NULL DEFAULT 0, obs_type TEXT)`);
        db.exec(`INSERT INTO observations_new SELECT id, session_id, project, tool_name, category, title, COALESCE(content, ''), importance, files_modified, timestamp_epoch, COALESCE(access_count, 0), last_accessed_at_epoch, deleted_at_epoch, consumed, obs_type FROM observations`);
        db.exec("DROP TABLE observations");
        db.exec("ALTER TABLE observations_new RENAME TO observations");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_importance ON observations(importance DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_composite ON observations(tool_name, category, project, session_id, timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project_active ON observations(project, deleted_at_epoch, timestamp_epoch DESC)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_project_importance ON observations(project, deleted_at_epoch, importance)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_obs_consumed ON observations(project, consumed, timestamp_epoch DESC)");
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN INSERT INTO observations_fts(observations_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); INSERT INTO observations_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END`);
        db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
        db.exec("COMMIT");
      } catch {
        try {
          db.exec("ROLLBACK");
        } catch {
        }
        try {
          db.exec("ROLLBACK TO v7_obs_probe");
        } catch {
        }
        try {
          db.exec("RELEASE v7_obs_probe");
        } catch {
        }
      }
    }
  } catch {
  }
}
function migrateV7toV8(db) {
  try {
    if (hasTable(db, "session_journal") && !hasColumn(db, "session_journal", "recall_text")) {
      db.exec("ALTER TABLE session_journal ADD COLUMN recall_text TEXT");
    }
    if (hasTable(db, "session_journal") && !hasTable(db, "session_journal_fts")) {
      db.exec(`
        CREATE VIRTUAL TABLE session_journal_fts USING fts5(
          content, recall_text, content='session_journal', content_rowid=id, tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS journal_fts_ai AFTER INSERT ON session_journal BEGIN
          INSERT INTO session_journal_fts(rowid, content, recall_text) VALUES (new.id, new.content, COALESCE(new.recall_text, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS journal_fts_ad AFTER DELETE ON session_journal BEGIN
          INSERT INTO session_journal_fts(session_journal_fts, rowid, content, recall_text) VALUES ('delete', old.id, old.content, COALESCE(old.recall_text, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS journal_fts_au AFTER UPDATE ON session_journal BEGIN
          INSERT INTO session_journal_fts(session_journal_fts, rowid, content, recall_text) VALUES ('delete', old.id, old.content, COALESCE(old.recall_text, ''));
          INSERT INTO session_journal_fts(rowid, content, recall_text) VALUES (new.id, new.content, COALESCE(new.recall_text, ''));
        END;
      `);
      try {
        db.exec("INSERT INTO session_journal_fts(session_journal_fts) VALUES('rebuild')");
      } catch {
      }
    }
  } catch {
  }
}
function migrateV8toV9(db) {
  try {
    if (hasTable(db, "artifacts")) {
      if (!hasColumn(db, "artifacts", "embedding")) db.exec("ALTER TABLE artifacts ADD COLUMN embedding BLOB");
      if (!hasColumn(db, "artifacts", "activation_score")) db.exec("ALTER TABLE artifacts ADD COLUMN activation_score REAL NOT NULL DEFAULT 1.0");
      if (!hasColumn(db, "artifacts", "superseded_by")) db.exec("ALTER TABLE artifacts ADD COLUMN superseded_by INTEGER");
      if (!hasColumn(db, "artifacts", "valid_until")) db.exec("ALTER TABLE artifacts ADD COLUMN valid_until INTEGER");
      if (!hasColumn(db, "artifacts", "confidence")) db.exec("ALTER TABLE artifacts ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0");
      if (!hasColumn(db, "artifacts", "novelty_score")) db.exec("ALTER TABLE artifacts ADD COLUMN novelty_score REAL NOT NULL DEFAULT 0.5");
    }
    if (hasTable(db, "experience_patterns")) {
      if (!hasColumn(db, "experience_patterns", "embedding")) db.exec("ALTER TABLE experience_patterns ADD COLUMN embedding BLOB");
      if (!hasColumn(db, "experience_patterns", "assumption")) db.exec("ALTER TABLE experience_patterns ADD COLUMN assumption TEXT");
      if (!hasColumn(db, "experience_patterns", "reality")) db.exec("ALTER TABLE experience_patterns ADD COLUMN reality TEXT");
      if (!hasColumn(db, "experience_patterns", "root_cause")) db.exec("ALTER TABLE experience_patterns ADD COLUMN root_cause TEXT");
      if (!hasColumn(db, "experience_patterns", "generalized_rule")) db.exec("ALTER TABLE experience_patterns ADD COLUMN generalized_rule TEXT");
      if (!hasColumn(db, "experience_patterns", "abstraction_level")) db.exec("ALTER TABLE experience_patterns ADD COLUMN abstraction_level TEXT DEFAULT 'tip'");
      if (!hasColumn(db, "experience_patterns", "verified")) db.exec("ALTER TABLE experience_patterns ADD COLUMN verified INTEGER NOT NULL DEFAULT 0");
      if (!hasColumn(db, "experience_patterns", "verification_count")) db.exec("ALTER TABLE experience_patterns ADD COLUMN verification_count INTEGER NOT NULL DEFAULT 0");
    }
    if (hasTable(db, "thread_state")) {
      if (!hasColumn(db, "thread_state", "summary_embedding")) db.exec("ALTER TABLE thread_state ADD COLUMN summary_embedding BLOB");
    }
    if (hasTable(db, "session_journal")) {
      if (!hasColumn(db, "session_journal", "embedding")) db.exec("ALTER TABLE session_journal ADD COLUMN embedding BLOB");
    }
    db.exec(`CREATE TABLE IF NOT EXISTS artifact_links (source_id INTEGER NOT NULL, target_id INTEGER NOT NULL, link_type TEXT NOT NULL CHECK (link_type IN ('related', 'supports', 'contradicts', 'supersedes', 'caused_by')), strength REAL NOT NULL DEFAULT 0.5, created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (source_id, target_id));`);
    db.exec(`CREATE TABLE IF NOT EXISTS retrieval_events (id INTEGER PRIMARY KEY AUTOINCREMENT, artifact_id INTEGER NOT NULL, session_id TEXT NOT NULL, query_text TEXT, was_referenced INTEGER, correction_followed INTEGER, timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()));
      CREATE INDEX IF NOT EXISTS idx_retrieval_artifact ON retrieval_events(artifact_id);
      CREATE INDEX IF NOT EXISTS idx_retrieval_session ON retrieval_events(session_id);`);
    db.exec(`CREATE TABLE IF NOT EXISTS capability_boundaries (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, domain TEXT NOT NULL, total_interactions INTEGER NOT NULL DEFAULT 0, corrections INTEGER NOT NULL DEFAULT 0, last_updated_epoch INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(project, domain));`);
    try {
      db.exec(`UPDATE artifacts SET activation_score = MAX(0.1, 0.0 + (importance - 3) * 0.3 + 1.0) WHERE activation_score = 1.0 AND id > 0`);
    } catch {
    }
  } catch {
  }
}
function migrateV9toV10(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        turn_number INTEGER NOT NULL DEFAULT 0,
        user_text TEXT,
        assistant_text TEXT,
        timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_convturns_session
        ON conversation_turns(session_id, turn_number);
      CREATE INDEX IF NOT EXISTS idx_convturns_project
        ON conversation_turns(project, timestamp_epoch DESC);
    `);
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
          user_text, assistant_text,
          content=conversation_turns,
          content_rowid=id,
          tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS convturns_fts_ai AFTER INSERT ON conversation_turns BEGIN
          INSERT INTO conversation_turns_fts(rowid, user_text, assistant_text)
          VALUES (new.id, COALESCE(new.user_text, ''), COALESCE(new.assistant_text, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS convturns_fts_ad AFTER DELETE ON conversation_turns BEGIN
          INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, user_text, assistant_text)
          VALUES ('delete', old.id, COALESCE(old.user_text, ''), COALESCE(old.assistant_text, ''));
        END;
      `);
    } catch {
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_session TEXT NOT NULL,
        sender TEXT NOT NULL,
        message_type TEXT NOT NULL DEFAULT 'event'
          CHECK (message_type IN ('event', 'command', 'query', 'advisory')),
        content TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal'
          CHECK (priority IN ('normal', 'urgent', 'advisory')),
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        delivered_at_epoch INTEGER,
        acknowledged INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessmsg_target
        ON session_messages(target_session, delivered_at_epoch, priority);
      CREATE INDEX IF NOT EXISTS idx_sessmsg_sender
        ON session_messages(sender, created_at_epoch DESC);
    `);
    if (hasTable(db, "experience_patterns")) {
      if (!hasColumn(db, "experience_patterns", "helpful_count"))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN helpful_count INTEGER NOT NULL DEFAULT 0");
      if (!hasColumn(db, "experience_patterns", "harmful_count"))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN harmful_count INTEGER NOT NULL DEFAULT 0");
      if (!hasColumn(db, "experience_patterns", "escalation_level"))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN escalation_level TEXT NOT NULL DEFAULT 'pattern'");
      try {
        db.exec(`
          UPDATE experience_patterns
          SET helpful_count = times_useful,
              harmful_count = MAX(0, times_triggered - times_useful)
          WHERE helpful_count = 0 AND harmful_count = 0 AND times_triggered > 0
        `);
      } catch {
      }
    }
    const MAX_SANE_EPOCH = 4102444800;
    db.exec(`
      UPDATE sessions
      SET created_at_epoch = CAST(created_at_epoch / 1000 AS INTEGER)
      WHERE created_at_epoch > ${MAX_SANE_EPOCH}
    `);
    db.exec(`
      UPDATE sessions
      SET ended_at_epoch = CAST(ended_at_epoch / 1000 AS INTEGER)
      WHERE ended_at_epoch IS NOT NULL AND ended_at_epoch > ${MAX_SANE_EPOCH}
    `);
    try {
      db.exec(`
        DELETE FROM artifacts WHERE id IN (
          SELECT a.id FROM artifacts a
          WHERE a.summary LIKE '[Reflection]%'
          AND a.id NOT IN (
            SELECT MIN(id) FROM artifacts
            WHERE summary LIKE '[Reflection]%'
            GROUP BY project, summary
          )
        )
      `);
      db.exec("INSERT INTO artifacts_fts(artifacts_fts) VALUES('rebuild')");
    } catch {
    }
  } catch {
  }
}
function migrateV10toV11(db) {
  try {
    if (hasTable(db, "observations")) {
      if (!hasColumn(db, "observations", "stability_class"))
        db.exec("ALTER TABLE observations ADD COLUMN stability_class TEXT DEFAULT 'standard'");
      if (!hasColumn(db, "observations", "novelty_score"))
        db.exec("ALTER TABLE observations ADD COLUMN novelty_score REAL DEFAULT 0.5");
      if (!hasColumn(db, "observations", "consolidated_into"))
        db.exec("ALTER TABLE observations ADD COLUMN consolidated_into INTEGER");
    }
  } catch {
  }
  try {
    if (hasTable(db, "experience_patterns")) {
      if (!hasColumn(db, "experience_patterns", "maturity"))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN maturity TEXT DEFAULT 'candidate'");
      if (!hasColumn(db, "experience_patterns", "confidence"))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN confidence REAL DEFAULT 0.5");
    }
  } catch {
  }
  try {
    if (hasTable(db, "artifact_links")) {
      if (!hasColumn(db, "artifact_links", "valid_at_epoch"))
        db.exec("ALTER TABLE artifact_links ADD COLUMN valid_at_epoch INTEGER");
      if (!hasColumn(db, "artifact_links", "invalid_at_epoch"))
        db.exec("ALTER TABLE artifact_links ADD COLUMN invalid_at_epoch INTEGER");
    }
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        artifact_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        access_type TEXT NOT NULL DEFAULT 'retrieval'
          CHECK (access_type IN ('retrieval', 'materialization', 'reference', 'spread')),
        timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_aal_artifact
        ON artifact_access_log(artifact_id, timestamp_epoch DESC);
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        domain TEXT NOT NULL,
        description TEXT NOT NULL,
        detected_by TEXT NOT NULL,
        detected_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        priority REAL NOT NULL DEFAULT 0.5,
        resolved_at_epoch INTEGER,
        resolution TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kg_project
        ON knowledge_gaps(project, resolved_at_epoch);
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS temporal_profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        hour_bucket INTEGER NOT NULL CHECK (hour_bucket BETWEEN 0 AND 5),
        day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
        session_count INTEGER NOT NULL DEFAULT 0,
        avg_duration_sec REAL,
        common_first_actions TEXT DEFAULT '[]',
        updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(project, hour_bucket, day_of_week)
      );
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS action_transitions (
        project TEXT NOT NULL,
        from_action TEXT NOT NULL,
        to_action TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        last_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (project, from_action, to_action)
      );
    `);
  } catch {
  }
  try {
    db.exec(`
      UPDATE observations SET stability_class = 'transient'
      WHERE stability_class = 'standard' AND category IN ('error', 'test')
    `);
    db.exec(`
      UPDATE observations SET stability_class = 'stable'
      WHERE stability_class = 'standard' AND category IN ('architecture', 'decision')
    `);
  } catch {
  }
  try {
    if (hasTable(db, "experience_patterns")) {
      db.exec(`
        UPDATE experience_patterns SET maturity = 'proven'
        WHERE maturity = 'candidate' AND times_triggered >= 5 AND helpful_count >= 3
      `);
      db.exec(`
        UPDATE experience_patterns SET maturity = 'established'
        WHERE maturity = 'candidate' AND times_triggered >= 2
      `);
      db.exec(`
        UPDATE experience_patterns
        SET confidence = CAST((helpful_count + 1) AS REAL) / CAST((helpful_count + harmful_count + 2) AS REAL)
        WHERE confidence = 0.5 AND (helpful_count > 0 OR harmful_count > 0)
      `);
    }
  } catch {
  }
  try {
    if (hasTable(db, "thread_state") && !hasColumn(db, "thread_state", "qdrant_synced")) {
      db.exec("ALTER TABLE thread_state ADD COLUMN qdrant_synced INTEGER NOT NULL DEFAULT 0");
    }
  } catch {
  }
  try {
    if (hasTable(db, "experience_patterns")) {
      if (!hasColumn(db, "experience_patterns", "retrieval_mode"))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN retrieval_mode TEXT DEFAULT 'reactive'");
      if (!hasColumn(db, "experience_patterns", "trigger_intents"))
        db.exec("ALTER TABLE experience_patterns ADD COLUMN trigger_intents TEXT DEFAULT '[]'");
    }
  } catch {
  }
}
function migrateV11toV12(db) {
  try {
    if (hasTable(db, "sessions")) {
      if (!hasColumn(db, "sessions", "name"))
        db.exec("ALTER TABLE sessions ADD COLUMN name TEXT");
      if (!hasColumn(db, "sessions", "transferred_to"))
        db.exec("ALTER TABLE sessions ADD COLUMN transferred_to TEXT");
    }
  } catch {
  }
  try {
    if (hasTable(db, "session_messages") && !hasColumn(db, "session_messages", "sender_type")) {
      db.exec(`
        CREATE TABLE session_messages_v12 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target_session TEXT NOT NULL,
          sender TEXT NOT NULL,
          sender_type TEXT NOT NULL DEFAULT 'angel'
            CHECK (sender_type IN ('angel', 'session', 'system')),
          message_type TEXT NOT NULL DEFAULT 'event'
            CHECK (message_type IN ('event', 'command', 'query', 'advisory', 'request', 'response', 'notify', 'transfer', 'acknowledge')),
          content TEXT NOT NULL,
          priority TEXT NOT NULL DEFAULT 'normal'
            CHECK (priority IN ('normal', 'urgent', 'advisory')),
          request_id TEXT,
          created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
          delivered_at_epoch INTEGER,
          acknowledged INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO session_messages_v12 (id, target_session, sender, message_type, content, priority, created_at_epoch, delivered_at_epoch, acknowledged)
          SELECT id, target_session, sender, message_type, content, priority, created_at_epoch, delivered_at_epoch, acknowledged
          FROM session_messages;
        DROP TABLE session_messages;
        ALTER TABLE session_messages_v12 RENAME TO session_messages;
        CREATE INDEX IF NOT EXISTS idx_sessmsg_target
          ON session_messages(target_session, delivered_at_epoch, priority);
        CREATE INDEX IF NOT EXISTS idx_sessmsg_sender
          ON session_messages(sender, created_at_epoch DESC);
      `);
    }
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        signal_type TEXT NOT NULL
          CHECK (signal_type IN ('wip', 'failure', 'danger', 'claim', 'discovery')),
        target TEXT NOT NULL,
        detail TEXT,
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at_epoch INTEGER,
        cleared_at_epoch INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_signals_project_type
        ON session_signals(project, signal_type, cleared_at_epoch);
      CREATE INDEX IF NOT EXISTS idx_signals_session
        ON session_signals(session_id, cleared_at_epoch);
    `);
  } catch {
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name)");
  } catch {
  }
  try {
    if (hasTable(db, "artifacts")) {
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'").get();
      if (schema?.sql && !schema.sql.includes("entity_summary")) {
        db.exec(`
          CREATE TABLE artifacts_v12 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            project TEXT,
            artifact_type TEXT NOT NULL CHECK (artifact_type IN (
              'observation', 'learning', 'decision', 'hot_file', 'flow', 'milestone',
              'memory_file', 'session_log', 'handoff', 'entity_summary'
            )),
            artifact_ref TEXT,
            summary TEXT,
            content TEXT,
            state TEXT DEFAULT 'active',
            ttl INTEGER,
            importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
            timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
            last_materialized_epoch INTEGER,
            retrieval_score REAL DEFAULT 0.0,
            embedding BLOB,
            activation_score REAL DEFAULT 0.0,
            superseded_by INTEGER,
            valid_until INTEGER,
            confidence REAL DEFAULT 1.0,
            novelty_score REAL DEFAULT 0.5
          );
          INSERT INTO artifacts_v12 SELECT * FROM artifacts;
          DROP TABLE artifacts;
          ALTER TABLE artifacts_v12 RENAME TO artifacts;
          CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project, artifact_type, timestamp_epoch DESC);
          CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, timestamp_epoch DESC);
          CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(artifact_type, state, importance DESC);
          CREATE INDEX IF NOT EXISTS idx_artifacts_activation ON artifacts(project, activation_score DESC);
        `);
      }
    }
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS angel_opinions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        subject TEXT NOT NULL,
        opinion TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        reinforced_count INTEGER NOT NULL DEFAULT 0,
        weakened_count INTEGER NOT NULL DEFAULT 0,
        contradicted_count INTEGER NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL DEFAULT 'inferred',
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(project, subject)
      );
      CREATE INDEX IF NOT EXISTS idx_opinions_project
        ON angel_opinions(project, confidence DESC);
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS entity_aliases (
        alias TEXT NOT NULL,
        canonical TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (alias)
      );
      CREATE INDEX IF NOT EXISTS idx_entity_canonical ON entity_aliases(canonical);
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS solution_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        pattern_id TEXT,
        artifact_id INTEGER,
        approach TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'partial', 'unknown')),
        impact TEXT,
        effectiveness_score REAL DEFAULT 0.5,
        created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_outcomes_pattern ON solution_outcomes(pattern_id, outcome);
      CREATE INDEX IF NOT EXISTS idx_outcomes_project ON solution_outcomes(project, created_at_epoch DESC);
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
        content,
        content=decisions,
        content_rowid=id,
        tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS decisions_fts_ai AFTER INSERT ON decisions BEGIN
        INSERT INTO decisions_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS decisions_fts_ad AFTER DELETE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS decisions_fts_au AFTER UPDATE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
        INSERT INTO decisions_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    db.exec("INSERT OR IGNORE INTO decisions_fts(rowid, content) SELECT id, content FROM decisions");
  } catch {
  }
  try {
    if (hasTable(db, "artifacts")) {
      if (!hasColumn(db, "artifacts", "retrieval_count"))
        db.exec("ALTER TABLE artifacts ADD COLUMN retrieval_count INTEGER DEFAULT 0");
      if (!hasColumn(db, "artifacts", "success_count"))
        db.exec("ALTER TABLE artifacts ADD COLUMN success_count INTEGER DEFAULT 0");
    }
  } catch {
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_index (
        project TEXT NOT NULL,
        file_path TEXT NOT NULL,
        last_indexed_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        ast_hash TEXT,
        symbols TEXT,
        call_graph TEXT,
        imports TEXT,
        exports TEXT,
        embedding BLOB,
        PRIMARY KEY (project, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_code_index_project
        ON code_index(project, last_indexed_epoch DESC);
    `);
  } catch {
  }
}
function migrateV12toV13(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS critical_rules (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        rule_text TEXT NOT NULL,
        variants TEXT,
        source TEXT NOT NULL CHECK (source IN ('author', 'system-promoted')),
        drift_risk TEXT NOT NULL CHECK (drift_risk IN ('safety', 'working-method', 'style')),
        domain_tags TEXT,
        base_ttl INTEGER NOT NULL,
        current_ttl INTEGER,
        last_injected_turn INTEGER,
        injection_count INTEGER DEFAULT 0,
        violation_count INTEGER DEFAULT 0,
        compliance_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_critical_rules_project_source
        ON critical_rules(project, source);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_critical_rules_dedup
        ON critical_rules(project, rule_text);
    `);
  } catch {
  }
}
function migrateV13toV14(db) {
  try {
    if (!hasColumn(db, "sessions", "extraction_cursor")) {
      db.exec("ALTER TABLE sessions ADD COLUMN extraction_cursor INTEGER");
    }
  } catch {
  }
  try {
    if (!hasColumn(db, "experience_patterns", "needs_reembed")) {
      db.exec("ALTER TABLE experience_patterns ADD COLUMN needs_reembed INTEGER NOT NULL DEFAULT 0");
    }
  } catch {
  }
}
function migrateV14toV15(db) {
  const loaded = loadSqliteVec(db);
  if (!loaded) {
    return;
  }
  const tables = [
    "vec_artifacts",
    "vec_patterns",
    "vec_threads",
    "vec_journal",
    "vec_conversations",
    "vec_transcript_chunks_v6"
  ];
  for (const table of tables) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding float[1024])`);
    } catch {
    }
  }
}
function migrateV15toV16(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_curated_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN (
        'mental_model', 'workspace_map', 'shipped',
        'reframe', 'constraint', 'preference'
      )),
      content TEXT NOT NULL,
      tags TEXT,
      supersedes_id INTEGER REFERENCES project_curated_context(id),
      curator TEXT NOT NULL CHECK(curator IN ('agent', 'angel')),
      trust_tier INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'superseded', 'proposed', 'archived')),
      source_session_id TEXT,
      created_at_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at_epoch INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_pcc_project_status
      ON project_curated_context(project, status);
    CREATE INDEX IF NOT EXISTS idx_pcc_project_type
      ON project_curated_context(project, type, status);
  `);
}
function migrateV16toV17(db) {
  applyV17DDL(db);
}
function migrateV17toV18(db) {
  db.exec(SHAPE_VOCABULARY_SCHEMA);
}
function migrateV18toV19(db) {
  db.exec(POINTER_RECALL_SCHEMA);
}
function migrateV19toV20(db) {
  if (!hasTable(db, "telemetry")) {
    return true;
  }
  if (!hasColumn(db, "telemetry", "event_kind")) {
    return true;
  }
  if (telemetryAcceptsRerankerFallback(db)) {
    return true;
  }
  const tx = db.transaction(() => {
    db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v19;`);
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);
    db.exec(TELEMETRY_SCHEMA);
    db.exec(`
      INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter)
      SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter
      FROM telemetry_v19;
    `);
    db.exec(`DROP TABLE telemetry_v19;`);
  });
  tx();
  return true;
}
function telemetryAcceptsRerankerFallback(db) {
  if (!hasTable(db, "telemetry")) return false;
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='telemetry'`
  ).get();
  return !!row?.sql && row.sql.includes("'reranker_fallback'");
}
function migrateV20toV21(db) {
  if (!hasTable(db, "telemetry")) {
    db.exec(ARTIFACT_TASK_PATTERN_SCHEMA);
    return true;
  }
  if (!hasColumn(db, "telemetry", "event_kind")) {
    db.exec(ARTIFACT_TASK_PATTERN_SCHEMA);
    return true;
  }
  if (hasTable(db, "artifact_task_pattern") && telemetryAcceptsCrossProjectEnums(db)) {
    return true;
  }
  const tx = db.transaction(() => {
    db.exec(ARTIFACT_TASK_PATTERN_SCHEMA);
    if (!telemetryAcceptsCrossProjectEnums(db)) {
      db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v20;`);
      db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
      db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);
      db.exec(TELEMETRY_SCHEMA);
      db.exec(`
        INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter)
        SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter
        FROM telemetry_v20;
      `);
      db.exec(`DROP TABLE telemetry_v20;`);
    }
  });
  tx();
  return true;
}
function telemetryAcceptsCrossProjectEnums(db) {
  if (!hasTable(db, "telemetry")) return false;
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='telemetry'`
  ).get();
  if (!row?.sql) return false;
  return row.sql.includes("'cross_project_ambiguous'") && row.sql.includes("'cross_project_query_expansion'");
}
function migrateV21toV22(db) {
  if (hasTable(db, "retrieval_log") && hasTable(db, "session_flag")) {
    return true;
  }
  db.exec(SCHEMA_V22);
  return true;
}
function migrateV22toV23(db) {
  if (hasTable(db, "policy_weights")) {
    db.exec("DROP TABLE IF EXISTS policy_weights");
  }
  if (hasTable(db, "artifacts") && hasColumn(db, "artifacts", "q_value")) {
    try {
      db.exec("ALTER TABLE artifacts DROP COLUMN q_value");
    } catch {
    }
  }
  return true;
}
function migrateV23toV24(db) {
  const legacyOldTables = [
    "learnings_old",
    "decisions_old",
    "experience_patterns_old",
    "angel_opinions_old",
    "critical_rules_old",
    "project_curated_context_old"
  ];
  for (const tbl of legacyOldTables) {
    db.exec(`DROP TABLE IF EXISTS ${tbl}`);
  }
  return true;
}
function migrateV24toV25(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodic_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      ts_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
      turn_number INTEGER,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      provenance TEXT NOT NULL CHECK (provenance IN ('organic','injected','tool_result','environmental')),
      parent_event_id INTEGER REFERENCES episodic_events(id),
      content_hash TEXT NOT NULL,
      metadata_json TEXT,
      schema_version SMALLINT NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_epev_session_turn_ts ON episodic_events(session_id, turn_number, ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_epev_project_ts     ON episodic_events(project, ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_epev_provenance     ON episodic_events(provenance);
    CREATE INDEX IF NOT EXISTS idx_epev_parent         ON episodic_events(parent_event_id);
  `);
  if (hasTable(db, "telemetry") && hasColumn(db, "telemetry", "event_kind") && !telemetryAcceptsEpisodicWriteFailure(db)) {
    const tx = db.transaction(() => {
      db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v24;`);
      db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
      db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);
      db.exec(TELEMETRY_SCHEMA);
      db.exec(`
        INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter)
        SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch, adapter
        FROM telemetry_v24;
      `);
      db.exec(`DROP TABLE telemetry_v24;`);
    });
    tx();
  }
  return true;
}
function telemetryAcceptsEpisodicWriteFailure(db) {
  if (!hasTable(db, "telemetry")) return false;
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='telemetry'`
  ).get();
  return !!row?.sql && row.sql.includes("'episodic_write_failure'");
}
function migrateV25toV26(db) {
  if (hasTable(db, "episodic_index_error_fingerprint")) {
    return false;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodic_index_error_fingerprint (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shingle_hash TEXT NOT NULL,
      episode_event_id INTEGER NOT NULL REFERENCES episodic_events(id),
      ts_epoch INTEGER NOT NULL,
      project TEXT NOT NULL,
      corpus_origin TEXT NOT NULL CHECK (corpus_origin IN ('phase1_organic','v4_backfill')),
      schema_version SMALLINT NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_epev_efp_shingle      ON episodic_index_error_fingerprint(shingle_hash);
    CREATE INDEX IF NOT EXISTS idx_epev_efp_event        ON episodic_index_error_fingerprint(episode_event_id);
    CREATE INDEX IF NOT EXISTS idx_epev_efp_project_ts   ON episodic_index_error_fingerprint(project, ts_epoch);
  `);
  return true;
}
function migrateV26toV27(db) {
  if (!hasTable(db, "episodic_index_error_fingerprint")) return false;
  const sqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='episodic_index_error_fingerprint'"
  ).get();
  const sql = sqlRow?.sql ?? "";
  if (sql.includes("phase1_organic_pre_phase2_close")) return false;
  db.exec(`
    ALTER TABLE episodic_index_error_fingerprint RENAME TO _v26_episodic_index_error_fingerprint;

    CREATE TABLE episodic_index_error_fingerprint (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shingle_hash TEXT NOT NULL,
      episode_event_id INTEGER NOT NULL REFERENCES episodic_events(id),
      ts_epoch INTEGER NOT NULL,
      project TEXT NOT NULL,
      corpus_origin TEXT NOT NULL CHECK (corpus_origin IN ('v4_backfill','phase1_organic_pre_phase2_close','phase1_organic_post_phase2_close')),
      schema_version SMALLINT NOT NULL DEFAULT 1
    );

    INSERT INTO episodic_index_error_fingerprint (id, shingle_hash, episode_event_id, ts_epoch, project, corpus_origin, schema_version)
      SELECT
        id,
        shingle_hash,
        episode_event_id,
        ts_epoch,
        project,
        CASE corpus_origin
          WHEN 'phase1_organic' THEN 'phase1_organic_pre_phase2_close'
          ELSE corpus_origin
        END,
        schema_version
      FROM _v26_episodic_index_error_fingerprint;

    DROP TABLE _v26_episodic_index_error_fingerprint;

    CREATE INDEX IF NOT EXISTS idx_epev_efp_shingle    ON episodic_index_error_fingerprint(shingle_hash);
    CREATE INDEX IF NOT EXISTS idx_epev_efp_event      ON episodic_index_error_fingerprint(episode_event_id);
    CREATE INDEX IF NOT EXISTS idx_epev_efp_project_ts ON episodic_index_error_fingerprint(project, ts_epoch);
  `);
  return true;
}
function migrateV27toV28(_db) {
  return true;
}
function migrateV28toV29(db) {
  const hasCursor = hasTable(db, "episode_boundary_cursor");
  const sessionsColsRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'"
  ).get();
  const sessionsSql = sessionsColsRow?.sql ?? "";
  const hasHeartbeatCol = sessionsSql.includes("last_heartbeat_ts");
  const hasJsonlCol = sessionsSql.includes("last_jsonl_write_ts");
  if (hasCursor && hasHeartbeatCol && hasJsonlCol) return false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_boundary_cursor (
      project                       TEXT    NOT NULL,
      session_id                    TEXT    NOT NULL,
      last_processed_jsonl_offset   INTEGER NOT NULL DEFAULT 0,
      last_processed_event_ts_epoch INTEGER NOT NULL DEFAULT 0,
      last_close_event_id           INTEGER,
      PRIMARY KEY (project, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ebc_session
      ON episode_boundary_cursor(session_id);
    CREATE INDEX IF NOT EXISTS idx_ebc_close_event
      ON episode_boundary_cursor(last_close_event_id) WHERE last_close_event_id IS NOT NULL;
  `);
  if (!hasHeartbeatCol) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN last_heartbeat_ts INTEGER`);
    } catch {
    }
  }
  if (!hasJsonlCol) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN last_jsonl_write_ts INTEGER`);
    } catch {
    }
  }
  return true;
}
function migrateV29toV30(db) {
  const learningsMeta = db.prepare(
    "SELECT type, sql FROM sqlite_master WHERE name='learnings' AND type IN ('table','view')"
  ).get();
  if (!learningsMeta) return false;
  if (learningsMeta.type === "view") return false;
  const learningsSql = learningsMeta.sql ?? "";
  const hasProvenanceCol = learningsSql.includes("provenance");
  if (hasProvenanceCol) return false;
  db.exec(
    `ALTER TABLE learnings
       ADD COLUMN provenance TEXT NOT NULL DEFAULT 'organic'
         CHECK (provenance IN ('organic','injected','tool_result','environmental'))`
  );
  db.exec(`UPDATE learnings SET provenance = 'organic' WHERE provenance IS NULL`);
  return true;
}
function migrateV30toV31(db) {
  const learningsMeta = db.prepare(
    "SELECT type, sql FROM sqlite_master WHERE name='learnings' AND type IN ('table','view')"
  ).get();
  if (!learningsMeta) return false;
  if (learningsMeta.type === "table") return false;
  const viewSql = learningsMeta.sql ?? "";
  if (/\bprovenance\b/i.test(viewSql)) return false;
  db.exec(`
    DROP TRIGGER IF EXISTS learnings_instead_insert;
    DROP TRIGGER IF EXISTS learnings_instead_update;
    DROP TRIGGER IF EXISTS learnings_instead_delete;
    DROP VIEW IF EXISTS learnings;
  `);
  const artifactProjectCol = hasColumn(db, "artifact", "project") ? "project" : "project_id";
  const artifactUpdatedCol = hasColumn(db, "artifact", "updated_at_epoch_ms") ? "updated_at_epoch_ms" : "updated_at_epoch";
  const artifactCreatedCol = hasColumn(db, "artifact", "created_at_epoch_ms") ? "created_at_epoch_ms" : "created_at_epoch";
  db.exec(`
    CREATE VIEW learnings AS
    SELECT
      CAST((SELECT m.legacy_id FROM legacy_id_map m WHERE m.legacy_table = 'learnings' AND m.new_uuid = artifact.id) AS INTEGER) AS id,
      CAST(artifact.${artifactProjectCol} AS TEXT) AS project,
      CAST(json_extract(artifact.data, '$.agent_id') AS TEXT) AS agent_id,
      CAST(json_extract(artifact.data, '$.fingerprint') AS TEXT) AS fingerprint,
      artifact.body AS content,
      CAST(json_extract(artifact.data, '$.promotion_count') AS INTEGER) AS promotion_count,
      CAST(json_extract(artifact.data, '$.first_seen_epoch') AS INTEGER) AS first_seen_epoch,
      CAST(json_extract(artifact.data, '$.first_seen_epoch') AS INTEGER) AS first_seen_epoch_ms,
      CAST(json_extract(artifact.data, '$.last_promoted_epoch') AS INTEGER) AS last_promoted_epoch,
      CAST(json_extract(artifact.data, '$.last_promoted_epoch') AS INTEGER) AS last_promoted_epoch_ms,
      CAST(artifact.${artifactUpdatedCol} / 1000 AS INTEGER) AS updated_at_epoch,
      artifact.${artifactUpdatedCol} AS updated_at_epoch_ms,
      COALESCE(CAST(json_extract(artifact.data, '$.provenance') AS TEXT), 'organic') AS provenance
    FROM artifact
    WHERE kind = 'learning'
    ORDER BY ${artifactCreatedCol}
  `);
  db.exec(`
    CREATE TRIGGER learnings_instead_insert INSTEAD OF INSERT ON learnings
    BEGIN
      SELECT CASE
        WHEN NEW.provenance IS NOT NULL
         AND NEW.provenance NOT IN ('organic','injected','tool_result','environmental')
        THEN RAISE(ABORT, 'CHECK constraint failed: learnings.provenance')
      END;
      INSERT INTO artifact(
        id, kind, title, body, scope, status, confidence,
        ${artifactCreatedCol}, ${artifactUpdatedCol}, session_id, ${artifactProjectCol}, data
      ) VALUES (
        lower(hex(randomblob(16))),
        'learning',
        substr(NEW.content, 1, 80),
        NEW.content,
        'project',
        'active',
        NULL,
        COALESCE(NEW.first_seen_epoch * 1000, unixepoch() * 1000),
        COALESCE(NEW.updated_at_epoch * 1000, unixepoch() * 1000),
        NULL,
        NEW.project,
        json_object(
          'agent_id', NEW.agent_id,
          'fingerprint', NEW.fingerprint,
          'promotion_count', COALESCE(NEW.promotion_count, 1),
          'first_seen_epoch', COALESCE(NEW.first_seen_epoch, unixepoch()),
          'last_promoted_epoch', COALESCE(NEW.last_promoted_epoch, unixepoch()),
          'provenance', COALESCE(NEW.provenance, 'organic')
        )
      );
      INSERT INTO legacy_id_map(legacy_table, legacy_id, new_uuid)
      VALUES (
        'learnings',
        COALESCE(
          NEW.id,
          (SELECT COALESCE(MAX(legacy_id), 0) + 1 FROM legacy_id_map WHERE legacy_table = 'learnings')
        ),
        (SELECT id FROM artifact WHERE rowid = last_insert_rowid())
      );
    END
  `);
  db.exec(`
    CREATE TRIGGER learnings_instead_update INSTEAD OF UPDATE ON learnings
    BEGIN
      SELECT CASE
        WHEN NEW.provenance IS NOT NULL
         AND NEW.provenance NOT IN ('organic','injected','tool_result','environmental')
        THEN RAISE(ABORT, 'CHECK constraint failed: learnings.provenance')
      END;
      UPDATE artifact SET
        ${artifactProjectCol} = NEW.project,
        body = NEW.content,
        data = json_set(json_set(json_set(json_set(json_set(json_set(data,
          '$.agent_id', NEW.agent_id),
          '$.fingerprint', NEW.fingerprint),
          '$.promotion_count', NEW.promotion_count),
          '$.first_seen_epoch', COALESCE(NEW.first_seen_epoch_ms, NEW.first_seen_epoch, json_extract(data, '$.first_seen_epoch'))),
          '$.last_promoted_epoch', COALESCE(NEW.last_promoted_epoch_ms, NEW.last_promoted_epoch, json_extract(data, '$.last_promoted_epoch'))),
          '$.provenance', COALESCE(NEW.provenance, json_extract(data, '$.provenance'), 'organic')
        ),
        ${artifactUpdatedCol} = COALESCE(NEW.updated_at_epoch_ms, unixepoch() * 1000)
      WHERE id = (SELECT new_uuid FROM legacy_id_map WHERE legacy_table = 'learnings' AND legacy_id = OLD.id);
    END
  `);
  db.exec(`
    CREATE TRIGGER learnings_instead_delete INSTEAD OF DELETE ON learnings
    BEGIN
      DELETE FROM artifact
        WHERE id = (SELECT new_uuid FROM legacy_id_map WHERE legacy_table = 'learnings' AND legacy_id = OLD.id)
          AND kind = 'learning';
      DELETE FROM legacy_id_map
        WHERE legacy_table = 'learnings' AND legacy_id = OLD.id;
    END
  `);
  db.exec(`
    UPDATE artifact
    SET data = json_set(data, '$.provenance', 'organic')
    WHERE kind = 'learning'
      AND json_extract(data, '$.provenance') IS NULL
  `);
  return true;
}
function migrateV32toV33(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_highlights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      mental_model TEXT,
      open_questions TEXT,
      reframes TEXT,
      tools_introduced TEXT,
      decisions_not_made TEXT,
      posture_context TEXT,
      degraded INTEGER NOT NULL DEFAULT 0,
      degraded_reason TEXT,
      degraded_model TEXT,
      created_at_epoch_ms INTEGER NOT NULL,
      re_extracted_at_epoch_ms INTEGER,
      UNIQUE(session_id, project)
    );
    CREATE INDEX IF NOT EXISTS idx_session_highlights_project_created
      ON session_highlights (project, created_at_epoch_ms DESC);
  `);
  return true;
}
function migrateV31toV32(db) {
  const exists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcript_chunk_v6'"
  ).get();
  if (exists) return false;
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_chunk_v6 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      sub_index INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
      provenance TEXT NOT NULL CHECK (provenance IN ('organic','injected','tool_result','environmental')),
      body TEXT NOT NULL,
      created_at_epoch_ms INTEGER NOT NULL,
      wrapper_redacted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_transcript_chunk_v6_session_turn
      ON transcript_chunk_v6(session_id, turn_index);
    CREATE INDEX IF NOT EXISTS idx_transcript_chunk_v6_project_created
      ON transcript_chunk_v6(project_id, created_at_epoch_ms);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_transcript_chunk_v6_session_turn_role_sub
      ON transcript_chunk_v6(session_id, turn_index, role, sub_index);
  `);
  const loaded = loadSqliteVec(db);
  if (loaded) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_transcript_chunks_v6 USING vec0(embedding float[1024])`);
    } catch {
    }
  }
  return true;
}
function migrateV33toV34(db) {
  if (hasColumn(db, "artifact", "project_id")) {
    db.exec(`ALTER TABLE artifact RENAME COLUMN project_id TO project`);
  }
  const tcHasProjectId = db.pragma("table_info(transcript_chunk_v6)").some((c) => c.name === "project_id");
  if (tcHasProjectId) {
    db.exec(`ALTER TABLE transcript_chunk_v6 RENAME COLUMN project_id TO project`);
  }
  const idxRows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='index'
       AND (tbl_name='artifact' OR tbl_name='transcript_chunk_v6')`
  ).all();
  for (const r of idxRows) {
    if (r.sql && /project_id/i.test(r.sql)) {
      db.exec(`DROP INDEX IF EXISTS "${r.name}"`);
      db.exec(r.sql.replace(/project_id/g, "project"));
    }
  }
  const trgRows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='trigger'
       AND (tbl_name='artifact' OR tbl_name='transcript_chunk_v6')`
  ).all();
  for (const r of trgRows) {
    if (r.sql && /project_id/i.test(r.sql)) {
      db.exec(`DROP TRIGGER IF EXISTS "${r.name}"`);
      db.exec(r.sql.replace(/project_id/g, "project"));
    }
  }
  const viewRows = db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type='view'`
  ).all();
  for (const v of viewRows) {
    if (v.sql && /project_id/i.test(v.sql)) {
      const vTriggers = db.prepare(
        `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?`
      ).all(v.name);
      for (const t of vTriggers) {
        db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
      }
      db.exec(`DROP VIEW IF EXISTS "${v.name}"`);
      db.exec(v.sql.replace(/\bartifact\.project_id\b/g, "artifact.project"));
      for (const t of vTriggers) {
        if (t.sql) {
          db.exec(t.sql.replace(/project_id/g, "project"));
        }
      }
    }
  }
  db.pragma("user_version = 34");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
      version        INTEGER PRIMARY KEY,
      applied_at_epoch INTEGER
    )`);
    const svCols = db.pragma("table_info(schema_versions)").map((c) => c.name);
    if (svCols.includes("applied_at_epoch")) {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch) VALUES (34, unixepoch())`);
    } else {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (34)`);
    }
  } catch {
  }
}
function migrateV34toV35(db) {
  const renames = [
    // sessions
    { table: "sessions", oldCol: "created_at_epoch", newCol: "created_at_epoch_ms", scale: true },
    { table: "sessions", oldCol: "ended_at_epoch", newCol: "ended_at_epoch_ms", scale: true },
    // observations
    { table: "observations", oldCol: "timestamp_epoch", newCol: "timestamp_epoch_ms", scale: true },
    { table: "observations", oldCol: "last_accessed_at_epoch", newCol: "last_accessed_at_epoch_ms", scale: true },
    { table: "observations", oldCol: "deleted_at_epoch", newCol: "deleted_at_epoch_ms", scale: true },
    // learnings
    { table: "learnings", oldCol: "first_seen_epoch", newCol: "first_seen_epoch_ms", scale: true },
    { table: "learnings", oldCol: "last_promoted_epoch", newCol: "last_promoted_epoch_ms", scale: true },
    { table: "learnings", oldCol: "updated_at_epoch", newCol: "updated_at_epoch_ms", scale: true },
    // checkpoint_meta
    { table: "checkpoint_meta", oldCol: "created_at_epoch", newCol: "created_at_epoch_ms", scale: true },
    { table: "checkpoint_meta", oldCol: "updated_at_epoch", newCol: "updated_at_epoch_ms", scale: true },
    // artifact (V17) — values are already milliseconds (runner multiplies by 1000 at write time)
    // scale=false: WHERE guard still applied via UPDATE below as a safety net
    { table: "artifact", oldCol: "created_at_epoch", newCol: "created_at_epoch_ms", scale: false },
    { table: "artifact", oldCol: "updated_at_epoch", newCol: "updated_at_epoch_ms", scale: false },
    // episodic_events
    { table: "episodic_events", oldCol: "ts_epoch", newCol: "ts_epoch_ms", scale: true },
    // telemetry
    { table: "telemetry", oldCol: "timestamp_epoch", newCol: "timestamp_epoch_ms", scale: true },
    // pressure_scores
    { table: "pressure_scores", oldCol: "last_touched_epoch", newCol: "last_touched_epoch_ms", scale: true },
    // schema_versions
    { table: "schema_versions", oldCol: "applied_at_epoch", newCol: "applied_at_epoch_ms", scale: true },
    // session_messages
    { table: "session_messages", oldCol: "created_at_epoch", newCol: "created_at_epoch_ms", scale: true },
    { table: "session_messages", oldCol: "delivered_at_epoch", newCol: "delivered_at_epoch_ms", scale: true },
    // session_signals
    { table: "session_signals", oldCol: "created_at_epoch", newCol: "created_at_epoch_ms", scale: true },
    { table: "session_signals", oldCol: "expires_at_epoch", newCol: "expires_at_epoch_ms", scale: true },
    { table: "session_signals", oldCol: "cleared_at_epoch", newCol: "cleared_at_epoch_ms", scale: true },
    // retrieval_events
    { table: "retrieval_events", oldCol: "timestamp_epoch", newCol: "timestamp_epoch_ms", scale: true },
    // kind_registry (V17 DDL table — passive kind tracking)
    { table: "kind_registry", oldCol: "first_seen_epoch", newCol: "first_seen_epoch_ms", scale: true },
    { table: "kind_registry", oldCol: "last_seen_epoch", newCol: "last_seen_epoch_ms", scale: true },
    // session_journal (SCHEMA_V3 table)
    { table: "session_journal", oldCol: "timestamp_epoch", newCol: "timestamp_epoch_ms", scale: true },
    // conversation_turns (V10 table)
    { table: "conversation_turns", oldCol: "timestamp_epoch", newCol: "timestamp_epoch_ms", scale: true },
    // artifacts (SCHEMA_V3 table — legacy pre-V17 knowledge artifact store)
    { table: "artifacts", oldCol: "timestamp_epoch", newCol: "timestamp_epoch_ms", scale: true },
    { table: "artifacts", oldCol: "last_materialized_epoch", newCol: "last_materialized_epoch_ms", scale: true }
  ];
  const tx = db.transaction(() => {
    for (const r of renames) {
      if (!hasTable(db, r.table)) continue;
      if (!hasColumn(db, r.table, r.oldCol)) continue;
      if (hasColumn(db, r.table, r.newCol)) continue;
      db.exec(`ALTER TABLE "${r.table}" RENAME COLUMN "${r.oldCol}" TO "${r.newCol}"`);
      if (r.scale) {
        db.exec(
          `UPDATE "${r.table}"
           SET "${r.newCol}" = "${r.newCol}" * 1000
           WHERE "${r.newCol}" IS NOT NULL AND "${r.newCol}" < 1000000000000`
        );
      }
    }
    const affectedTables = [...new Set(renames.map((r) => r.table))];
    const oldNewMap = {};
    for (const r of renames) oldNewMap[r.oldCol] = r.newCol;
    const idxRows = db.prepare(
      `SELECT name, sql, tbl_name FROM sqlite_master
       WHERE type='index'
         AND tbl_name IN (${affectedTables.map(() => "?").join(",")})`
    ).all(...affectedTables);
    for (const idx of idxRows) {
      if (!idx.sql) continue;
      let newSql = idx.sql;
      let changed = false;
      for (const [oldCol, newCol] of Object.entries(oldNewMap)) {
        const re = new RegExp(`\\b${escapeRegex(oldCol)}\\b`, "g");
        if (re.test(newSql)) {
          newSql = newSql.replace(new RegExp(`\\b${escapeRegex(oldCol)}\\b`, "g"), newCol);
          changed = true;
        }
      }
      if (changed) {
        db.exec(`DROP INDEX IF EXISTS "${idx.name}"`);
        try {
          db.exec(newSql);
        } catch {
        }
      }
    }
    const trgRows = db.prepare(
      `SELECT name, sql, tbl_name FROM sqlite_master
       WHERE type='trigger'
         AND tbl_name IN (${affectedTables.map(() => "?").join(",")})`
    ).all(...affectedTables);
    for (const trg of trgRows) {
      if (!trg.sql) continue;
      let newSql = trg.sql;
      let changed = false;
      for (const [oldCol, newCol] of Object.entries(oldNewMap)) {
        const re = new RegExp(`\\b${escapeRegex(oldCol)}\\b`, "g");
        if (re.test(newSql)) {
          newSql = newSql.replace(new RegExp(`\\b${escapeRegex(oldCol)}\\b`, "g"), newCol);
          changed = true;
        }
      }
      if (changed) {
        db.exec(`DROP TRIGGER IF EXISTS "${trg.name}"`);
        try {
          db.exec(newSql);
        } catch {
        }
      }
    }
    const viewRows = db.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='view'`
    ).all();
    for (const v of viewRows) {
      if (!v.sql) continue;
      let newSql = v.sql;
      let changed = false;
      for (const [oldCol, newCol] of Object.entries(oldNewMap)) {
        const re = new RegExp(`\\b${escapeRegex(oldCol)}\\b`, "g");
        if (re.test(newSql)) {
          newSql = newSql.replace(new RegExp(`\\b${escapeRegex(oldCol)}\\b`, "g"), newCol);
          changed = true;
        }
      }
      if (changed) {
        const vTriggers = db.prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?`
        ).all(v.name);
        for (const t of vTriggers) {
          db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
        }
        db.exec(`DROP VIEW IF EXISTS "${v.name}"`);
        try {
          db.exec(newSql);
          for (const t of vTriggers) {
            if (t.sql) {
              let tSql = t.sql;
              for (const [oldCol, newCol] of Object.entries(oldNewMap)) {
                tSql = tSql.replace(new RegExp(`\\b${escapeRegex(oldCol)}\\b`, "g"), newCol);
              }
              try {
                db.exec(tSql);
              } catch {
              }
            }
          }
        } catch {
        }
      }
    }
    db.pragma("user_version = 35");
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
        version          INTEGER PRIMARY KEY,
        applied_at_epoch_ms INTEGER
      )`);
      const svCols = db.pragma("table_info(schema_versions)").map((c) => c.name);
      if (svCols.includes("applied_at_epoch_ms")) {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch_ms) VALUES (35, unixepoch() * 1000)`);
      } else if (svCols.includes("applied_at_epoch")) {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch) VALUES (35, unixepoch())`);
      } else {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (35)`);
      }
    } catch {
    }
  });
  tx();
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function telemetryAcceptsSessionEndAction(db) {
  if (!hasTable(db, "telemetry")) return false;
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='telemetry'`
  ).get();
  return !!row?.sql && row.sql.includes("'session_end_action'");
}
function migrateV35toV36(db) {
  if (!hasTable(db, "telemetry")) return true;
  if (!hasColumn(db, "telemetry", "event_kind")) return true;
  if (telemetryAcceptsSessionEndAction(db)) return true;
  const tx = db.transaction(() => {
    db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v35;`);
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
    db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);
    db.exec(TELEMETRY_SCHEMA);
    db.exec(`
      INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter)
      SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter
      FROM telemetry_v35;
    `);
    db.exec(`DROP TABLE telemetry_v35;`);
    db.pragma("user_version = 36");
    try {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (36)`);
    } catch {
    }
  });
  tx();
  return true;
}
function migrateV36toV37(db) {
  if (hasTable(db, "artifact_id_map")) {
    return true;
  }
  const tx = db.transaction(() => {
    if (hasTable(db, "artifacts") && !hasColumn(db, "artifacts", "read_only")) {
      db.exec(`ALTER TABLE artifacts ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_id_map (
        legacy_id          INTEGER PRIMARY KEY,
        v17_id             TEXT NOT NULL UNIQUE,
        mapped_at_epoch_ms INTEGER NOT NULL,
        project            TEXT NOT NULL,
        FOREIGN KEY (v17_id) REFERENCES artifact(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_id_map_v17
        ON artifact_id_map(v17_id);
      CREATE INDEX IF NOT EXISTS idx_artifact_id_map_project
        ON artifact_id_map(project);
    `);
    loadSqliteVec(db);
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_artifact_v17
          USING vec0(embedding float[1024]);
      `);
    } catch {
    }
    if (hasTable(db, "kind_registry")) {
      const krCols = new Set(
        db.pragma("table_info(kind_registry)").map((c) => c.name)
      );
      if (!krCols.has("first_seen_epoch_ms")) {
        db.exec("ALTER TABLE kind_registry ADD COLUMN first_seen_epoch_ms INTEGER NOT NULL DEFAULT 0");
        if (krCols.has("first_seen_epoch")) {
          db.exec("UPDATE kind_registry SET first_seen_epoch_ms = first_seen_epoch * 1000 WHERE first_seen_epoch_ms = 0");
        }
      }
      if (!krCols.has("last_seen_epoch_ms")) {
        db.exec("ALTER TABLE kind_registry ADD COLUMN last_seen_epoch_ms INTEGER NOT NULL DEFAULT 0");
        if (krCols.has("last_seen_epoch")) {
          db.exec("UPDATE kind_registry SET last_seen_epoch_ms = last_seen_epoch * 1000 WHERE last_seen_epoch_ms = 0");
        }
      }
    }
    _populateArtifactIdMapInTransaction(db);
    _extendTelemetryForV37(db);
    db.pragma("user_version = 37");
    try {
      const svCols = db.pragma("table_info(schema_versions)").map((c) => c.name);
      if (svCols.includes("applied_at_epoch_ms")) {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch_ms) VALUES (37, unixepoch() * 1000)`);
      } else if (svCols.includes("applied_at_epoch")) {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version, applied_at_epoch) VALUES (37, unixepoch())`);
      } else {
        db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (37)`);
      }
    } catch {
    }
  });
  tx();
  return true;
}
function _populateArtifactIdMapInTransaction(db) {
  if (!hasTable(db, "artifacts")) return;
  if (!hasTable(db, "artifact")) return;
  const { createHash } = require("node:crypto");
  const stateToStatus = (state) => {
    switch (state) {
      case "fresh":
        return "active";
      case "packed":
        return "stale";
      case "materialized":
        return "superseded";
      default:
        return "active";
    }
  };
  const artCols = new Set(db.pragma("table_info(artifacts)").map((c) => c.name));
  const colOrNull = (col) => artCols.has(col) ? col : `NULL AS ${col}`;
  const selectSql = `
    SELECT id, session_id, project,
           ${artCols.has("artifact_type") ? "artifact_type" : "'observation' AS artifact_type"},
           ${colOrNull("artifact_ref")},
           ${artCols.has("summary") ? "summary" : "'' AS summary"},
           ${colOrNull("content")},
           ${artCols.has("state") ? "state" : "'fresh' AS state"},
           ${artCols.has("ttl") ? "ttl" : "3 AS ttl"},
           ${artCols.has("importance") ? "importance" : "3 AS importance"},
           ${artCols.has("retrieval_score") ? "retrieval_score" : "1.0 AS retrieval_score"},
           ${artCols.has("timestamp_epoch_ms") ? "timestamp_epoch_ms" : "(unixepoch() * 1000) AS timestamp_epoch_ms"},
           ${colOrNull("last_materialized_epoch_ms")},
           ${artCols.has("activation_score") ? "activation_score" : "1.0 AS activation_score"},
           ${colOrNull("superseded_by")},
           ${colOrNull("valid_until")},
           ${artCols.has("confidence") ? "confidence" : "1.0 AS confidence"},
           ${artCols.has("novelty_score") ? "novelty_score" : "0.5 AS novelty_score"}
    FROM artifacts
  `;
  const legacyRows = db.prepare(selectSql).all();
  const insertArtifactStmt = db.prepare(`
    INSERT OR IGNORE INTO artifact(
      id, kind, title, body, scope, status, confidence,
      created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMapStmt = db.prepare(`
    INSERT OR IGNORE INTO artifact_id_map(legacy_id, v17_id, mapped_at_epoch_ms, project)
    VALUES (?, ?, ?, ?)
  `);
  const now = Date.now();
  for (const row of legacyRows) {
    const contentHash = createHash("sha256").update(row.summary + (row.content ?? "")).digest("hex");
    const v17Id = createHash("sha256").update(`${row.id}:${row.project}:${row.timestamp_epoch_ms}:${contentHash}`).digest("hex").slice(0, 32);
    const v17Confidence = row.importance / 5;
    const v17Status = stateToStatus(row.state);
    const dataSidecar = {
      migrated_from_legacy_id: row.id,
      ttl: row.ttl,
      retrieval_score: row.retrieval_score,
      activation_score: row.activation_score,
      novelty_score: row.novelty_score
    };
    if (row.artifact_ref !== null) dataSidecar["artifact_ref"] = row.artifact_ref;
    if (row.last_materialized_epoch_ms !== null) dataSidecar["last_materialized_epoch"] = row.last_materialized_epoch_ms;
    if (row.valid_until !== null) dataSidecar["valid_until"] = row.valid_until;
    insertArtifactStmt.run(
      v17Id,
      row.artifact_type,
      // kind = artifact_type (same values)
      row.summary,
      // title = summary
      row.content ?? "",
      // body = content (COALESCE empty string)
      "project",
      // scope = 'project' (all artifacts are project-scoped)
      v17Status,
      v17Confidence,
      row.timestamp_epoch_ms,
      row.timestamp_epoch_ms,
      // updated_at_epoch_ms same as created initially
      row.session_id,
      row.project,
      JSON.stringify(dataSidecar)
    );
    insertMapStmt.run(row.id, v17Id, now, row.project);
  }
  if (artCols.has("superseded_by")) {
    db.exec(`
      UPDATE artifact
      SET supersedes_id = (
        SELECT m_superseded.v17_id
        FROM artifact_id_map m_superseding
        INNER JOIN artifacts leg_superseded ON leg_superseded.superseded_by = m_superseding.legacy_id
        INNER JOIN artifact_id_map m_superseded ON m_superseded.legacy_id = leg_superseded.id
        WHERE m_superseding.v17_id = artifact.id
        LIMIT 1
      )
      WHERE artifact.supersedes_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM artifact_id_map m_superseding
          INNER JOIN artifacts leg_superseded ON leg_superseded.superseded_by = m_superseding.legacy_id
          WHERE m_superseding.v17_id = artifact.id
        )
    `);
  }
}
var TELEMETRY_SCHEMA_V37 = `
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'hook_invocation', 'injection', 'observation_capture', 'decision_capture',
    'checkpoint_write', 'enrichment', 'topic_shift', 'dedup', 'decay_prune', 'error',
    'reranker_fallback',
    'cross_project_ambiguous', 'cross_project_query_expansion',
    'episodic_write_failure',
    'signal_reread_after_surface', 'signal_retrieval_fallback',
    'signal_transcript_injection_acceptance', 'signal_retrieved_but_unapplied',
    'handoff_parse_failed',
    'session_end_action',
    're_vectorize_failed'
  )),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  latency_ms REAL,
  timestamp_epoch_ms INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  adapter TEXT DEFAULT 'unknown'
);
CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry(session_id, timestamp_epoch_ms DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_kind ON telemetry(event_kind, timestamp_epoch_ms DESC);
`;
function _telemetryAcceptsReVectorizeFailed(db) {
  if (!hasTable(db, "telemetry")) return false;
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='telemetry'`
  ).get();
  return !!row?.sql && row.sql.includes("'re_vectorize_failed'");
}
function _extendTelemetryForV37(db) {
  if (!hasTable(db, "telemetry")) return;
  if (!hasColumn(db, "telemetry", "event_kind")) return;
  if (_telemetryAcceptsReVectorizeFailed(db)) return;
  db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v36_for_v37;`);
  db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
  db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);
  db.exec(TELEMETRY_SCHEMA_V37);
  db.exec(`
    INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter)
    SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter
    FROM telemetry_v36_for_v37;
  `);
  db.exec(`DROP TABLE telemetry_v36_for_v37;`);
}
function _installReadOnlyTriggers(db) {
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS prevent_legacy_insert_post_cutover
        BEFORE INSERT ON artifacts
        WHEN (SELECT COUNT(*) FROM artifacts WHERE read_only = 1 LIMIT 1) > 0
        BEGIN
          SELECT RAISE(ABORT,
            'legacy artifacts table is read-only post-cutover; write to V17 artifact table instead');
        END;
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS prevent_legacy_update_post_cutover
        BEFORE UPDATE ON artifacts
        WHEN OLD.read_only = 1
        BEGIN
          SELECT RAISE(ABORT,
            'legacy artifacts table is read-only post-cutover; write to V17 artifact table instead');
        END;
    `);
  } catch {
  }
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS prevent_legacy_delete_post_cutover
        BEFORE DELETE ON artifacts
        WHEN OLD.read_only = 1
        BEGIN
          SELECT RAISE(ABORT,
            'legacy artifacts table is read-only post-cutover; write to V17 artifact table instead');
        END;
    `);
  } catch {
  }
}
function migrateV37toV38(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS soft_link (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        src_artifact_id     TEXT NOT NULL,
        dst_artifact_id     TEXT NOT NULL,
        type                TEXT NOT NULL CHECK (type IN ('supersedes', 'promoted_to', 'extracted_from', 'references')),
        confidence          REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
        created_by_session  TEXT NOT NULL,
        created_at_epoch_ms INTEGER NOT NULL,
        project             TEXT NOT NULL,
        data                TEXT,
        FOREIGN KEY (src_artifact_id) REFERENCES artifact(id) ON DELETE RESTRICT,
        FOREIGN KEY (dst_artifact_id) REFERENCES artifact(id) ON DELETE RESTRICT,
        UNIQUE (src_artifact_id, dst_artifact_id, type)
      );
      CREATE INDEX IF NOT EXISTS idx_soft_link_src     ON soft_link(src_artifact_id, type);
      CREATE INDEX IF NOT EXISTS idx_soft_link_dst     ON soft_link(dst_artifact_id, type);
      CREATE INDEX IF NOT EXISTS idx_soft_link_project ON soft_link(project);

      CREATE TABLE IF NOT EXISTS hard_link (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        src_artifact_id         TEXT NOT NULL,
        dst_artifact_id         TEXT NOT NULL,
        type                    TEXT NOT NULL CHECK (type IN ('triggered_by', 'evidence_for', 'contradicts')),
        proposed_confidence     REAL NOT NULL CHECK (proposed_confidence >= 0.0 AND proposed_confidence <= 1.0),
        proposed_by_session     TEXT NOT NULL,
        proposed_at_epoch_ms    INTEGER NOT NULL,
        confirmed_by_session    TEXT,
        confirmed_at_epoch_ms   INTEGER,
        rejected_by_session     TEXT,
        rejected_at_epoch_ms    INTEGER,
        decay_count             INTEGER NOT NULL DEFAULT 0 CHECK (decay_count >= 0),
        proposer_rationale      TEXT,
        project                 TEXT NOT NULL,
        FOREIGN KEY (src_artifact_id) REFERENCES artifact(id) ON DELETE RESTRICT,
        FOREIGN KEY (dst_artifact_id) REFERENCES artifact(id) ON DELETE RESTRICT,
        UNIQUE (src_artifact_id, dst_artifact_id, type)
      );
      CREATE INDEX IF NOT EXISTS idx_hard_link_src     ON hard_link(src_artifact_id, type);
      CREATE INDEX IF NOT EXISTS idx_hard_link_dst     ON hard_link(dst_artifact_id, type);
      CREATE INDEX IF NOT EXISTS idx_hard_link_project ON hard_link(project);
    `);
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_hard_link_pending
          ON hard_link(project, confirmed_by_session)
          WHERE confirmed_by_session IS NULL;
      `);
    } catch {
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS hard_link_history (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        hard_link_id        INTEGER NOT NULL,
        action              TEXT NOT NULL CHECK (action IN ('proposed', 'confirmed', 'rejected', 'decayed')),
        session_id          TEXT NOT NULL,
        action_at_epoch_ms  INTEGER NOT NULL,
        details             TEXT,
        FOREIGN KEY (hard_link_id) REFERENCES hard_link(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_hard_link_history_link ON hard_link_history(hard_link_id);
    `);
    db.pragma("user_version = 38");
    try {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (38)`);
    } catch {
    }
  });
  tx();
}
function migrateV38toV39(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS handoff_refresh_state (
        session_id            TEXT PRIMARY KEY,
        project               TEXT NOT NULL,
        last_refresh_epoch_ms INTEGER NOT NULL,
        refresh_count         INTEGER NOT NULL DEFAULT 0,
        updated_at_epoch_ms   INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_handoff_refresh_session
        ON handoff_refresh_state(session_id);
    `);
    const hasTelemetry = db.prepare(
      "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='telemetry'"
    ).get();
    if (hasTelemetry.cnt > 0) {
      let alreadyExtended = false;
      try {
        db.prepare(`INSERT INTO telemetry(session_id, event_kind, detail, adapter) VALUES('_probe','chr_boundary_detected','{}','probe')`).run();
        db.prepare(`DELETE FROM telemetry WHERE session_id='_probe' AND event_kind='chr_boundary_detected'`).run();
        alreadyExtended = true;
      } catch {
      }
      if (!alreadyExtended) {
        db.exec(`ALTER TABLE telemetry RENAME TO telemetry_v38;`);
        db.exec(`DROP INDEX IF EXISTS idx_telemetry_session;`);
        db.exec(`DROP INDEX IF EXISTS idx_telemetry_kind;`);
        db.exec(`
          CREATE TABLE IF NOT EXISTS telemetry (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id          TEXT NOT NULL,
            event_kind          TEXT NOT NULL CHECK (event_kind IN (
              'hook_invocation', 'injection', 'observation_capture', 'decision_capture',
              'checkpoint_write', 'enrichment', 'topic_shift', 'dedup', 'decay_prune', 'error',
              'reranker_fallback',
              'cross_project_ambiguous', 'cross_project_query_expansion',
              'episodic_write_failure',
              'signal_reread_after_surface', 'signal_retrieval_fallback',
              'signal_transcript_injection_acceptance', 'signal_retrieved_but_unapplied',
              'handoff_parse_failed',
              'session_end_action',
              're_vectorize_failed',
              'soft_link_skipped', 'soft_link_write_failed',
              'chr_boundary_detected', 'chr_no_boundary', 'chr_classify_failed', 'chr_throttled'
            )),
            detail              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
            latency_ms          REAL,
            timestamp_epoch_ms  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
            adapter             TEXT DEFAULT 'unknown'
          );
          CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry(session_id, timestamp_epoch_ms DESC);
          CREATE INDEX IF NOT EXISTS idx_telemetry_kind ON telemetry(event_kind, timestamp_epoch_ms DESC);
        `);
        db.exec(`
          INSERT INTO telemetry (id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter)
          SELECT id, session_id, event_kind, detail, latency_ms, timestamp_epoch_ms, adapter
          FROM telemetry_v38
          WHERE event_kind IN (
            'hook_invocation', 'injection', 'observation_capture', 'decision_capture',
            'checkpoint_write', 'enrichment', 'topic_shift', 'dedup', 'decay_prune', 'error',
            'reranker_fallback',
            'cross_project_ambiguous', 'cross_project_query_expansion',
            'episodic_write_failure',
            'signal_reread_after_surface', 'signal_retrieval_fallback',
            'signal_transcript_injection_acceptance', 'signal_retrieved_but_unapplied',
            'handoff_parse_failed',
            'session_end_action',
            're_vectorize_failed',
            'soft_link_skipped', 'soft_link_write_failed',
            'chr_boundary_detected', 'chr_no_boundary', 'chr_classify_failed', 'chr_throttled'
          );
        `);
        db.exec(`DROP TABLE telemetry_v38;`);
      }
    }
    db.pragma("user_version = 39");
    try {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (39)`);
    } catch {
    }
  });
  tx();
}
function migrateV39toV40(db) {
  const backfillTargets = [
    ["checkpoint_meta", "created_at_epoch_ms"],
    ["checkpoint_meta", "updated_at_epoch_ms"],
    ["sessions", "created_at_epoch_ms"],
    ["observations", "timestamp_epoch_ms"],
    ["retrieval_events", "timestamp_epoch_ms"],
    ["session_signals", "created_at_epoch_ms"],
    ["session_messages", "created_at_epoch_ms"],
    ["episodic_events", "ts_epoch_ms"]
  ];
  const ddlTables = [
    "checkpoint_meta",
    "sessions",
    "observations",
    "retrieval_events",
    "session_signals",
    "session_messages",
    "episodic_events"
  ];
  const tx = db.transaction(() => {
    for (const [table, col] of backfillTargets) {
      if (!hasTable(db, table) || !hasColumn(db, table, col)) continue;
      db.exec(
        `UPDATE ${table} SET ${col} = ${col} * 1000 WHERE ${col} > 0 AND ${col} < 100000000000`
      );
    }
    if (hasTable(db, "kind_registry")) {
      db.exec(`DROP TRIGGER IF EXISTS artifact_register_kind`);
      if (hasTable(db, "artifact")) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS artifact_register_kind
                 AFTER INSERT ON artifact
                 BEGIN
                   INSERT INTO kind_registry(kind, first_seen_epoch_ms, last_seen_epoch_ms)
                     VALUES (NEW.kind, NEW.created_at_epoch_ms, NEW.created_at_epoch_ms)
                   ON CONFLICT(kind) DO UPDATE SET last_seen_epoch_ms = excluded.last_seen_epoch_ms;
                 END`);
      }
      if (hasColumn(db, "kind_registry", "first_seen_epoch")) {
        try {
          db.exec("ALTER TABLE kind_registry DROP COLUMN first_seen_epoch");
        } catch {
        }
      }
      if (hasColumn(db, "kind_registry", "last_seen_epoch")) {
        try {
          db.exec("ALTER TABLE kind_registry DROP COLUMN last_seen_epoch");
        } catch {
        }
      }
    }
  });
  tx();
  const anyDb = db;
  if (typeof anyDb.unsafeMode === "function") anyDb.unsafeMode(true);
  db.pragma("writable_schema = 1");
  try {
    const stmt = db.prepare(
      `UPDATE sqlite_master
       SET sql = replace(sql, 'DEFAULT (unixepoch())', 'DEFAULT (unixepoch() * 1000)')
       WHERE type = 'table' AND name = ?`
    );
    for (const t of ddlTables) {
      if (hasTable(db, t)) stmt.run(t);
    }
  } finally {
    db.pragma("writable_schema = 0");
    if (typeof anyDb.unsafeMode === "function") anyDb.unsafeMode(false);
  }
  db.pragma("user_version = 40");
  try {
    db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (40)`);
  } catch {
  }
}
function migrateV40toV41(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chr_pending_classifications (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id             TEXT NOT NULL,
        project                TEXT NOT NULL,
        user_text              TEXT,
        assistant_text         TEXT NOT NULL,
        source_turn_uuid       TEXT NOT NULL,
        enqueued_at_epoch_ms   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        processed_at_epoch_ms  INTEGER,
        attempt_count          INTEGER NOT NULL DEFAULT 0,
        last_error             TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chr_pending_unprocessed
        ON chr_pending_classifications(processed_at_epoch_ms, enqueued_at_epoch_ms)
        WHERE processed_at_epoch_ms IS NULL;
      CREATE INDEX IF NOT EXISTS idx_chr_pending_session
        ON chr_pending_classifications(session_id, enqueued_at_epoch_ms DESC);
    `);
    db.pragma("user_version = 41");
    try {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (41)`);
    } catch {
    }
  });
  tx();
}
function migrateV41toV42(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_termination (
        session_id              TEXT PRIMARY KEY,
        project                 TEXT NOT NULL,
        ended_at_epoch_ms       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        end_reason              TEXT NOT NULL
          CHECK (end_reason IN ('endsession', 'crash', 'compact', 'idle_close', 'unknown')),
        last_user_directive     TEXT,
        last_assistant_text     TEXT,
        observation_count       INTEGER NOT NULL DEFAULT 0,
        recorded_at_epoch_ms    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_session_termination_recent
        ON session_termination(ended_at_epoch_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_session_termination_project_recent
        ON session_termination(project, ended_at_epoch_ms DESC);
    `);
    db.pragma("user_version = 42");
    try {
      db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (42)`);
    } catch {
    }
  });
  tx();
}
function migrateV42toV43(db) {
  const renames = [
    ["thread_state", "updated_at_epoch", "updated_at_epoch_ms"],
    ["checkpoint_tracking", "last_checkpoint_epoch", "last_checkpoint_epoch_ms"],
    ["checkpoint_tracking", "updated_at_epoch", "updated_at_epoch_ms"],
    ["checkpoint_tracking", "last_tick_epoch", "last_tick_epoch_ms"],
    ["verified_facts", "created_at_epoch", "created_at_epoch_ms"],
    ["file_leases", "granted_at_epoch", "granted_at_epoch_ms"],
    ["artifact_claims", "claimed_at_epoch", "claimed_at_epoch_ms"],
    ["session_events", "timestamp_epoch", "timestamp_epoch_ms"],
    ["session_journal", "timestamp_epoch", "timestamp_epoch_ms"],
    ["artifact_links", "created_at_epoch", "created_at_epoch_ms"],
    ["artifact_links", "valid_at_epoch", "valid_at_epoch_ms"],
    ["artifact_links", "invalid_at_epoch", "invalid_at_epoch_ms"],
    ["capability_boundaries", "last_updated_epoch", "last_updated_epoch_ms"],
    ["conversation_turns", "timestamp_epoch", "timestamp_epoch_ms"],
    ["artifact_access_log", "timestamp_epoch", "timestamp_epoch_ms"],
    ["knowledge_gaps", "detected_at_epoch", "detected_at_epoch_ms"],
    ["knowledge_gaps", "resolved_at_epoch", "resolved_at_epoch_ms"],
    ["temporal_profile", "updated_at_epoch", "updated_at_epoch_ms"],
    ["action_transitions", "last_epoch", "last_epoch_ms"],
    ["solution_outcomes", "created_at_epoch", "created_at_epoch_ms"],
    ["entity_aliases", "created_at_epoch", "created_at_epoch_ms"],
    ["artifacts", "timestamp_epoch", "timestamp_epoch_ms"],
    ["artifacts", "last_materialized_epoch", "last_materialized_epoch_ms"],
    ["code_index", "last_indexed_epoch", "last_indexed_epoch_ms"]
  ];
  let restoreReadOnlyTriggers = false;
  try {
    if (hasTable(db, "artifacts") && hasColumn(db, "artifacts", "read_only")) {
      const flipped = db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE read_only = 1`).get().n;
      if (flipped > 0) {
        db.exec(`DROP TRIGGER IF EXISTS prevent_legacy_insert_post_cutover`);
        db.exec(`DROP TRIGGER IF EXISTS prevent_legacy_update_post_cutover`);
        db.exec(`DROP TRIGGER IF EXISTS prevent_legacy_delete_post_cutover`);
        restoreReadOnlyTriggers = true;
      }
    }
  } catch {
  }
  try {
    const tx = db.transaction(() => {
      for (const [table, oldCol, newCol] of renames) {
        if (!hasTable(db, table)) continue;
        if (hasColumn(db, table, oldCol) && !hasColumn(db, table, newCol)) {
          db.exec(`ALTER TABLE "${table}" RENAME COLUMN "${oldCol}" TO "${newCol}"`);
          db.exec(
            `UPDATE "${table}" SET "${newCol}" = "${newCol}" * 1000 WHERE "${newCol}" > 0 AND "${newCol}" < 100000000000`
          );
        }
      }
    });
    tx();
  } finally {
    if (restoreReadOnlyTriggers) {
      try {
        _installReadOnlyTriggers(db);
      } catch {
      }
    }
  }
  const tables = [...new Set(renames.map(([t]) => t))];
  const anyDb = db;
  if (typeof anyDb.unsafeMode === "function") anyDb.unsafeMode(true);
  db.pragma("writable_schema = 1");
  try {
    const stmt = db.prepare(
      `UPDATE sqlite_master
       SET sql = replace(sql, 'DEFAULT (unixepoch())', 'DEFAULT (unixepoch() * 1000)')
       WHERE type = 'table' AND name = ?`
    );
    for (const t of tables) {
      if (hasTable(db, t)) stmt.run(t);
    }
  } finally {
    db.pragma("writable_schema = 0");
    if (typeof anyDb.unsafeMode === "function") anyDb.unsafeMode(false);
  }
  db.pragma("user_version = 43");
  try {
    db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (43)`);
  } catch {
  }
}
function migrateV43toV44(db) {
  if (!hasTable(db, "session_termination")) {
    return;
  }
  if (!hasColumn(db, "session_termination", "open_blockers")) {
    db.exec(`ALTER TABLE session_termination ADD COLUMN open_blockers TEXT`);
  }
  db.pragma("user_version = 44");
  try {
    db.exec(`INSERT OR IGNORE INTO schema_versions(version) VALUES (44)`);
  } catch {
  }
}

// src/core/migrations.ts
var TARGET_USER_VERSION = 44;
function runMigrations(db) {
  const row = db.pragma("user_version");
  let version = row[0]?.user_version ?? 0;
  const TARGET_VERSION = TARGET_USER_VERSION;
  if (version >= TARGET_VERSION) {
    loadSqliteVec(db);
    return;
  }
  const migrations = [
    [2, () => {
    }],
    [3, () => migrateV3toV4(db)],
    [4, () => migrateV4toV5(db)],
    [5, () => migrateV5toV6(db)],
    [6, () => migrateV6toV7(db)],
    [7, () => migrateV7toV8(db)],
    [8, () => migrateV8toV9(db)],
    [9, () => migrateV9toV10(db)],
    [10, () => migrateV10toV11(db)],
    [11, () => migrateV11toV12(db)],
    [12, () => migrateV12toV13(db)],
    [13, () => migrateV13toV14(db)],
    [14, () => migrateV14toV15(db)],
    [15, () => migrateV15toV16(db)],
    [16, () => migrateV16toV17(db)],
    [17, () => migrateV17toV18(db)],
    [18, () => migrateV18toV19(db)],
    [19, () => {
      migrateV19toV20(db);
    }],
    [20, () => {
      migrateV20toV21(db);
    }],
    [21, () => {
      migrateV21toV22(db);
    }],
    [22, () => {
      migrateV22toV23(db);
    }],
    [23, () => {
      migrateV23toV24(db);
    }],
    [24, () => {
      migrateV24toV25(db);
    }],
    [25, () => {
      migrateV25toV26(db);
    }],
    [26, () => {
      migrateV26toV27(db);
    }],
    [27, () => {
      migrateV27toV28(db);
    }],
    [28, () => {
      migrateV28toV29(db);
    }],
    [29, () => {
      migrateV29toV30(db);
    }],
    [30, () => {
      migrateV30toV31(db);
    }],
    [31, () => {
      migrateV31toV32(db);
    }],
    [32, () => {
      migrateV32toV33(db);
    }],
    [33, () => {
      migrateV33toV34(db);
    }],
    [34, () => {
      migrateV34toV35(db);
    }],
    [35, () => {
      migrateV35toV36(db);
    }],
    [36, () => {
      migrateV36toV37(db);
    }],
    [37, () => {
      migrateV37toV38(db);
    }],
    [38, () => {
      migrateV38toV39(db);
    }],
    [39, () => {
      migrateV39toV40(db);
    }],
    [40, () => {
      migrateV40toV41(db);
    }],
    [41, () => {
      migrateV41toV42(db);
    }],
    [42, () => {
      migrateV42toV43(db);
    }],
    [43, () => {
      migrateV43toV44(db);
    }]
  ];
  if (version === 0) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    if (!tables.includes("observations")) return;
    migrateV1toV2(db);
    if (!migrateV2toV3(db)) {
      db.pragma("user_version = 2");
      return;
    }
    version = 3;
  } else if (version === 1) {
    migrateV1toV2(db);
    if (!migrateV2toV3(db)) {
      db.pragma("user_version = 2");
      return;
    }
    version = 3;
  } else if (version === 2) {
    if (!migrateV2toV3(db)) return;
    version = 3;
  }
  let lastSuccessfulVersion = version;
  for (const [fromVersion, migrate] of migrations) {
    if (version <= fromVersion && fromVersion >= 3) {
      try {
        migrate();
        lastSuccessfulVersion = fromVersion + 1;
      } catch (err) {
        if (process.env.DEBUG_MIGRATIONS) {
          console.error(`[migrations] step [${fromVersion}\u2192${fromVersion + 1}] failed:`, err);
        }
        break;
      }
    }
  }
  db.pragma(`user_version = ${lastSuccessfulVersion >= TARGET_VERSION ? TARGET_VERSION : lastSuccessfulVersion}`);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  readLastTurnTexts,
  recordSessionTermination,
  runMigrations
});
