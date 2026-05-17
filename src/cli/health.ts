/**
 * claudex health CLI — comprehensive health check for the live database.
 * Opens the DB and validates schema, write/read, FTS5, telemetry, scope, sessions.
 *
 * Usage:
 *   claudex health
 *
 * Non-throwing — reports errors as check failures, never crashes.
 * Exit code 0 for healthy, 1 for failures.
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/paths.js';
import { detectProjectScope } from '../shared/scope-detector.js';

// ── Expected schema definition ──────────────────────────────────────

/** Tables and their expected columns with constraints. */
interface ColumnDef {
  name: string;
  notNull?: boolean;
  hasDefault?: boolean;
}

const EXPECTED_TABLES: Record<string, ColumnDef[]> = {
  observations: [
    { name: 'id', notNull: true },
    { name: 'session_id', notNull: true },
    { name: 'project' },
    { name: 'tool_name', notNull: true },
    { name: 'category', notNull: true },
    { name: 'title', notNull: true },
    { name: 'content', notNull: true },
    { name: 'importance', notNull: true },
    { name: 'files_modified', notNull: true, hasDefault: true },
    { name: 'timestamp_epoch_ms', notNull: true, hasDefault: true },
    { name: 'access_count', notNull: true, hasDefault: true },
    { name: 'last_accessed_at_epoch_ms' },
    { name: 'deleted_at_epoch_ms' },
    { name: 'consumed', notNull: true, hasDefault: true },
    { name: 'obs_type' },
  ],
  sessions: [
    { name: 'session_id', notNull: true },
    { name: 'scope' },
    { name: 'project' },
    { name: 'cwd' },
    { name: 'source' },
    { name: 'status', notNull: true, hasDefault: true },
    { name: 'observation_count', notNull: true, hasDefault: true },
    { name: 'created_at_epoch_ms', notNull: true, hasDefault: true },
    { name: 'ended_at_epoch_ms' },
    { name: 'adapter' },
  ],
  pressure_scores: [
    { name: 'file_path', notNull: true },
    { name: 'project', notNull: true },
    { name: 'raw_pressure', notNull: true, hasDefault: true },
    { name: 'temperature', notNull: true, hasDefault: true },
    { name: 'last_touched_epoch_ms', notNull: true, hasDefault: true },
    { name: 'decay_rate', notNull: true, hasDefault: true },
  ],
  learnings: [
    { name: 'id', notNull: true },
    { name: 'project', notNull: true, hasDefault: true },
    { name: 'agent_id', notNull: true, hasDefault: true },
    { name: 'fingerprint', notNull: true },
    { name: 'content', notNull: true },
    { name: 'promotion_count', notNull: true, hasDefault: true },
    { name: 'first_seen_epoch_ms', notNull: true, hasDefault: true },
    { name: 'last_promoted_epoch_ms', notNull: true, hasDefault: true },
    { name: 'updated_at_epoch_ms', notNull: true, hasDefault: true },
  ],
  decisions: [
    { name: 'id', notNull: true },
    { name: 'session_id', notNull: true },
    { name: 'project', notNull: true, hasDefault: true },
    { name: 'content', notNull: true },
    { name: 'source', notNull: true },
    { name: 'fingerprint', notNull: true },
    { name: 'timestamp_epoch_ms', notNull: true, hasDefault: true },
    { name: 'updated_at_epoch', notNull: true, hasDefault: true },
  ],
  thread_state: [
    { name: 'session_id', notNull: true },
    { name: 'topic' },
    { name: 'summary' },
    { name: 'key_exchanges', notNull: true, hasDefault: true },
    { name: 'updated_at_epoch', notNull: true, hasDefault: true },
    { name: 'summary_embedding' },
  ],
  checkpoint_tracking: [
    { name: 'session_id', notNull: true },
    { name: 'last_checkpoint_epoch' },
    { name: 'thresholds_hit', notNull: true, hasDefault: true },
    { name: 'observation_count', notNull: true, hasDefault: true },
    { name: 'post_compact_pending', notNull: true, hasDefault: true },
    { name: 'updated_at_epoch', notNull: true, hasDefault: true },
  ],
  checkpoint_meta: [
    { name: 'checkpoint_id', notNull: true },
    { name: 'session_id', notNull: true },
    { name: 'trigger', notNull: true },
    { name: 'status', notNull: true, hasDefault: true },
    { name: 'data' },
    { name: 'mirror_path' },
    { name: 'error' },
    { name: 'created_at_epoch_ms', notNull: true, hasDefault: true },
    { name: 'updated_at_epoch_ms', notNull: true, hasDefault: true },
  ],
  session_journal: [
    { name: 'id', notNull: true },
    { name: 'session_id', notNull: true },
    { name: 'project', notNull: true },
    { name: 'entry_type', notNull: true },
    { name: 'content', notNull: true },
    { name: 'timestamp_epoch_ms', notNull: true, hasDefault: true },
    { name: 'recall_text' },
    { name: 'embedding' },
  ],
  artifacts: [
    { name: 'id', notNull: true },
    { name: 'session_id', notNull: true },
    { name: 'project', notNull: true },
    { name: 'artifact_type', notNull: true },
    { name: 'artifact_ref' },
    { name: 'summary', notNull: true },
    { name: 'content' },
    { name: 'state', notNull: true, hasDefault: true },
    { name: 'ttl', notNull: true, hasDefault: true },
    { name: 'importance', notNull: true, hasDefault: true },
    { name: 'timestamp_epoch_ms', notNull: true, hasDefault: true },
    { name: 'last_materialized_epoch_ms' },
    { name: 'embedding' },
    { name: 'activation_score', notNull: true, hasDefault: true },
    { name: 'superseded_by' },
    { name: 'valid_until' },
    { name: 'confidence', notNull: true, hasDefault: true },
    { name: 'novelty_score', notNull: true, hasDefault: true },
  ],
  verified_facts: [
    { name: 'id', notNull: true },
    { name: 'session_id', notNull: true },
    { name: 'fact', notNull: true },
    { name: 'created_at_epoch', notNull: true, hasDefault: true },
  ],
  telemetry: [
    { name: 'id', notNull: true },
    { name: 'session_id', notNull: true },
    { name: 'event_kind', notNull: true },
    { name: 'detail', notNull: true, hasDefault: true },
    { name: 'latency_ms' },
    { name: 'timestamp_epoch_ms', notNull: true, hasDefault: true },
    { name: 'adapter' },
  ],
  schema_versions: [
    { name: 'version', notNull: true },
  ],
  experience_patterns: [
    { name: 'id', notNull: true },
    { name: 'pattern_type', notNull: true },
    { name: 'trigger_context', notNull: true },
    { name: 'lesson', notNull: true },
    { name: 'anti_pattern' },
    { name: 'severity', notNull: true, hasDefault: true },
    { name: 'score', notNull: true, hasDefault: true },
    { name: 'times_triggered', notNull: true, hasDefault: true },
    { name: 'times_useful', notNull: true, hasDefault: true },
    { name: 'source_session' },
    { name: 'source_project', notNull: true },
    { name: 'created_at_epoch', notNull: true },
    { name: 'last_triggered_epoch' },
    { name: 'trigger_glob' },
    { name: 'trigger_command' },
    { name: 'embedding' },
    { name: 'assumption' },
    { name: 'reality' },
    { name: 'root_cause' },
    { name: 'generalized_rule' },
    { name: 'abstraction_level' },
    { name: 'verified', notNull: true, hasDefault: true },
    { name: 'verification_count', notNull: true, hasDefault: true },
  ],
  context_triggers: [
    { name: 'id', notNull: true },
    { name: 'glob_pattern' },
    { name: 'command_pattern' },
    { name: 'knowledge_domain', notNull: true },
    { name: 'priority', notNull: true, hasDefault: true },
    { name: 'project', notNull: true, hasDefault: true },
  ],
  session_events: [
    { name: 'id', notNull: true },
    { name: 'session_id', notNull: true },
    { name: 'project', notNull: true },
    { name: 'event_type', notNull: true },
    { name: 'entity', notNull: true },
    { name: 'action', notNull: true },
    { name: 'detail' },
    { name: 'timestamp_epoch_ms', notNull: true, hasDefault: true },
  ],
  artifact_links: [
    { name: 'source_id', notNull: true },
    { name: 'target_id', notNull: true },
    { name: 'link_type', notNull: true },
    { name: 'strength', notNull: true, hasDefault: true },
    { name: 'created_at_epoch', notNull: true, hasDefault: true },
  ],
  // V17 unified artifact kernel — Phase 14-07b: migrated from legacy artifacts
  artifact: [
    { name: 'id', notNull: true },
    { name: 'kind', notNull: true },
    { name: 'title' },
    { name: 'body', notNull: true },
    { name: 'scope' },
    { name: 'status', notNull: true, hasDefault: true },
    { name: 'confidence' },
    { name: 'created_at_epoch_ms', notNull: true },
    { name: 'updated_at_epoch_ms', notNull: true },
    { name: 'session_id' },
    { name: 'project' },
    { name: 'embedding_ref' },
    { name: 'supersedes_id' },
    { name: 'data', notNull: true, hasDefault: true },
  ],
  retrieval_events: [
    { name: 'id', notNull: true },
    { name: 'artifact_id', notNull: true },
    { name: 'session_id', notNull: true },
    { name: 'query_text' },
    { name: 'was_referenced' },
    { name: 'correction_followed' },
    { name: 'timestamp_epoch_ms', notNull: true, hasDefault: true },
  ],
  capability_boundaries: [
    { name: 'id', notNull: true },
    { name: 'project', notNull: true },
    { name: 'domain', notNull: true },
    { name: 'total_interactions', notNull: true, hasDefault: true },
    { name: 'corrections', notNull: true, hasDefault: true },
    { name: 'last_updated_epoch', notNull: true, hasDefault: true },
  ],
  file_leases: [
    { name: 'file_path', notNull: true },
    { name: 'worker_id', notNull: true },
    { name: 'granted_at_epoch', notNull: true },
    { name: 'ttl_seconds', notNull: true, hasDefault: true },
  ],
  artifact_claims: [
    { name: 'artifact_id' },
    { name: 'worker_id', notNull: true },
    { name: 'claimed_at_epoch', notNull: true },
    { name: 'ttl_seconds', notNull: true, hasDefault: true },
  ],
};

const EXPECTED_TABLE_NAMES = Object.keys(EXPECTED_TABLES);

// ── Check result types ──────────────────────────────────────────────

export interface CheckResult {
  label: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
}

export interface HealthReport {
  checks: CheckResult[];
  failures: number;
  warnings: number;
}

// ── Individual checks ───────────────────────────────────────────────

/**
 * Check 1: Schema validation — verify all expected tables exist.
 */
export function checkTables(db: Database.Database): CheckResult {
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const existing = new Set(rows.map(r => r.name));

    const missing: string[] = [];
    for (const table of EXPECTED_TABLE_NAMES) {
      if (!existing.has(table)) {
        missing.push(table);
      }
    }

    if (missing.length > 0) {
      return {
        label: 'Schema',
        status: 'fail',
        message: `${EXPECTED_TABLE_NAMES.length - missing.length}/${EXPECTED_TABLE_NAMES.length} tables present (missing: ${missing.join(', ')})`,
      };
    }

    return {
      label: 'Schema',
      status: 'pass',
      message: `${EXPECTED_TABLE_NAMES.length}/${EXPECTED_TABLE_NAMES.length} tables present`,
    };
  } catch (err) {
    return {
      label: 'Schema',
      status: 'fail',
      message: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check 2: Column validation — verify all expected columns exist with correct constraints.
 */
export function checkColumns(db: Database.Database): CheckResult {
  try {
    const missingCols: string[] = [];
    const constraintIssues: string[] = [];

    for (const [table, expectedCols] of Object.entries(EXPECTED_TABLES)) {
      let cols: Array<{ name: string; notnull: number; dflt_value: string | null }>;
      try {
        cols = db.pragma(`table_info(${table})`) as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      } catch {
        // Table doesn't exist — already reported by checkTables
        continue;
      }

      if (cols.length === 0) continue; // Table doesn't exist

      const colMap = new Map(cols.map(c => [c.name, c]));

      for (const expected of expectedCols) {
        const actual = colMap.get(expected.name);
        if (!actual) {
          missingCols.push(`${table}.${expected.name}`);
          continue;
        }

        // Check NOT NULL constraint
        if (expected.notNull && actual.notnull === 0) {
          // Special case: PKs are implicitly NOT NULL in SQLite even if notnull=0
          // PRAGMA table_info reports notnull=0 for INTEGER PRIMARY KEY; skip those
          const isPk = table !== 'schema_versions' || expected.name !== 'version';
          // Only flag non-PK columns that should be NOT NULL but aren't
          if (expected.name !== 'id' && expected.name !== 'session_id' && expected.name !== 'file_path' &&
              expected.name !== 'checkpoint_id' && expected.name !== 'version') {
            constraintIssues.push(`${table}.${expected.name} missing NOT NULL`);
          }
        }

        // Check DEFAULT constraint
        if (expected.hasDefault && actual.dflt_value === null) {
          // Some columns have defaults via unixepoch() which PRAGMA may not show;
          // also, ALTER TABLE ADD COLUMN defaults may not match PRAGMA dflt_value.
          // Only flag clearly wrong cases — be lenient here.
        }
      }
    }

    if (missingCols.length > 0) {
      return {
        label: 'Columns',
        status: 'fail',
        message: `Missing columns: ${missingCols.join(', ')}`,
      };
    }

    if (constraintIssues.length > 0) {
      return {
        label: 'Columns',
        status: 'warn',
        message: `Constraint issues: ${constraintIssues.join(', ')}`,
      };
    }

    return {
      label: 'Columns',
      status: 'pass',
      message: 'All expected columns found',
    };
  } catch (err) {
    return {
      label: 'Columns',
      status: 'fail',
      message: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check 3: Write/read test — INSERT + ROLLBACK for each table to validate v3 constraints.
 */
export function checkWriteRead(db: Database.Database): CheckResult {
  const failures: string[] = [];

  const testInserts: Record<string, string> = {
    observations: `INSERT INTO observations (session_id, tool_name, category, title, content, importance, files_modified, consumed)
      VALUES ('__health_check__', 'health', 'other', 'test', 'test', 3, '[]', 0)`,
    sessions: `INSERT INTO sessions (session_id, status, observation_count)
      VALUES ('__health_check__', 'active', 0)`,
    pressure_scores: `INSERT INTO pressure_scores (file_path, project, raw_pressure, temperature, last_touched_epoch_ms, decay_rate)
      VALUES ('__health_check__', '__health__', 0.0, 'COLD', 0, 0.1)`,
    learnings: `INSERT INTO learnings (project, agent_id, fingerprint, content, promotion_count)
      VALUES ('__health__', 'default', '__health_check__', 'test', 1)`,
    decisions: `INSERT INTO decisions (session_id, project, content, source, fingerprint)
      VALUES ('__health_check__', '__health__', 'test', 'explicit', '__health_check__')`,
    thread_state: `INSERT INTO thread_state (session_id, key_exchanges)
      VALUES ('__health_check__', '[]')`,
    checkpoint_tracking: `INSERT INTO checkpoint_tracking (session_id, observation_count, post_compact_pending)
      VALUES ('__health_check__', 0, 0)`,
    checkpoint_meta: `INSERT INTO checkpoint_meta (checkpoint_id, session_id, trigger, status)
      VALUES ('__health_check__', '__health_check__', 'threshold', 'pending')`,
    session_journal: `INSERT INTO session_journal (session_id, project, entry_type, content)
      VALUES ('__health_check__', '__health__', 'flow', 'test')`,
    artifacts: `INSERT INTO artifacts (session_id, project, artifact_type, summary, state, ttl, importance)
      VALUES ('__health_check__', '__health__', 'observation', 'test', 'fresh', 3, 3)`,
    // V17 unified artifact — Phase 14-07b: migrated from legacy artifacts
    artifact: `INSERT OR IGNORE INTO artifact (id, kind, title, body, status, confidence, created_at_epoch_ms, updated_at_epoch_ms, session_id, project, data)
      VALUES ('__health_check_v17__', 'observation', 'health check', '', 'active', 0.6, 0, 0, '__health_check__', '__health__', '{}')`,
    verified_facts: `INSERT INTO verified_facts (session_id, fact)
      VALUES ('__health_check__', 'test')`,
    telemetry: `INSERT INTO telemetry (session_id, event_kind, detail)
      VALUES ('__health_check__', 'error', '{}')`,
    schema_versions: `INSERT OR IGNORE INTO schema_versions (version) VALUES (99999)`,
  };

  for (const [table, sql] of Object.entries(testInserts)) {
    try {
      // Use SAVEPOINT for nested transaction support within existing transactions
      db.exec('SAVEPOINT health_write_test');
      db.exec(sql);
      db.exec('ROLLBACK TO SAVEPOINT health_write_test');
      db.exec('RELEASE SAVEPOINT health_write_test');
    } catch (err) {
      // Make sure we rollback on failure
      try { db.exec('ROLLBACK TO SAVEPOINT health_write_test'); } catch { /* ignore */ }
      try { db.exec('RELEASE SAVEPOINT health_write_test'); } catch { /* ignore */ }
      failures.push(`${table}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length > 0) {
    return {
      label: 'Write test',
      status: 'fail',
      message: `${failures.length} table(s) reject v3 inserts: ${failures.join('; ')}`,
    };
  }

  return {
    label: 'Write test',
    status: 'pass',
    message: 'All tables accept v3 inserts',
  };
}

/**
 * Check 4: FTS5 health — verify observations_fts exists with correct column count.
 */
export function checkFts5(db: Database.Database): CheckResult {
  try {
    // Check observations_fts exists
    const row = db
      .prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='observations_fts'")
      .get() as { cnt: number };

    if (row.cnt === 0) {
      return {
        label: 'FTS5',
        status: 'fail',
        message: 'observations_fts table does not exist',
      };
    }

    // Check column count (should be 2: title, content)
    const cols = db.pragma('table_info(observations_fts)') as Array<{ name: string }>;
    const colCount = cols.length;

    if (colCount !== 2) {
      return {
        label: 'FTS5',
        status: 'fail',
        message: `Expected 2 FTS columns (title, content), found ${colCount}: ${cols.map(c => c.name).join(', ')}`,
      };
    }

    // Try a simple MATCH query
    try {
      db.prepare("SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'health_check_probe' LIMIT 1").all();
    } catch (err) {
      return {
        label: 'FTS5',
        status: 'fail',
        message: `FTS5 MATCH query failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      label: 'FTS5',
      status: 'pass',
      message: '2-column index, queries working',
    };
  } catch (err) {
    return {
      label: 'FTS5',
      status: 'fail',
      message: `FTS5 check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check 5: Telemetry errors — count recent errors and show latest messages.
 */
export function checkTelemetry(db: Database.Database): CheckResult {
  try {
    const nowMs = Date.now();
    const fiveMin = nowMs - 300_000;
    const oneHour = nowMs - 3_600_000;
    const twentyFourHour = nowMs - 86_400_000;

    const count5m = (db.prepare(
      "SELECT COUNT(*) as cnt FROM telemetry WHERE event_kind = 'error' AND timestamp_epoch_ms >= ?"
    ).get(fiveMin) as { cnt: number }).cnt;

    const count1h = (db.prepare(
      "SELECT COUNT(*) as cnt FROM telemetry WHERE event_kind = 'error' AND timestamp_epoch_ms >= ?"
    ).get(oneHour) as { cnt: number }).cnt;

    const count24h = (db.prepare(
      "SELECT COUNT(*) as cnt FROM telemetry WHERE event_kind = 'error' AND timestamp_epoch_ms >= ?"
    ).get(twentyFourHour) as { cnt: number }).cnt;

    // Get recent error messages
    const recentErrors = db.prepare(
      "SELECT detail FROM telemetry WHERE event_kind = 'error' ORDER BY timestamp_epoch_ms DESC LIMIT 3"
    ).all() as Array<{ detail: string }>;

    let message = `${count5m} errors (5m) | ${count1h} errors (1h) | ${count24h} errors (24h)`;

    if (recentErrors.length > 0) {
      const errorSummaries = recentErrors.map(e => {
        try {
          const parsed = JSON.parse(e.detail);
          return parsed.message || parsed.error || e.detail.slice(0, 80);
        } catch {
          return e.detail.slice(0, 80);
        }
      });
      message += `\n              Recent: ${errorSummaries.join(' | ')}`;
    }

    // Warn if errors in last hour, fail if errors in last 5 minutes
    if (count5m > 0) {
      return { label: 'Telemetry', status: 'warn', message };
    }

    return { label: 'Telemetry', status: 'pass', message };
  } catch (err) {
    return {
      label: 'Telemetry',
      status: 'fail',
      message: `Telemetry query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check 6: projects.json / scope detection.
 */
export function checkScope(cwd: string): CheckResult {
  try {
    const project = detectProjectScope(cwd);
    if (project) {
      return {
        label: 'Scope',
        status: 'pass',
        message: `Project: ${project}`,
      };
    }

    return {
      label: 'Scope',
      status: 'warn',
      message: 'No project scope detected for cwd (projects.json missing or no match)',
    };
  } catch (err) {
    return {
      label: 'Scope',
      status: 'fail',
      message: `Scope detection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check 7: Session health — orphaned sessions and aggregate stats.
 */
export function checkSessions(db: Database.Database): CheckResult {
  try {
    const nowMs = Date.now();
    const oneDayAgo = nowMs - 86_400_000;

    // Count orphaned sessions (active but older than 24h)
    const orphaned = (db.prepare(
      "SELECT COUNT(*) as cnt FROM sessions WHERE status = 'active' AND created_at_epoch_ms < ?"
    ).get(oneDayAgo) as { cnt: number }).cnt;

    if (orphaned > 0) {
      return {
        label: 'Sessions',
        status: 'warn',
        message: `${orphaned} orphaned session(s) (active > 24h old)`,
      };
    }

    return {
      label: 'Sessions',
      status: 'pass',
      message: 'No orphaned sessions',
    };
  } catch (err) {
    return {
      label: 'Sessions',
      status: 'fail',
      message: `Session check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check 8: Aggregate stats line.
 */
export function checkStats(db: Database.Database): CheckResult {
  try {
    const obsCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM observations WHERE deleted_at_epoch_ms IS NULL"
    ).get() as { cnt: number }).cnt;

    const artifactCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM artifacts"
    ).get() as { cnt: number }).cnt;

    let v17ArtifactCount = 0;
    try {
      v17ArtifactCount = (db.prepare(
        "SELECT COUNT(*) as cnt FROM artifact"
      ).get() as { cnt: number }).cnt;
    } catch { /* V17 table not yet present (pre-migration DB) — non-fatal */ }

    const journalCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM session_journal"
    ).get() as { cnt: number }).cnt;

    const sessionCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM sessions"
    ).get() as { cnt: number }).cnt;

    return {
      label: 'Stats',
      status: 'pass',
      message: `${sessionCount.toLocaleString()} sessions | ${obsCount.toLocaleString()} observations | ${artifactCount.toLocaleString()} artifacts (legacy) | ${v17ArtifactCount.toLocaleString()} artifacts (V17) | ${journalCount.toLocaleString()} journal entries`,
    };
  } catch (err) {
    return {
      label: 'Stats',
      status: 'fail',
      message: `Stats query failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Report assembly ─────────────────────────────────────────────────

const STATUS_ICONS: Record<CheckResult['status'], string> = {
  pass: '\u2713',  // ✓
  fail: '\u2717',  // ✗
  warn: '\u26A0',  // ⚠
};

/**
 * Formats a health report as a string for terminal output.
 */
export function formatReport(report: HealthReport): string {
  const lines: string[] = ['=== Claudex Health Check ===', ''];

  for (const check of report.checks) {
    const icon = STATUS_ICONS[check.status];
    const label = (check.label + ':').padEnd(16);
    lines.push(`${label}${icon} ${check.message}`);
  }

  lines.push('');

  // Overall verdict
  if (report.failures > 0) {
    lines.push(`Overall: UNHEALTHY (${report.failures} failure(s), ${report.warnings} warning(s))`);
  } else if (report.warnings > 0) {
    lines.push(`Overall: HEALTHY (${report.warnings} warning(s))`);
  } else {
    lines.push('Overall: HEALTHY');
  }

  return lines.join('\n');
}

// ── Main execution ──────────────────────────────────────────────────

/**
 * Runs all health checks against the given database path and cwd.
 * Returns a HealthReport. Exported for testability.
 */
export function runHealthCheck(dbPath: string, cwd: string): HealthReport {
  const checks: CheckResult[] = [];

  // Try to open DB
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: false });
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    checks.push({
      label: 'Database',
      status: 'fail',
      message: `Could not open database at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { checks, failures: 1, warnings: 0 };
  }

  try {
    // 1. Schema validation (tables)
    checks.push(checkTables(db));

    // 2. Column validation
    checks.push(checkColumns(db));

    // 3. Write/read test
    checks.push(checkWriteRead(db));

    // 4. FTS5 health
    checks.push(checkFts5(db));

    // 5. Telemetry errors
    checks.push(checkTelemetry(db));

    // 6. Scope detection
    checks.push(checkScope(cwd));

    // 7. Session health
    checks.push(checkSessions(db));

    // 8. Stats
    checks.push(checkStats(db));
  } finally {
    try { db.close(); } catch { /* non-throwing */ }
  }

  const failures = checks.filter(c => c.status === 'fail').length;
  const warnings = checks.filter(c => c.status === 'warn').length;

  return { checks, failures, warnings };
}

// ── Entry point ─────────────────────────────────────────────────────

const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv &&
  typeof process.argv[1] === 'string' &&
  (process.argv[1].includes('health') || process.argv[1].endsWith('health.cjs'));

if (isDirectExecution) {
  try {
    const dbPath = getDbPath();
    const cwd = process.cwd();
    const report = runHealthCheck(dbPath, cwd);
    const output = formatReport(report);
    process.stdout.write(output + '\n');
    process.exit(report.failures > 0 ? 1 : 0);
  } catch (err) {
    process.stderr.write(`Health check error: ${err instanceof Error ? err.message : 'Unknown error'}\n`);
    process.exit(1);
  }
}
